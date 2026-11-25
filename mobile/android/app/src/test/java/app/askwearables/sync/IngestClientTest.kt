package app.askwearables.sync

import app.askwearables.sync.mapping.Mapper
import app.askwearables.sync.model.DeviceClass
import app.askwearables.sync.model.MetricId
import app.askwearables.sync.model.Source
import app.askwearables.sync.net.HttpResponse
import app.askwearables.sync.net.HttpTransport
import app.askwearables.sync.net.IngestClient
import app.askwearables.sync.net.IngestException
import app.askwearables.sync.net.RetryPolicy
import app.askwearables.sync.net.parseRetryAfterMs
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.time.Instant
import java.time.ZoneId

class IngestClientTest {
    private class Call(val url: String, val headers: Map<String, String>, val body: String)

    private class FakeTransport(vararg replies: Any) : HttpTransport {
        val queue = ArrayDeque(replies.toList())
        val calls = mutableListOf<Call>()
        override suspend fun post(url: String, headers: Map<String, String>, body: ByteArray): HttpResponse {
            calls += Call(url, headers, String(body))
            return when (val r = queue.removeFirstOrNull() ?: 200) {
                is Int -> HttpResponse(r, emptyMap(), "{}")
                is HttpResponse -> r
                is IOException -> throw r
                else -> error("bad reply")
            }
        }
    }

    private val source = Source("health_connect:t", "health_connect", null, DeviceClass.WATCH, Instant.EPOCH, null, null)
    private fun records(n: Int) = (0 until n).map {
        Mapper.hourlyBucket(MetricId.STEPS, Instant.EPOCH.plusSeconds(it * 3600L), 1.0, "health_connect:t", ZoneId.of("UTC"))
    }

    private fun client(t: FakeTransport, waits: MutableList<Long>, token: String? = "tok") = IngestClient(
        baseUrl = "https://api.askwearables.app", transport = t, policy = RetryPolicy(maxAttempts = 4, baseDelayMs = 1000, maxDelayMs = 60_000),
        tokenProvider = { token }, sleeper = { waits += it }, random = { 1.0 },
    )

    @Test
    fun batchesOf2000WithBearerToken() = runTest {
        val t = FakeTransport()
        assertEquals(3, client(t, mutableListOf()).upload(source, records(4500)))
        assertEquals("https://api.askwearables.app/v1/ingest", t.calls[0].url)
        assertEquals("Bearer tok", t.calls[0].headers["Authorization"])
        assertEquals("application/json", t.calls[0].headers["Content-Type"])
        val sizes = t.calls.map { Json.parseToJsonElement(it.body).jsonObject["records"]!!.jsonArray.size }
        assertEquals(listOf(2000, 2000, 500), sizes)
    }

    @Test
    fun honoursRetryAfterOn429() = runTest {
        val waits = mutableListOf<Long>()
        val t = FakeTransport(HttpResponse(429, mapOf("retry-after" to "7"), ""), 200)
        client(t, waits).upload(source, records(1))
        assertEquals(listOf(7000L), waits)
        assertEquals(2, t.calls.size)
    }

    @Test
    fun exponentialBackoffOn5xxAndIOErrorsThenGivesUp() = runTest {
        val waits = mutableListOf<Long>()
        val t = FakeTransport(503, IOException("reset"), 500, 502)
        try {
            client(t, waits).upload(source, records(1))
            fail()
        } catch (e: IngestException.GaveUp) {
            assertEquals(502, e.lastStatus)
        }
        assertEquals(listOf(1000L, 2000L, 4000L), waits)
        assertEquals(4, t.calls.size)
    }

    @Test
    fun longRetryAfterStopsWithoutWaiting() = runTest {
        val waits = mutableListOf<Long>()
        try {
            client(FakeTransport(HttpResponse(429, mapOf("Retry-After" to "3600"), "")), waits).upload(source, records(1))
            fail()
        } catch (e: IngestException.GaveUp) {
            assertEquals(429, e.lastStatus)
        }
        assertTrue(waits.isEmpty())
    }

    @Test
    fun authAndValidationErrorsAreNotRetried() = runTest {
        val t401 = FakeTransport(401)
        try { client(t401, mutableListOf()).upload(source, records(1)); fail() } catch (e: IngestException.Unauthorized) {}
        assertEquals(1, t401.calls.size)
        val t400 = FakeTransport(400)
        try { client(t400, mutableListOf()).upload(source, records(1)); fail() } catch (e: IngestException.Rejected) { assertEquals(400, e.status) }
        assertEquals(1, t400.calls.size)
    }

    @Test
    fun missingTokenSendsNothing() = runTest {
        val t = FakeTransport()
        try { client(t, mutableListOf(), token = null).upload(source, records(1)); fail() } catch (e: IngestException.NoToken) {}
        assertEquals(0, t.calls.size)
    }

    @Test
    fun retryAfterParsing() {
        val now = Instant.ofEpochSecond(1_000_000)
        assertEquals(120_000L, parseRetryAfterMs("120", now))
        assertNull(parseRetryAfterMs(null, now))
        assertNull(parseRetryAfterMs("soon", now))
        assertEquals(30_000L, parseRetryAfterMs("Mon, 12 Jan 1970 13:47:10 GMT", now))
    }
}
