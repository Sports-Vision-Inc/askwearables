import Foundation
#if canImport(HealthKit)
import HealthKit
#endif

/// The twelve HealthKit types the app reads. Each has its own permission row, observer query and persisted anchor.
public enum HealthDataType: String, CaseIterable, Sendable {
    case steps
    case activeEnergy = "active_energy"
    case heartRate = "heart_rate"
    case restingHeartRate = "resting_hr"
    case hrvSDNN = "hrv_sdnn"
    case oxygenSaturation = "spo2"
    case respiratoryRate = "respiratory_rate"
    case vo2Max = "vo2max"
    case bodyMass = "weight"
    case sleepAnalysis = "sleep"
    case workouts = "workout"
    case wristTemperature = "wrist_temperature"

    public var label: String {
        switch self {
        case .steps: return "Steps"
        case .activeEnergy: return "Active energy"
        case .heartRate: return "Heart rate"
        case .restingHeartRate: return "Resting heart rate"
        case .hrvSDNN: return "Heart rate variability (SDNN)"
        case .oxygenSaturation: return "Blood oxygen"
        case .respiratoryRate: return "Respiratory rate"
        case .vo2Max: return "VO2 max"
        case .bodyMass: return "Weight"
        case .sleepAnalysis: return "Sleep"
        case .workouts: return "Workouts"
        case .wristTemperature: return "Sleeping wrist temperature"
        }
    }

    /// The broker metric for quantity types; nil for sleep and workouts, which become sessions.
    public var metric: MetricId? {
        switch self {
        case .steps: return .steps
        case .activeEnergy: return .activeEnergy
        case .heartRate: return .heartRate
        case .restingHeartRate: return .restingHR
        case .hrvSDNN: return .hrvSDNN
        case .oxygenSaturation: return .spo2
        case .respiratoryRate: return .respiratoryRate
        case .vo2Max: return .vo2max
        case .bodyMass: return .weight
        case .wristTemperature: return .skinTempDeviation
        case .sleepAnalysis, .workouts: return nil
        }
    }

    /// Cumulative types are sent as de-duplicated hourly totals rather than raw samples.
    public var isCumulative: Bool { self == .steps || self == .activeEnergy }

    /// Resting HR is Apple's own daily estimate, not a single measurement.
    public var method: Method { self == .restingHeartRate ? .vendorDaily : .measured }
}

#if canImport(HealthKit)
public extension HealthDataType {
    var quantityIdentifier: HKQuantityTypeIdentifier? {
        switch self {
        case .steps: return .stepCount
        case .activeEnergy: return .activeEnergyBurned
        case .heartRate: return .heartRate
        case .restingHeartRate: return .restingHeartRate
        case .hrvSDNN: return .heartRateVariabilitySDNN
        case .oxygenSaturation: return .oxygenSaturation
        case .respiratoryRate: return .respiratoryRate
        case .vo2Max: return .vo2Max
        case .bodyMass: return .bodyMass
        case .wristTemperature: return .appleSleepingWristTemperature
        case .sleepAnalysis, .workouts: return nil
        }
    }

    var sampleType: HKSampleType {
        switch self {
        case .sleepAnalysis: return HKCategoryType(.sleepAnalysis)
        case .workouts: return HKWorkoutType.workoutType()
        default: return HKQuantityType(quantityIdentifier!)
        }
    }

    /// The unit HealthKit values are read in, and the factor taking them to the catalogue unit.
    var readUnit: (HKUnit, Double)? {
        switch self {
        case .steps: return (.count(), 1)
        case .activeEnergy: return (.kilocalorie(), 1)
        case .heartRate, .restingHeartRate: return (HKUnit.count().unitDivided(by: .minute()), 1)
        case .hrvSDNN: return (.secondUnit(with: .milli), 1)
        case .oxygenSaturation: return (.percent(), 100) // HealthKit percent is a 0...1 fraction.
        case .respiratoryRate: return (HKUnit.count().unitDivided(by: .minute()), 1)
        case .vo2Max: return (HKUnit.literUnit(with: .milli).unitDivided(by: HKUnit.gramUnit(with: .kilo).unitMultiplied(by: .minute())), 1)
        case .bodyMass: return (.gramUnit(with: .kilo), 1)
        case .wristTemperature: return (.degreeCelsius(), 1)
        case .sleepAnalysis, .workouts: return nil
        }
    }

    static var readTypes: Set<HKObjectType> { Set(allCases.map(\.sampleType)) }
}
#endif
