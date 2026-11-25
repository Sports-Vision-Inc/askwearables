import Foundation

// Pure mapping from platform-neutral snapshots to canonical records. HealthKit objects are converted to these
// snapshots in HealthKitConversion.swift; keeping this layer free of HealthKit makes it unit-testable anywhere.

/// One quantity sample already converted to the catalogue unit.
public struct QuantitySnapshot: Equatable, Sendable {
    public var uuid: UUID
    public var start: Date
    public var end: Date
    public var value: Double

    public init(uuid: UUID, start: Date, end: Date, value: Double) {
        self.uuid = uuid
        self.start = start
        self.end = end
        self.value = value
    }
}

/// Mirrors HKCategoryValueSleepAnalysis.
public enum SleepStage: Int, Sendable {
    case inBed = 0
    case asleepUnspecified = 1
    case awake = 2
    case asleepCore = 3
    case asleepDeep = 4
    case asleepREM = 5
}

public struct SleepSegment: Equatable, Sendable {
    public var uuid: UUID
    public var start: Date
    public var end: Date
    public var stage: SleepStage
    /// Segments are only merged with segments from the same writer (bundle id), so a phone's
    /// bedtime schedule and a watch's staged sleep do not fuse into one night.
    public var sourceKey: String

    public init(uuid: UUID, start: Date, end: Date, stage: SleepStage, sourceKey: String) {
        self.uuid = uuid
        self.start = start
        self.end = end
        self.stage = stage
        self.sourceKey = sourceKey
    }
}

public struct WorkoutSnapshot: Equatable, Sendable {
    public var uuid: UUID
    public var start: Date
    public var end: Date
    /// Already one of WORKOUT_TYPES.
    public var type: String
    public var distanceM: Double?
    public var energyKcal: Double?
    public var avgHR: Double?

    public init(uuid: UUID, start: Date, end: Date, type: String, distanceM: Double? = nil, energyKcal: Double? = nil, avgHR: Double? = nil) {
        self.uuid = uuid
        self.start = start
        self.end = end
        self.type = type
        self.distanceM = distanceM
        self.energyKcal = energyKcal
        self.avgHR = avgHR
    }
}

public enum Mapper {
    /// Minutes east of UTC on this device's clock at `date`.
    public static func tzOffsetMin(at date: Date, timeZone: TimeZone) -> Int {
        timeZone.secondsFromGMT(for: date) / 60
    }

    public static func sample(_ s: QuantitySnapshot, metric: MetricId, method: Method, sourceId: String, timeZone: TimeZone) -> CanonicalRecord {
        .sample(CanonicalSample(metric: metric, start: s.start, end: s.end, value: s.value, unit: metric.catalogueUnit,
                                sourceId: sourceId, method: method, externalId: s.uuid.uuidString,
                                tzOffsetMin: tzOffsetMin(at: s.start, timeZone: timeZone)))
    }

    // MARK: cumulative types (steps, active energy)

    /// HealthKit keeps one sample per writer, so iPhone and Apple Watch both record the same steps. The app therefore
    /// sends hourly totals from HKStatisticsCollectionQuery, which de-duplicates across sources the same way the Health
    /// app does. Each bucket has a deterministic id, so a later re-send overwrites the earlier total on the broker.
    public static func hourlyExternalId(metric: MetricId, hourStart: Date) -> String {
        "hk-hourly:\(metric.rawValue):\(ISO.string(hourStart))"
    }

    public static func hourFloor(_ d: Date) -> Date {
        Date(timeIntervalSince1970: (d.timeIntervalSince1970 / 3600).rounded(.down) * 3600)
    }

    /// Every UTC hour touched by any of the given intervals.
    public static func affectedHours(_ intervals: [(Date, Date)]) -> [Date] {
        var hours = Set<Date>()
        for (start, end) in intervals {
            var h = hourFloor(start)
            let last = hourFloor(end == start ? end : end.addingTimeInterval(-0.001))
            while h <= last {
                hours.insert(h)
                h = h.addingTimeInterval(3600)
            }
        }
        return hours.sorted()
    }

    public static func hourlyBucket(metric: MetricId, hourStart: Date, total: Double, sourceId: String, timeZone: TimeZone) -> CanonicalRecord {
        .sample(CanonicalSample(metric: metric, start: hourStart, end: hourStart.addingTimeInterval(3600), value: total,
                                unit: metric.catalogueUnit, sourceId: sourceId, method: .measured,
                                externalId: hourlyExternalId(metric: metric, hourStart: hourStart),
                                tzOffsetMin: tzOffsetMin(at: hourStart, timeZone: timeZone)))
    }

    // MARK: sleep

    /// Group sleep segments into nights: same writer, sorted by start, merged when the gap is at most `maxGap`.
    /// external_id is the UUID of the night's earliest segment.
    public static func sleepSessions(_ segments: [SleepSegment], sourceId: String, timeZone: TimeZone,
                                     maxGap: TimeInterval = 60 * 60) -> [CanonicalRecord] {
        let bySource = Dictionary(grouping: segments, by: \.sourceKey)
        var out: [(Date, CanonicalRecord)] = []
        for key in bySource.keys.sorted() {
            let sorted = bySource[key]!.sorted { ($0.start, $0.uuid.uuidString) < ($1.start, $1.uuid.uuidString) }
            var group: [SleepSegment] = []
            var groupEnd = Date.distantPast
            func flush() {
                guard let first = group.first else { return }
                let end = group.map(\.end).max()!
                if end > first.start, end.timeIntervalSince(first.start) <= 36 * 3600 {
                    let rec = CanonicalRecord.session(CanonicalSession(
                        start: first.start, end: end, sourceId: sourceId, externalId: first.uuid.uuidString,
                        tzOffsetMin: tzOffsetMin(at: first.start, timeZone: timeZone), detail: .sleep(stageDetail(group))))
                    out.append((first.start, rec))
                }
                group = []
            }
            for seg in sorted {
                if !group.isEmpty && seg.start.timeIntervalSince(groupEnd) > maxGap { flush() }
                if group.isEmpty { groupEnd = seg.end } else { groupEnd = max(groupEnd, seg.end) }
                group.append(seg)
            }
            flush()
        }
        return out.sorted { $0.0 < $1.0 }.map(\.1)
    }

    static func stageDetail(_ group: [SleepSegment]) -> SleepStagesDetail {
        var minutes: [SleepStage: Double] = [:]
        for s in group { minutes[s.stage, default: 0] += s.end.timeIntervalSince(s.start) / 60 }
        func r(_ x: Double?) -> Double? { x.map { ($0 * 10).rounded() / 10 } }
        // "Core" is Apple's name for light sleep. Unspecified asleep time counts toward the session but not a stage.
        return SleepStagesDetail(deepMin: r(minutes[.asleepDeep]), lightMin: r(minutes[.asleepCore]), remMin: r(minutes[.asleepREM]),
                                 awakeMin: r(minutes[.awake]), inBedMin: r(minutes[.inBed]))
    }

    // MARK: workouts

    public static func workoutSession(_ w: WorkoutSnapshot, sourceId: String, timeZone: TimeZone) -> CanonicalRecord? {
        guard w.end > w.start, w.end.timeIntervalSince(w.start) <= 36 * 3600 else { return nil }
        return .session(CanonicalSession(start: w.start, end: w.end, sourceId: sourceId, externalId: w.uuid.uuidString,
                                         tzOffsetMin: tzOffsetMin(at: w.start, timeZone: timeZone),
                                         detail: .workout(WorkoutDetail(type: w.type, distanceM: w.distanceM, energyKcal: w.energyKcal, avgHR: w.avgHR))))
    }

    // MARK: wrist temperature

    /// HealthKit stores absolute sleeping wrist temperature (about 35 degC); the broker's metric is the deviation from the
    /// person's baseline, like the Health app shows. Baseline = mean of up to `window` earlier nights, needing at least
    /// `minNights` (the Health app waits for about five). Nights without enough history are skipped, not guessed.
    public static func wristTemperatureDeviations(history: [QuantitySnapshot], emitFor: Set<UUID>, sourceId: String, timeZone: TimeZone,
                                                  minNights: Int = 5, window: Int = 30) -> [CanonicalRecord] {
        let sorted = history.sorted { $0.start < $1.start }
        var out: [CanonicalRecord] = []
        for (i, night) in sorted.enumerated() where emitFor.contains(night.uuid) {
            let prior = sorted[..<i].suffix(window)
            guard prior.count >= minNights else { continue }
            let baseline = prior.map(\.value).reduce(0, +) / Double(prior.count)
            let dev = ((night.value - baseline) * 1000).rounded() / 1000
            out.append(.sample(CanonicalSample(metric: .skinTempDeviation, start: night.start, end: night.end, value: dev, unit: "degC",
                                               sourceId: sourceId, method: .derived, externalId: night.uuid.uuidString,
                                               tzOffsetMin: tzOffsetMin(at: night.start, timeZone: timeZone))))
        }
        return out
    }

    // MARK: batching

    public static let maxBatch = 2000

    public static func batches<T>(_ items: [T], size: Int = maxBatch) -> [[T]] {
        precondition(size > 0)
        return stride(from: 0, to: items.count, by: size).map { Array(items[$0..<min($0 + size, items.count)]) }
    }
}
