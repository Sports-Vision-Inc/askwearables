import XCTest
@testable import AskWearablesKit
#if canImport(HealthKit)
import HealthKit
#endif

final class AnchorStoreTests: XCTestCase {
    var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("anchors-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testOneAnchorPerTypeSurvivesANewStoreInstance() throws {
        let a = try FileAnchorStore(directory: dir)
        try a.setAnchorData(Data([1, 2, 3]), for: "steps")
        try a.setAnchorData(Data([9]), for: "heart_rate")
        let b = try FileAnchorStore(directory: dir)
        XCTAssertEqual(b.anchorData(for: "steps"), Data([1, 2, 3]))
        XCTAssertEqual(b.anchorData(for: "heart_rate"), Data([9]))
        XCTAssertNil(b.anchorData(for: "sleep"))
        XCTAssertEqual(b.allKeys(), ["heart_rate", "steps"])
    }

    func testOverwriteAndClear() throws {
        let a = try FileAnchorStore(directory: dir)
        try a.setAnchorData(Data([1]), for: "steps")
        try a.setAnchorData(Data([2]), for: "steps")
        XCTAssertEqual(a.anchorData(for: "steps"), Data([2]))
        try a.setAnchorData(nil, for: "steps")
        XCTAssertNil(a.anchorData(for: "steps"))
        XCTAssertEqual(a.allKeys(), [])
    }

    #if canImport(HealthKit)
    func testHKQueryAnchorRoundTripsPerType() throws {
        let store = try FileAnchorStore(directory: dir)
        try store.setAnchor(HKQueryAnchor(fromValue: 42), for: .steps)
        try store.setAnchor(HKQueryAnchor(fromValue: 7), for: .sleepAnalysis)
        let reopened = try FileAnchorStore(directory: dir)
        XCTAssertEqual(reopened.anchor(for: .steps), HKQueryAnchor(fromValue: 42))
        XCTAssertEqual(reopened.anchor(for: .sleepAnalysis), HKQueryAnchor(fromValue: 7))
        XCTAssertNil(reopened.anchor(for: .workouts))
        XCTAssertEqual(Set(reopened.allKeys()), [HealthDataType.steps.rawValue, HealthDataType.sleepAnalysis.rawValue])
    }

    func testEveryTypeHasADistinctAnchorKey() {
        XCTAssertEqual(Set(HealthDataType.allCases.map(\.rawValue)).count, 12)
        XCTAssertEqual(HealthDataType.readTypes.count, 12)
    }
    #endif
}

#if canImport(HealthKit)
final class HKConversionTests: XCTestCase {
    let t0 = try! ISO.date("2026-11-20T03:00:00Z")

    func q(_ id: HKQuantityTypeIdentifier, _ value: Double, _ unit: HKUnit) -> HKQuantitySample {
        HKQuantitySample(type: HKQuantityType(id), quantity: HKQuantity(unit: unit, doubleValue: value), start: t0, end: t0.addingTimeInterval(60))
    }

    func testSpO2FractionBecomesPercent() {
        let s = HKConversion.quantity(q(.oxygenSaturation, 0.97, .percent()), as: .oxygenSaturation)!
        XCTAssertEqual(s.value, 97, accuracy: 1e-9)
    }

    func testHRVSecondsBecomeMilliseconds() {
        let s = HKConversion.quantity(q(.heartRateVariabilitySDNN, 0.045, .second()), as: .hrvSDNN)!
        XCTAssertEqual(s.value, 45, accuracy: 1e-9)
    }

    func testBodyMassPoundsBecomeKg() {
        let s = HKConversion.quantity(q(.bodyMass, 150, .pound()), as: .bodyMass)!
        XCTAssertEqual(s.value, 68.0388555, accuracy: 1e-6)
    }

    func testVO2MaxUnit() {
        let unit = HKUnit(from: "ml/kg*min")
        let s = HKConversion.quantity(q(.vo2Max, 48.2, unit), as: .vo2Max)!
        XCTAssertEqual(s.value, 48.2, accuracy: 1e-9)
    }

    func testHeartRateKeepsRecordUUIDAsExternalId() throws {
        let sample = q(.heartRate, 58, HKUnit.count().unitDivided(by: .minute()))
        let snap = HKConversion.quantity(sample, as: .heartRate)!
        let rec = Mapper.sample(snap, metric: .heartRate, method: .measured, sourceId: "s", timeZone: TimeZone(identifier: "UTC")!)
        guard case .sample(let s) = rec else { return XCTFail() }
        XCTAssertEqual(s.externalId, sample.uuid.uuidString)
        XCTAssertEqual(s.unit, "bpm")
        XCTAssertEqual(s.value, 58)
    }

    func testRestingHRIsVendorDaily() {
        XCTAssertEqual(HealthDataType.restingHeartRate.method, .vendorDaily)
        XCTAssertEqual(HealthDataType.heartRate.method, .measured)
    }

    func testSleepCategorySampleBecomesSegment() {
        let s = HKCategorySample(type: HKCategoryType(.sleepAnalysis), value: HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
                                 start: t0, end: t0.addingTimeInterval(1800))
        let seg = HKConversion.sleep(s)!
        XCTAssertEqual(seg.stage, .asleepDeep)
        XCTAssertEqual(seg.uuid, s.uuid)
    }

    func testWorkoutTypesMapToCatalogueList() {
        XCTAssertEqual(HKConversion.workoutType(.running), "run")
        XCTAssertEqual(HKConversion.workoutType(.traditionalStrengthTraining), "strength")
        XCTAssertEqual(HKConversion.workoutType(.highIntensityIntervalTraining), "hiit")
        XCTAssertEqual(HKConversion.workoutType(.tennis), "sport")
        XCTAssertEqual(HKConversion.workoutType(.curling), "other")
    }
}
#endif
