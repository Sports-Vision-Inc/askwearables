package app.askwearables.sync.work

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.BackoffPolicy
import app.askwearables.sync.SyncApp
import app.askwearables.sync.net.IngestException
import java.util.concurrent.TimeUnit

class SyncWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        val app = SyncApp.from(applicationContext)
        val sync = app.sync() ?: return Result.success() // Health Connect unavailable: nothing to do.
        if (app.tokens.read().isNullOrBlank()) return Result.success()
        return try {
            val r = sync.syncAll()
            // Retry the run when an upload failed for a transient reason; tokens were not advanced for those types.
            if (r.errors.isNotEmpty() && runAttemptCount < 3) Result.retry() else Result.success()
        } catch (e: IngestException.Unauthorized) {
            Result.failure()
        } catch (e: Exception) {
            if (runAttemptCount < 3) Result.retry() else Result.failure()
        }
    }
}

object SyncScheduler {
    private const val PERIODIC = "askwearables_periodic_sync"
    private const val NOW = "askwearables_sync_now"

    private val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /**
     * Hourly periodic job. Background reads need READ_HEALTH_DATA_IN_BACKGROUND; without it the job's reads fail
     * while the app is not in the foreground, and data is picked up on the next app open instead.
     */
    fun schedulePeriodic(context: Context) {
        val req = PeriodicWorkRequestBuilder<SyncWorker>(1, TimeUnit.HOURS)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    fun syncNow(context: Context) {
        val req = OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(constraints).build()
        WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.KEEP, req)
    }
}
