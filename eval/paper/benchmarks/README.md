# Benchmark selections

Committed records of which items the two benchmark suites use. Full description: `eval/paper/BENCHMARKS.md`.

- `phia_sample.json`: the 180 PHIA questions (120 answerable, 60 unsupported), written by
  `npx tsx eval/paper/benchdry.ts --suite phia`. Ids (`<user>:<row>` in PHIA's
  `data/auto_eval/<persona>_final_v2.csv`), stratum, question hash and flags only. PHIA is CC BY-NC 4.0, so no
  question text and no reference answers are stored here.
- `real_sample.json`: the 16 PMData and LifeSnaps participants, their "today", eligibility counts and natural
  data-quality traps, written by `eval/.venv/bin/python eval/paper/real_reference.py`. No daily values; the
  reference answers themselves are written to `eval/data/benchmarks/real_reference.json` (gitignored).

Selection (both fixed seed 20261124):

- PHIA answerable: mapping entries with `status: "mapped"` and `extract.from: "l2.value"` (aggregate statistics and
  threshold day counts; 548 eligible, all with labels PHIA's code reproduces), stratified by user × operation,
  proportional allocation (largest remainder), 120 drawn. Within a stratum, items are ordered by
  sha256(`seed:id`) and the first k taken.
- PHIA unsupported: mapping entries with `status: "unsupported"` (2,163), stratified by reason, proportional with at
  least 2 per reason, 60 drawn the same way.
- Real: participants with at least 45 days that have steps, a main sleep and a resting heart rate; 8 drawn per
  dataset with Python's `random.Random(20261124).sample` over the sorted eligible ids (PMData 13 eligible of 16,
  LifeSnaps 44 of 71).
