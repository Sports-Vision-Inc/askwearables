#!/usr/bin/env bash
# Lane 1 only (open models on Workers AI), resumable.
set -uo pipefail
cd "$(dirname "$0")/../.."
export EVAL_TODAY="${EVAL_TODAY:-$(date -u +%Y-%m-%d)}"
{
  EVAL_CF_RPM=160 npx tsx eval/paper/run.ts --suite accuracy --models open
  EVAL_CF_RPM=160 npx tsx eval/paper/run.ts --suite privacy --models open
  EVAL_CF_RPM=160 npx tsx eval/paper/run.ts --suite repeat --models open --runs 5
  echo "LANE1 DONE"
} >> eval/paper/results/run-all.log.lane1 2>&1
