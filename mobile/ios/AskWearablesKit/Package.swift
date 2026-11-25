// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "AskWearablesKit",
    // macOS is listed only so `swift test` can run the pure mapping, anchor and upload tests on a Mac.
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "AskWearablesKit", targets: ["AskWearablesKit"]),
    ],
    targets: [
        .target(name: "AskWearablesKit"),
        .testTarget(name: "AskWearablesKitTests", dependencies: ["AskWearablesKit"]),
    ]
)
