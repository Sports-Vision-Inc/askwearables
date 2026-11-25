// Capability matrix per provider and tier, read at runtime (spec: "Gated tiers ... A capability matrix per provider and tier").
// docs/providers/README.md renders this object; a test keeps the two in sync. Sources: docs/providers/<name>.md, read 2026-11-24.
import type { MetricId, TermsFlags } from "@askwearables/core";
import type { Capabilities, ProviderId } from "./connector.js";

export interface TierCapabilities {
  tier: string;
  accessPath: string;
  webhooks: boolean;
  backfill: boolean;
  /** Days of history readable; null when the provider documents no limit. */
  historyDays: number | null;
  /** Users allowed before vendor approval or at this tier; null when unstated. */
  userCap: number | null;
  notes?: string;
}

export interface ProviderCapabilities {
  provider: ProviderId;
  label: string;
  metrics: MetricId[];
  /** Proprietary scores emitted as vendor_score records, never as metrics. */
  vendorScores: string[];
  termsFlags: TermsFlags;
  /** The tier the connector assumes unless the host says otherwise. */
  defaultTier: string;
  tiers: TierCapabilities[];
  docs: string;
}

export const CAPABILITY_MATRIX: Record<ProviderId, ProviderCapabilities> = {
  oura: {
    provider: "oura",
    label: "Oura API v2",
    metrics: ["steps", "active_energy", "resting_hr", "heart_rate", "hrv_rmssd", "sleep_duration", "sleep_efficiency", "sleep_stages", "spo2", "respiratory_rate", "skin_temp_deviation", "vo2max", "workout"],
    vendorScores: ["readiness", "sleep_score", "activity_score"],
    // Oura API Agreement (effective 2026-06-08) s.4(d): no prompting or providing data to any AI model except via Oura's MCP server;
    // "Aggregator" rules restrict passing data to third parties. See docs/providers/oura.md.
    termsFlags: { no_ai: true, no_intermediary: true },
    defaultTier: "unapproved",
    tiers: [
      { tier: "unapproved", accessPath: "Cloud REST, OAuth2 (PKCE)", webhooks: true, backfill: true, historyDays: null, userCap: 10, notes: "Personal access tokens retired Dec 2025" },
      { tier: "approved", accessPath: "Cloud REST, OAuth2 (PKCE)", webhooks: true, backfill: true, historyDays: null, userCap: null, notes: "Each Aggregator end customer needs Oura approval" },
      { tier: "sandbox", accessPath: "Cloud REST /v2/sandbox, fake data", webhooks: false, backfill: true, historyDays: null, userCap: null },
    ],
    docs: "docs/providers/oura.md",
  },
  whoop: {
    provider: "whoop",
    label: "WHOOP API v2",
    metrics: ["resting_hr", "hrv_rmssd", "sleep_duration", "sleep_efficiency", "sleep_stages", "spo2", "respiratory_rate", "workout", "weight"],
    vendorScores: ["recovery", "strain", "sleep_performance"],
    // Terms 4.2.3 ban using data to create/train/test/improve AI; inference is not named. TODO(verify) with WHOOP in writing.
    termsFlags: {},
    defaultTier: "sandbox",
    tiers: [
      { tier: "sandbox", accessPath: "Cloud REST, OAuth2", webhooks: true, backfill: true, historyDays: null, userCap: 10 },
      { tier: "build", accessPath: "Cloud REST, OAuth2", webhooks: true, backfill: true, historyDays: null, userCap: 100 },
      { tier: "growth", accessPath: "Cloud REST, OAuth2", webhooks: true, backfill: true, historyDays: null, userCap: 1000 },
      { tier: "scale", accessPath: "Cloud REST, OAuth2", webhooks: true, backfill: true, historyDays: null, userCap: 5000 },
      { tier: "production", accessPath: "Cloud REST, OAuth2", webhooks: true, backfill: true, historyDays: null, userCap: null },
    ],
    docs: "docs/providers/whoop.md",
  },
  "google-health": {
    provider: "google-health",
    label: "Google Health API v4",
    metrics: ["steps", "active_energy", "resting_hr", "heart_rate", "hrv_rmssd", "sleep_duration", "sleep_efficiency", "sleep_stages", "spo2", "respiratory_rate", "skin_temp_deviation", "vo2max", "weight", "workout"],
    vendorScores: [],
    termsFlags: {},
    defaultTier: "unverified",
    tiers: [
      { tier: "unverified", accessPath: "Cloud REST/gRPC, Google OAuth 2.0 (Restricted scopes)", webhooks: true, backfill: true, historyDays: null, userCap: 100, notes: "2.5 QPS per user" },
      { tier: "verified", accessPath: "Cloud REST/gRPC, Google OAuth 2.0 (Restricted scopes)", webhooks: true, backfill: true, historyDays: null, userCap: null, notes: "OAuth verification plus annual CASA assessment" },
    ],
    docs: "docs/providers/google-health.md",
  },
  garmin: {
    provider: "garmin",
    label: "Garmin Health and Activity API",
    metrics: ["steps", "active_energy", "resting_hr", "heart_rate", "sleep_duration", "sleep_stages", "spo2", "weight", "workout"],
    vendorScores: ["stress"], // Body Battery field names unconfirmed: TODO(verify), not mapped yet
    termsFlags: {},
    defaultTier: "starter",
    tiers: [
      { tier: "personal", accessPath: "Personal API (own account, API key -> 24h token, pull)", webhooks: false, backfill: false, historyDays: null, userCap: 1, notes: "Not for apps serving other users; not implemented here" },
      { tier: "starter", accessPath: "Cloud REST, OAuth2 PKCE, push only", webhooks: true, backfill: false, historyDays: 0, userCap: 1000, notes: "User cap from press reports; TODO(verify)" },
      { tier: "enterprise", accessPath: "Cloud REST, OAuth2 PKCE, push or ping/pull", webhooks: true, backfill: true, historyDays: 30, userCap: null, notes: "Garmin says history '1 month +'; backfill arrives via webhooks" },
    ],
    docs: "docs/providers/garmin.md",
  },
  polar: {
    provider: "polar",
    label: "Polar AccessLink v3",
    metrics: ["steps", "active_energy", "hrv_rmssd", "sleep_duration", "sleep_stages", "respiratory_rate", "workout"],
    vendorScores: ["nightly_recharge", "ans_charge", "sleep_score"],
    termsFlags: {},
    defaultTier: "standard",
    tiers: [
      {
        tier: "standard",
        accessPath: "Cloud REST, OAuth2 (no refresh; ~1 year tokens)",
        webhooks: true,
        backfill: true,
        historyDays: 365,
        userCap: null,
        notes: "Daily activity 365 days (28-day ranges); exercises 30 days; sleep and Nightly Recharge 28 days",
      },
    ],
    docs: "docs/providers/polar.md",
  },
  strava: {
    provider: "strava",
    label: "Strava API v3",
    metrics: ["workout"],
    vendorScores: [],
    // API Policy (2026) s.5.3 bans AI use incl. context-window ingestion; s.5.16 bans intermediaries; display to the user only.
    termsFlags: { no_ai: true, no_intermediary: true, display_to_user_only: true },
    defaultTier: "single_player",
    tiers: [
      { tier: "single_player", accessPath: "Cloud REST, OAuth2", webhooks: true, backfill: true, historyDays: null, userCap: 1 },
      { tier: "standard", accessPath: "Cloud REST, OAuth2", webhooks: true, backfill: true, historyDays: null, userCap: 10, notes: "Developer needs a paid Strava subscription from June 2026" },
    ],
    docs: "docs/providers/strava.md",
  },
  "open-wearables": {
    provider: "open-wearables",
    label: "Open Wearables (self-hosted)",
    metrics: ["steps", "active_energy", "resting_hr", "heart_rate", "hrv_rmssd", "hrv_sdnn", "sleep_duration", "sleep_efficiency", "sleep_stages", "spo2", "respiratory_rate", "vo2max", "weight", "workout"],
    vendorScores: [],
    // Per-record upstream terms still apply: records whose source.provider is Strava are dropped on normalize.
    termsFlags: {},
    defaultTier: "self_hosted",
    tiers: [
      { tier: "self_hosted", accessPath: "Self-hosted REST /api/v1, API key", webhooks: true, backfill: true, historyDays: null, userCap: null, notes: "History limited by each upstream provider; outgoing webhooks via Svix, off by default" },
    ],
    docs: "docs/providers/open-wearables.md",
  },
};

/** Capabilities a connector reports, for a given tier (default: the provider's default tier). */
export function capabilitiesFor(provider: ProviderId, tier?: string): Capabilities {
  const p = CAPABILITY_MATRIX[provider];
  const t = p.tiers.find((x) => x.tier === (tier ?? p.defaultTier));
  if (!t) throw new Error(`unknown_tier:${provider}:${tier}`);
  return { metrics: [...p.metrics], webhooks: t.webhooks, backfill: t.backfill, historyDays: t.historyDays, termsFlags: { ...p.termsFlags } };
}

const yn = (b: boolean) => (b ? "yes" : "no");
const flags = (f: TermsFlags) =>
  Object.entries(f)
    .filter(([, v]) => v)
    .map(([k]) => `\`${k}\``)
    .join(", ") || "none";

/** The capability matrix as a Markdown table. docs/providers/README.md embeds this verbatim. */
export function renderMatrixMarkdown(): string {
  const rows = [
    "| Provider | Tier | Access path | Webhooks | Backfill | History limit | User cap | Terms flags |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const p of Object.values(CAPABILITY_MATRIX)) {
    for (const t of p.tiers) {
      const hist = t.historyDays === null ? "not documented" : t.historyDays === 0 ? "none" : `${t.historyDays} days`;
      rows.push(
        `| ${p.label} | ${t.tier}${t.tier === p.defaultTier ? " (default)" : ""} | ${t.accessPath} | ${yn(t.webhooks)} | ${yn(t.backfill)} | ${hist} | ${t.userCap ?? "none stated"} | ${flags(p.termsFlags)} |`,
      );
    }
  }
  return rows.join("\n");
}
