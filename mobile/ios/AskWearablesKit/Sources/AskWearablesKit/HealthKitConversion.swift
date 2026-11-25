#if canImport(HealthKit)
import Foundation
import HealthKit

/// HealthKit objects -> platform-neutral snapshots (see Mapping.swift).
public enum HKConversion {
    public static func quantity(_ s: HKQuantitySample, as type: HealthDataType) -> QuantitySnapshot? {
        guard let (unit, factor) = type.readUnit, s.quantity.is(compatibleWith: unit) else { return nil }
        return QuantitySnapshot(uuid: s.uuid, start: s.startDate, end: s.endDate, value: s.quantity.doubleValue(for: unit) * factor)
    }

    public static func sleep(_ s: HKCategorySample) -> SleepSegment? {
        guard s.categoryType.identifier == HKCategoryTypeIdentifier.sleepAnalysis.rawValue,
              let stage = SleepStage(rawValue: s.value) else { return nil }
        return SleepSegment(uuid: s.uuid, start: s.startDate, end: s.endDate, stage: stage,
                            sourceKey: s.sourceRevision.source.bundleIdentifier)
    }

    public static func workout(_ w: HKWorkout) -> WorkoutSnapshot {
        let energy = w.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity()?.doubleValue(for: .kilocalorie())
        let avgHR = w.statistics(for: HKQuantityType(.heartRate))?.averageQuantity()?
            .doubleValue(for: HKUnit.count().unitDivided(by: .minute()))
        let distanceTypes: [HKQuantityTypeIdentifier] = [.distanceWalkingRunning, .distanceCycling, .distanceSwimming,
                                                         .distanceDownhillSnowSports, .distanceWheelchair]
        let distance = distanceTypes.lazy
            .compactMap { w.statistics(for: HKQuantityType($0))?.sumQuantity()?.doubleValue(for: .meter()) }
            .first
        return WorkoutSnapshot(uuid: w.uuid, start: w.startDate, end: w.endDate, type: workoutType(w.workoutActivityType),
                               distanceM: distance.map { ($0 * 10).rounded() / 10 },
                               energyKcal: energy.map { ($0 * 10).rounded() / 10 },
                               avgHR: avgHR.map { ($0 * 10).rounded() / 10 })
    }

    /// HKWorkoutActivityType -> WORKOUT_TYPES in packages/core/src/catalogue.ts.
    public static func workoutType(_ t: HKWorkoutActivityType) -> String {
        switch t {
        case .running: return "run"
        case .walking: return "walk"
        case .hiking: return "hike"
        case .cycling, .handCycling: return "cycle"
        case .swimming, .swimBikeRun: return "swim"
        case .traditionalStrengthTraining, .functionalStrengthTraining, .coreTraining: return "strength"
        case .highIntensityIntervalTraining, .crossTraining, .mixedCardio: return "hiit"
        case .yoga, .pilates, .mindAndBody, .flexibility: return "yoga"
        case .rowing, .paddleSports: return "row"
        case .elliptical: return "elliptical"
        case .soccer, .tennis, .basketball, .americanFootball, .australianFootball, .golf, .baseball, .softball,
             .volleyball, .badminton, .tableTennis, .squash, .racquetball, .rugby, .hockey, .lacrosse, .cricket,
             .handball, .pickleball, .boxing, .martialArts, .kickboxing:
            return "sport"
        default: return "other"
        }
    }
}
#endif
