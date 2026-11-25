package app.askwearables.sync.hc

import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
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
import app.askwearables.sync.model.Method
import app.askwearables.sync.model.MetricId
import kotlin.reflect.KClass

/** The Health Connect types the app reads. Each has its own read permission and its own Changes token. */
enum class HcType(
    val key: String,
    val label: String,
    val recordClass: KClass<out Record>,
    val metric: MetricId?,
    val method: Method = Method.MEASURED,
    /** Feature flag needed on this device before the type can be requested, if any. */
    val feature: Int? = null,
) {
    STEPS("steps", "Steps", StepsRecord::class, MetricId.STEPS),
    ACTIVE_ENERGY("active_energy", "Active energy", ActiveCaloriesBurnedRecord::class, MetricId.ACTIVE_ENERGY),
    HEART_RATE("heart_rate", "Heart rate", HeartRateRecord::class, MetricId.HEART_RATE),
    RESTING_HR("resting_hr", "Resting heart rate", RestingHeartRateRecord::class, MetricId.RESTING_HR, Method.VENDOR_DAILY),
    // Health Connect stores RMSSD, not SDNN; it is kept as its own metric on the broker.
    HRV_RMSSD("hrv_rmssd", "Heart rate variability (RMSSD)", HeartRateVariabilityRmssdRecord::class, MetricId.HRV_RMSSD),
    SPO2("spo2", "Blood oxygen", OxygenSaturationRecord::class, MetricId.SPO2),
    RESPIRATORY_RATE("respiratory_rate", "Respiratory rate", RespiratoryRateRecord::class, MetricId.RESPIRATORY_RATE),
    VO2MAX("vo2max", "VO2 max", Vo2MaxRecord::class, MetricId.VO2MAX),
    WEIGHT("weight", "Weight", WeightRecord::class, MetricId.WEIGHT),
    SLEEP("sleep", "Sleep", SleepSessionRecord::class, null),
    EXERCISE("workout", "Workouts", ExerciseSessionRecord::class, null),
    SKIN_TEMPERATURE("skin_temperature", "Skin temperature", SkinTemperatureRecord::class, MetricId.SKIN_TEMP_DEVIATION,
        feature = HealthConnectFeatures.FEATURE_SKIN_TEMPERATURE),
    ;

    /** Steps and active energy are read as hourly totals from the aggregation API, which removes duplicates. */
    val isCumulative: Boolean get() = this == STEPS || this == ACTIVE_ENERGY

    val readPermission: String get() = HealthPermission.getReadPermission(recordClass)
}

object HcPermissions {
    /** Read only for workout distance; not synced as its own type. */
    val DISTANCE: String = HealthPermission.getReadPermission(DistanceRecord::class)
    const val HISTORY: String = HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY
    const val BACKGROUND: String = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND
}
