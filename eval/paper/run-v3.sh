#!/usr/bin/env bash
# Third revision (planner prompt only; docs/paper/v2-preregistration.md, addendum). Condition C only. Results in
# eval/paper/results/v3/. Cloudflare API limit 240 rpm: lanes 100 + 100 + 35 = 235.
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . .secrets/openrouter.env; set +a
export STUDY_COMMIT="$(git rev-parse --short HEAD)"
export EVAL_TODAY="$(sed -n 's/.*today=\([0-9-]*\).*/\1/p' eval/paper/results/final/STUDY.txt)"
export EVAL_RESULTS_DIR="results/v3"
mkdir -p eval/paper/results/v3
echo "commit=$STUDY_COMMIT today=$EVAL_TODAY third revision (planner prompt), condition C only" > eval/paper/results/v3/STUDY.txt
R="npx tsx eval/paper/run.ts"
L=eval/paper/results/v3
( while true; do npx wrangler whoami >/dev/null 2>&1; sleep 300; done ) & REF=$!
( for p in 1 2; do EVAL_PHIA_FRESH=1 EVAL_CF_RPM=100 $R --suite phia --models open --conditions C_broker; done; echo "PHIA DONE" ) >> $L/lane-phia.log 2>&1 & A=$!
( for p in 1 2; do
    EVAL_CF_RPM=100 $R --suite accuracy --models open --conditions C_broker
    EVAL_CF_RPM=100 $R --suite privacy --models open --conditions C_broker
    EVAL_CF_RPM=100 $R --suite real --models open --conditions C_broker
  done; echo "REG DONE" ) >> $L/lane-reg.log 2>&1 & B=$!
( for p in 1 2; do
    EVAL_CF_RPM=35 EVAL_OR_CONCURRENCY=16 EVAL_SPEND_CAP=195 $R --suite accuracy --models frontier --conditions C_broker
    EVAL_CF_RPM=35 EVAL_OR_CONCURRENCY=16 EVAL_SPEND_CAP=195 $R --suite privacy --models frontier --conditions C_broker
  done; echo "FRONT DONE" ) >> $L/lane-front.log 2>&1 & C=$!
wait $A $B $C
echo "V3 DONE" >> $L/lane-phia.log
kill $REF 2>/dev/null
