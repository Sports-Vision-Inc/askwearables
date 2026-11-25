-- Single-use nonces for signed developer requests (300-second window).
CREATE TABLE nonces (k TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
