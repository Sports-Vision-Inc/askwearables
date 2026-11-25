import SwiftUI
import AskWearablesKit

struct ContentView: View {
    var body: some View {
        TabView {
            StatusView().tabItem { Label("Sync", systemImage: "arrow.triangle.2.circlepath") }
            SettingsView().tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}

struct StatusView: View {
    @EnvironmentObject var model: SyncViewModel

    var body: some View {
        NavigationStack {
            List {
                if !model.healthAvailable {
                    Section { Text("Apple Health is not available on this device.") }
                }
                Section {
                    if !model.hasToken {
                        Label("Paste your device sync token in Settings.", systemImage: "key")
                    }
                    if !model.authorizationRequested {
                        Button("Connect Apple Health") { model.connectAppleHealth() }
                    } else {
                        Button(model.syncing ? "Syncing…" : "Sync now") { model.syncNow() }
                            .disabled(model.syncing)
                    }
                } footer: {
                    Text("The app also syncs in the background when Apple Health has new data, typically within an hour. Apple Health cannot be read while the phone is locked, so data recorded then is sent after the next unlock.")
                }

                Section {
                    PermissionExplainer()
                }

                Section("Data types") {
                    ForEach(model.rows) { row in TypeRow(row: row) }
                }
            }
            .navigationTitle("AskWearables")
            .alert(model.message ?? "", isPresented: Binding(get: { model.message != nil }, set: { if !$0 { model.message = nil } })) {
                Button("OK", role: .cancel) {}
            }
        }
    }
}

/// HealthKit deliberately hides whether read access was denied: a denied type looks exactly like a type with no data.
struct PermissionExplainer: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Seeing “No data yet”?", systemImage: "questionmark.circle")
                .font(.headline)
            Text("For privacy, Apple Health never tells an app whether you said no to a data type. If you turned a type off, or if nothing has recorded it yet, this app sees the same thing: no data. It cannot tell the two apart.")
            Text("To check, open the Health app → your profile picture → Privacy → Apps → AskWearables Sync, and make sure the types you want to share are switched on.")
                .foregroundStyle(.secondary)
            if let url = URL(string: "x-apple-health://") {
                Link("Open the Health app", destination: url)
            }
        }
        .font(.subheadline)
        .padding(.vertical, 4)
    }
}

struct TypeRow: View {
    let row: SyncViewModel.Row

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(row.type.label)
            Group {
                if let at = row.status.lastSyncAt {
                    if row.status.everSawData {
                        Text("Last checked \(at.formatted(.relative(presentation: .named))) · \(row.status.totalRecordsSent) records sent")
                    } else {
                        Text("No data yet: either nothing has recorded it, or access is off in the Health app.")
                    }
                } else {
                    Text("Not synced yet")
                }
                if row.status.deletionsNotForwarded > 0 {
                    Text("\(row.status.deletionsNotForwarded) deletions in Apple Health are not yet forwarded")
                }
                if let err = row.status.lastError {
                    Text(err).foregroundStyle(.orange)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var model: SyncViewModel
    @State private var tokenField = ""
    @State private var confirmResync = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Paste device sync token", text: $tokenField)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Save token") {
                        model.saveToken(tokenField)
                        tokenField = ""
                    }
                    .disabled(tokenField.trimmingCharacters(in: .whitespaces).isEmpty)
                    if model.hasToken {
                        Button("Remove token", role: .destructive) { model.deleteToken() }
                    }
                } header: {
                    Text("Device sync token")
                } footer: {
                    Text(model.hasToken ? "A token is saved in this phone's Keychain." : "No token saved. Create one in the AskWearables dashboard.")
                }

                Section {
                    Picker("Main wearable", selection: $model.deviceClass) {
                        ForEach(DeviceClass.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                    }
                } footer: {
                    Text("What mostly writes to Apple Health on this phone. The broker uses it to choose between sources that report the same metric.")
                }

                Section("Connection") {
                    LabeledContent("Endpoint", value: model.endpoint)
                    LabeledContent("Source id", value: model.sourceId)
                }

                Section {
                    Button("Re-send all history") { confirmResync = true }
                } footer: {
                    Text("Clears the saved sync positions so everything is sent again. The broker ignores records it already has.")
                }
            }
            .navigationTitle("Settings")
            .confirmationDialog("Re-send all history?", isPresented: $confirmResync) {
                Button("Re-send") { model.resyncEverything() }
            }
        }
    }
}
