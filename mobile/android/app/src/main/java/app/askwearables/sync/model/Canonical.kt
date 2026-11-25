package app.askwearables.sync.model

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

// Kotlin mirrors of packages/core/src/types.ts. toJson() produces exactly the shapes the ingest endpoint expects:
// snake_case keys, ISO-8601 UTC timestamps with milliseconds, optional fields omitted when null, and the nullable
// Source fields written as explicit JSON null.

/** MetricId values this app sends, with their catalogue units (packages/core/src/catalogue.ts). */
enum class MetricId(val id: String, val unit: String) {
    STEPS("steps", "count"),
    ACTIVE_ENERGY("active_energy", "kcal"),
    RESTING_HR("resting_hr", "bpm"),
    HEART_RATE("heart_rate", "bpm"),
    HRV_RMSSD("hrv_rmssd", "ms"),
    SPO2("spo2", "percent"),
    RESPIRATORY_RATE("respiratory_rate", "breaths/min"),
    SKIN_TEMP_DEVIATION("skin_temp_deviation", "degC"),
    VO2MAX("vo2max", "ml/kg/min"),
    WEIGHT("weight", "kg"),
}

enum class DeviceClass(val id: String) { WATCH("watch"), RING("ring"), BAND("band"), PHONE("phone"), SCALE("scale"), CGM("cgm"), OTHER("other") }

enum class Method(val id: String) { MEASURED("measured"), VENDOR_DAILY("vendor_daily"), DERIVED("derived"), MANUAL("manual") }

object Iso {
    private val fmt: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    /** Same form as JavaScript's Date.prototype.toISOString(). */
    fun format(i: Instant): String = fmt.format(i)
}

data class TermsFlags(val noAi: Boolean? = null, val noIntermediary: Boolean? = null, val displayToUserOnly: Boolean? = null) {
    fun toJson(): JsonObject = buildJsonObject {
        noAi?.let { put("no_ai", it) }
        noIntermediary?.let { put("no_intermediary", it) }
        displayToUserOnly?.let { put("display_to_user_only", it) }
    }
}

data class Source(
    val id: String,
    val provider: String,
    val deviceModel: String?,
    val deviceClass: DeviceClass,
    val connectedAt: Instant,
    /** YYYY-MM-DD */
    val earliestReadable: String?,
    val lastSyncAt: Instant?,
    val termsFlags: TermsFlags = TermsFlags(),
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("id", id)
        put("provider", provider)
        put("device_model", deviceModel?.let(::JsonPrimitive) ?: JsonNull)
        put("device_class", deviceClass.id)
        put("connected_at", Iso.format(connectedAt))
        put("earliest_readable", earliestReadable?.let(::JsonPrimitive) ?: JsonNull)
        put("last_sync_at", lastSyncAt?.let { JsonPrimitive(Iso.format(it)) } ?: JsonNull)
        put("terms_flags", termsFlags.toJson())
    }
}

sealed interface CanonicalRecord {
    fun toJson(): JsonObject
}

data class CanonicalSample(
    val metric: MetricId,
    val start: Instant,
    val end: Instant,
    val value: Double,
    val unit: String,
    val sourceId: String,
    val method: Method,
    val externalId: String?,
    /** Minutes east of UTC at the sample's start. */
    val tzOffsetMin: Int,
) : CanonicalRecord {
    override fun toJson(): JsonObject = buildJsonObject {
        put("kind", "sample")
        put("metric", metric.id)
        put("start", Iso.format(start))
        put("end", Iso.format(end))
        put("value", jsonNumber(value))
        put("unit", unit)
        put("source_id", sourceId)
        put("method", method.id)
        externalId?.let { put("external_id", it) }
        put("tz_offset_min", tzOffsetMin)
    }
}

sealed interface SessionDetail {
    fun toJson(): JsonObject
}

data class SleepStagesDetail(
    val deepMin: Double? = null,
    val lightMin: Double? = null,
    val remMin: Double? = null,
    val awakeMin: Double? = null,
    val inBedMin: Double? = null,
) : SessionDetail {
    override fun toJson(): JsonObject = buildJsonObject {
        deepMin?.let { put("deep_min", jsonNumber(it)) }
        lightMin?.let { put("light_min", jsonNumber(it)) }
        remMin?.let { put("rem_min", jsonNumber(it)) }
        awakeMin?.let { put("awake_min", jsonNumber(it)) }
        inBedMin?.let { put("in_bed_min", jsonNumber(it)) }
    }
}

data class WorkoutDetail(
    /** One of WORKOUT_TYPES in catalogue.ts. */
    val type: String,
    val load: Double? = null,
    val distanceM: Double? = null,
    val energyKcal: Double? = null,
    val avgHr: Double? = null,
    val title: String? = null,
    val notes: String? = null,
) : SessionDetail {
    override fun toJson(): JsonObject = buildJsonObject {
        put("type", type)
        load?.let { put("load", jsonNumber(it)) }
        distanceM?.let { put("distance_m", jsonNumber(it)) }
        energyKcal?.let { put("energy_kcal", jsonNumber(it)) }
        avgHr?.let { put("avg_hr", jsonNumber(it)) }
        title?.let { put("title", it) }
        notes?.let { put("notes", it) }
    }
}

data class CanonicalSession(
    val start: Instant,
    val end: Instant,
    val sourceId: String,
    val externalId: String?,
    val tzOffsetMin: Int,
    val isMain: Boolean? = null,
    val detail: SessionDetail,
) : CanonicalRecord {
    val sessionKind: String get() = if (detail is SleepStagesDetail) "sleep" else "workout"

    override fun toJson(): JsonObject = buildJsonObject {
        put("kind", "session")
        put("session_kind", sessionKind)
        put("start", Iso.format(start))
        put("end", Iso.format(end))
        put("source_id", sourceId)
        externalId?.let { put("external_id", it) }
        put("tz_offset_min", tzOffsetMin)
        isMain?.let { put("is_main", it) }
        put("detail", detail.toJson())
    }
}

/** Body of POST /v1/ingest. */
data class IngestBody(val source: Source, val records: List<CanonicalRecord>) {
    fun toJson(): JsonObject = buildJsonObject {
        put("source", source.toJson())
        put("records", JsonArray(records.map { it.toJson() }))
    }

    fun toJsonString(): String = toJson().toString()
}

/** Whole numbers are written without a trailing ".0" (as JavaScript would), others as-is. */
internal fun jsonNumber(v: Double): JsonElement {
    require(v.isFinite()) { "non-finite value" }
    return if (v == Math.rint(v) && kotlin.math.abs(v) < 1e15) JsonPrimitive(v.toLong()) else JsonPrimitive(v)
}
