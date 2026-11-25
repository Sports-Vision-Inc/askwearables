"""Response and request shapes, matching sdks/openapi.json and what the API returns."""

from __future__ import annotations

from typing import Any, Literal, Optional, TypedDict, Union

Level = Literal[0, 1, 2, 3]
Purpose = Literal["scheduling", "training_advice", "sleep_coaching", "general_wellness", "personal_research"]
Operation = Literal[
    "latest", "aggregate", "trend", "compare_to_baseline", "compare_periods", "threshold_check", "correlate", "list_sessions"
]


class DateWindow(TypedDict):
    start: str
    end: str


class _QuerySpecRequired(TypedDict):
    metrics: list[str]
    operation: Operation
    window: DateWindow


class QuerySpec(_QuerySpecRequired, total=False):
    granularity: Literal["day", "week"]
    params: dict[str, Any]


class Finding(TypedDict, total=False):
    metric: str
    statement: str
    flag: Literal["yes", "no", "unknown"]
    direction: str
    magnitude: str
    value: float
    unit: str
    values: list[dict[str, Any]]
    unknown_reason: str


class DataQuality(TypedDict, total=False):
    freshness_hours: Optional[float]
    coverage: Optional[float]
    sources: list[str]
    baseline_days: Optional[int]
    caveats: list[str]


class Packet(TypedDict, total=False):
    packet_version: Literal["1"]
    packet_id: str
    level: int
    operation: Operation
    metrics: list[str]
    window: DateWindow
    findings: list[Finding]
    data_quality: DataQuality
    as_of: str
    data_version: str
    not_medical_advice: Literal[True]


class AskResponse(TypedDict, total=False):
    status: Literal["ok", "denied", "unsupported"]
    packet: Packet
    receipt_id: str
    reasons: list[str]
    supported: list[str]


class _GrantRequestRequired(TypedDict):
    purpose: Purpose
    metrics: list[str]
    max_level: Level
    max_window_days: int
    daily_packet_budget: int
    days: int


class GrantRequest(_GrantRequestRequired, total=False):
    return_url: str


class GrantLink(TypedDict):
    url: str
    expires_in: int


class CreatedUser(TypedDict):
    user: str
    created: bool


class CapabilitiesGrant(TypedDict):
    purpose: Purpose
    max_level: Level
    max_window_days: int
    daily_packet_budget: int
    expires_at: str


class Capabilities(TypedDict):
    operations: list[dict[str, Any]]
    metrics: list[dict[str, Any]]
    levels: list[dict[str, Any]]
    grant: Optional[CapabilitiesGrant]
    examples: list[str]


class Rejected(TypedDict):
    index: int
    reason: str


class IngestResult(TypedDict):
    written: int
    unchanged: int
    rejected: list[Rejected]
    days_recomputed: int
    data_version: str


class UsageDay(TypedDict):
    day: str
    calls: int
    packets: int
    denials: int


Record = dict[str, Any]
QueryResult = Union[AskResponse, dict[str, Any]]
