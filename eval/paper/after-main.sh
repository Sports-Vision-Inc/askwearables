#!/usr/bin/env bash
cd "$(dirname "$0")/results"
until grep -q "LANE1 DONE" run-all.log.lane1 && grep -q "LANE2 DONE" run-all.log.lane2 && ! pgrep -f "llm-planner-phia" >/dev/null; do sleep 30; done
cd ../../.. && ./eval/paper/run-v2.sh
