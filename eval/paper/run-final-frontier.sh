#!/usr/bin/env bash
# Frontier lane of the clean study (same frozen commit and date), resumable; reruns errored rows.
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . .secrets/openrouter.env; set +a
export STUDY_COMMIT="$(git rev-parse --short HEAD)"
export EVAL_TODAY="$(sed -n 's/.*today=\([0-9-]*\).*/\1/p' eval/paper/results/final/STUDY.txt)"
export EVAL_RESULTS_DIR="results/final" EVAL_SPEND_CAP="${EVAL_SPEND_CAP:-145}"
# OpenRouter reserves credit per in-flight request; 8 in flight keeps reservations under the balance.
export EVAL_OR_CONCURRENCY=8 EVAL_POOL=24
R="npx tsx eval/paper/run.ts"
{
  EVAL_CF_RPM=60 $R --suite accuracy --models frontier
  EVAL_CF_RPM=60 $R --suite privacy --models frontier --people 5
  EVAL_CF_RPM=60 $R --suite phia --models frontier
  echo "FRONTIER DONE"
} >> eval/paper/results/final/lane2b.log 2>&1
