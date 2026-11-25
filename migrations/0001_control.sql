-- Control data in D1: users, agents, grants, sessions, passkeys, API keys, organizations.
-- No health data lives here. Every table carries user_id or org_id from the first migration.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  org_id TEXT,                 -- null for the owner and other direct users; set for a developer's end users
  external_id TEXT,            -- the developer's own id for this user
  email TEXT,
  display_name TEXT,
  tz TEXT NOT NULL DEFAULT 'UTC',
  role TEXT NOT NULL DEFAULT 'user', -- 'owner' | 'user'
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (org_id, external_id)
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,         -- credential id, base64url
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,    -- base64url COSE key
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,    -- sha256 of the cookie value
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  user_id TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,   -- the OAuth client id, or ag_<...> for developer agents
  name TEXT NOT NULL,
  registered_by TEXT NOT NULL, -- 'dcr', 'cimd', or an org id
  verified_domain TEXT,
  model_facing INTEGER NOT NULL DEFAULT 1,
  org_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE grants (
  grant_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  purpose TEXT NOT NULL,
  metrics TEXT NOT NULL,       -- JSON array
  sensitive TEXT NOT NULL DEFAULT '[]',
  max_level INTEGER NOT NULL,
  max_window_days INTEGER NOT NULL,
  daily_packet_budget INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX grants_user ON grants (user_id, agent_id);

CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  webhook_url TEXT,
  webhook_secret_enc TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE api_keys (
  key_hash TEXT PRIMARY KEY,   -- sha256 of the key; the key itself is shown once
  prefix TEXT NOT NULL,        -- first characters, for display
  kind TEXT NOT NULL,          -- 'owner' | 'developer' | 'sync'
  user_id TEXT,                -- owner and sync keys
  org_id TEXT,                 -- developer keys
  agent_id TEXT,               -- developer keys act as this agent
  signing_secret_enc TEXT,     -- developer keys: HMAC secret for signed requests (encrypted)
  source_id TEXT,              -- sync keys: the source they write to
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE consent_links (
  token_hash TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  request TEXT NOT NULL,       -- JSON: purpose, metrics, max_level, window, budget, days
  return_url TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE usage (
  org_id TEXT NOT NULL,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  packets INTEGER NOT NULL DEFAULT 0,
  denials INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, day)
);
