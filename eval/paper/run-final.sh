#!/usr/bin/env bash
# The clean, frozen study. Run from a committed tree; every row records the commit and the pinned evaluation date.
# Two lanes keep the Cloudflare token under its documented 1,200 requests / 5 minutes.
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . .secrets/openrouter.env; set +a
export STUDY_COMMIT="$(git rev-parse --short HEAD)"
export EVAL_TODAY="${EVAL_TODAY:-$(date -u +%Y-%m-%d)}"
export EVAL_RESULTS_DIR="results/final" EVAL_SPEND_CAP="${EVAL_SPEND_CAP:-145}"
mkdir -p eval/paper/results/final
echo "commit=$STUDY_COMMIT today=$EVAL_TODAY" > eval/paper/results/final/STUDY.txt
R="npx tsx eval/paper/run.ts"
(
  EVAL_CF_RPM=150 $R --suite accuracy --models open
  EVAL_CF_RPM=150 $R --suite privacy --models open
  EVAL_CF_RPM=150 $R --suite repeat --models open --runs 5
  EVAL_CF_RPM=150 $R --suite phia --models open
  EVAL_CF_RPM=150 $R --suite real --models open
  EVAL_CF_RPM=60 npx tsx eval/scripts/llm-planner-phia.ts llama-3.3-70b 400
  EVAL_CF_RPM=60 npx tsx eval/scripts/llm-planner-phia.ts llama-3.3-70b 400 --heldout
  echo "LANE1 DONE"
) >> eval/paper/results/final/lane1.log 2>&1 &
(
  EVAL_CF_RPM=40 $R --suite accuracy --models frontier
  EVAL_CF_RPM=40 $R --suite privacy --models frontier --people 5
  EVAL_CF_RPM=40 $R --suite accuracy --models free
  EVAL_CF_RPM=40 $R --suite privacy --models free --people 5
  # Frontier models on the PHIA end-to-end suite last, so the spend cap can only shorten the optional part.
  EVAL_CF_RPM=40 $R --suite phia --models frontier
  echo "LANE2 DONE"
) >> eval/paper/results/final/lane2.log 2>&1 &
( while true; do npx wrangler whoami >/dev/null 2>&1; sleep 900; done ) &
REFRESH=$!
wait %1 %2
kill $REFRESH 2>/dev/null
echo "FINAL DONE" >> eval/paper/results/final/lane1.log
