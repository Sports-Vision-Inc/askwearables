package app.askwearables.sync.store

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.askwearables.sync.hc.HcType
import app.askwearables.sync.model.DeviceClass
import java.security.KeyStore
import java.time.Instant
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Non-secret state: install id, Changes tokens (one per type), onboarding dates and per-type status. */
class SyncPrefs(context: Context) {
    private val p: SharedPreferences = context.getSharedPreferences("askwearables_sync", Context.MODE_PRIVATE)

    val installId: String
        get() = p.getString("install_id", null) ?: UUID.randomUUID().toString().also { p.edit().putString("install_id", it).apply() }

    val sourceId: String get() = "health_connect:$installId"

    var deviceClass: DeviceClass
        get() = p.getString("device_class", null)?.let { id -> DeviceClass.entries.firstOrNull { it.id == id } } ?: DeviceClass.WATCH
        set(v) = p.edit().putString("device_class", v.id).apply()

    /** When read permission was first granted. Without the history permission, the 30-day window counts back from here. */
    var firstGrantAt: Instant?
        get() = p.getLong("first_grant_at", 0).takeIf { it > 0 }?.let(Instant::ofEpochMilli)
        set(v) = p.edit().putLong("first_grant_at", v?.toEpochMilli() ?: 0).apply()

    val connectedAt: Instant get() = firstGrantAt ?: Instant.now()

    var historyGranted: Boolean
        get() = p.getBoolean("history_granted", false)
        set(v) = p.edit().putBoolean("history_granted", v).apply()

    /** Earliest instant any synced record started at; used as earliest_readable when history access is granted. */
    var earliestSeen: Instant?
        get() = p.getLong("earliest_seen", 0).takeIf { it != 0L }?.let(Instant::ofEpochMilli)
        set(v) = p.edit().putLong("earliest_seen", v?.toEpochMilli() ?: 0).apply()

    fun noteSeen(i: Instant) {
        val cur = earliestSeen
        if (cur == null || i < cur) earliestSeen = i
    }

    fun changesToken(t: HcType): String? = p.getString("token.${t.key}", null)
    fun setChangesToken(t: HcType, token: String?) = p.edit().putString("token.${t.key}", token).apply()

    fun lastSyncAt(t: HcType): Instant? = p.getLong("last_sync.${t.key}", 0).takeIf { it > 0 }?.let(Instant::ofEpochMilli)
    fun setLastSyncAt(t: HcType, i: Instant) = p.edit().putLong("last_sync.${t.key}", i.toEpochMilli()).apply()

    fun totalSent(t: HcType): Long = p.getLong("sent.${t.key}", 0)
    fun addSent(t: HcType, n: Int) = p.edit().putLong("sent.${t.key}", totalSent(t) + n).apply()

    fun deletionsNotForwarded(t: HcType): Long = p.getLong("deleted.${t.key}", 0)
    fun addDeletions(t: HcType, n: Int) = p.edit().putLong("deleted.${t.key}", deletionsNotForwarded(t) + n).apply()

    fun lastError(t: HcType): String? = p.getString("error.${t.key}", null)
    fun setLastError(t: HcType, e: String?) = p.edit().putString("error.${t.key}", e).apply()

    fun resetAllTokens() = p.edit().apply { HcType.entries.forEach { remove("token.${it.key}") } }.apply()
}

interface TokenStore {
    fun read(): String?
    fun save(token: String)
    fun delete()
}

/**
 * Device sync token, encrypted with an AES-GCM key that lives in the Android Keystore and never leaves it.
 * (androidx.security EncryptedSharedPreferences is deprecated, so this uses the Keystore directly.)
 */
class KeystoreTokenStore(context: Context) : TokenStore {
    private val p = context.getSharedPreferences("askwearables_secret", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    override fun read(): String? {
        val blob = p.getString("token", null) ?: return null
        return try {
            val bytes = Base64.decode(blob, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
            String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
        } catch (e: Exception) {
            null
        }
    }

    override fun save(token: String) {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        val ct = cipher.doFinal(token.trim().toByteArray(Charsets.UTF_8))
        p.edit().putString("token", Base64.encodeToString(iv + ct, Base64.NO_WRAP)).apply()
    }

    override fun delete() {
        p.edit().remove("token").apply()
    }

    private companion object {
        const val ALIAS = "askwearables_sync_token"
        const val TRANSFORM = "AES/GCM/NoPadding"
    }
}
