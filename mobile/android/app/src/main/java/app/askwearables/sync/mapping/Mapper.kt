package app.askwearables.sync.mapping

import app.askwearables.sync.model.CanonicalRecord
import app.askwearables.sync.model.CanonicalSample
import app.askwearables.sync.model.CanonicalSession
import app.askwearables.sync.model.Iso
import app.askwearables.sync.model.Method
import app.askwearables.sync.model.MetricId
import app.askwearables.sync.model.SleepStagesDetail
import app.askwearables.sync.model.WorkoutDetail
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import kotlin.math.roundToLong

// Pure mapping from platform-neutral snapshots to canonical records. Health Connect records are turned into these
// snapshots in hc/HcConversion.kt, which keeps this layer testable on the JVM without a device.

/** One value already converted to the catalogue unit. `id` is the Health Connect record id (a UUID). */
data class QuantitySnapshot(val id: String, val start: Instant, val end: Instant, val value: Double)

enum class SleepStage { AWAKE, SLEEPING, OUT_OF_BED, LIGHT, DEEP, REM, AWAKE_IN_BED, UNKNOWN }

data class StageSnapshot(val start: Instant, val end: Instant, val stage: SleepStage)

data class SleepSnapshot(val id: String, val start: Instant, val end: Instant, val stages: List<StageSnapshot>)

data class WorkoutSnapshot(
    val id: String,
    val start: Instant,
    val end: Instant,
    /** Already one of WORKOUT_TYPES. */
    val type: String,
    val distanceM: Double? = null,
    val energyKcal: Double? = null,
    val avgHr: Double? = null,
)

object Mapper {
    const val MAX_BATCH = 2000
    private const val MAX_SESSION_HOURS = 36L

    /** Minutes east of UTC on this device's clock at [at]. */
    fun tzOffsetMin(at: Instant, zone: ZoneId): Int = zone.rules.getOffset(at).totalSeconds / 60

    fun sample(s: QuantitySnapshot, metric: MetricId, method: Method, sourceId: String, zone: ZoneId): CanonicalSample =
        CanonicalSample(metric, s.start, s.end, s.value, metric.unit, sourceId, method, s.id, tzOffsetMin(s.start, zone))

    // ---- cumulative types: hourly totals from the aggregation API, which removes duplicates across apps ----

    fun hourlyExternalId(metric: MetricId, hourStart: Instant) = "hc-hourly:${metric.id}:${Iso.format(hourStart)}"

    fun hourFloor(i: Instant): Instant = i.truncatedTo(ChronoUnit.HOURS)

    /** Every UTC hour touched by any interval (end exclusive). */
    fun affectedHours(intervals: List<Pair<Instant, Instant>>): List<Instant> {
        val out = sortedSetOf<Instant>()
        for ((start, end) in intervals) {
            var h = hourFloor(start)
            val last = hourFloor(if (end > start) end.minusMillis(1) else end)
            while (h <= last) {
                out.add(h)
                h = h.plus(1, ChronoUnit.HOURS)
            }
        }
        return out.toList()
    }

    fun hourlyBucket(metric: MetricId, hourStart: Instant, total: Double, sourceId: String, zone: ZoneId) = CanonicalSample(
        metric, hourStart, hourStart.plus(1, ChronoUnit.HOURS), total, metric.unit, sourceId, Method.MEASURED,
        hourlyExternalId(metric, hourStart), tzOffsetMin(hourStart, zone),
    )

    // ---- sleep ----

    fun sleepSession(s: SleepSnapshot, sourceId: String, zone: ZoneId): CanonicalSession? {
        if (!s.end.isAfter(s.start) || Duration.between(s.start, s.end).toHours() > MAX_SESSION_HOURS) return null
        val minutes = HashMap<SleepStage, Double>()
        for (st in s.stages) {
            if (st.end.isAfter(st.start)) minutes.merge(st.stage, Duration.between(st.start, st.end).toMillis() / 60000.0, Double::plus)
        }
        val awake = listOfNotNull(minutes[SleepStage.AWAKE], minutes[SleepStage.AWAKE_IN_BED]).takeIf { it.isNotEmpty() }?.sum()
        val detail = SleepStagesDetail(
            deepMin = minutes[SleepStage.DEEP]?.let(::round1),
            lightMin = minutes[SleepStage.LIGHT]?.let(::round1),
            remMin = minutes[SleepStage.REM]?.let(::round1),
            awakeMin = awake?.let(::round1),
            // Health Connect sessions span time in bed; out-of-bed periods are excluded.
            inBedMin = round1(Duration.between(s.start, s.end).toMillis() / 60000.0 - (minutes[SleepStage.OUT_OF_BED] ?: 0.0)),
        )
        return CanonicalSession(s.start, s.end, sourceId, s.id, tzOffsetMin(s.start, zone), detail = detail)
    }

    // ---- workouts ----

    fun workoutSession(w: WorkoutSnapshot, sourceId: String, zone: ZoneId): CanonicalSession? {
        if (!w.end.isAfter(w.start) || Duration.between(w.start, w.end).toHours() > MAX_SESSION_HOURS) return null
        return CanonicalSession(
            w.start, w.end, sourceId, w.id, tzOffsetMin(w.start, zone),
            detail = WorkoutDetail(type = w.type, distanceM = w.distanceM?.let(::round1), energyKcal = w.energyKcal?.let(::round1), avgHr = w.avgHr?.let(::round1)),
        )
    }

    // ---- skin temperature ----

    /**
     * Health Connect's SkinTemperatureRecord already carries deltas from the writer's baseline, which is what the
     * broker's skin_temp_deviation means. The night's value is the mean delta.
     */
    fun skinTemperature(id: String, start: Instant, end: Instant, deltasC: List<Double>, sourceId: String, zone: ZoneId): CanonicalSample? {
        if (deltasC.isEmpty()) return null
        val mean = deltasC.average()
        return CanonicalSample(MetricId.SKIN_TEMP_DEVIATION, start, end, (mean * 1000).roundToLong() / 1000.0, "degC", sourceId,
            Method.MEASURED, id, tzOffsetMin(start, zone))
    }

    fun <T> batches(items: List<T>, size: Int = MAX_BATCH): List<List<T>> = items.chunked(size)

    private fun round1(x: Double) = (x * 10).roundToLong() / 10.0
}

/** ExerciseSessionRecord.EXERCISE_TYPE_* names (lower-case, without prefix) -> WORKOUT_TYPES. */
object WorkoutTypes {
    fun map(name: String): String = when (name) {
        "running", "running_treadmill" -> "run"
        "walking" -> "walk"
        "hiking" -> "hike"
        "biking", "biking_stationary" -> "cycle"
        "swimming_pool", "swimming_open_water" -> "swim"
        "strength_training", "weightlifting", "calisthenics" -> "strength"
        "high_intensity_interval_training", "boot_camp" -> "hiit"
        "yoga", "pilates", "stretching" -> "yoga"
        "rowing", "rowing_machine", "paddling" -> "row"
        "elliptical" -> "elliptical"
        "soccer", "tennis", "basketball", "football_american", "football_australian", "golf", "baseball", "softball",
        "volleyball", "badminton", "table_tennis", "squash", "racquetball", "rugby", "ice_hockey", "roller_hockey",
        "cricket", "handball", "boxing", "martial_arts", "frisbee_disc", "fencing" -> "sport"
        else -> "other"
    }
}
