#!/usr/bin/env bash
# After lane 1: rerun every errored row of the clean study under harness v1.1 (resume skips completed rows).
set -uo pipefail
cd "$(dirname "$0")/../.."
until grep -q "LANE1 DONE" eval/paper/results/final/lane1.log; do sleep 60; done
set -a; . .secrets/openrouter.env; set +a
export STUDY_COMMIT="$(git rev-parse --short study-v1.1)"
export EVAL_TODAY="$(sed -n 's/.*today=\([0-9-]*\).*/\1/p' eval/paper/results/final/STUDY.txt)"
export EVAL_RESULTS_DIR="results/final"
R="npx tsx eval/paper/run.ts"
( while true; do npx wrangler whoami >/dev/null 2>&1; sleep 600; done ) & REF=$!
{
  for pass in 1 2; do
    EVAL_CF_RPM=150 $R --suite accuracy --models open
    EVAL_CF_RPM=150 $R --suite privacy --models open
    EVAL_CF_RPM=150 $R --suite repeat --models open --runs 5
    EVAL_CF_RPM=150 $R --suite phia --models open
    EVAL_CF_RPM=150 $R --suite real --models open
  done
  echo "RETRY DONE"
} >> eval/paper/results/final/retry.log 2>&1
kill $REF 2>/dev/null
