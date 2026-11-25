#!/usr/bin/env bash
# Seeds a local owner key into the local D1, then runs scripts/e2e.mjs against wrangler dev.
# The consent approval is simulated by inserting the grant the hosted consent page would create.
set -euo pipefail
cd "$(dirname "$0")/.."
D1="npx wrangler d1 execute askwearables-control --local -c workers/gate/wrangler.jsonc --persist-to .wrangler/state"
KEY="aw_own_local$(openssl rand -hex 16)"
HASH=$(printf %s "$KEY" | shasum -a 256 | cut -d' ' -f1)
$D1 --command "INSERT OR IGNORE INTO users (id, tz, role, created_at) VALUES ('u_localowner','UTC','owner','2026-11-24T00:00:00Z'); INSERT INTO api_keys (key_hash,prefix,kind,user_id,created_at) VALUES ('$HASH','aw_own_local','owner','u_localowner','2026-11-24T00:00:00Z');" > /dev/null
export AW_APPROVE_CMD="$D1 --command \"INSERT INTO grants (grant_id,user_id,agent_id,purpose,metrics,sensitive,max_level,max_window_days,daily_packet_budget,expires_at,created_at) SELECT 'gr_e2e'||abs(random()), u.id, k.agent_id, 'sleep_coaching', '[\\\"sleep_duration\\\",\\\"resting_hr\\\"]', '[]', 1, 14, 5, '2027-01-01T00:00:00Z', strftime('%Y-%m-%dT%H:%M:%SZ','now') FROM users u JOIN api_keys k ON k.org_id = u.org_id AND k.kind='developer' WHERE u.external_id='\$AW_E2E_USER' ORDER BY k.created_at DESC LIMIT 1\" > /dev/null"
AW_BASE="${AW_BASE:-http://localhost:8787}" AW_OWNER_KEY="$KEY" node scripts/e2e.mjs
