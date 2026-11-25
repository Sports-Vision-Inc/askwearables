#if canImport(HealthKit)
import Foundation
import HealthKit

/// Observer query per type (with background delivery) signals a change; an anchored object query per type fetches the
/// delta from that type's persisted anchor; the delta is mapped, uploaded, and only then is the new anchor saved.
public actor HealthKitSyncEngine {
    public let healthStore: HKHealthStore
    let anchors: AnchorStore
    let settings: SyncSettings
    let client: IngestClient
    let timeZone: @Sendable () -> TimeZone
    let deviceModel: String?
    /// Page size for anchored queries; each page is uploaded and its anchor saved before the next.
    let pageLimit: Int

    private var running: Set<HealthDataType> = []
    private var observersStarted = false

    public init(healthStore: HKHealthStore = HKHealthStore(), anchors: AnchorStore, settings: SyncSettings, client: IngestClient,
                deviceModel: String?, timeZone: @escaping @Sendable () -> TimeZone = { TimeZone.current }, pageLimit: Int = 5000) {
        self.healthStore = healthStore
        self.anchors = anchors
        self.settings = settings
        self.client = client
        self.deviceModel = deviceModel
        self.timeZone = timeZone
        self.pageLimit = pageLimit
    }

    public static var isHealthDataAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    // MARK: authorization

    /// Shows the per-type read sheet. HealthKit never reveals whether read access was granted: a denied type simply
    /// looks empty. The app can only tell whether the sheet has been shown.
    public func requestAuthorization() async throws {
        try await healthStore.requestAuthorization(toShare: [], read: HealthDataType.readTypes)
        settings.authorizationRequested = true
    }

    /// true when the system would show the sheet again (new types added, or never asked).
    public func shouldRequestAuthorization() async -> Bool {
        let status = try? await healthStore.statusForAuthorizationRequest(toShare: [], read: HealthDataType.readTypes)
        return status != .unnecessary
    }

    // MARK: observers

    /// Call from application(_:didFinishLaunchingWithOptions:) so queries exist before HealthKit delivers updates.
    public func startObservers() {
        guard !observersStarted, Self.isHealthDataAvailable, settings.authorizationRequested else { return }
        observersStarted = true
        for type in HealthDataType.allCases {
            let query = HKObserverQuery(sampleType: type.sampleType, predicate: nil) { [weak self] _, completion, error in
                guard let self else { completion(); return }
                if error != nil { completion(); return }
                Task {
                    await self.syncCatchingLock(type)
                    // Always call the completion handler: three misses and HealthKit stops waking the app.
                    completion()
                }
            }
            healthStore.execute(query)
            // iOS caps most types at hourly regardless of the requested frequency.
            healthStore.enableBackgroundDelivery(for: type.sampleType, frequency: .immediate) { [weak self] ok, error in
                guard let self, !ok else { return }
                Task { await self.recordError(type, "background delivery not enabled: \(error?.localizedDescription ?? "unknown")") }
            }
        }
    }

    // MARK: sync

    /// Sync every type. Used on launch, on foreground, on "Sync now" and on the first unlock after a locked failure.
    public func syncAll() async {
        settings.pendingCatchUp = false
        await withTaskGroup(of: Void.self) { group in
            for type in HealthDataType.allCases {
                group.addTask { await self.syncCatchingLock(type) }
            }
        }
    }

    func syncCatchingLock(_ type: HealthDataType) async {
        do {
            _ = try await sync(type)
        } catch let e as HKError where e.code == .errorDatabaseInaccessible {
            // The store is encrypted while the phone is locked. Remember to catch up on the next unlock.
            settings.pendingCatchUp = true
            recordError(type, "Phone was locked; will catch up after the next unlock.")
        } catch {
            recordError(type, String(describing: error))
        }
    }

    private func recordError(_ type: HealthDataType, _ message: String) {
        settings.updateStatus(for: type) { $0.lastError = message }
    }

    /// Fetch, map and upload the delta for one type. Returns the number of records sent.
    @discardableResult
    public func sync(_ type: HealthDataType) async throws -> Int {
        guard !running.contains(type) else { return 0 }
        running.insert(type)
        defer { running.remove(type) }

        var sent = 0
        while true {
            let (added, deleted, newAnchor) = try await anchoredQuery(type: type.sampleType, anchor: anchors.anchor(for: type), limit: pageLimit)
            let records = try await buildRecords(type, added: added)
            if !records.isEmpty {
                try await client.upload(source: await currentSource(), records: records)
            }
            if let newAnchor { try anchors.setAnchor(newAnchor, for: type) }
            sent += records.count
            let addedCount = added.count, recordCount = records.count, deletedCount = deleted.count
            settings.updateStatus(for: type) {
                $0.lastSyncAt = Date()
                $0.lastSamplesSeen = addedCount
                $0.lastRecordsSent = recordCount
                $0.totalRecordsSent += recordCount
                $0.everSawData = $0.everSawData || addedCount > 0
                $0.deletionsNotForwarded += deletedCount
                $0.lastError = nil
            }
            if added.count + deleted.count < pageLimit { break }
        }
        return sent
    }

    public func currentSource() async -> Source {
        let earliest = healthStore.earliestPermittedSampleDate()
        return Source(id: settings.sourceId, provider: "apple_health", deviceModel: deviceModel, deviceClass: settings.deviceClass,
                      connectedAt: settings.connectedAt, earliestReadable: ISO.day(earliest, timeZone: timeZone()),
                      lastSyncAt: Date(), termsFlags: TermsFlags())
    }

    /// Clear every anchor so the next sync re-sends all history (the broker de-duplicates on external_id).
    public func resetAnchors() throws {
        for type in HealthDataType.allCases { try anchors.setAnchor(nil, for: type) }
    }

    // MARK: mapping a delta

    func buildRecords(_ type: HealthDataType, added: [HKSample]) async throws -> [CanonicalRecord] {
        guard !added.isEmpty else { return [] }
        let tz = timeZone()
        let sourceId = settings.sourceId
        switch type {
        case .sleepAnalysis:
            let addedSegs = added.compactMap { ($0 as? HKCategorySample).flatMap(HKConversion.sleep) }
            guard let lo = addedSegs.map(\.start).min(), let hi = addedSegs.map(\.end).max() else { return [] }
            // Re-read the surrounding nights so a new segment is merged with its neighbours into one session.
            let around = try await samples(type: type.sampleType, from: lo.addingTimeInterval(-18 * 3600), to: hi.addingTimeInterval(18 * 3600))
            let segs = around.compactMap { ($0 as? HKCategorySample).flatMap(HKConversion.sleep) }
            return Mapper.sleepSessions(segs, sourceId: sourceId, timeZone: tz).filter { rec in
                guard case .session(let s) = rec else { return false }
                return addedSegs.contains { $0.start < s.end && $0.end > s.start }
            }

        case .workouts:
            return added.compactMap { ($0 as? HKWorkout).map(HKConversion.workout) }
                .compactMap { Mapper.workoutSession($0, sourceId: sourceId, timeZone: tz) }

        case .steps, .activeEnergy:
            let metric = type.metric!
            let hours = Mapper.affectedHours(added.map { ($0.startDate, $0.endDate) })
            guard let first = hours.first, let last = hours.last else { return [] }
            let totals = try await hourlyTotals(type: type, from: first, to: last.addingTimeInterval(3600))
            return hours.map { Mapper.hourlyBucket(metric: metric, hourStart: $0, total: totals[$0] ?? 0, sourceId: sourceId, timeZone: tz) }

        case .wristTemperature:
            let addedSnaps = added.compactMap { ($0 as? HKQuantitySample).flatMap { HKConversion.quantity($0, as: type) } }
            guard let lo = addedSnaps.map(\.start).min(), let hi = addedSnaps.map(\.end).max() else { return [] }
            let history = try await samples(type: type.sampleType, from: lo.addingTimeInterval(-60 * 86400), to: hi)
                .compactMap { ($0 as? HKQuantitySample).flatMap { HKConversion.quantity($0, as: type) } }
            return Mapper.wristTemperatureDeviations(history: history, emitFor: Set(addedSnaps.map(\.uuid)), sourceId: sourceId, timeZone: tz)

        default:
            let metric = type.metric!
            return added.compactMap { ($0 as? HKQuantitySample).flatMap { HKConversion.quantity($0, as: type) } }
                .map { Mapper.sample($0, metric: metric, method: type.method, sourceId: sourceId, timeZone: tz) }
        }
    }

    // MARK: HealthKit query wrappers

    func anchoredQuery(type: HKSampleType, anchor: HKQueryAnchor?, limit: Int) async throws -> ([HKSample], [HKDeletedObject], HKQueryAnchor?) {
        try await withCheckedThrowingContinuation { cont in
            let q = HKAnchoredObjectQuery(type: type, predicate: nil, anchor: anchor, limit: limit) { _, added, deleted, newAnchor, error in
                if let error { cont.resume(throwing: error); return }
                cont.resume(returning: (added ?? [], deleted ?? [], newAnchor))
            }
            healthStore.execute(q)
        }
    }

    func samples(type: HKSampleType, from: Date, to: Date) async throws -> [HKSample] {
        try await withCheckedThrowingContinuation { cont in
            let pred = HKQuery.predicateForSamples(withStart: from, end: to, options: [])
            let sort = [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]
            let q = HKSampleQuery(sampleType: type, predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: sort) { _, results, error in
                if let error { cont.resume(throwing: error); return }
                cont.resume(returning: results ?? [])
            }
            healthStore.execute(q)
        }
    }

    /// Hourly cumulative sums, de-duplicated across sources by HealthKit.
    func hourlyTotals(type: HealthDataType, from: Date, to: Date) async throws -> [Date: Double] {
        guard let qtype = type.sampleType as? HKQuantityType, let (unit, factor) = type.readUnit else { return [:] }
        return try await withCheckedThrowingContinuation { cont in
            let pred = HKQuery.predicateForSamples(withStart: from, end: to, options: [])
            let q = HKStatisticsCollectionQuery(quantityType: qtype, quantitySamplePredicate: pred, options: .cumulativeSum,
                                                anchorDate: from, intervalComponents: DateComponents(hour: 1))
            q.initialResultsHandler = { _, collection, error in
                if let error { cont.resume(throwing: error); return }
                var out: [Date: Double] = [:]
                collection?.enumerateStatistics(from: from, to: to) { stats, _ in
                    if let sum = stats.sumQuantity() { out[Mapper.hourFloor(stats.startDate)] = sum.doubleValue(for: unit) * factor }
                }
                cont.resume(returning: out)
            }
            healthStore.execute(q)
        }
    }
}
#endif
