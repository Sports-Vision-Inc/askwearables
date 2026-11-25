"""The AskWearables client: urllib for HTTP, hmac/hashlib for signing, json for bodies."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Iterable, Mapping, Optional, cast

from .signing import sign_request
from .types import AskResponse, Capabilities, CreatedUser, GrantLink, GrantRequest, IngestResult, Packet, QueryResult, QuerySpec, UsageDay

DEFAULT_BASE_URL = "https://api.askwearables.app"
#: The API accepts at most this many records per ingest call; the client splits larger batches.
MAX_INGEST_BATCH = 2000
USER_AGENT = "askwearables-python/1.0.0"

#: Every operation in sdks/openapi.json. tests/test_openapi.py checks this table against the document.
OPERATIONS: dict[str, dict[str, Any]] = {
    "ask": {"method": "POST", "path": "/v1/ask", "user_header": True},
    "query": {"method": "POST", "path": "/v1/query", "user_header": True},
    "capabilities": {"method": "GET", "path": "/v1/capabilities", "user_header": True},
    "getPacket": {"method": "GET", "path": "/v1/packets/{packet_id}", "user_header": True},
    "receipts": {"method": "GET", "path": "/v1/receipts", "user_header": False},
    "createGrantLink": {"method": "POST", "path": "/v1/grants", "user_header": True},
    "revokeGrant": {"method": "DELETE", "path": "/v1/grants/{grant_id}", "user_header": False},
    "createUser": {"method": "POST", "path": "/v1/users", "user_header": False},
    "ingest": {"method": "POST", "path": "/v1/ingest", "user_header": True},
    "usage": {"method": "GET", "path": "/v1/usage", "user_header": False},
    "export": {"method": "GET", "path": "/v1/export", "user_header": False},
}


@dataclass
class Response:
    status: int
    headers: Mapping[str, str]
    body: bytes = b""


#: transport(method, url, headers, body, timeout) -> Response. Replace it in tests.
Transport = Callable[[str, str, dict[str, str], Optional[bytes], float], Response]


def urllib_transport(method: str, url: str, headers: dict[str, str], body: Optional[bytes], timeout: float) -> Response:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 - https base URL by default
            return Response(res.status, {k.lower(): v for k, v in res.headers.items()}, res.read())
    except urllib.error.HTTPError as e:
        return Response(e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, e.read() or b"")


class AskWearablesError(Exception):
    def __init__(self, status: int, code: str, body: Any = None, retry_after: Optional[float] = None):
        super().__init__(f"AskWearables API error {status}: {code}")
        self.status = status
        self.code = code
        self.body = body
        self.retry_after = retry_after


def parse_retry_after(value: Optional[str], now: float) -> Optional[float]:
    """Retry-After as delta seconds or an HTTP date, in seconds; None if absent or unreadable."""
    if not value:
        return None
    v = value.strip()
    try:
        return max(0.0, float(v))
    except ValueError:
        pass
    try:
        dt = parsedate_to_datetime(v)
    except (TypeError, ValueError):
        return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return max(0.0, dt.timestamp() - now)


@dataclass
class AskWearables:
    """Client for the AskWearables REST API.

    ``api_key`` is a developer key (``aw_dev_``), owner key (``aw_own_``), sync key (``aw_sync_``) or an OAuth
    access token. With ``signing_secret`` set, every request is signed with a fresh timestamp and nonce.
    """

    api_key: str
    signing_secret: Optional[str] = None
    base_url: str = DEFAULT_BASE_URL
    user: Optional[str] = None
    max_retries: int = 3
    max_retry_delay: float = 120.0
    timeout: float = 30.0
    transport: Transport = field(default=urllib_transport, repr=False)
    sleep: Callable[[float], None] = field(default=time.sleep, repr=False)
    now: Callable[[], float] = field(default=time.time, repr=False)
    headers: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.api_key:
            raise ValueError("api_key is required")
        self.base_url = self.base_url.rstrip("/")

    # ---------- agent calls ----------

    def ask(self, question: str, *, purpose: Optional[str] = None, user: Optional[str] = None) -> AskResponse:
        """Ask one question in plain language. A denial is a normal result (status "denied", with reasons)."""
        body: dict[str, Any] = {"question": question}
        if purpose is not None:
            body["purpose"] = purpose
        return cast(AskResponse, self.request("ask", body=body, user=user, accept=(403,)))

    def query(self, spec: QuerySpec, *, user: Optional[str] = None) -> QueryResult:
        """Run a QuerySpec directly. Agents are gated like ask; owner keys get level 3."""
        return cast(QueryResult, self.request("query", body={"spec": spec}, user=user, accept=(403,)))

    def capabilities(self, *, user: Optional[str] = None) -> Capabilities:
        """Metrics, operations and levels, plus the grant this agent holds for the user (None if none)."""
        return cast(Capabilities, self.request("capabilities", user=user))

    def get_packet(self, packet_id: str, *, user: Optional[str] = None) -> Optional[Packet]:
        """A packet this agent received in the last 24 hours, or None."""
        try:
            return cast(Packet, self.request("getPacket", path_params={"packet_id": packet_id}, user=user))
        except AskWearablesError as e:
            if e.status == 404:
                return None
            raise

    # ---------- developer platform ----------

    def create_user(self, external_id: str, *, tz: str = "UTC") -> CreatedUser:
        """Register an end user by your own id. Idempotent: an existing user returns created=False."""
        return cast(CreatedUser, self.request("createUser", body={"external_id": external_id, "tz": tz}))

    def create_grant_link(self, request: GrantRequest, *, user: Optional[str] = None) -> GrantLink:
        """A one-time link (valid one hour) to the hosted consent screen for your user."""
        res = self.request("createGrantLink", body=dict(request), user=user)
        if isinstance(res, dict) and "error" in res:
            raise AskWearablesError(200, str(res["error"]), res)
        return cast(GrantLink, res)

    def ingest(self, source: Mapping[str, Any], records: Iterable[Mapping[str, Any]], *, user: Optional[str] = None) -> IngestResult:
        """Push normalized records for one source; batches over 2000 records are split.

        ``source`` needs ``id``, ``provider`` and ``device_class``; other fields get safe defaults.
        Records without a ``source_id`` are given the source's id.
        """
        src: dict[str, Any] = {
            "device_model": None,
            "earliest_readable": None,
            "last_sync_at": None,
            "terms_flags": {},
            "connected_at": datetime.fromtimestamp(self.now(), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            **source,
        }
        recs = [r if r.get("source_id") else {**r, "source_id": src["id"]} for r in records]
        total: IngestResult = {"written": 0, "unchanged": 0, "rejected": [], "days_recomputed": 0, "data_version": ""}
        for i in range(0, max(1, len(recs)), MAX_INGEST_BATCH):
            r = self.request("ingest", body={"source": src, "records": recs[i : i + MAX_INGEST_BATCH]}, user=user)
            total["written"] += int(r.get("written", 0))
            total["unchanged"] += int(r.get("unchanged", 0))
            total["days_recomputed"] += int(r.get("days_recomputed", 0))
            for x in r.get("rejected", []):
                total["rejected"].append({"index": int(x["index"]) + i, "reason": str(x["reason"])})
            total["data_version"] = r.get("data_version", total["data_version"])
        return total

    def usage(self) -> list[UsageDay]:
        """Calls, packets and denials per day for your organization, newest first (31 days)."""
        return cast("list[UsageDay]", self.request("usage"))

    # ---------- transport ----------

    def request(
        self,
        op: str,
        *,
        path_params: Optional[Mapping[str, str]] = None,
        query: Optional[Mapping[str, Any]] = None,
        body: Any = None,
        user: Optional[str] = None,
        accept: Iterable[int] = (),
    ) -> Any:
        """Low-level call for any operation in the OpenAPI document."""
        spec = OPERATIONS[op]
        method: str = spec["method"]
        path: str = spec["path"]
        for k, v in (path_params or {}).items():
            path = path.replace("{" + k + "}", urllib.parse.quote(v, safe=""))
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        signed_path = urllib.parse.urlsplit(url).path
        raw = b"" if body is None else json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        who = user if user is not None else self.user
        accepted = set(accept)

        attempt = 0
        while True:
            headers = {"Accept": "application/json", "Authorization": f"Bearer {self.api_key}", "User-Agent": USER_AGENT, **self.headers}
            if raw:
                headers["Content-Type"] = "application/json"
            if who and spec["user_header"]:
                headers["X-AskWearables-User"] = who
            if self.signing_secret:
                # A fresh timestamp and single-use nonce on every attempt, so a retry is never a replay.
                headers.update(sign_request(self.signing_secret, method, signed_path, raw, timestamp=int(self.now())))
            res = self.transport(method, url, headers, raw or None, self.timeout)
            data: Any
            try:
                data = json.loads(res.body.decode("utf-8")) if res.body else None
            except (ValueError, UnicodeDecodeError):
                data = res.body.decode("utf-8", "replace")

            if res.status == 429:
                hdrs = {k.lower(): v for k, v in res.headers.items()}
                wait = parse_retry_after(hdrs.get("retry-after"), self.now())
                if wait is None:
                    wait = min(self.max_retry_delay, float(2**attempt))
                if attempt >= self.max_retries or wait > self.max_retry_delay:
                    raise AskWearablesError(429, "rate_limited", data, wait)
                self.sleep(wait)
                attempt += 1
                continue
            if 200 <= res.status < 300 or res.status in accepted:
                return data
            code = data["error"] if isinstance(data, dict) and isinstance(data.get("error"), str) else f"http_{res.status}"
            raise AskWearablesError(res.status, code, data)
