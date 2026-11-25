package app.askwearables.sync.ui

import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity

/** Shown from Health Connect's permission screen ("privacy policy" link). Must match the Play Console privacy policy. */
class PermissionsRationaleActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (16 * resources.displayMetrics.density).toInt()
        setContentView(ScrollView(this).apply {
            addView(TextView(this@PermissionsRationaleActivity).apply {
                setPadding(pad, pad, pad, pad)
                textSize = 15f
                text = """
                    How AskWearables Sync uses your health data

                    This app reads the Health Connect data types you allow (steps, active energy, heart rate, resting heart rate, heart rate variability, blood oxygen, respiratory rate, VO2 max, weight, sleep, exercise with distance, and skin temperature) and sends them to your own AskWearables account over an encrypted connection.

                    Past data: with the history permission the app can send data older than 30 days. Without it, Health Connect only shows the app the 30 days before you first connected.

                    Background: with the background permission the app syncs about once an hour. Without it, the app syncs when you open it.

                    Nothing is written to Health Connect. Nothing is sold or used for advertising. Apps and agents only see your data through grants you create in AskWearables, and every release is logged in your audit receipts.

                    You can revoke any permission at any time in Health Connect settings, and delete your data from your AskWearables account.
                """.trimIndent()
            })
        })
    }
}
