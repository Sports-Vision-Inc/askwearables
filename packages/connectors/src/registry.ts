// Connector registry with per-provider feature flags. Every live provider ships OFF; the host turns them on.
import type { TermsFlags } from "@askwearables/core";
import { CAPABILITY_MATRIX } from "./capabilities.js";
import { ProviderDisabled, type Connector, type ConnectorOptions, type ProviderId } from "./connector.js";
import { GarminConnector, type GarminOptions } from "./providers/garmin.js";
import { GoogleHealthConnector, type GoogleHealthOptions } from "./providers/google-health.js";
import { OpenWearablesConnector, type OpenWearablesOptions } from "./providers/open-wearables.js";
import { OuraConnector, type OuraOptions } from "./providers/oura.js";
import { PolarConnector, type PolarOptions } from "./providers/polar.js";
import { StravaConnector, type StravaOptions } from "./providers/strava.js";
import { WhoopConnector, type WhoopOptions } from "./providers/whoop.js";

export interface ProviderFlag {
  enabled: boolean;
  /** Tier the deployment holds with the vendor; selects capabilities. */
  tier?: string;
  /**
   * Strava only: written approval from Strava for this use. Without it the flag cannot be turned on,
   * because the 2026 API Policy bans AI use and intermediaries.
   */
  writtenApproval?: string;
}

export type ProviderFlags = Record<ProviderId, ProviderFlag>;

export const DEFAULT_FLAGS: Readonly<ProviderFlags> = Object.freeze({
  oura: { enabled: false },
  whoop: { enabled: false },
  "google-health": { enabled: false },
  garmin: { enabled: false },
  polar: { enabled: false },
  strava: { enabled: false },
  "open-wearables": { enabled: false },
});

export interface ProviderOptionsMap {
  oura: OuraOptions;
  whoop: WhoopOptions;
  "google-health": GoogleHealthOptions;
  garmin: GarminOptions;
  polar: PolarOptions;
  strava: StravaOptions;
  "open-wearables": OpenWearablesOptions;
}

const FACTORIES: { [K in ProviderId]: (o: ProviderOptionsMap[K], tier?: string) => Connector } = {
  oura: (o, t) => new OuraConnector(o, t),
  whoop: (o, t) => new WhoopConnector(o, t),
  "google-health": (o, t) => new GoogleHealthConnector(o, t),
  garmin: (o, t) => new GarminConnector(o, t),
  polar: (o, t) => new PolarConnector(o, t),
  strava: (o, t) => new StravaConnector(o, t),
  "open-wearables": (o, t) => new OpenWearablesConnector(o, t),
};

/** Parse flags from an env-style JSON string, e.g. CONNECTOR_FLAGS='{"oura":{"enabled":true}}'. Unknown keys are ignored. */
export function parseFlags(json: string | undefined): ProviderFlags {
  const out = structuredClone(DEFAULT_FLAGS) as ProviderFlags;
  if (!json) return out;
  const parsed = JSON.parse(json) as Partial<Record<string, Partial<ProviderFlag>>>;
  for (const id of Object.keys(out) as ProviderId[]) {
    const f = parsed[id];
    if (!f) continue;
    out[id] = { ...out[id], ...f, enabled: f.enabled === true };
  }
  return out;
}

export class ConnectorRegistry {
  private readonly flags: ProviderFlags;

  constructor(
    flags: Partial<ProviderFlags> = {},
    private readonly options: Partial<ProviderOptionsMap> = {},
  ) {
    this.flags = { ...structuredClone(DEFAULT_FLAGS), ...flags } as ProviderFlags;
    const s = this.flags.strava;
    if (s.enabled && !s.writtenApproval) {
      throw new ProviderDisabled("strava", "requires_written_approval");
    }
  }

  isEnabled(id: ProviderId): boolean {
    return this.flags[id].enabled;
  }

  flag(id: ProviderId): ProviderFlag {
    return { ...this.flags[id] };
  }

  enabled(): ProviderId[] {
    return (Object.keys(this.flags) as ProviderId[]).filter((id) => this.flags[id].enabled);
  }

  /** Terms flags for a provider, for the source row; carried even when the provider is disabled. */
  termsFlags(id: ProviderId): TermsFlags {
    return { ...CAPABILITY_MATRIX[id].termsFlags };
  }

  /** Build a connector. Throws ProviderDisabled when the flag is off or options are missing. */
  get<K extends ProviderId>(id: K): Connector {
    const f = this.flags[id];
    if (!f.enabled) throw new ProviderDisabled(id, "flag_off");
    const o = this.options[id];
    if (!o) throw new ProviderDisabled(id, "no_options");
    return FACTORIES[id](o as ProviderOptionsMap[K], f.tier);
  }
}

export type { ConnectorOptions };
