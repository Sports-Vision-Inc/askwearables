#!/usr/bin/env bash
# Wrangler's OAuth token expires after about an hour; any wrangler command refreshes it in its config file,
# which the harness re-reads on every call. Keep it fresh while the study runs.
while true; do npx wrangler whoami >/dev/null 2>&1; sleep 900; done
