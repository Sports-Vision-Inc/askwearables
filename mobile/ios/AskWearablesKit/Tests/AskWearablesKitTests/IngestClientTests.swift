import XCTest
@testable import AskWearablesKit

final class MockTransport: HTTPTransport, @unchecked Sendable {
    struct Reply { var status: Int; var headers: [String: String] = [:]; var error: Error? = nil }
    private let lock = NSLock()
    var replies: [Reply]
    var requests: [URLRequest] = []

    init(_ replies: [Reply]) { self.replies = replies }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let reply: Reply = lock.withLock {
            requests.append(request)
            return replies.isEmpty ? Reply(status: 200) : replies.removeFirst()
        }
        if let e = reply.error { throw e }
        return (Data("{}".utf8), HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!)
    }
}

final class SleepRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var waits: [TimeInterval] = []
    func record(_ t: TimeInterval) { lock.withLock { waits.append(t) } }
}

final class IngestClientTests: XCTestCase {
    let source = Source(id: "apple_health:t", provider: "apple_health", deviceModel: nil, deviceClass: .watch,
                        connectedAt: Date(timeIntervalSince1970: 0), earliestReadable: nil, lastSyncAt: nil)

    func records(_ n: Int) -> [CanonicalRecord] {
        (0..<n).map { i in
            Mapper.hourlyBucket(metric: .steps, hourStart: Date(timeIntervalSince1970: Double(i) * 3600), total: 1,
                                sourceId: "apple_health:t", timeZone: TimeZone(identifier: "UTC")!)
        }
    }

    func client(_ t: MockTransport, _ sleeps: SleepRecorder, token: String? = "tok") -> IngestClient {
        IngestClient(baseURL: URL(string: "https://api.askwearables.app")!, transport: t, policy: RetryPolicy(maxAttempts: 4, baseDelay: 1, maxDelay: 60),
                     tokenProvider: { token }, sleeper: { sleeps.record($0) }, random: { 1.0 })
    }

    func testBatchesOf2000WithBearerTokenAndJSONBody() async throws {
        let t = MockTransport([])
        let c = client(t, SleepRecorder())
        let n = try await c.upload(source: source, records: records(4500))
        XCTAssertEqual(n, 3)
        XCTAssertEqual(t.requests.count, 3)
        let r = t.requests[0]
        XCTAssertEqual(r.url?.absoluteString, "https://api.askwearables.app/v1/ingest")
        XCTAssertEqual(r.httpMethod, "POST")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let counts = try t.requests.map { req -> Int in
            let obj = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: Any]
            XCTAssertNotNil(obj["source"])
            return (obj["records"] as! [Any]).count
        }
        XCTAssertEqual(counts, [2000, 2000, 500])
    }

    func testHonoursRetryAfterOn429() async throws {
        let t = MockTransport([.init(status: 429, headers: ["Retry-After": "7"]), .init(status: 200)])
        let s = SleepRecorder()
        try await client(t, s).upload(source: source, records: records(1))
        XCTAssertEqual(s.waits, [7])
        XCTAssertEqual(t.requests.count, 2)
    }

    func testExponentialBackoffOn5xxAndNetworkErrorsThenGivesUp() async {
        let t = MockTransport([.init(status: 503), .init(status: 0, error: URLError(.timedOut)), .init(status: 500), .init(status: 502)])
        let s = SleepRecorder()
        do {
            try await client(t, s).upload(source: source, records: records(1))
            XCTFail("expected failure")
        } catch {
            XCTAssertEqual(error as? IngestError, .gaveUp(lastStatus: 502))
        }
        XCTAssertEqual(s.waits, [1, 2, 4]) // base * 2^attempt with jitter fixed at 1.0; no wait after the last try
        XCTAssertEqual(t.requests.count, 4)
    }

    func testRetryAfterLongerThanMaxDelayStopsWithoutSleeping() async {
        let t = MockTransport([.init(status: 429, headers: ["Retry-After": "3600"])])
        let s = SleepRecorder()
        do {
            try await client(t, s).upload(source: source, records: records(1))
            XCTFail("expected failure")
        } catch {
            XCTAssertEqual(error as? IngestError, .gaveUp(lastStatus: 429))
        }
        XCTAssertEqual(s.waits, [])
    }

    func testUnauthorizedAndBadRequestAreNotRetried() async {
        for (status, expected) in [(401, IngestError.unauthorized(401)), (400, IngestError.rejected(400, "{}"))] {
            let t = MockTransport([.init(status: status)])
            do {
                try await client(t, SleepRecorder()).upload(source: source, records: records(1))
                XCTFail("expected failure")
            } catch {
                XCTAssertEqual(error as? IngestError, expected)
            }
            XCTAssertEqual(t.requests.count, 1)
        }
    }

    func testNoTokenFailsBeforeAnyRequest() async {
        let t = MockTransport([])
        do {
            try await client(t, SleepRecorder(), token: nil).upload(source: source, records: records(1))
            XCTFail("expected failure")
        } catch {
            XCTAssertEqual(error as? IngestError, .noToken)
        }
        XCTAssertEqual(t.requests.count, 0)
    }

    func testRetryAfterParsing() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(parseRetryAfter("120", now: now), 120)
        XCTAssertNil(parseRetryAfter(nil, now: now))
        XCTAssertNil(parseRetryAfter("soon", now: now))
        let httpDate = "Mon, 12 Jan 1970 13:47:10 GMT" // now + 30 s
        XCTAssertEqual(parseRetryAfter(httpDate, now: now)!, 30, accuracy: 0.5)
    }
}
