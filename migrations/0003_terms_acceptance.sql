-- Clickwrap: which version of the Terms and Privacy Policy each user accepted, and when.
ALTER TABLE users ADD COLUMN terms_version TEXT;
ALTER TABLE users ADD COLUMN terms_accepted_at TEXT;
ALTER TABLE users ADD COLUMN age_confirmed INTEGER NOT NULL DEFAULT 0;
