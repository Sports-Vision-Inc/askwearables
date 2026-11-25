#!/usr/bin/env bash
# Runs the whole study. Two lanes so the Cloudflare token stays under its documented 1,200 requests / 5 min:
# lane 1 (open models on Workers AI) at 160/min, lane 2 (frontier and free models on OpenRouter; their broker
# planner calls still use Workers AI) at 40/min.
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . .secrets/openrouter.env; set +a
export EVAL_TODAY="${EVAL_TODAY:-$(date -u +%Y-%m-%d)}"
LOG=eval/paper/results/run-all.log
(
  EVAL_CF_RPM=160 npx tsx eval/paper/run.ts --suite accuracy --models open
  EVAL_CF_RPM=160 npx tsx eval/paper/run.ts --suite privacy --models open
  EVAL_CF_RPM=160 npx tsx eval/paper/run.ts --suite repeat --models open --runs 5
  echo "LANE1 DONE"
) >> "$LOG.lane1" 2>&1 &
(
  export EVAL_SPEND_CAP="${EVAL_SPEND_CAP:-40}"
  EVAL_CF_RPM=40 npx tsx eval/paper/run.ts --suite accuracy --models frontier
  EVAL_CF_RPM=40 npx tsx eval/paper/run.ts --suite privacy --models frontier --people 5
  EVAL_CF_RPM=40 npx tsx eval/paper/run.ts --suite accuracy --models free
  EVAL_CF_RPM=40 npx tsx eval/paper/run.ts --suite privacy --models free --people 5
  echo "LANE2 DONE"
) >> "$LOG.lane2" 2>&1 &
wait
echo "ALL DONE" >> "$LOG.lane1"
