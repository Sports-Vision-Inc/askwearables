import Foundation
#if canImport(HealthKit)
import HealthKit
#endif

/// Persists one opaque anchor per data type. The anchor for a type is written only after that type's delta has been
/// uploaded, so a crash or a failed upload re-sends the delta (the broker de-duplicates on external_id).
public protocol AnchorStore: AnyObject {
    func anchorData(for key: String) -> Data?
    func setAnchorData(_ data: Data?, for key: String) throws
    func allKeys() -> [String]
}

/// One file per data type under a directory (Application Support by default). Files use
/// completeUntilFirstUserAuthentication protection so background deliveries after the first unlock can read them.
public final class FileAnchorStore: AnchorStore {
    public let directory: URL
    private let lock = NSLock()

    public init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    public static func defaultDirectory() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return base.appendingPathComponent("AskWearables/anchors", isDirectory: true)
    }

    private func url(for key: String) -> URL {
        let safe = key.map { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" ? String($0) : "_" }.joined()
        return directory.appendingPathComponent("\(safe).anchor")
    }

    public func anchorData(for key: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        return try? Data(contentsOf: url(for: key))
    }

    public func setAnchorData(_ data: Data?, for key: String) throws {
        lock.lock(); defer { lock.unlock() }
        let u = url(for: key)
        guard let data else {
            try? FileManager.default.removeItem(at: u)
            return
        }
        #if os(iOS)
        try data.write(to: u, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: u, options: [.atomic])
        #endif
    }

    public func allKeys() -> [String] {
        lock.lock(); defer { lock.unlock() }
        let files = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return files.filter { $0.hasSuffix(".anchor") }.map { String($0.dropLast(".anchor".count)) }.sorted()
    }
}

#if canImport(HealthKit)
public enum AnchorCoding {
    public static func encode(_ anchor: HKQueryAnchor) throws -> Data {
        try NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true)
    }

    public static func decode(_ data: Data) -> HKQueryAnchor? {
        try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }
}

public extension AnchorStore {
    func anchor(for type: HealthDataType) -> HKQueryAnchor? {
        anchorData(for: type.rawValue).flatMap(AnchorCoding.decode)
    }

    func setAnchor(_ anchor: HKQueryAnchor?, for type: HealthDataType) throws {
        try setAnchorData(anchor.map(AnchorCoding.encode), for: type.rawValue)
    }
}
#endif
