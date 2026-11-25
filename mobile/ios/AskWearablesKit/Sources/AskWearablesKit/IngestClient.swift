import Foundation

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    let session: URLSession
    public init(session: URLSession = .shared) { self.session = session }
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }
}

public enum IngestError: Error, Equatable {
    case noToken
    /// 401/403: the device sync token is wrong or revoked. Never retried.
    case unauthorized(Int)
    /// Other 4xx: the body was rejected. Never retried.
    case rejected(Int, String)
    /// Retries exhausted on 429/5xx/network errors.
    case gaveUp(lastStatus: Int?)
}

public struct RetryPolicy: Sendable {
    public var maxAttempts: Int
    public var baseDelay: TimeInterval
    public var maxDelay: TimeInterval

    public init(maxAttempts: Int = 6, baseDelay: TimeInterval = 1, maxDelay: TimeInterval = 300) {
        self.maxAttempts = maxAttempts
        self.baseDelay = baseDelay
        self.maxDelay = maxDelay
    }

    /// Exponential backoff with full jitter: random in [0, min(maxDelay, base * 2^attempt)].
    public func backoff(attempt: Int, random: Double) -> TimeInterval {
        let cap = min(maxDelay, baseDelay * pow(2, Double(attempt)))
        return cap * min(max(random, 0), 1)
    }
}

/// Parse Retry-After as delta-seconds or an HTTP-date.
public func parseRetryAfter(_ value: String?, now: Date = Date()) -> TimeInterval? {
    guard let raw = value?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
    if let secs = Double(raw) { return max(0, secs) }
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "GMT")
    f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
    if let d = f.date(from: raw) { return max(0, d.timeIntervalSince(now)) }
    return nil
}

/// Posts records to POST {baseURL}/v1/ingest in batches of at most 2,000.
public final class IngestClient: @unchecked Sendable {
    public static let defaultBaseURL = URL(string: "https://api.askwearables.app")!

    let baseURL: URL
    let transport: HTTPTransport
    let policy: RetryPolicy
    let tokenProvider: @Sendable () -> String?
    let sleeper: @Sendable (TimeInterval) async throws -> Void
    let random: @Sendable () -> Double

    public init(baseURL: URL = IngestClient.defaultBaseURL,
                transport: HTTPTransport = URLSessionTransport(),
                policy: RetryPolicy = RetryPolicy(),
                tokenProvider: @escaping @Sendable () -> String?,
                sleeper: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) },
                random: @escaping @Sendable () -> Double = { Double.random(in: 0...1) }) {
        self.baseURL = baseURL
        self.transport = transport
        self.policy = policy
        self.tokenProvider = tokenProvider
        self.sleeper = sleeper
        self.random = random
    }

    public var ingestURL: URL { baseURL.appendingPathComponent("v1/ingest") }

    /// Upload all records; returns the number of requests made that succeeded. Throws on the first batch that fails,
    /// so the caller keeps its anchor and retries the whole delta later (ingest is idempotent on external_id).
    @discardableResult
    public func upload(source: Source, records: [CanonicalRecord]) async throws -> Int {
        guard let token = tokenProvider(), !token.isEmpty else { throw IngestError.noToken }
        var sent = 0
        for batch in Mapper.batches(records) {
            try await post(IngestBody(source: source, records: batch), token: token)
            sent += 1
        }
        return sent
    }

    func post(_ body: IngestBody, token: String) async throws {
        var req = URLRequest(url: ingestURL)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try IngestJSON.encoder().encode(body)
        req.timeoutInterval = 60

        var lastStatus: Int?
        for attempt in 0..<policy.maxAttempts {
            var wait: TimeInterval
            do {
                let (data, resp) = try await transport.send(req)
                lastStatus = resp.statusCode
                switch resp.statusCode {
                case 200..<300:
                    return
                case 401, 403:
                    throw IngestError.unauthorized(resp.statusCode)
                case 429:
                    wait = parseRetryAfter(resp.value(forHTTPHeaderField: "Retry-After"))
                        ?? policy.backoff(attempt: attempt, random: random())
                case 408, 500..<600:
                    wait = parseRetryAfter(resp.value(forHTTPHeaderField: "Retry-After"))
                        ?? policy.backoff(attempt: attempt, random: random())
                default:
                    throw IngestError.rejected(resp.statusCode, String(data: data.prefix(500), encoding: .utf8) ?? "")
                }
            } catch let e as IngestError {
                throw e
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                // Network error: retry with backoff.
                wait = policy.backoff(attempt: attempt, random: random())
            }
            // A Retry-After longer than we are willing to wait (background time is short) ends this attempt; the
            // anchor is not advanced, so the next observer wake-up or foreground sync sends the same delta again.
            if wait > policy.maxDelay { throw IngestError.gaveUp(lastStatus: lastStatus) }
            if attempt + 1 < policy.maxAttempts { try await sleeper(wait) }
        }
        throw IngestError.gaveUp(lastStatus: lastStatus)
    }
}
