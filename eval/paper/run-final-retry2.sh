#!/usr/bin/env bash
# Finish the clean study: rerun every errored row (resume skips completed rows). Two lanes in parallel,
# together under the documented Cloudflare API limit (1,200 requests / 5 min per token = 240 rpm).
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . .secrets/openrouter.env; set +a
export STUDY_COMMIT="$(git rev-parse --short HEAD)"
export EVAL_TODAY="$(sed -n 's/.*today=\([0-9-]*\).*/\1/p' eval/paper/results/final/STUDY.txt)"
export EVAL_RESULTS_DIR="results/final"
R="npx tsx eval/paper/run.ts"
L=eval/paper/results/final
( while true; do npx wrangler whoami >/dev/null 2>&1; sleep 600; done ) & REF=$!
( for pass in 1 2; do
    for s in repeat privacy accuracy; do
      if [ $s = repeat ]; then EVAL_CF_RPM=200 $R --suite repeat --models open --runs 5; else EVAL_CF_RPM=200 $R --suite $s --models open; fi
    done
    EVAL_CF_RPM=200 $R --suite phia --models open
    EVAL_CF_RPM=200 $R --suite real --models open
  done; echo "OPEN DONE" ) >> $L/retry-open.log 2>&1 &
O=$!
( for pass in 1 2; do EVAL_CF_RPM=30 EVAL_OR_CONCURRENCY=12 EVAL_SPEND_CAP=195 $R --suite phia --models frontier; done; echo "FRONT DONE" ) >> $L/retry-frontier.log 2>&1 &
F=$!
wait $O $F
echo "RETRY DONE" >> $L/retry.log
kill $REF 2>/dev/null
