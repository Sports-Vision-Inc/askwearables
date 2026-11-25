package app.askwearables.sync.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.lifecycle.lifecycleScope
import app.askwearables.sync.SyncApp
import app.askwearables.sync.hc.HcPermissions
import app.askwearables.sync.hc.HcType
import app.askwearables.sync.model.DeviceClass
import app.askwearables.sync.work.SyncScheduler
import kotlinx.coroutines.launch
import java.time.Instant

/** Onboarding, token entry and sync status. Plain Views keep the dependency list short. */
class MainActivity : ComponentActivity() {
    private val app by lazy { SyncApp.from(this) }
    private lateinit var status: TextView
    private lateinit var types: TextView
    private lateinit var connect: Button
    private lateinit var syncNow: Button
    private lateinit var permissionLauncher: ActivityResultLauncher<Set<String>>

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        permissionLauncher = registerForActivityResult(PermissionController.createRequestPermissionResultContract()) { granted ->
            if (granted.any { p -> HcType.entries.any { it.readPermission == p } }) {
                if (app.prefs.firstGrantAt == null) app.prefs.firstGrantAt = Instant.now()
                app.prefs.historyGranted = HcPermissions.HISTORY in granted
                SyncScheduler.schedulePeriodic(this)
                runSync()
            }
            refresh()
        }
        setContentView(buildUi())
    }

    override fun onResume() {
        super.onResume()
        refresh()
        // Foreground is always allowed to read, so catch up whenever the app is opened.
        if (app.prefs.firstGrantAt != null && !app.tokens.read().isNullOrBlank()) runSync()
    }

    private fun buildUi(): View {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        fun text(s: String, size: Float = 15f) = TextView(this).apply { text = s; textSize = size; setPadding(0, pad / 2, 0, pad / 2) }

        col.addView(text("AskWearables Sync", 22f))
        status = text("")
        col.addView(status)

        connect = Button(this).apply { text = "Connect Health Connect"; setOnClickListener { requestPermissions() } }
        col.addView(connect)
        syncNow = Button(this).apply { text = "Sync now"; setOnClickListener { runSync() } }
        col.addView(syncNow)

        col.addView(text("Device sync token", 17f))
        val tokenField = EditText(this).apply {
            hint = "Paste device sync token"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        col.addView(tokenField)
        col.addView(Button(this).apply {
            text = "Save token"
            setOnClickListener {
                val t = tokenField.text.toString().trim()
                if (t.isNotEmpty()) { app.tokens.save(t); tokenField.setText(""); refresh() }
            }
        })
        col.addView(Button(this).apply { text = "Remove token"; setOnClickListener { app.tokens.delete(); refresh() } })

        col.addView(text("Main wearable writing to Health Connect", 17f))
        col.addView(Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, DeviceClass.entries.map { it.id })
            setSelection(DeviceClass.entries.indexOf(app.prefs.deviceClass))
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) { app.prefs.deviceClass = DeviceClass.entries[pos] }
                override fun onNothingSelected(p: AdapterView<*>?) {}
            }
        })

        col.addView(text("Data types", 17f))
        types = text("", 13f)
        col.addView(types)

        col.addView(Button(this).apply {
            text = "Re-send all history"
            setOnClickListener { app.prefs.resetAllTokens(); runSync() }
        })
        return ScrollView(this).apply { addView(col) }
    }

    private fun requestPermissions() {
        when (HealthConnectClient.getSdkStatus(this)) {
            HealthConnectClient.SDK_AVAILABLE -> app.sync()?.let { permissionLauncher.launch(it.onboardingPermissions()) }
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                val uri = Uri.parse("market://details?id=com.google.android.apps.healthdata&url=healthconnect%3A%2F%2Fonboarding")
                startActivity(Intent(Intent.ACTION_VIEW, uri).setPackage("com.android.vending"))
            }
            else -> status.text = "Health Connect is not available on this phone (it needs Android 9 or later)."
        }
    }

    private fun runSync() {
        val sync = app.sync() ?: return
        if (app.tokens.read().isNullOrBlank()) { status.text = "Paste your device sync token first."; return }
        syncNow.isEnabled = false
        lifecycleScope.launch {
            try {
                val r = sync.syncAll()
                status.text = "Sent ${r.sent} records." + if (r.errors.isEmpty()) "" else " Some types failed; see below."
            } catch (e: Exception) {
                status.text = "Sync failed: ${e.message}"
            } finally {
                syncNow.isEnabled = true
                refresh()
            }
        }
    }

    private fun refresh() {
        val sdk = HealthConnectClient.getSdkStatus(this)
        val hasToken = !app.tokens.read().isNullOrBlank()
        lifecycleScope.launch {
            val sync = app.sync()
            val granted = try { sync?.grantedPermissions() ?: emptySet() } catch (e: Exception) { emptySet() }
            val lines = mutableListOf<String>()
            lines += when (sdk) {
                HealthConnectClient.SDK_AVAILABLE -> "Health Connect: available"
                HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "Health Connect: needs install or update"
                else -> "Health Connect: not available"
            }
            lines += if (hasToken) "Sync token: saved (encrypted with the Android Keystore)" else "Sync token: not set"
            lines += "History access: " + if (HcPermissions.HISTORY in granted) "granted (all past data)" else "not granted (30 days before first connect)"
            lines += "Background access: " + if (HcPermissions.BACKGROUND in granted) "granted (hourly background sync)" else "not granted (syncs when the app is open)"
            lines += "Earliest readable date: " + (sync?.earliestReadable() ?: "unknown")
            status.text = lines.joinToString("\n")
            connect.text = if (granted.isEmpty()) "Connect Health Connect" else "Review Health Connect permissions"

            types.text = HcType.entries.joinToString("\n\n") { t ->
                val p = app.prefs
                buildString {
                    append(t.label).append(": ")
                    append(if (t.readPermission in granted) "allowed" else "not allowed")
                    p.lastSyncAt(t)?.let { append(" · last sync ").append(it) }
                    append(" · ").append(p.totalSent(t)).append(" records sent")
                    if (p.deletionsNotForwarded(t) > 0) append(" · ").append(p.deletionsNotForwarded(t)).append(" deletions not forwarded")
                    p.lastError(t)?.let { append("\n  error: ").append(it) }
                }
            }
        }
    }
}
