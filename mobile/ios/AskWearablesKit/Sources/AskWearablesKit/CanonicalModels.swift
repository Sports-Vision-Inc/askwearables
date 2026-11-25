import Foundation

// Swift mirrors of packages/core/src/types.ts. Each type encodes to exactly the JSON shape the broker's
// ingest endpoint expects: snake_case keys, ISO-8601 UTC timestamps, optional fields omitted when nil,
// and the nullable Source fields written as explicit JSON null.

/// MetricId values this app sends. Raw values must match packages/core/src/types.ts.
public enum MetricId: String, Codable, CaseIterable, Sendable {
    case steps
    case activeEnergy = "active_energy"
    case restingHR = "resting_hr"
    case heartRate = "heart_rate"
    case hrvSDNN = "hrv_sdnn"
    case spo2
    case respiratoryRate = "respiratory_rate"
    case skinTempDeviation = "skin_temp_deviation"
    case vo2max
    case weight

    /// The catalogue unit (packages/core/src/catalogue.ts). The app always converts to this unit on device.
    public var catalogueUnit: String {
        switch self {
        case .steps: return "count"
        case .activeEnergy: return "kcal"
        case .restingHR, .heartRate: return "bpm"
        case .hrvSDNN: return "ms"
        case .spo2: return "percent"
        case .respiratoryRate: return "breaths/min"
        case .skinTempDeviation: return "degC"
        case .vo2max: return "ml/kg/min"
        case .weight: return "kg"
        }
    }
}

public enum DeviceClass: String, Codable, CaseIterable, Sendable {
    case watch, ring, band, phone, scale, cgm, other
}

public enum Method: String, Codable, Sendable {
    case measured
    case vendorDaily = "vendor_daily"
    case derived
    case manual
}

public struct TermsFlags: Codable, Equatable, Sendable {
    public var noAI: Bool?
    public var noIntermediary: Bool?
    public var displayToUserOnly: Bool?

    public init(noAI: Bool? = nil, noIntermediary: Bool? = nil, displayToUserOnly: Bool? = nil) {
        self.noAI = noAI
        self.noIntermediary = noIntermediary
        self.displayToUserOnly = displayToUserOnly
    }

    enum CodingKeys: String, CodingKey {
        case noAI = "no_ai"
        case noIntermediary = "no_intermediary"
        case displayToUserOnly = "display_to_user_only"
    }
}

public struct Source: Codable, Equatable, Sendable {
    public var id: String
    public var provider: String
    public var deviceModel: String?
    public var deviceClass: DeviceClass
    /// ISO UTC
    public var connectedAt: Date
    /// YYYY-MM-DD
    public var earliestReadable: String?
    public var lastSyncAt: Date?
    public var termsFlags: TermsFlags

    public init(id: String, provider: String, deviceModel: String?, deviceClass: DeviceClass, connectedAt: Date,
                earliestReadable: String?, lastSyncAt: Date?, termsFlags: TermsFlags = TermsFlags()) {
        self.id = id
        self.provider = provider
        self.deviceModel = deviceModel
        self.deviceClass = deviceClass
        self.connectedAt = connectedAt
        self.earliestReadable = earliestReadable
        self.lastSyncAt = lastSyncAt
        self.termsFlags = termsFlags
    }

    enum CodingKeys: String, CodingKey {
        case id, provider
        case deviceModel = "device_model"
        case deviceClass = "device_class"
        case connectedAt = "connected_at"
        case earliestReadable = "earliest_readable"
        case lastSyncAt = "last_sync_at"
        case termsFlags = "terms_flags"
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(provider, forKey: .provider)
        // `string | null` in TypeScript: always present, null when unknown.
        if let deviceModel { try c.encode(deviceModel, forKey: .deviceModel) } else { try c.encodeNil(forKey: .deviceModel) }
        try c.encode(deviceClass, forKey: .deviceClass)
        try c.encode(ISO.string(connectedAt), forKey: .connectedAt)
        if let earliestReadable { try c.encode(earliestReadable, forKey: .earliestReadable) } else { try c.encodeNil(forKey: .earliestReadable) }
        if let lastSyncAt { try c.encode(ISO.string(lastSyncAt), forKey: .lastSyncAt) } else { try c.encodeNil(forKey: .lastSyncAt) }
        try c.encode(termsFlags, forKey: .termsFlags)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        provider = try c.decode(String.self, forKey: .provider)
        deviceModel = try c.decodeIfPresent(String.self, forKey: .deviceModel)
        deviceClass = try c.decode(DeviceClass.self, forKey: .deviceClass)
        connectedAt = try ISO.date(c.decode(String.self, forKey: .connectedAt))
        earliestReadable = try c.decodeIfPresent(String.self, forKey: .earliestReadable)
        lastSyncAt = try c.decodeIfPresent(String.self, forKey: .lastSyncAt).map(ISO.date)
        termsFlags = try c.decode(TermsFlags.self, forKey: .termsFlags)
    }
}

public struct CanonicalSample: Equatable, Sendable {
    public var metric: MetricId
    public var start: Date
    public var end: Date
    public var value: Double
    public var unit: String
    public var sourceId: String
    public var method: Method
    public var externalId: String?
    /// Minutes east of UTC at the sample's start.
    public var tzOffsetMin: Int

    public init(metric: MetricId, start: Date, end: Date, value: Double, unit: String, sourceId: String,
                method: Method, externalId: String?, tzOffsetMin: Int) {
        self.metric = metric
        self.start = start
        self.end = end
        self.value = value
        self.unit = unit
        self.sourceId = sourceId
        self.method = method
        self.externalId = externalId
        self.tzOffsetMin = tzOffsetMin
    }
}

public struct SleepStagesDetail: Codable, Equatable, Sendable {
    public var deepMin: Double?
    public var lightMin: Double?
    public var remMin: Double?
    public var awakeMin: Double?
    public var inBedMin: Double?

    public init(deepMin: Double? = nil, lightMin: Double? = nil, remMin: Double? = nil, awakeMin: Double? = nil, inBedMin: Double? = nil) {
        self.deepMin = deepMin
        self.lightMin = lightMin
        self.remMin = remMin
        self.awakeMin = awakeMin
        self.inBedMin = inBedMin
    }

    enum CodingKeys: String, CodingKey {
        case deepMin = "deep_min"
        case lightMin = "light_min"
        case remMin = "rem_min"
        case awakeMin = "awake_min"
        case inBedMin = "in_bed_min"
    }
}

public struct WorkoutDetail: Codable, Equatable, Sendable {
    /// One of WORKOUT_TYPES in catalogue.ts.
    public var type: String
    public var load: Double?
    public var distanceM: Double?
    public var energyKcal: Double?
    public var avgHR: Double?
    public var title: String?
    public var notes: String?

    public init(type: String, load: Double? = nil, distanceM: Double? = nil, energyKcal: Double? = nil, avgHR: Double? = nil,
                title: String? = nil, notes: String? = nil) {
        self.type = type
        self.load = load
        self.distanceM = distanceM
        self.energyKcal = energyKcal
        self.avgHR = avgHR
        self.title = title
        self.notes = notes
    }

    enum CodingKeys: String, CodingKey {
        case type, load
        case distanceM = "distance_m"
        case energyKcal = "energy_kcal"
        case avgHR = "avg_hr"
        case title, notes
    }
}

public enum SessionDetail: Equatable, Sendable {
    case sleep(SleepStagesDetail)
    case workout(WorkoutDetail)
}

public struct CanonicalSession: Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case sleep, workout }

    public var sessionKind: Kind
    public var start: Date
    public var end: Date
    public var sourceId: String
    public var externalId: String?
    public var tzOffsetMin: Int
    public var isMain: Bool?
    public var detail: SessionDetail

    public init(start: Date, end: Date, sourceId: String, externalId: String?, tzOffsetMin: Int, isMain: Bool? = nil, detail: SessionDetail) {
        switch detail {
        case .sleep: sessionKind = .sleep
        case .workout: sessionKind = .workout
        }
        self.start = start
        self.end = end
        self.sourceId = sourceId
        self.externalId = externalId
        self.tzOffsetMin = tzOffsetMin
        self.isMain = isMain
        self.detail = detail
    }
}

/// CanonicalRecord = CanonicalSample | CanonicalSession (vendor scores are never produced by HealthKit).
public enum CanonicalRecord: Encodable, Equatable, Sendable {
    case sample(CanonicalSample)
    case session(CanonicalSession)

    enum Keys: String, CodingKey {
        case kind, metric, start, end, value, unit
        case sourceId = "source_id"
        case method
        case externalId = "external_id"
        case tzOffsetMin = "tz_offset_min"
        case sessionKind = "session_kind"
        case isMain = "is_main"
        case detail
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .sample(let s):
            try c.encode("sample", forKey: .kind)
            try c.encode(s.metric, forKey: .metric)
            try c.encode(ISO.string(s.start), forKey: .start)
            try c.encode(ISO.string(s.end), forKey: .end)
            try c.encode(s.value, forKey: .value)
            try c.encode(s.unit, forKey: .unit)
            try c.encode(s.sourceId, forKey: .sourceId)
            try c.encode(s.method, forKey: .method)
            try c.encodeIfPresent(s.externalId, forKey: .externalId)
            try c.encode(s.tzOffsetMin, forKey: .tzOffsetMin)
        case .session(let s):
            try c.encode("session", forKey: .kind)
            try c.encode(s.sessionKind, forKey: .sessionKind)
            try c.encode(ISO.string(s.start), forKey: .start)
            try c.encode(ISO.string(s.end), forKey: .end)
            try c.encode(s.sourceId, forKey: .sourceId)
            try c.encodeIfPresent(s.externalId, forKey: .externalId)
            try c.encode(s.tzOffsetMin, forKey: .tzOffsetMin)
            try c.encodeIfPresent(s.isMain, forKey: .isMain)
            switch s.detail {
            case .sleep(let d): try c.encode(d, forKey: .detail)
            case .workout(let d): try c.encode(d, forKey: .detail)
            }
        }
    }
}

/// Body of POST /v1/ingest.
public struct IngestBody: Encodable, Sendable {
    public var source: Source
    public var records: [CanonicalRecord]

    public init(source: Source, records: [CanonicalRecord]) {
        self.source = source
        self.records = records
    }
}

public enum IngestJSON {
    /// Sorted keys make bodies byte-stable, which keeps tests simple and retries identical.
    public static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }
}

/// ISO-8601 in UTC with milliseconds, the same form as JavaScript's Date.prototype.toISOString().
public enum ISO {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    private static let lock = NSLock()

    public static func string(_ date: Date) -> String {
        lock.lock(); defer { lock.unlock() }
        return withFraction.string(from: date)
    }

    public static func date(_ s: String) throws -> Date {
        lock.lock(); defer { lock.unlock() }
        if let d = withFraction.date(from: s) ?? plain.date(from: s) { return d }
        throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "bad ISO date \(s)"))
    }

    /// YYYY-MM-DD of `date` in `timeZone`.
    public static func day(_ date: Date, timeZone: TimeZone) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let c = cal.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }
}
