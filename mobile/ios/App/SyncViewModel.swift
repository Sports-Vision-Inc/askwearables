import Foundation
import SwiftUI
import AskWearablesKit

@MainActor
final class SyncViewModel: ObservableObject {
    struct Row: Identifiable {
        let type: HealthDataType
        let status: SyncSettings.TypeStatus
        var id: String { type.rawValue }
    }

    @Published private(set) var rows: [Row] = []
    @Published private(set) var hasToken = false
    @Published private(set) var authorizationRequested = false
    @Published private(set) var syncing = false
    @Published var message: String?
    @Published var deviceClass: DeviceClass {
        didSet { env.settings.deviceClass = deviceClass }
    }

    let env: AppEnvironment
    let healthAvailable = HealthKitSyncEngine.isHealthDataAvailable

    init(env: AppEnvironment) {
        self.env = env
        deviceClass = env.settings.deviceClass
        reload()
        NotificationCenter.default.addObserver(forName: SyncSettings.statusChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.reload() }
        }
    }

    var sourceId: String { env.settings.sourceId }
    var endpoint: String { env.settings.baseURL.appendingPathComponent("v1/ingest").absoluteString }

    func reload() {
        rows = HealthDataType.allCases.map { Row(type: $0, status: env.settings.status(for: $0)) }
        hasToken = !(env.tokens.readToken() ?? "").isEmpty
        authorizationRequested = env.settings.authorizationRequested
    }

    func connectAppleHealth() {
        Task {
            do {
                try await env.engine.requestAuthorization()
                await env.engine.startObservers()
                reload()
                syncNow(onlyIfReady: true)
            } catch {
                message = "Could not show the Health permission sheet: \(error.localizedDescription)"
            }
        }
    }

    func syncNow(onlyIfReady: Bool = false) {
        guard healthAvailable, authorizationRequested, hasToken else {
            if !onlyIfReady { message = hasToken ? "Connect Apple Health first." : "Paste your device sync token in Settings first." }
            return
        }
        guard !syncing else { return }
        syncing = true
        Task {
            await env.engine.syncAll()
            syncing = false
            reload()
        }
    }

    func saveToken(_ token: String) {
        do {
            try env.tokens.saveToken(token)
            message = "Token saved in the Keychain."
        } catch {
            message = "Could not save the token: \(error)"
        }
        reload()
    }

    func deleteToken() {
        try? env.tokens.deleteToken()
        reload()
    }

    func resyncEverything() {
        Task {
            do {
                try await env.engine.resetAnchors()
                syncNow()
            } catch {
                message = "Could not reset: \(error)"
            }
        }
    }
}
