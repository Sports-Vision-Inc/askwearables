# Second iteration of AskWearables: pre-registration

Written and committed before any second-iteration run. The study (frozen commit, results in
`eval/paper/results/final/`) is not changed by anything here; the second iteration is reported separately.

## What changed, and why

The study's PHIA end-to-end suite and its failure attribution (`eval/paper/phia_failures.py`) found three general
problems. Each change below is general: none refers to PHIA, its users, its wording or its labels.

1. **Release level follows the question.** A threshold check that asks *how many* days met a condition
   (`params.mode = "count"`) is released at level 1, which carries the count; a yes/no threshold check stays at
   level 0. The grant's maximum still caps the level. (`packages/core/src/catalogue.ts` `requiredLevel`, `gate.ts`.)
2. **A denial names a granted alternative.** When a requested metric is outside the grant and a closely related
   metric is inside it (heart rate and resting heart rate; sleep duration and sleep efficiency), the denial carries
   the reason `granted_alternative:<metric>:<alternative>` and a one-sentence hint. The gate still denies the
   requested metric. (`catalogue.ts` `RELATED_METRICS`, `gate.ts`, `broker.ts`.)
3. **Planner prompt.** "How many days/nights" is a count also over a single day; a question that joins a supported
   request with an unsupported one is planned for the supported part. One example added.

Not changed: the operation set, the catalogue's definitions (sleep duration stays time asleep), the window rule
("last N days" = N days), the study grant (no heart rate), the agent prompts, the harness and the scoring.
PHIA's N+1-day labelling is not adopted.

## Evaluation

- **Fresh PHIA sample** (`eval/paper/benchmarks/phia_sample_v2.json`, seed 20261126): 120 directly answerable and
  60 unsupported questions, drawn with the study's stratification from questions not in the study sample and not in
  either planner-study sample (the planner prompt was revised with those in view). Overlap with both: 0.
- **Conditions and models**: A, B and C on the fresh sample with the six open-weight models; the frontier models as
  far as the evaluation budget allows (reported with their n). A and B do not depend on the broker; they are rerun
  because the questions are new.
- **Regression checks**, condition C only, second-iteration broker: the synthetic accuracy suite (all nine models),
  the privacy suite (all nine models), and the real-data suite (six open-weight models), compared with the study's
  C runs on the same tasks.
- Same harness rules as the study: infrastructure errors retried; context-window and turn-limit outcomes final.

## Hypotheses and analysis (fixed now)

- **H1 (primary).** On the fresh sample's answerable questions, scored as worded, pooled C accuracy rises relative
  to the study's C and the gap to A narrows. Reported: per-model and pooled accuracy for A, B, C with Wilson
  intervals and McNemar C vs A.
- **H2.** On the fresh sample's unsupported questions, C's refusal rate stays at least as high as in the study (84%).
- **H3 (no regression).** On the synthetic suite, C2 accuracy is not lower than the study's C (paired McNemar per
  model and pooled); on privacy, C2 leaks no more than C; on real data, C2 is reported against C per model.
- Secondary: the PHIA failure attribution rerun on C2.

Whatever the outcome, all of the above is reported.

## Addendum: third revision (written before its runs)

The second iteration's planner prompt cost accuracy on the synthetic week-over-week question: the planner more often
compared the two weeks before last. The third revision changes only the planner prompt: it lists, for comparisons
with the period before, both windows for 3, 7, 14, 28 and 30 days and for this week against last week (computed from
today, as the prompt already does for single windows), adds one comparison example, and says that a compound
question with an unsupported part is planned for its supported part and refused only when no part is supported.

Checked first on the planner alone (`eval/scripts/planner-windows.ts`): a held-out set of 16 window questions with
expected windows (`eval/paper/benchmarks/planner_windows.json`, committed before the prompt change), and every ask
agent models sent on the week-over-week task. Then measured end to end, condition C only, with the third-revision
broker on the same tasks as the second iteration: the synthetic and privacy suites (nine models), real data and the
fresh PHIA sample (six open-weight models). The fresh PHIA sample is reused, not redrawn; this is disclosed.

Hypotheses: on the synthetic suite, C3 is not less accurate than the study's C (H3 again, pooled and on the
week-over-week question); on fresh PHIA, C3's accuracy on answerable questions as worded is not lower than C2's and
its refusal of unsupported questions not lower than C2's; privacy leaks no more than C2's.
