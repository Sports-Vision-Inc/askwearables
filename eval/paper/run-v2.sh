#!/usr/bin/env bash
# Second iteration of condition C (planner v2: unit aliases, narrower sensitive-word check, daily-values guidance).
# Runs after the main study; results go to *_v2 files and are reported as a separate, labelled condition.
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . .secrets/openrouter.env; set +a
export EVAL_TODAY="${EVAL_TODAY:-$(date -u +%Y-%m-%d)}" EVAL_SPEND_CAP="${EVAL_SPEND_CAP:-45}"
{
  EVAL_CF_RPM=120 npx tsx eval/paper/run.ts --suite accuracy --version v2 --models open --conditions C_broker
  EVAL_CF_RPM=120 npx tsx eval/paper/run.ts --suite accuracy --version v2 --models gemini-4-neon --conditions C_broker
  EVAL_CF_RPM=60 npx tsx eval/scripts/llm-planner-phia.ts llama-3.3-70b 400 --version=v2
  EVAL_CF_RPM=60 npx tsx eval/scripts/llm-planner-phia.ts llama-3.3-70b 400 --heldout --version=v2
  echo "V2 DONE"
} >> eval/paper/results/run-v2.log 2>&1
