import Foundation
import Security

public protocol TokenStore: AnyObject, Sendable {
    func readToken() -> String?
    func saveToken(_ token: String) throws
    func deleteToken() throws
}

public struct KeychainError: Error, Equatable { public let status: OSStatus }

/// Stores the device sync token as a generic password. Accessible after first unlock (this device only) so that
/// HealthKit background deliveries can upload while the phone is locked again later.
public final class KeychainTokenStore: TokenStore, @unchecked Sendable {
    let service: String
    let account: String

    public init(service: String = "app.askwearables.sync", account: String = "device_sync_token") {
        self.service = service
        self.account = account
    }

    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    public func readToken() -> String? {
        var q = baseQuery
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func saveToken(_ token: String) throws {
        let data = Data(token.trimmingCharacters(in: .whitespacesAndNewlines).utf8)
        let attrs: [String: Any] = [kSecValueData as String: data,
                                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(baseQuery as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery
            add.merge(attrs) { $1 }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func deleteToken() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}

/// For tests and previews.
public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private var token: String?
    private let lock = NSLock()
    public init(_ token: String? = nil) { self.token = token }
    public func readToken() -> String? { lock.lock(); defer { lock.unlock() }; return token }
    public func saveToken(_ token: String) throws { lock.lock(); self.token = token; lock.unlock() }
    public func deleteToken() throws { lock.lock(); token = nil; lock.unlock() }
}
