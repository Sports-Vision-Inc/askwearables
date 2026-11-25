package app.askwearables.sync.hc

import android.os.Build
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.aggregate.AggregateMetric
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.SkinTemperatureRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateGroupByDurationRequest
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import app.askwearables.sync.mapping.Mapper
import app.askwearables.sync.mapping.WorkoutSnapshot
import app.askwearables.sync.model.CanonicalRecord
import app.askwearables.sync.model.Source
import app.askwearables.sync.net.IngestClient
import app.askwearables.sync.store.SyncPrefs
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/**
 * One Changes token per type. First run: take a token, then backfill everything readable (cumulative types through the
 * aggregation API in hourly buckets, others by paged readRecords). Later runs: consume changes page by page, upload,
 * then store the next token. Upload failures leave the stored token untouched, so the same delta is re-sent.
 */
class HealthConnectSync(
    private val client: HealthConnectClient,
    private val prefs: SyncPrefs,
    private val ingest: IngestClient,
    private val ownPackage: String,
    private val zone: () -> ZoneId = { ZoneId.systemDefault() },
    private val now: () -> Instant = { Instant.now() },
) {
    data class Result(val sent: Int, val errors: Map<HcType, String>)

    fun featureAvailable(feature: Int): Boolean =
        client.features.getFeatureStatus(feature) == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE

    /** Types this device's Health Connect can serve. */
    fun supportedTypes(): List<HcType> = HcType.entries.filter { t -> t.feature?.let(::featureAvailable) ?: true }

    /** Every permission requested at onboarding: per-type reads, distance (for workouts), history and background. */
    fun onboardingPermissions(): Set<String> = buildSet {
        supportedTypes().forEach { add(it.readPermission) }
        add(HcPermissions.DISTANCE)
        if (featureAvailable(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY)) add(HcPermissions.HISTORY)
        if (featureAvailable(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND)) add(HcPermissions.BACKGROUND)
    }

    suspend fun grantedPermissions(): Set<String> = client.permissionController.getGrantedPermissions()

    /** earliest_readable: with history access, the earliest record seen; without it, 30 days before the first grant. */
    fun earliestReadable(): String? {
        val z = zone()
        return if (prefs.historyGranted) prefs.earliestSeen?.let { it.atZone(z).toLocalDate().toString() }
        else prefs.firstGrantAt?.let { it.minus(30, ChronoUnit.DAYS).atZone(z).toLocalDate().toString() }
    }

    fun currentSource(deviceModel: String? = "${Build.MANUFACTURER} ${Build.MODEL}".trim().ifEmpty { null }): Source = Source(
        id = prefs.sourceId,
        provider = "health_connect",
        deviceModel = deviceModel,
        deviceClass = prefs.deviceClass,
        connectedAt = prefs.connectedAt,
        earliestReadable = earliestReadable(),
        lastSyncAt = now(),
    )

    suspend fun syncAll(): Result {
        val granted = grantedPermissions()
        prefs.historyGranted = HcPermissions.HISTORY in granted
        if (prefs.firstGrantAt == null && HcType.entries.any { it.readPermission in granted }) prefs.firstGrantAt = now()
        var sent = 0
        val errors = mutableMapOf<HcType, String>()
        for (type in supportedTypes()) {
            if (type.readPermission !in granted) continue
            try {
                sent += syncType(type, granted)
                prefs.setLastSyncAt(type, now())
                prefs.setLastError(type, null)
            } catch (e: Exception) {
                errors[type] = e.message ?: e.javaClass.simpleName
                prefs.setLastError(type, errors[type])
            }
        }
        return Result(sent, errors)
    }

    suspend fun syncType(type: HcType, granted: Set<String>): Int {
        val token = prefs.changesToken(type)
        if (token == null) {
            // Take the token first so changes written during the backfill are picked up next time.
            val fresh = client.getChangesToken(ChangesTokenRequest(setOf(type.recordClass)))
            val sent = backfill(type, backfillStart(), now(), granted)
            prefs.setChangesToken(type, fresh)
            return sent
        }
        var next: String = token
        var sent = 0
        while (true) {
            val resp = client.getChanges(next)
            if (resp.changesTokenExpired) {
                // Tokens expire after about 30 days unused: re-read since the last successful sync (minus a day of
                // overlap); the broker de-duplicates on external_id.
                val fresh = client.getChangesToken(ChangesTokenRequest(setOf(type.recordClass)))
                val from = (prefs.lastSyncAt(type) ?: backfillStart()).minus(1, ChronoUnit.DAYS)
                sent += backfill(type, maxOf(from, backfillStart()), now(), granted)
                prefs.setChangesToken(type, fresh)
                return sent
            }
            val upserts = resp.changes.filterIsInstance<UpsertionChange>().map { it.record }
                .filter { it.metadata.dataOrigin.packageName != ownPackage && type.recordClass.isInstance(it) }
            val deletions = resp.changes.count { it is DeletionChange }
            val records = recordsFor(type, upserts, granted)
            upload(records)
            sent += records.size
            // The ingest API has no delete call yet; deletions are counted and shown, not forwarded.
            if (deletions > 0) prefs.addDeletions(type, deletions)
            prefs.addSent(type, records.size)
            next = resp.nextChangesToken
            prefs.setChangesToken(type, next)
            if (!resp.hasMore) break
        }
        return sent
    }

    /** Without the history permission, Health Connect serves 30 days before the first grant. */
    fun backfillStart(): Instant {
        val first = prefs.firstGrantAt ?: now()
        return if (prefs.historyGranted) first.minus(HISTORY_LIMIT_DAYS, ChronoUnit.DAYS) else first.minus(30, ChronoUnit.DAYS)
    }

    private suspend fun backfill(type: HcType, from: Instant, to: Instant, granted: Set<String>): Int {
        if (!to.isAfter(from)) return 0
        var sent = 0
        if (type.isCumulative) {
            // Find where data starts, so years of empty hourly buckets are not requested.
            val first = client.readRecords(ReadRecordsRequest(type.recordClass, TimeRangeFilter.between(from, to), ascendingOrder = true, pageSize = 1))
                .records.firstOrNull() ?: return 0
            var cursor = Mapper.hourFloor(HcConversion.timeRange(first)?.first ?: from)
            prefs.noteSeen(cursor)
            while (cursor < to) {
                val end = minOf(cursor.plus(7, ChronoUnit.DAYS), to)
                val records = hourlyTotals(type, cursor, end, onlyHours = null)
                upload(records)
                sent += records.size
                prefs.addSent(type, records.size)
                cursor = end
            }
            return sent
        }
        var pageToken: String? = null
        do {
            val resp = client.readRecords(ReadRecordsRequest(type.recordClass, TimeRangeFilter.between(from, to), pageSize = PAGE_SIZE, pageToken = pageToken))
            val records = recordsFor(type, resp.records.filter { it.metadata.dataOrigin.packageName != ownPackage }, granted)
            upload(records)
            sent += records.size
            prefs.addSent(type, records.size)
            pageToken = resp.pageToken?.takeIf { it.isNotEmpty() }
        } while (pageToken != null)
        return sent
    }

    private suspend fun upload(records: List<CanonicalRecord>) {
        if (records.isNotEmpty()) ingest.upload(currentSource(), records)
    }

    /** Map changed or read records of one type to canonical records. */
    suspend fun recordsFor(type: HcType, records: List<Record>, granted: Set<String>): List<CanonicalRecord> {
        if (records.isEmpty()) return emptyList()
        records.forEach { r -> HcConversion.timeRange(r)?.let { prefs.noteSeen(it.first) } }
        val z = zone()
        val sourceId = prefs.sourceId
        return when (type) {
            HcType.STEPS, HcType.ACTIVE_ENERGY -> {
                val hours = Mapper.affectedHours(records.mapNotNull(HcConversion::timeRange))
                // One aggregation request per affected day keeps requests few and buckets aligned.
                hours.groupBy { it.truncatedTo(ChronoUnit.DAYS) }.flatMap { (day, hs) ->
                    hourlyTotals(type, day, day.plus(1, ChronoUnit.DAYS), onlyHours = hs.toSet())
                }
            }
            HcType.SLEEP -> records.filterIsInstance<SleepSessionRecord>().mapNotNull { Mapper.sleepSession(HcConversion.sleep(it), sourceId, z) }
            HcType.EXERCISE -> records.filterIsInstance<ExerciseSessionRecord>().mapNotNull { workout(it, granted, sourceId, z) }
            HcType.SKIN_TEMPERATURE -> records.filterIsInstance<SkinTemperatureRecord>().mapNotNull { HcConversion.skinTemperature(it, sourceId, z) }
            else -> records.flatMap(HcConversion::quantities).map { Mapper.sample(it, type.metric!!, type.method, sourceId, z) }
        }
    }

    /**
     * Hourly totals from the aggregation API, which de-duplicates overlapping records from different apps.
     * With [onlyHours], every listed hour is emitted (0 when empty) so a lowered total overwrites the old one.
     */
    private suspend fun hourlyTotals(type: HcType, from: Instant, to: Instant, onlyHours: Set<Instant>?): List<CanonicalRecord> {
        val metric = type.metric!!
        val aggregate: AggregateMetric<*> = if (type == HcType.STEPS) StepsRecord.COUNT_TOTAL else ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL
        val groups = client.aggregateGroupByDuration(
            AggregateGroupByDurationRequest(setOf(aggregate), TimeRangeFilter.between(from, to), Duration.ofHours(1)),
        )
        val totals = HashMap<Instant, Double>()
        for (g in groups) {
            val v: Double? = when (type) {
                HcType.STEPS -> g.result[StepsRecord.COUNT_TOTAL]?.toDouble()
                else -> g.result[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.inKilocalories
            }
            if (v != null) totals[Mapper.hourFloor(g.startTime)] = v
        }
        val z = zone()
        val hours = onlyHours?.sorted() ?: totals.keys.sorted()
        return hours.map { Mapper.hourlyBucket(metric, it, totals[it] ?: 0.0, prefs.sourceId, z) }
    }

    private suspend fun workout(r: ExerciseSessionRecord, granted: Set<String>, sourceId: String, z: ZoneId): CanonicalRecord? {
        val metrics = buildSet<AggregateMetric<*>> {
            if (HcType.ACTIVE_ENERGY.readPermission in granted) add(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL)
            if (HcPermissions.DISTANCE in granted) add(DistanceRecord.DISTANCE_TOTAL)
            if (HcType.HEART_RATE.readPermission in granted) add(HeartRateRecord.BPM_AVG)
        }
        val agg = if (metrics.isEmpty()) null else client.aggregate(AggregateRequest(metrics, TimeRangeFilter.between(r.startTime, r.endTime)))
        return Mapper.workoutSession(
            WorkoutSnapshot(
                id = r.metadata.id, start = r.startTime, end = r.endTime, type = HcConversion.workoutType(r.exerciseType),
                distanceM = agg?.get(DistanceRecord.DISTANCE_TOTAL)?.inMeters,
                energyKcal = agg?.get(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL)?.inKilocalories,
                avgHr = agg?.get(HeartRateRecord.BPM_AVG)?.toDouble(),
            ),
            sourceId, z,
        )
    }

    companion object {
        const val PAGE_SIZE = 1000
        /** With history access, look back this far. Health Connect returns whatever exists inside the range. */
        const val HISTORY_LIMIT_DAYS = 3650L
    }
}
