package app.askwearables.sync

import app.askwearables.sync.mapping.Mapper
import app.askwearables.sync.mapping.QuantitySnapshot
import app.askwearables.sync.mapping.SleepSnapshot
import app.askwearables.sync.mapping.SleepStage
import app.askwearables.sync.mapping.StageSnapshot
import app.askwearables.sync.mapping.WorkoutSnapshot
import app.askwearables.sync.mapping.WorkoutTypes
import app.askwearables.sync.model.DeviceClass
import app.askwearables.sync.model.IngestBody
import app.askwearables.sync.model.Method
import app.askwearables.sync.model.MetricId
import app.askwearables.sync.model.Source
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class JsonMappingTest {
    private val utc = ZoneId.of("UTC")
    private val berlin = ZoneId.of("Europe/Berlin")
    private val t0 = Instant.parse("2026-11-20T07:00:00Z")

    @Test
    fun sampleSerializesToExactlyTheCanonicalSampleShape() {
        val rec = Mapper.sample(QuantitySnapshot("4f1c-uuid", t0, t0, 61.0), MetricId.HEART_RATE, Method.MEASURED, "health_connect:x", berlin)
        assertEquals(
            """{"kind":"sample","metric":"heart_rate","start":"2026-11-20T07:00:00.000Z","end":"2026-11-20T07:00:00.000Z","value":61,"unit":"bpm","source_id":"health_connect:x","method":"measured","external_id":"4f1c-uuid","tz_offset_min":60}""",
            rec.toJson().toString(),
        )
    }

    @Test
    fun fractionalValuesStayFractional() {
        val rec = Mapper.sample(QuantitySnapshot("id", t0, t0, 97.5), MetricId.SPO2, Method.MEASURED, "s", utc)
        assertEquals("97.5", rec.toJson()["value"]!!.jsonPrimitive.content)
        assertEquals("percent", rec.toJson()["unit"]!!.jsonPrimitive.content)
    }

    @Test
    fun tzOffsetIsTheDeviceOffsetAtTheSampleStart() {
        assertEquals(120, Mapper.tzOffsetMin(Instant.parse("2026-07-01T12:00:00Z"), berlin))
        assertEquals(60, Mapper.tzOffsetMin(t0, berlin))
        assertEquals(330, Mapper.tzOffsetMin(t0, ZoneId.of("Asia/Kolkata")))
        assertEquals(-300, Mapper.tzOffsetMin(t0, ZoneId.of("America/New_York")))
    }

    @Test
    fun sourceWritesExplicitNullsAndEmptyTermsFlags() {
        val src = Source("health_connect:abc", "health_connect", null, DeviceClass.RING, t0, null, null)
        assertEquals(
            """{"id":"health_connect:abc","provider":"health_connect","device_model":null,"device_class":"ring","connected_at":"2026-11-20T07:00:00.000Z","earliest_readable":null,"last_sync_at":null,"terms_flags":{}}""",
            src.toJson().toString(),
        )
    }

    @Test
    fun ingestBodyHasSourceAndRecords() {
        val src = Source("s", "health_connect", "Google Pixel 9", DeviceClass.WATCH, t0, "2026-10-21", t0)
        val body = IngestBody(src, listOf(Mapper.hourlyBucket(MetricId.STEPS, t0, 812.0, "s", utc)))
        val obj = Json.parseToJsonElement(body.toJsonString()).jsonObject
        assertEquals(setOf("source", "records"), obj.keys)
        assertEquals("2026-10-21", obj["source"]!!.jsonObject["earliest_readable"]!!.jsonPrimitive.content)
        val r = obj["records"]!!.jsonArray[0].jsonObject
        assertEquals(setOf("kind", "metric", "start", "end", "value", "unit", "source_id", "method", "external_id", "tz_offset_min"), r.keys)
        assertEquals("hc-hourly:steps:2026-11-20T07:00:00.000Z", r["external_id"]!!.jsonPrimitive.content)
        assertEquals("2026-11-20T08:00:00.000Z", r["end"]!!.jsonPrimitive.content)
        assertEquals("count", r["unit"]!!.jsonPrimitive.content)
    }

    @Test
    fun sleepSessionShapeAndStageMinutes() {
        val start = Instant.parse("2026-11-19T23:00:00Z")
        val s = SleepSnapshot(
            "sleep-uuid", start, Instant.parse("2026-11-20T06:30:00Z"),
            listOf(
                StageSnapshot(start, Instant.parse("2026-11-20T00:00:00Z"), SleepStage.LIGHT),
                StageSnapshot(Instant.parse("2026-11-20T00:00:00Z"), Instant.parse("2026-11-20T01:30:00Z"), SleepStage.DEEP),
                StageSnapshot(Instant.parse("2026-11-20T01:30:00Z"), Instant.parse("2026-11-20T01:40:00Z"), SleepStage.AWAKE),
                StageSnapshot(Instant.parse("2026-11-20T01:40:00Z"), Instant.parse("2026-11-20T03:00:00Z"), SleepStage.REM),
                StageSnapshot(Instant.parse("2026-11-20T03:00:00Z"), Instant.parse("2026-11-20T03:20:00Z"), SleepStage.OUT_OF_BED),
                StageSnapshot(Instant.parse("2026-11-20T03:20:00Z"), Instant.parse("2026-11-20T06:30:00Z"), SleepStage.LIGHT),
            ),
        )
        val obj = Mapper.sleepSession(s, "s", utc)!!.toJson()
        assertEquals(setOf("kind", "session_kind", "start", "end", "source_id", "external_id", "tz_offset_min", "detail"), obj.keys)
        assertEquals("session", obj["kind"]!!.jsonPrimitive.content)
        assertEquals("sleep", obj["session_kind"]!!.jsonPrimitive.content)
        assertEquals("sleep-uuid", obj["external_id"]!!.jsonPrimitive.content)
        assertEquals(
            """{"deep_min":90,"light_min":250,"rem_min":80,"awake_min":10,"in_bed_min":430}""",
            obj["detail"].toString(),
        )
    }

    @Test
    fun workoutSessionOmitsMissingDetailFields() {
        val w = WorkoutSnapshot("w-uuid", t0, t0.plusSeconds(1800), WorkoutTypes.map("running"), distanceM = 5012.34, energyKcal = 320.0)
        val obj = Mapper.workoutSession(w, "s", utc)!!.toJson()
        assertEquals("workout", obj["session_kind"]!!.jsonPrimitive.content)
        assertEquals("""{"type":"run","distance_m":5012.3,"energy_kcal":320}""", obj["detail"].toString())
        assertNull(obj["is_main"])
    }

    @Test
    fun zeroLengthOrOverlongSessionsAreDropped() {
        assertNull(Mapper.workoutSession(WorkoutSnapshot("w", t0, t0, "run"), "s", utc))
        assertNull(Mapper.sleepSession(SleepSnapshot("x", t0, t0.plusSeconds(40 * 3600), emptyList()), "s", utc))
    }

    @Test
    fun skinTemperatureIsMeanDeltaInDegC() {
        val rec = Mapper.skinTemperature("t-uuid", t0, t0.plusSeconds(8 * 3600), listOf(0.2, 0.4, 0.3), "s", utc)!!
        assertEquals(MetricId.SKIN_TEMP_DEVIATION, rec.metric)
        assertEquals(0.3, rec.value, 1e-9)
        assertEquals("degC", rec.toJson()["unit"]!!.jsonPrimitive.content)
        assertNull(Mapper.skinTemperature("t", t0, t0, emptyList(), "s", utc))
    }

    @Test
    fun affectedHoursAndStableBucketIds() {
        val hours = Mapper.affectedHours(
            listOf(
                Instant.parse("2026-11-20T07:50:00Z") to Instant.parse("2026-11-20T09:00:00Z"),
                Instant.parse("2026-11-20T12:10:00Z") to Instant.parse("2026-11-20T12:10:00Z"),
            ),
        )
        assertEquals(listOf("2026-11-20T07:00:00Z", "2026-11-20T08:00:00Z", "2026-11-20T12:00:00Z").map(Instant::parse), hours)
        val a = Mapper.hourlyBucket(MetricId.ACTIVE_ENERGY, hours[0], 10.0, "s", utc)
        val b = Mapper.hourlyBucket(MetricId.ACTIVE_ENERGY, hours[0], 25.0, "s", utc)
        assertEquals(a.externalId, b.externalId)
        assertEquals("kcal", a.unit)
    }

    @Test
    fun workoutTypesMapToCatalogueList() {
        assertEquals("run", WorkoutTypes.map("running_treadmill"))
        assertEquals("strength", WorkoutTypes.map("weightlifting"))
        assertEquals("hiit", WorkoutTypes.map("high_intensity_interval_training"))
        assertEquals("sport", WorkoutTypes.map("tennis"))
        assertEquals("other", WorkoutTypes.map("dancing"))
    }

    @Test
    fun batchesNeverExceed2000() {
        assertEquals(listOf(2000, 2000, 1), Mapper.batches((0 until 4001).toList()).map { it.size })
    }

    @Test
    fun nullableSourceFieldsAreJsonNull() {
        val obj = Source("s", "health_connect", null, DeviceClass.WATCH, t0, null, null).toJson()
        assertEquals(JsonNull, obj["device_model"])
        assertEquals(JsonNull, obj["last_sync_at"])
    }
}
