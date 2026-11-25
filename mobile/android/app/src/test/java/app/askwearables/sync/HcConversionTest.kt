package app.askwearables.sync

import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Percentage
import app.askwearables.sync.hc.HcConversion
import app.askwearables.sync.hc.HcType
import app.askwearables.sync.mapping.Mapper
import app.askwearables.sync.mapping.SleepStage
import app.askwearables.sync.model.Method
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset

/** Health Connect record objects -> snapshots. Record ids are assigned by Health Connect, so they are empty here. */
class HcConversionTest {
    private val t0 = Instant.parse("2026-11-20T07:00:00Z")
    private val off = ZoneOffset.ofHours(1)

    @Test
    fun heartRateSeriesBecomesOneSamplePerReadingWithStableIds() {
        val r = HeartRateRecord(
            startTime = t0, startZoneOffset = off, endTime = t0.plusSeconds(120), endZoneOffset = off,
            samples = listOf(HeartRateRecord.Sample(t0, 60), HeartRateRecord.Sample(t0.plusSeconds(60), 64)),
            metadata = Metadata.manualEntry(),
        )
        val snaps = HcConversion.quantities(r)
        assertEquals(listOf(60.0, 64.0), snaps.map { it.value })
        assertEquals(":${t0.toEpochMilli()}", snaps[0].id) // "<record id>:<epoch ms>"
        val rec = Mapper.sample(snaps[1], HcType.HEART_RATE.metric!!, Method.MEASURED, "s", ZoneId.of("UTC"))
        assertEquals("bpm", rec.unit)
        assertEquals(t0.plusSeconds(60), rec.start)
        assertEquals(rec.start, rec.end)
    }

    @Test
    fun spo2AndWeightUseCatalogueUnits() {
        val spo2 = OxygenSaturationRecord(time = t0, zoneOffset = off, percentage = Percentage(96.5), metadata = Metadata.manualEntry())
        assertEquals(96.5, HcConversion.quantities(spo2).single().value, 1e-9)
        val w = WeightRecord(time = t0, zoneOffset = off, weight = Mass.pounds(150.0), metadata = Metadata.manualEntry())
        assertEquals(68.0388555, HcConversion.quantities(w).single().value, 1e-6)
    }

    @Test
    fun sleepStagesMap() {
        val r = SleepSessionRecord(
            startTime = t0, startZoneOffset = off, endTime = t0.plusSeconds(3600), endZoneOffset = off,
            stages = listOf(SleepSessionRecord.Stage(t0, t0.plusSeconds(3600), SleepSessionRecord.STAGE_TYPE_DEEP)),
            metadata = Metadata.manualEntry(),
        )
        val snap = HcConversion.sleep(r)
        assertEquals(SleepStage.DEEP, snap.stages.single().stage)
        assertEquals(SleepStage.AWAKE_IN_BED, HcConversion.sleepStage(SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED))
        assertEquals(SleepStage.UNKNOWN, HcConversion.sleepStage(99))
    }

    @Test
    fun exerciseTypesMap() {
        assertEquals("run", HcConversion.workoutType(ExerciseSessionRecord.EXERCISE_TYPE_RUNNING))
        assertEquals("cycle", HcConversion.workoutType(ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY))
        assertEquals("swim", HcConversion.workoutType(ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL))
        assertEquals("other", HcConversion.workoutType(ExerciseSessionRecord.EXERCISE_TYPE_DANCING))
    }

    @Test
    fun timeRangeCoversIntervalAndInstantRecords() {
        val w = WeightRecord(time = t0, zoneOffset = off, weight = Mass.kilograms(70.0), metadata = Metadata.manualEntry())
        assertEquals(t0 to t0, HcConversion.timeRange(w))
    }

    @Test
    fun everyTypeHasADistinctTokenKeyAndPermission() {
        assertEquals(12, HcType.entries.map { it.key }.toSet().size)
        assertEquals(12, HcType.entries.map { it.readPermission }.toSet().size)
        assertEquals("android.permission.health.READ_STEPS", HcType.STEPS.readPermission)
    }
}
