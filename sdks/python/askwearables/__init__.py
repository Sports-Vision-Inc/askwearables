"""AskWearables: a broker between wearable data and AI agents. Python client (stdlib only)."""

from .client import (
    DEFAULT_BASE_URL,
    MAX_INGEST_BATCH,
    OPERATIONS,
    AskWearables,
    AskWearablesError,
    Response,
    parse_retry_after,
)
from .signing import canonical_string, hmac_sha256_hex, new_nonce, sha256_hex, sign_request, verify_webhook

__version__ = "1.0.0"

__all__ = [
    "AskWearables",
    "AskWearablesError",
    "DEFAULT_BASE_URL",
    "MAX_INGEST_BATCH",
    "OPERATIONS",
    "Response",
    "canonical_string",
    "hmac_sha256_hex",
    "new_nonce",
    "parse_retry_after",
    "sha256_hex",
    "sign_request",
    "verify_webhook",
]
