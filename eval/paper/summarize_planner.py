"""Planner comparison on the PHIA sample: honest refusal, over-refusal, operation+metric agreement, window agreement, latency."""
import json, statistics, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1] if len(sys.argv) > 1 else "eval/paper/results/planner-phia.jsonl")]
mp = {e["id"]: e for e in json.load(open("eval/phia/mapping.json"))["entries"]}
for r in rows:
    e = mp[r["id"]]
    r["direct"] = e["status"] == "mapped" and e.get("extract", {}).get("from") == "l2.value"
    # Compare windows with what the question means (window_basis), not the wake-date-shifted spec window.
    r["map_window"] = e.get("window_basis") or r["map_window"]
by = collections.defaultdict(list)
for r in rows: by[r["planner"]].append(r)
print("mapped = directly answerable from a packet (aggregate / threshold values); session post-processing questions excluded")
print(f"{'planner':<20}{'n':>5}{'refuse unsup':>14}{'guess unsup':>13}{'over-refuse':>13}{'op+metric':>11}{'+window':>9}{'median s':>10}{'p90 s':>8}")
for p, rs in sorted(by.items()):
    u = [r for r in rs if r["mapping"] == "unsupported"]
    m = [r for r in rs if r["mapping"] == "mapped" and r["direct"]]
    refused = sum(r["status"] == "unsupported" for r in u)
    over = sum(r["status"] == "unsupported" for r in m)
    same = sum(r["same_op_metric"] for r in m)
    win = sum(r["same_op_metric"] and r["window"] == r["map_window"] for r in m)
    ms = sorted(r["ms"] for r in rs)
    pct = lambda a, b: f"{100*a/max(1,b):.1f}%"
    print(f"{p:<20}{len(rs):>5}{pct(refused,len(u)):>14}{len(u)-refused:>13}{pct(over,len(m)):>13}{pct(same,len(m)):>11}{pct(win,len(m)):>9}{statistics.median(ms)/1000:>10.1f}{ms[int(.9*len(ms))-1]/1000:>8.1f}")
