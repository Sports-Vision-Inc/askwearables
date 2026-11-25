import Foundation

/// Small non-secret settings and per-type status, kept in UserDefaults.
public final class SyncSettings: @unchecked Sendable {
    public static let statusChanged = Notification.Name("AskWearablesSyncStatusChanged")

    let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    /// Stable per-install id; the broker source id is "apple_health:<installId>".
    public var installId: String {
        if let id = defaults.string(forKey: "installId") { return id }
        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: "installId")
        return id
    }

    public var sourceId: String { "apple_health:\(installId)" }

    public var connectedAt: Date {
        if let d = defaults.object(forKey: "connectedAt") as? Date { return d }
        let d = Date()
        defaults.set(d, forKey: "connectedAt")
        return d
    }

    /// Which wearable mostly writes into Apple Health. The broker uses device_class for source priority.
    public var deviceClass: DeviceClass {
        get { defaults.string(forKey: "deviceClass").flatMap(DeviceClass.init(rawValue:)) ?? .watch }
        set { defaults.set(newValue.rawValue, forKey: "deviceClass") }
    }

    public var authorizationRequested: Bool {
        get { defaults.bool(forKey: "authorizationRequested") }
        set { defaults.set(newValue, forKey: "authorizationRequested") }
    }

    /// Set when a sync hit the locked store; cleared by the catch-up sync on next unlock.
    public var pendingCatchUp: Bool {
        get { defaults.bool(forKey: "pendingCatchUp") }
        set { defaults.set(newValue, forKey: "pendingCatchUp") }
    }

    public var baseURL: URL {
        get { defaults.string(forKey: "baseURL").flatMap(URL.init(string:)) ?? IngestClient.defaultBaseURL }
        set { defaults.set(newValue.absoluteString, forKey: "baseURL") }
    }

    public struct TypeStatus: Codable, Equatable, Sendable {
        public var lastSyncAt: Date?
        public var lastRecordsSent: Int = 0
        public var totalRecordsSent: Int = 0
        public var lastSamplesSeen: Int = 0
        public var everSawData: Bool = false
        /// HealthKit deletions observed. The ingest API has no delete call yet, so these are counted, not sent.
        public var deletionsNotForwarded: Int = 0
        public var lastError: String?

        public init() {}
    }

    public func status(for type: HealthDataType) -> TypeStatus {
        guard let data = defaults.data(forKey: "status.\(type.rawValue)"),
              let s = try? JSONDecoder().decode(TypeStatus.self, from: data) else { return TypeStatus() }
        return s
    }

    public func updateStatus(for type: HealthDataType, _ change: (inout TypeStatus) -> Void) {
        var s = status(for: type)
        change(&s)
        if let data = try? JSONEncoder().encode(s) { defaults.set(data, forKey: "status.\(type.rawValue)") }
        NotificationCenter.default.post(name: Self.statusChanged, object: nil)
    }
}
