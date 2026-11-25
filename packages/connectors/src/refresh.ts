// Per-user refresh serialization.
//
// WHOOP invalidates the old access token on refresh, and Oura, Garmin and Strava rotate refresh tokens (the old one dies
// on use). Two concurrent refreshes for one user therefore break the second caller and can lose the only valid refresh
// token. Rule for every host: serialize refreshes per (provider, user), and persist the returned tokens in one write
// before releasing the lock.
//
// This helper coalesces concurrent refreshes inside one isolate. Across isolates (Workers scale out), the host must run
// refresh inside the user's Durable Object or under a row lock; this helper is not a substitute for that.
import type { Connector, Tokens } from "./connector.js";

export type RefreshFn = (key: string, tokens: Tokens) => Promise<Tokens>;

/**
 * Wrap a connector's refresh so concurrent calls for the same key share one in-flight request.
 * `persist` runs once per real refresh, before any waiter sees the new tokens.
 */
export function serializeRefresh(connector: Pick<Connector, "refresh">, persist?: (key: string, t: Tokens) => Promise<void>): RefreshFn {
  const inflight = new Map<string, Promise<Tokens>>();
  return (key, tokens) => {
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      try {
        const next = await connector.refresh(tokens);
        if (persist) await persist(key, next);
        return next;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };
}

/** True when the access token expires within `skewMs` (default 5 minutes) of now. */
export function needsRefresh(tokens: Tokens, now: Date, skewMs = 5 * 60_000): boolean {
  if (!tokens.expires_at) return false;
  return Date.parse(tokens.expires_at) - now.getTime() <= skewMs;
}
