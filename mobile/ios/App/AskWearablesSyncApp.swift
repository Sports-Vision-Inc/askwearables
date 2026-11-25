import SwiftUI
import UIKit
import AskWearablesKit

/// Shared objects. Built once, before HealthKit can deliver anything.
@MainActor
final class AppEnvironment {
    static let shared = AppEnvironment()

    let settings = SyncSettings()
    let tokens: TokenStore = KeychainTokenStore()
    let engine: HealthKitSyncEngine

    private init() {
        let tokens = self.tokens
        let anchorDir = (try? FileAnchorStore.defaultDirectory()) ?? FileManager.default.temporaryDirectory
        // If Application Support cannot be created the app still runs, with anchors in tmp (full re-sync after purge).
        let anchors: AnchorStore = (try? FileAnchorStore(directory: anchorDir))
            ?? (try! FileAnchorStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("anchors")))
        let client = IngestClient(baseURL: settings.baseURL, tokenProvider: { tokens.readToken() })
        engine = HealthKitSyncEngine(anchors: anchors, settings: settings, client: client, deviceModel: Self.machineIdentifier())
    }

    /// e.g. "iPhone16,2"
    static func machineIdentifier() -> String? {
        var info = utsname()
        uname(&info)
        let id = withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        return id.isEmpty ? nil : id
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let env = AppEnvironment.shared
        // Observer queries must exist before HealthKit delivers the update that launched us in the background.
        Task { await env.engine.startObservers() }

        // The HealthKit store is encrypted while the phone is locked. When a sync failed for that reason, catch up as
        // soon as protected data becomes available again (first unlock).
        NotificationCenter.default.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification,
                                               object: nil, queue: .main) { _ in
            Task { @MainActor in
                if env.settings.pendingCatchUp { await env.engine.syncAll() }
            }
        }
        return true
    }
}

@main
struct AskWearablesSyncApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = SyncViewModel(env: .shared)

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
        }
        .onChange(of: scenePhase) { _, phase in
            // Foreground is the most reliable trigger: the phone is unlocked and the store readable.
            if phase == .active { model.syncNow(onlyIfReady: true) }
        }
    }
}
