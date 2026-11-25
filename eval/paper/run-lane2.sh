#!/usr/bin/env bash
# Lane 2 only (frontier and free models via OpenRouter), resumable.
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . .secrets/openrouter.env; set +a
export EVAL_TODAY="${EVAL_TODAY:-$(date -u +%Y-%m-%d)}" EVAL_SPEND_CAP="${EVAL_SPEND_CAP:-45}"
{
  EVAL_CF_RPM=40 npx tsx eval/paper/run.ts --suite accuracy --models frontier
  EVAL_CF_RPM=40 npx tsx eval/paper/run.ts --suite privacy --models frontier --people 5
  EVAL_CF_RPM=40 npx tsx eval/paper/run.ts --suite accuracy --models free
  EVAL_CF_RPM=40 npx tsx eval/paper/run.ts --suite privacy --models free --people 5
  echo "LANE2 DONE"
} >> eval/paper/results/run-all.log.lane2 2>&1
