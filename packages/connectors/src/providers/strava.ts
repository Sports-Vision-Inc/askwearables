// Strava API v3. Docs and terms read 2026-11-24: docs/providers/strava.md (developers.strava.com, API Agreement 2026 and
// API Policy 2026, both effective 2026-06-01).
//
// SHIPPED DISABLED. API Policy s.5.3 bans using Strava data in the development, training, evaluation or OPERATION of any
// AI application, including RAG, embeddings and "ingestion into a context window". s.5.16 bans aggregators, proxies and
// MCP servers that re-expose Strava data; data may be displayed only to the user. Terms flags:
// {no_ai, no_intermediary, display_to_user_only}. backfill and handleWebhook refuse to run unless the host holds written
// approval from Strava (StravaOptions.writtenApproval). normalize stays pure so fixtures can be contract-tested.
//
// Other limits: cache at most 7 days (s.5.5/6.2), no combining with other customers' data (s.5.4), delete within 30 days of
// revocation (s.7.4). Webhooks carry NO signature: use a secret callback path and check subscription_id.
import { mapWorkoutType, type CanonicalRecord } from "@askwearables/core";
import { capabilitiesFor } from "../capabilities.js";
import { ProviderDisabled, WebhookAuthError, type AuthStart, type Capabilities, type Connector, type ConnectorOptions, type ExchangeContext, type RawRecord, type SyncJob, type Tokens } from "../connector.js";
import { fetchWithBackoff, formBody, getJson, HttpError, randomToken, tokensFromResponse, type OAuthTokenResponse } from "../http.js";
import { timingSafeEqual } from "../webhook.js";
import { BaseConnector, num, session } from "../base.js";

export const STRAVA = {
  authorize: "https://www.strava.com/oauth/authorize",
  // TODO(verify): the docs' cURL example uses /api/v3/oauth/token; the prose uses /oauth/token.
  token: "https://www.strava.com/oauth/token",
  // Moves to a new, not-yet-named domain on 2027-06-01.
  api: "https://www.strava.com/api/v3",
  scope: "activity:read",
} as const;

export interface StravaOptions extends ConnectorOptions {
  /** Reference to Strava's written approval. Without it no data is fetched. */
  writtenApproval?: string;
  /** hub.verify_token used when creating the push subscription. */
  verifyToken?: string;
  /** Our push subscription id; events for any other id are rejected. */
  subscriptionId?: number;
  /** Secret last path segment of the callback URL. */
  webhookToken?: string;
}

export class StravaConnector extends BaseConnector implements Connector {
  readonly provider = "strava" as const;
  readonly capabilities: Capabilities;

  constructor(
    protected override readonly opts: StravaOptions,
    tier?: string,
  ) {
    super(opts);
    this.capabilities = capabilitiesFor("strava", tier);
  }

  private assertApproved(): void {
    if (!this.opts.writtenApproval) throw new ProviderDisabled("strava", "terms_no_ai_no_intermediary");
  }

  async authUrl(_userId: string, redirectUri: string): Promise<AuthStart> {
    this.assertApproved();
    const state = randomToken();
    const q = new URLSearchParams({ client_id: this.opts.clientId, redirect_uri: redirectUri, response_type: "code", approval_prompt: "auto", scope: STRAVA.scope, state });
    return { url: `${STRAVA.authorize}?${q}`, state };
  }

  async exchangeCode(code: string, _ctx: ExchangeContext = {}): Promise<Tokens> {
    this.assertApproved();
    const body = await this.tokenRequest({ grant_type: "authorization_code", code, client_id: this.opts.clientId, client_secret: this.opts.clientSecret });
    return body;
  }

  /** Refresh tokens rotate; the old one is invalidated immediately. Serialize per user. */
  async refresh(tokens: Tokens): Promise<Tokens> {
    if (!tokens.refresh_token) throw new Error("strava_no_refresh_token");
    const t = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: this.opts.clientId, client_secret: this.opts.clientSecret });
    if (tokens.provider_user_id) t.provider_user_id = tokens.provider_user_id;
    return t;
  }

  private async tokenRequest(fields: Record<string, string | undefined>): Promise<Tokens> {
    const res = await fetchWithBackoff(this.http, STRAVA.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: formBody(fields) });
    if (!res.ok) throw new HttpError(res.status, STRAVA.token, await res.text());
    const body = (await res.json()) as OAuthTokenResponse & { athlete?: { id?: number } };
    const t: Tokens = tokensFromResponse(body, this.clock());
    if (body.athlete?.id !== undefined) t.provider_user_id = String(body.athlete.id);
    return t;
  }

  async *backfill(userId: string, since: string): AsyncIterable<RawRecord> {
    this.assertApproved();
    const { access_token } = await this.tokensFor(userId);
    const after = String(Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000));
    for (let page = 1; ; page++) {
      const q = new URLSearchParams({ after, page: String(page), per_page: "200" });
      const list = await getJson<unknown[]>(this.http, `${STRAVA.api}/athlete/activities?${q}`, { headers: { authorization: `Bearer ${access_token}` } });
      if (!list?.length) return;
      for (const a of list) yield this.raw(userId, "activity", a);
    }
  }

  async challenge(request: Request): Promise<Response | null> {
    if (request.method !== "GET") return null;
    const u = new URL(request.url);
    const challenge = u.searchParams.get("hub.challenge");
    if (challenge === null) return null;
    if (!this.opts.verifyToken || u.searchParams.get("hub.verify_token") !== this.opts.verifyToken) return new Response("forbidden", { status: 403 });
    return Response.json({ "hub.challenge": challenge });
  }

  async handleWebhook(request: Request): Promise<SyncJob[]> {
    this.assertApproved();
    const seg = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";
    if (!this.opts.webhookToken || !timingSafeEqual(seg, this.opts.webhookToken)) throw new WebhookAuthError("strava_path_token");
    const e = (await request.json()) as { object_type: string; object_id: number; aspect_type: string; owner_id: number; subscription_id: number; event_time: number; updates?: Record<string, string> };
    if (this.opts.subscriptionId !== undefined && e.subscription_id !== this.opts.subscriptionId) throw new WebhookAuthError("strava_subscription");
    const base = { provider: "strava" as const, provider_user_id: String(e.owner_id), data_type: e.object_type, dedupe_key: `strava:${e.object_type}:${e.object_id}:${e.aspect_type}:${e.event_time}` };
    if (e.object_type === "athlete" && e.updates?.authorized === "false") return [{ ...base, action: "deregister" }];
    return [{ ...base, action: e.aspect_type === "delete" ? "delete" : "fetch", object_id: String(e.object_id) }];
  }

  normalize(raw: RawRecord): CanonicalRecord[] {
    if (raw.type !== "activity") return [];
    const a = raw.payload as Record<string, any>;
    // start_date_local is local wall time written with a trailing Z; the difference gives the offset.
    const tz = num(a.utc_offset) !== undefined ? Math.round(num(a.utc_offset)! / 60) : Math.round((Date.parse(a.start_date_local) - Date.parse(a.start_date)) / 60_000);
    const end = new Date(Date.parse(a.start_date) + num(a.elapsed_time)! * 1000).toISOString();
    const detail: Record<string, unknown> = { type: mapWorkoutType(a.sport_type ?? a.type) };
    if (num(a.distance) !== undefined) detail.distance_m = num(a.distance);
    if (num(a.average_heartrate) !== undefined) detail.avg_hr = num(a.average_heartrate);
    if (num(a.calories) !== undefined) detail.energy_kcal = num(a.calories);
    return [session("workout", a.start_date, end, tz, raw.source_id, `strava:activity:${a.id}`, detail as { type: string })];
  }
}
