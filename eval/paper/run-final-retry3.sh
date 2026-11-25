#!/usr/bin/env bash
# Finish the clean study in four parallel lanes (resume skips completed rows). Pacing stays inside the documented limits:
# Cloudflare API 1,200 req / 5 min per token (240 rpm): 80 + 80 + 15 + 60 = 235. Paid-tier inkling 20 rpm: 9 + 9 + 1 = 19.
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . .secrets/openrouter.env; set +a
export STUDY_COMMIT="$(git rev-parse --short HEAD)"
export EVAL_TODAY="$(sed -n 's/.*today=\([0-9-]*\).*/\1/p' eval/paper/results/final/STUDY.txt)"
export EVAL_RESULTS_DIR="results/final"
R="npx tsx eval/paper/run.ts"
L=eval/paper/results/final
( while true; do npx wrangler whoami >/dev/null 2>&1; sleep 300; done ) & REF=$!
( for p in 1 2; do EVAL_CF_RPM=80 EVAL_PAID_RPM=9 $R --suite phia --models open; done; echo "PHIA DONE" ) >> $L/retry-phia.log 2>&1 & A=$!
( for p in 1 2; do EVAL_CF_RPM=80 EVAL_PAID_RPM=9 $R --suite real --models open; done; echo "REAL DONE" ) >> $L/retry-real.log 2>&1 & B=$!
( for p in 1 2; do
    EVAL_CF_RPM=15 EVAL_PAID_RPM=1 $R --suite privacy --models open
    EVAL_CF_RPM=15 EVAL_PAID_RPM=1 $R --suite repeat --models open --runs 5
    EVAL_CF_RPM=15 EVAL_PAID_RPM=1 $R --suite accuracy --models open
  done; echo "SMALL DONE" ) >> $L/retry-small.log 2>&1 & C=$!
( for p in 1 2; do EVAL_CF_RPM=60 EVAL_OR_CONCURRENCY=40 EVAL_SPEND_CAP=195 $R --suite phia --models frontier; done; echo "FRONT DONE" ) >> $L/retry-frontier.log 2>&1 & D=$!
wait $A $B $C $D
echo "RETRY DONE" >> $L/retry.log
kill $REF 2>/dev/null
