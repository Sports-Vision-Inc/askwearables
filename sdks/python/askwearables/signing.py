"""Request signing for developer keys (HMAC-SHA256, stdlib only).

signature = hex(HMAC-SHA256(secret, f"{timestamp}\\n{nonce}\\n{METHOD}\\n{path}\\n{sha256hex(body)}"))

``path`` is the URL path without the query string; ``body`` is the exact bytes sent (empty for GET).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time

__all__ = ["sha256_hex", "hmac_sha256_hex", "new_nonce", "canonical_string", "sign_request", "verify_webhook"]


def _b(data: str | bytes) -> bytes:
    return data.encode("utf-8") if isinstance(data, str) else data


def sha256_hex(data: str | bytes) -> str:
    return hashlib.sha256(_b(data)).hexdigest()


def hmac_sha256_hex(secret: str, message: str | bytes) -> str:
    return hmac.new(_b(secret), _b(message), hashlib.sha256).hexdigest()


def new_nonce() -> str:
    """24 URL-safe characters; the API accepts [A-Za-z0-9_-]{16,64}."""
    return base64.urlsafe_b64encode(secrets.token_bytes(18)).decode("ascii").rstrip("=")


def canonical_string(timestamp: str, nonce: str, method: str, path: str, body_sha256: str) -> str:
    return "\n".join([timestamp, nonce, method.upper(), path, body_sha256])


def sign_request(
    secret: str,
    method: str,
    path: str,
    body: str | bytes = b"",
    *,
    timestamp: int | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    ts = str(int(time.time()) if timestamp is None else int(timestamp))
    n = nonce or new_nonce()
    sig = hmac_sha256_hex(secret, canonical_string(ts, n, method, path, sha256_hex(body)))
    return {"X-AskWearables-Timestamp": ts, "X-AskWearables-Nonce": n, "X-AskWearables-Signature": sig}


def verify_webhook(
    secret: str,
    timestamp: str | None,
    signature: str | None,
    body: str | bytes,
    *,
    tolerance_seconds: int = 300,
    now: float | None = None,
) -> bool:
    """Verify a grant webhook: ``signature == "sha256=" + hex(HMAC(secret, f"{timestamp}.{body}"))``."""
    if not timestamp or not signature:
        return False
    try:
        ts = int(timestamp)
    except ValueError:
        return False
    current = time.time() if now is None else now
    if abs(current - ts) > tolerance_seconds:
        return False
    expected = "sha256=" + hmac_sha256_hex(secret, _b(timestamp) + b"." + _b(body))
    return hmac.compare_digest(expected, signature)
