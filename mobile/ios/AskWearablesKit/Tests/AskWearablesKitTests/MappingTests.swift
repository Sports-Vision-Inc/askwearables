import XCTest
@testable import AskWearablesKit

final class JSONShapeTests: XCTestCase {
    let utc = TimeZone(identifier: "UTC")!
    let berlin = TimeZone(identifier: "Europe/Berlin")!
    let t0 = try! ISO.date("2026-11-20T07:00:00.000Z")

    func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try IngestJSON.encoder().encode(value)
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    func testSampleEncodesExactlyTheCanonicalSampleKeys() throws {
        let uuid = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
        let rec = Mapper.sample(QuantitySnapshot(uuid: uuid, start: t0, end: t0.addingTimeInterval(60), value: 61),
                                metric: .heartRate, method: .measured, sourceId: "apple_health:x", timeZone: berlin)
        let data = try IngestJSON.encoder().encode(rec)
        XCTAssertEqual(String(data: data, encoding: .utf8),
                       #"{"end":"2026-11-20T07:01:00.000Z","external_id":"11111111-2222-3333-4444-555555555555","kind":"sample","method":"measured","metric":"heart_rate","source_id":"apple_health:x","start":"2026-11-20T07:00:00.000Z","tz_offset_min":60,"unit":"bpm","value":61}"#)
    }

    func testTzOffsetIsTheDeviceOffsetAtTheSampleStartAcrossDST() {
        let summer = try! ISO.date("2026-07-01T12:00:00Z")
        XCTAssertEqual(Mapper.tzOffsetMin(at: summer, timeZone: berlin), 120)
        XCTAssertEqual(Mapper.tzOffsetMin(at: t0, timeZone: berlin), 60)
        XCTAssertEqual(Mapper.tzOffsetMin(at: t0, timeZone: TimeZone(identifier: "Asia/Kolkata")!), 330)
        XCTAssertEqual(Mapper.tzOffsetMin(at: t0, timeZone: TimeZone(identifier: "America/New_York")!), -300)
    }

    func testSourceWritesNullsForUnknownNullableFields() throws {
        let src = Source(id: "apple_health:abc", provider: "apple_health", deviceModel: nil, deviceClass: .watch,
                         connectedAt: t0, earliestReadable: nil, lastSyncAt: nil)
        let data = try IngestJSON.encoder().encode(src)
        XCTAssertEqual(String(data: data, encoding: .utf8),
                       #"{"connected_at":"2026-11-20T07:00:00.000Z","device_class":"watch","device_model":null,"earliest_readable":null,"id":"apple_health:abc","last_sync_at":null,"provider":"apple_health","terms_flags":{}}"#)
    }

    func testIngestBodyShape() throws {
        let src = Source(id: "s", provider: "apple_health", deviceModel: "iPhone16,2", deviceClass: .phone, connectedAt: t0,
                         earliestReadable: "2014-09-01", lastSyncAt: t0)
        let body = IngestBody(source: src, records: [
            Mapper.hourlyBucket(metric: .steps, hourStart: t0, total: 812, sourceId: "s", timeZone: utc),
        ])
        let obj = try json(body)
        XCTAssertEqual(Set(obj.keys), ["source", "records"])
        let s = obj["source"] as! [String: Any]
        XCTAssertEqual(s["earliest_readable"] as? String, "2014-09-01")
        XCTAssertEqual(s["device_model"] as? String, "iPhone16,2")
        let r = (obj["records"] as! [[String: Any]])[0]
        XCTAssertEqual(Set(r.keys), ["kind", "metric", "start", "end", "value", "unit", "source_id", "method", "external_id", "tz_offset_min"])
        XCTAssertEqual(r["external_id"] as? String, "hk-hourly:steps:2026-11-20T07:00:00.000Z")
        XCTAssertEqual(r["end"] as? String, "2026-11-20T08:00:00.000Z")
        XCTAssertEqual(r["unit"] as? String, "count")
    }

    func testWorkoutSessionShapeOmitsMissingDetailFields() throws {
        let uuid = UUID()
        let rec = Mapper.workoutSession(WorkoutSnapshot(uuid: uuid, start: t0, end: t0.addingTimeInterval(1800), type: "run",
                                                        distanceM: 5012.3, energyKcal: 320.5, avgHR: nil),
                                        sourceId: "s", timeZone: utc)!
        let obj = try json(rec)
        XCTAssertEqual(Set(obj.keys), ["kind", "session_kind", "start", "end", "source_id", "external_id", "tz_offset_min", "detail"])
        XCTAssertEqual(obj["kind"] as? String, "session")
        XCTAssertEqual(obj["session_kind"] as? String, "workout")
        XCTAssertEqual(obj["external_id"] as? String, uuid.uuidString)
        let d = obj["detail"] as! [String: Any]
        XCTAssertEqual(Set(d.keys), ["type", "distance_m", "energy_kcal"])
        XCTAssertEqual(d["distance_m"] as? Double, 5012.3)
    }

    func testWorkoutRejectsZeroLength() {
        XCTAssertNil(Mapper.workoutSession(WorkoutSnapshot(uuid: UUID(), start: t0, end: t0, type: "run"), sourceId: "s", timeZone: utc))
    }
}

final class SleepGroupingTests: XCTestCase {
    let utc = TimeZone(identifier: "UTC")!
    func at(_ s: String) -> Date { try! ISO.date(s) }

    func seg(_ a: String, _ b: String, _ stage: SleepStage, src: String = "com.apple.health.watch", uuid: UUID = UUID()) -> SleepSegment {
        SleepSegment(uuid: uuid, start: at(a), end: at(b), stage: stage, sourceKey: src)
    }

    func testSegmentsOfOneNightBecomeOneSessionWithStageMinutes() throws {
        let firstId = UUID()
        let segs = [
            seg("2026-11-19T23:00:00Z", "2026-11-20T00:00:00Z", .asleepCore, uuid: firstId),
            seg("2026-11-20T00:00:00Z", "2026-11-20T01:30:00Z", .asleepDeep),
            seg("2026-11-20T01:30:00Z", "2026-11-20T01:40:00Z", .awake),
            seg("2026-11-20T01:40:00Z", "2026-11-20T03:00:00Z", .asleepREM),
            // 45-minute gap still joins the same night
            seg("2026-11-20T03:45:00Z", "2026-11-20T06:00:00Z", .asleepCore),
        ]
        let out = Mapper.sleepSessions(segs.shuffled(), sourceId: "s", timeZone: utc)
        XCTAssertEqual(out.count, 1)
        guard case .session(let s) = out[0], case .sleep(let d) = s.detail else { return XCTFail() }
        XCTAssertEqual(s.start, at("2026-11-19T23:00:00Z"))
        XCTAssertEqual(s.end, at("2026-11-20T06:00:00Z"))
        XCTAssertEqual(s.externalId, firstId.uuidString)
        XCTAssertEqual(d, SleepStagesDetail(deepMin: 90, lightMin: 195, remMin: 80, awakeMin: 10, inBedMin: nil))
        let data = try IngestJSON.encoder().encode(out[0])
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(obj["session_kind"] as? String, "sleep")
        XCTAssertNil(obj["is_main"])
        XCTAssertEqual(Set((obj["detail"] as! [String: Any]).keys), ["deep_min", "light_min", "rem_min", "awake_min"])
    }

    func testDifferentWritersAndLongGapsAreSeparateSessions() {
        let segs = [
            seg("2026-11-19T23:00:00Z", "2026-11-20T06:00:00Z", .asleepCore),
            seg("2026-11-19T22:30:00Z", "2026-11-20T06:30:00Z", .inBed, src: "com.apple.Health"),
            seg("2026-11-20T14:00:00Z", "2026-11-20T14:30:00Z", .asleepUnspecified), // nap
        ]
        let out = Mapper.sleepSessions(segs, sourceId: "s", timeZone: utc)
        XCTAssertEqual(out.count, 3)
    }
}

final class CumulativeAndDerivedTests: XCTestCase {
    func at(_ s: String) -> Date { try! ISO.date(s) }

    func testAffectedHoursCoverEveryTouchedHourButNotTheExclusiveEnd() {
        let hours = Mapper.affectedHours([
            (at("2026-11-20T07:50:00Z"), at("2026-11-20T09:00:00Z")),
            (at("2026-11-20T12:10:00Z"), at("2026-11-20T12:10:00Z")),
        ])
        XCTAssertEqual(hours, [at("2026-11-20T07:00:00Z"), at("2026-11-20T08:00:00Z"), at("2026-11-20T12:00:00Z")])
    }

    func testHourlyBucketIdsAreStableSoResendsOverwrite() {
        let h = at("2026-11-20T07:00:00Z")
        let a = Mapper.hourlyBucket(metric: .activeEnergy, hourStart: h, total: 10, sourceId: "s", timeZone: .init(identifier: "UTC")!)
        let b = Mapper.hourlyBucket(metric: .activeEnergy, hourStart: h, total: 25, sourceId: "s", timeZone: .init(identifier: "UTC")!)
        guard case .sample(let x) = a, case .sample(let y) = b else { return XCTFail() }
        XCTAssertEqual(x.externalId, y.externalId)
        XCTAssertEqual(x.unit, "kcal")
    }

    func testWristTemperatureBecomesDeviationFromBaselineOnlyWithEnoughNights() {
        var history: [QuantitySnapshot] = []
        for i in 0..<6 {
            let start = at("2026-11-01T23:00:00Z").addingTimeInterval(Double(i) * 86400)
            history.append(QuantitySnapshot(uuid: UUID(), start: start, end: start.addingTimeInterval(7 * 3600), value: i == 5 ? 35.9 : 35.4))
        }
        let ids = Set(history.map(\.uuid))
        let out = Mapper.wristTemperatureDeviations(history: history, emitFor: ids, sourceId: "s", timeZone: .init(identifier: "UTC")!)
        XCTAssertEqual(out.count, 1) // only night 6 has five earlier nights
        guard case .sample(let s) = out[0] else { return XCTFail() }
        XCTAssertEqual(s.metric, .skinTempDeviation)
        XCTAssertEqual(s.method, .derived)
        XCTAssertEqual(s.unit, "degC")
        XCTAssertEqual(s.value, 0.5, accuracy: 1e-9)
        XCTAssertEqual(s.externalId, history[5].uuid.uuidString)
    }

    func testBatchesNeverExceed2000() {
        let b = Mapper.batches(Array(0..<4001))
        XCTAssertEqual(b.map(\.count), [2000, 2000, 1])
        XCTAssertEqual(Mapper.batches([Int]()).count, 0)
    }
}
