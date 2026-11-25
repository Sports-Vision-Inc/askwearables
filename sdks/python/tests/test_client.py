import hashlib
import hmac
import json
import unittest
from email.utils import formatdate
from typing import Any, Callable, Optional, Union
from urllib.parse import urlsplit

import _setup  # noqa: F401
from askwearables import AskWearables, AskWearablesError, Response, parse_retry_after

NOW = 1764000000.0
PACKET = {
    "packet_version": "1", "packet_id": "pk_0123456789abcdef01234567", "level": 1, "operation": "compare_to_baseline",
    "metrics": ["sleep_duration"], "window": {"start": "2026-11-18", "end": "2026-11-24"},
    "findings": [{"metric": "sleep_duration", "statement": "Sleep moderately below usual, 3 nights", "direction": "below", "magnitude": "moderate"}],
    "data_quality": {"freshness_hours": 5, "coverage": 0.9, "sources": ["apple_health"], "baseline_days": 28, "caveats": []},
    "as_of": "2026-11-24T10:00:00Z", "data_version": "dv_1", "not_medical_advice": True,
}


def res(body: Any, status: int = 200, headers: Optional[dict[str, str]] = None) -> Response:
    return Response(status, headers or {}, b"" if body is None else json.dumps(body).encode())


class Mock:
    def __init__(self, responses: list[Union[Response, Callable[[dict[str, Any]], Response]]]):
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def __call__(self, method: str, url: str, headers: dict[str, str], body: Optional[bytes], timeout: float) -> Response:
        call = {"method": method, "url": url, "headers": dict(headers), "body": body or b""}
        self.calls.append(call)
        r = self.responses.pop(0)
        return r(call) if callable(r) else r


def verify(call: dict[str, Any], secret: str = "awsig_secret") -> bool:
    h = call["headers"]
    msg = "\n".join([h["X-AskWearables-Timestamp"], h["X-AskWearables-Nonce"], call["method"], urlsplit(call["url"]).path, hashlib.sha256(call["body"]).hexdigest()])
    return hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest() == h["X-AskWearables-Signature"]


def client(mock: Mock, **kw: Any) -> tuple[AskWearables, list[float]]:
    sleeps: list[float] = []
    opts: dict[str, Any] = dict(api_key="aw_dev_key", signing_secret="awsig_secret", base_url="https://api.example.test/", user="user-42",
                                transport=mock, now=lambda: NOW, sleep=sleeps.append)
    opts.update(kw)
    return AskWearables(**opts), sleeps


class ClientTest(unittest.TestCase):
    def test_ask_signed(self) -> None:
        m = Mock([res({"status": "ok", "packet": PACKET, "receipt_id": "rc_1"})])
        c, _ = client(m)
        out = c.ask("Am I rested?", purpose="scheduling")
        self.assertEqual(out["status"], "ok")
        call = m.calls[0]
        self.assertEqual(call["url"], "https://api.example.test/v1/ask")
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["headers"]["Authorization"], "Bearer aw_dev_key")
        self.assertEqual(call["headers"]["X-AskWearables-User"], "user-42")
        self.assertEqual(call["headers"]["X-AskWearables-Timestamp"], str(int(NOW)))
        self.assertEqual(json.loads(call["body"]), {"question": "Am I rested?", "purpose": "scheduling"})
        self.assertTrue(verify(call))

    def test_denial_is_a_result(self) -> None:
        m = Mock([res({"status": "denied", "reasons": ["metric_not_in_grant:hrv_rmssd"]}, 403)])
        c, _ = client(m)
        self.assertEqual(c.ask("Is my HRV going up?")["reasons"], ["metric_not_in_grant:hrv_rmssd"])

    def test_get_signed_over_empty_body(self) -> None:
        m = Mock([res({"operations": [], "metrics": [], "levels": [], "grant": None, "examples": []})])
        c, _ = client(m)
        self.assertIsNone(c.capabilities(user="other")["grant"])
        self.assertEqual(m.calls[0]["body"], b"")
        self.assertEqual(m.calls[0]["headers"]["X-AskWearables-User"], "other")
        self.assertNotIn("Content-Type", m.calls[0]["headers"])
        self.assertTrue(verify(m.calls[0]))

    def test_unsigned_without_secret(self) -> None:
        m = Mock([res({"status": "ok", "packet": PACKET})])
        c = AskWearables("oauth-token", transport=m)
        c.query({"metrics": ["steps"], "operation": "trend", "window": {"start": "2026-11-01", "end": "2026-11-24"}})
        self.assertEqual(m.calls[0]["url"], "https://api.askwearables.app/v1/query")
        self.assertNotIn("X-AskWearables-Signature", m.calls[0]["headers"])
        self.assertNotIn("X-AskWearables-User", m.calls[0]["headers"])

    def test_retry_after_429(self) -> None:
        m = Mock([res({"error": "rate_limited"}, 429, {"Retry-After": "2"}), res({"error": "rate_limited"}, 429, {"retry-after": "1"}), res({"status": "ok", "packet": PACKET})])
        c, sleeps = client(m)
        self.assertEqual(c.ask("How much did I sleep this week?")["status"], "ok")
        self.assertEqual(sleeps, [2.0, 1.0])
        self.assertEqual(len({x["headers"]["X-AskWearables-Nonce"] for x in m.calls}), 3)
        for x in m.calls:
            self.assertTrue(verify(x))

    def test_retry_after_forms(self) -> None:
        self.assertEqual(parse_retry_after(formatdate(NOW + 5, usegmt=True), NOW), 5.0)
        self.assertIsNone(parse_retry_after("garbage", NOW))
        m = Mock([res(None, 429), res([])])
        c, sleeps = client(m)
        self.assertEqual(c.usage(), [])
        self.assertEqual(sleeps, [1.0])

    def test_gives_up(self) -> None:
        m = Mock([res({}, 429, {"retry-after": "1"}), res({}, 429, {"retry-after": "1"})])
        c, _ = client(m, max_retries=1)
        with self.assertRaises(AskWearablesError) as cm:
            c.usage()
        self.assertEqual(cm.exception.status, 429)
        m2 = Mock([res({}, 429, {"retry-after": "600"})])
        c2, sleeps = client(m2)
        with self.assertRaises(AskWearablesError) as cm2:
            c2.usage()
        self.assertEqual(cm2.exception.retry_after, 600.0)
        self.assertEqual(sleeps, [])

    def test_error_code(self) -> None:
        m = Mock([res({"error": "unknown_user"}, 400)])
        c, _ = client(m)
        with self.assertRaises(AskWearablesError) as cm:
            c.capabilities()
        self.assertEqual((cm.exception.status, cm.exception.code), (400, "unknown_user"))

    def test_get_packet(self) -> None:
        m = Mock([res({"error": "not_found"}, 404), res(PACKET)])
        c, _ = client(m)
        self.assertIsNone(c.get_packet("pk_000000000000000000000000"))
        self.assertEqual(m.calls[0]["url"], "https://api.example.test/v1/packets/pk_000000000000000000000000")
        p = c.get_packet(PACKET["packet_id"])
        self.assertEqual(p and p["packet_id"], PACKET["packet_id"])

    def test_create_user(self) -> None:
        m = Mock([res({"user": "user-7", "created": True})])
        c, _ = client(m)
        self.assertEqual(c.create_user("user-7", tz="Europe/London"), {"user": "user-7", "created": True})
        self.assertEqual(json.loads(m.calls[0]["body"]), {"external_id": "user-7", "tz": "Europe/London"})
        self.assertNotIn("X-AskWearables-User", m.calls[0]["headers"])

    def test_grant_link(self) -> None:
        req: Any = {"purpose": "sleep_coaching", "metrics": ["sleep_duration"], "max_level": 1, "max_window_days": 30, "daily_packet_budget": 20, "days": 30}
        m = Mock([res({"url": "https://auth.askwearables.app/consent/cl_abc", "expires_in": 3600}), res({"error": "invalid_request", "details": ["metrics_empty"]})])
        c, _ = client(m)
        self.assertIn("/consent/", c.create_grant_link(req)["url"])
        self.assertTrue(verify(m.calls[0]))
        with self.assertRaises(AskWearablesError) as cm:
            c.create_grant_link({**req, "metrics": []})
        self.assertEqual(cm.exception.code, "invalid_request")

    def test_ingest_batches(self) -> None:
        def answer(rejected: list[dict[str, Any]], unchanged: int, dv: str) -> Callable[[dict[str, Any]], Response]:
            return lambda call: res({"written": len(json.loads(call["body"])["records"]), "unchanged": unchanged, "rejected": rejected, "days_recomputed": 1, "data_version": dv})

        m = Mock([answer([{"index": 3, "reason": "implausible:steps"}], 0, "dv_a"), answer([{"index": 0, "reason": "bad_offset"}], 1, "dv_b")])
        c, _ = client(m)
        records = [{"kind": "sample", "metric": "steps", "start": "2026-11-01T00:00:00Z", "end": "2026-11-01T01:00:00Z", "value": i, "unit": "count", "method": "measured", "tz_offset_min": 0, "external_id": f"s{i}"} for i in range(2500)]
        out = c.ingest({"id": "phone:1", "provider": "apple_health", "device_class": "watch"}, records)
        self.assertEqual(len(m.calls), 2)
        first = json.loads(m.calls[0]["body"])
        self.assertEqual(len(first["records"]), 2000)
        self.assertEqual(first["records"][0]["source_id"], "phone:1")
        self.assertEqual(first["source"]["terms_flags"], {})
        self.assertIsNone(first["source"]["device_model"])
        self.assertEqual(first["source"]["connected_at"], "2025-11-24T16:00:00.000Z")
        self.assertEqual(out, {"written": 2500, "unchanged": 1, "rejected": [{"index": 3, "reason": "implausible:steps"}, {"index": 2000, "reason": "bad_offset"}], "days_recomputed": 2, "data_version": "dv_b"})

    def test_signed_path_excludes_query(self) -> None:
        m = Mock([res({"receipts": []})])
        c, _ = client(m)
        c.request("receipts", query={"limit": 5})
        self.assertEqual(m.calls[0]["url"], "https://api.example.test/v1/receipts?limit=5")
        self.assertTrue(verify(m.calls[0]))


if __name__ == "__main__":
    unittest.main()
