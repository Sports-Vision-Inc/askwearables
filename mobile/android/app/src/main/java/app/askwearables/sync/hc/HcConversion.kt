package app.askwearables.sync.hc

import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SkinTemperatureRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.WeightRecord
import app.askwearables.sync.mapping.QuantitySnapshot
import app.askwearables.sync.mapping.SleepSnapshot
import app.askwearables.sync.mapping.SleepStage
import app.askwearables.sync.mapping.StageSnapshot
import app.askwearables.sync.mapping.WorkoutTypes
import app.askwearables.sync.model.CanonicalRecord
import app.askwearables.sync.mapping.Mapper
import java.time.Instant
import java.time.ZoneId

/** Health Connect records -> snapshots / canonical records. Cumulative types never pass through here. */
object HcConversion {
    /** Quantity snapshots in the catalogue unit; external id = Health Connect record id (heart rate: id + sample time). */
    fun quantities(record: Record): List<QuantitySnapshot> {
        val id = record.metadata.id
        return when (record) {
            is HeartRateRecord -> record.samples.map {
                QuantitySnapshot("$id:${it.time.toEpochMilli()}", it.time, it.time, it.beatsPerMinute.toDouble())
            }
            is RestingHeartRateRecord -> listOf(QuantitySnapshot(id, record.time, record.time, record.beatsPerMinute.toDouble()))
            is HeartRateVariabilityRmssdRecord -> listOf(QuantitySnapshot(id, record.time, record.time, record.heartRateVariabilityMillis))
            is OxygenSaturationRecord -> listOf(QuantitySnapshot(id, record.time, record.time, record.percentage.value))
            is RespiratoryRateRecord -> listOf(QuantitySnapshot(id, record.time, record.time, record.rate))
            is Vo2MaxRecord -> listOf(QuantitySnapshot(id, record.time, record.time, record.vo2MillilitersPerMinuteKilogram))
            is WeightRecord -> listOf(QuantitySnapshot(id, record.time, record.time, record.weight.inKilograms))
            else -> emptyList()
        }
    }

    /** (start, end) of any synced record type. IntervalRecord/InstantaneousRecord are internal in connect-client 1.1. */
    fun timeRange(r: Record): Pair<Instant, Instant>? = when (r) {
        is StepsRecord -> r.startTime to r.endTime
        is ActiveCaloriesBurnedRecord -> r.startTime to r.endTime
        is HeartRateRecord -> r.startTime to r.endTime
        is SleepSessionRecord -> r.startTime to r.endTime
        is ExerciseSessionRecord -> r.startTime to r.endTime
        is SkinTemperatureRecord -> r.startTime to r.endTime
        is RestingHeartRateRecord -> r.time to r.time
        is HeartRateVariabilityRmssdRecord -> r.time to r.time
        is OxygenSaturationRecord -> r.time to r.time
        is RespiratoryRateRecord -> r.time to r.time
        is Vo2MaxRecord -> r.time to r.time
        is WeightRecord -> r.time to r.time
        else -> null
    }

    fun sleep(record: SleepSessionRecord): SleepSnapshot = SleepSnapshot(
        record.metadata.id, record.startTime, record.endTime,
        record.stages.map { StageSnapshot(it.startTime, it.endTime, sleepStage(it.stage)) },
    )

    fun sleepStage(stage: Int): SleepStage = when (stage) {
        SleepSessionRecord.STAGE_TYPE_AWAKE -> SleepStage.AWAKE
        SleepSessionRecord.STAGE_TYPE_SLEEPING -> SleepStage.SLEEPING
        SleepSessionRecord.STAGE_TYPE_OUT_OF_BED -> SleepStage.OUT_OF_BED
        SleepSessionRecord.STAGE_TYPE_LIGHT -> SleepStage.LIGHT
        SleepSessionRecord.STAGE_TYPE_DEEP -> SleepStage.DEEP
        SleepSessionRecord.STAGE_TYPE_REM -> SleepStage.REM
        SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED -> SleepStage.AWAKE_IN_BED
        else -> SleepStage.UNKNOWN
    }

    fun skinTemperature(record: SkinTemperatureRecord, sourceId: String, zone: ZoneId): CanonicalRecord? =
        Mapper.skinTemperature(record.metadata.id, record.startTime, record.endTime, record.deltas.map { it.delta.inCelsius }, sourceId, zone)

    fun workoutType(exerciseType: Int): String = WorkoutTypes.map(EXERCISE_NAMES[exerciseType] ?: "other")

    private val EXERCISE_NAMES: Map<Int, String> = mapOf(
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING to "running",
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL to "running_treadmill",
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING to "walking",
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING to "hiking",
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING to "biking",
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY to "biking_stationary",
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL to "swimming_pool",
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER to "swimming_open_water",
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING to "strength_training",
        ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING to "weightlifting",
        ExerciseSessionRecord.EXERCISE_TYPE_CALISTHENICS to "calisthenics",
        ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING to "high_intensity_interval_training",
        ExerciseSessionRecord.EXERCISE_TYPE_BOOT_CAMP to "boot_camp",
        ExerciseSessionRecord.EXERCISE_TYPE_YOGA to "yoga",
        ExerciseSessionRecord.EXERCISE_TYPE_PILATES to "pilates",
        ExerciseSessionRecord.EXERCISE_TYPE_STRETCHING to "stretching",
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING to "rowing",
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE to "rowing_machine",
        ExerciseSessionRecord.EXERCISE_TYPE_PADDLING to "paddling",
        ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL to "elliptical",
        ExerciseSessionRecord.EXERCISE_TYPE_SOCCER to "soccer",
        ExerciseSessionRecord.EXERCISE_TYPE_TENNIS to "tennis",
        ExerciseSessionRecord.EXERCISE_TYPE_BASKETBALL to "basketball",
        ExerciseSessionRecord.EXERCISE_TYPE_FOOTBALL_AMERICAN to "football_american",
        ExerciseSessionRecord.EXERCISE_TYPE_FOOTBALL_AUSTRALIAN to "football_australian",
        ExerciseSessionRecord.EXERCISE_TYPE_GOLF to "golf",
        ExerciseSessionRecord.EXERCISE_TYPE_BASEBALL to "baseball",
        ExerciseSessionRecord.EXERCISE_TYPE_SOFTBALL to "softball",
        ExerciseSessionRecord.EXERCISE_TYPE_VOLLEYBALL to "volleyball",
        ExerciseSessionRecord.EXERCISE_TYPE_BADMINTON to "badminton",
        ExerciseSessionRecord.EXERCISE_TYPE_TABLE_TENNIS to "table_tennis",
        ExerciseSessionRecord.EXERCISE_TYPE_SQUASH to "squash",
        ExerciseSessionRecord.EXERCISE_TYPE_RACQUETBALL to "racquetball",
        ExerciseSessionRecord.EXERCISE_TYPE_RUGBY to "rugby",
        ExerciseSessionRecord.EXERCISE_TYPE_ICE_HOCKEY to "ice_hockey",
        ExerciseSessionRecord.EXERCISE_TYPE_ROLLER_HOCKEY to "roller_hockey",
        ExerciseSessionRecord.EXERCISE_TYPE_CRICKET to "cricket",
        ExerciseSessionRecord.EXERCISE_TYPE_HANDBALL to "handball",
        ExerciseSessionRecord.EXERCISE_TYPE_BOXING to "boxing",
        ExerciseSessionRecord.EXERCISE_TYPE_MARTIAL_ARTS to "martial_arts",
        ExerciseSessionRecord.EXERCISE_TYPE_FRISBEE_DISC to "frisbee_disc",
        ExerciseSessionRecord.EXERCISE_TYPE_FENCING to "fencing",
    )
}
