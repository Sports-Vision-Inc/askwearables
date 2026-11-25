package app.askwearables.sync.net

import app.askwearables.sync.mapping.Mapper
import app.askwearables.sync.model.CanonicalRecord
import app.askwearables.sync.model.IngestBody
import app.askwearables.sync.model.Source
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.time.Duration
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random

data class HttpResponse(val status: Int, val headers: Map<String, String>, val body: String) {
    fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
}

fun interface HttpTransport {
    @Throws(IOException::class)
    suspend fun post(url: String, headers: Map<String, String>, body: ByteArray): HttpResponse
}

class UrlConnectionTransport : HttpTransport {
    override suspend fun post(url: String, headers: Map<String, String>, body: ByteArray): HttpResponse = withContext(Dispatchers.IO) {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = 30_000
            conn.readTimeout = 60_000
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
            conn.setFixedLengthStreamingMode(body.size)
            conn.outputStream.use { it.write(body) }
            val status = conn.responseCode
            val text = (if (status >= 400) conn.errorStream else conn.inputStream)?.bufferedReader()?.use { it.readText() } ?: ""
            val hdrs = conn.headerFields.filterKeys { it != null }.mapValues { it.value.joinToString(",") }
            HttpResponse(status, hdrs, text)
        } finally {
            conn.disconnect()
        }
    }
}

sealed class IngestException(message: String) : Exception(message) {
    object NoToken : IngestException("no device sync token")
    class Unauthorized(val status: Int) : IngestException("token rejected ($status)")
    class Rejected(val status: Int, val body: String) : IngestException("ingest rejected ($status): $body")
    class GaveUp(val lastStatus: Int?) : IngestException("gave up after retries (last status $lastStatus)")
}

data class RetryPolicy(val maxAttempts: Int = 6, val baseDelayMs: Long = 1_000, val maxDelayMs: Long = 300_000) {
    /** Exponential backoff with full jitter. */
    fun backoffMs(attempt: Int, random: Double): Long {
        val cap = min(maxDelayMs.toDouble(), baseDelayMs * 2.0.pow(attempt))
        return (cap * random.coerceIn(0.0, 1.0)).toLong()
    }
}

/** Retry-After as delta-seconds or an HTTP-date. */
fun parseRetryAfterMs(value: String?, now: Instant = Instant.now()): Long? {
    val raw = value?.trim().orEmpty()
    if (raw.isEmpty()) return null
    raw.toDoubleOrNull()?.let { return (it.coerceAtLeast(0.0) * 1000).toLong() }
    return try {
        val at = ZonedDateTime.parse(raw, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant()
        Duration.between(now, at).toMillis().coerceAtLeast(0)
    } catch (e: Exception) {
        null
    }
}

/** POSTs records to {baseUrl}/v1/ingest in batches of at most 2,000. */
class IngestClient(
    private val baseUrl: String = DEFAULT_BASE_URL,
    private val transport: HttpTransport = UrlConnectionTransport(),
    private val policy: RetryPolicy = RetryPolicy(),
    private val tokenProvider: () -> String?,
    private val sleeper: suspend (Long) -> Unit = { delay(it) },
    private val random: () -> Double = { Random.nextDouble() },
) {
    val ingestUrl: String get() = baseUrl.trimEnd('/') + "/v1/ingest"

    /** Throws on the first batch that fails, so the caller keeps its changes token and re-sends later. */
    suspend fun upload(source: Source, records: List<CanonicalRecord>): Int {
        val token = tokenProvider()?.takeIf { it.isNotBlank() } ?: throw IngestException.NoToken
        var requests = 0
        for (batch in Mapper.batches(records)) {
            post(IngestBody(source, batch).toJsonString().toByteArray(Charsets.UTF_8), token)
            requests++
        }
        return requests
    }

    private suspend fun post(body: ByteArray, token: String) {
        val headers = mapOf("Authorization" to "Bearer $token", "Content-Type" to "application/json")
        var lastStatus: Int? = null
        for (attempt in 0 until policy.maxAttempts) {
            val waitMs: Long = try {
                val r = transport.post(ingestUrl, headers, body)
                lastStatus = r.status
                when (r.status) {
                    in 200..299 -> return
                    401, 403 -> throw IngestException.Unauthorized(r.status)
                    429, 408, in 500..599 -> parseRetryAfterMs(r.header("Retry-After")) ?: policy.backoffMs(attempt, random())
                    else -> throw IngestException.Rejected(r.status, r.body.take(500))
                }
            } catch (e: IOException) {
                policy.backoffMs(attempt, random())
            }
            // A Retry-After longer than we will wait ends this run; the next WorkManager run re-sends the same delta.
            if (waitMs > policy.maxDelayMs) throw IngestException.GaveUp(lastStatus)
            if (attempt + 1 < policy.maxAttempts) sleeper(waitMs)
        }
        throw IngestException.GaveUp(lastStatus)
    }

    companion object {
        const val DEFAULT_BASE_URL = "https://api.askwearables.app"
    }
}
