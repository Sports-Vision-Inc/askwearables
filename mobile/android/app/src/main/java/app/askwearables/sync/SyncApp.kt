package app.askwearables.sync

import android.app.Application
import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import app.askwearables.sync.hc.HealthConnectSync
import app.askwearables.sync.net.IngestClient
import app.askwearables.sync.store.KeystoreTokenStore
import app.askwearables.sync.store.SyncPrefs
import app.askwearables.sync.store.TokenStore
import app.askwearables.sync.work.SyncScheduler

class SyncApp : Application() {
    val prefs: SyncPrefs by lazy { SyncPrefs(this) }
    val tokens: TokenStore by lazy { KeystoreTokenStore(this) }

    /** null when Health Connect is missing or needs an update. */
    fun healthConnect(): HealthConnectClient? =
        if (HealthConnectClient.getSdkStatus(this) == HealthConnectClient.SDK_AVAILABLE) HealthConnectClient.getOrCreate(this) else null

    fun sync(): HealthConnectSync? = healthConnect()?.let { hc ->
        HealthConnectSync(hc, prefs, IngestClient(tokenProvider = { tokens.read() }), packageName)
    }

    override fun onCreate() {
        super.onCreate()
        if (prefs.firstGrantAt != null) SyncScheduler.schedulePeriodic(this)
    }

    companion object {
        fun from(context: Context) = context.applicationContext as SyncApp
    }
}
