# Review: "AskWearables: Computed, Minimum-Necessary Context for AI Agents over Personal Wearable Data"

Reviewer role: independent area-chair-style review. Reviewed against the draft in `docs/paper/tex/` as built on
2026-11-24 at about 20:40 CST (27 pages, `latexmk` clean). Ground truth came from `eval/paper/out/summary.md` and
`results.json`, which I regenerated with `report.py` and `make_macros.py`. I also checked the raw runs in
`eval/paper/results/*.jsonl` (3,149 scored accuracy runs at review time), the study code in
`eval/paper/*.ts`, the system code in `packages/core/src`, `eval/phia/NOTES.md`, `docs/paper/related_work.md`,
`docs/paper/overexposure.md`, and the arXiv pages of six cited papers.

Privacy and repeatability print as [pending]. I do not count pending cells as errors. Where interim privacy data
bears on a claim already in the text, I say so in passing.

The draft was edited while I reviewed it. Some issues I found early were already fixed in the version I finally
built: the McNemar counts in Table 4 now use the up/down to higher/lower rescoring, `\cErr` is now 54, and the
"down is scored wrong" sentence is gone from Scope. These are not counted below. Line numbers refer to the files
as they stood at the end of the review.

---

## 1. Reviewer summary

**What the paper does.** It presents a broker that sits between a user's wearable data and any LLM agent. The
broker has four parts:
- an LLM planner that maps a question to a typed QuerySpec without seeing data;
- a tested metric layer (source dedup, local days, coverage, per-source IQR baselines) and 8 operations;
- a deterministic gate with purpose-bound grants, 4 release levels, a daily release limit and hash-chained
  receipts;
- a short context packet of at most 400 tokens.

The evaluation compares three conditions on the same agent model:
- **A**: the raw export in the prompt;
- **B**: unrestricted MCP-style tools;
- **C**: the broker.

It covers 11 models: C runs exist for 10, and 9 are complete. Each model answers 100 questions over 10 synthetic
people, each carrying one data-quality trap. The paper reports accuracy (Wilson CIs, exact McNemar, Holm), honest
refusal, "context over-exposure" (characters delivered), tokens, cost and latency. Privacy (4 scenarios) and
repeatability are still pending. Separately, it evaluates the planner on a 400-question stratified sample of PHIA
and the compute engine on the 1,837 PHIA questions that map to its operations.

**Main claims.**
1. C is more accurate than A for 5 of 10 models (4 after Holm) and significantly worse for none. With C, accuracy
   ranges from 89% to 100% across complete models.
2. Raw context delivers 12.3 times more of the record than C at no accuracy benefit.
3. For near-ceiling models, the benefit is minimum-necessary, auditable release and 0.41 to 0.59 times the tokens.
4. The planner refuses 100% of unsupported PHIA questions.
5. The engine matches 94.7% of PHIA reference answers under PHIA's windows.

**Strengths.**
- **S1. Clean separation of concerns, well motivated.** The plan, compute and release split is clearly described.
  The gate is short, readable code whose order matches the paper (`gate.ts:49-127` against `design.tex:69-82`).
  The 400-token packet cap holds in the data: the largest broker response in 1,500 calls is 1,326 characters, or
  about 332 estimated tokens.
- **S2. Unusually good reproducibility hygiene.** Every number is a generated macro, pending cells render
  visibly, and the scoring rules and raw runs are kept.
- **S3. Ground truth by construction.** The paper scores against a truth ledger, not the broker's output. It runs
  paired exact tests with Wilson intervals and Holm correction, and it reports the models with no gain
  (gpt-oss-20b, gpt-oss-120b, inkling, astra, fable).
- **S4. Honest scoping in places.** The paper does not claim lower volume than B, it gives a reach-not-volume
  framing, and it says plainly that near-ceiling models do not gain accuracy. The PHIA disagreement accounting is
  careful, and the N+1-day finding is a genuine contribution to PHIA users.
- **S5. Cost and latency reported per correct answer, including the broker's own planner.** This is rare and
  useful.

**Weaknesses.** Detail is in Sections 3 and 4.
- **W1. The B baseline is partly a harness artifact.**
  - For llama-4-scout, 69 of the 71 "no tool call" B runs contain a tool call written as text. The model emitted
    `[get_daily(metric=steps, start=2026-11-18, ...)]` in its content, and the provider never parsed it into
    `tool_calls`.
  - The parser's fallback then read the number "2026" from the date and scored it as the answer in 52 runs
    (54 including llama-3.3-70b and mistral).
  - The paper says the model "invented the answer". That is wrong. The C-vs-B effect for llama-4-scout (78/0) is
    largely an interoperability failure, not model behaviour.
  - Three llama-3.3-70b B runs have the same failure.
- **W2. The study is small and synthetic, and scoring and broker were designed together.** It uses 10 people,
  one trap each, and 100 tasks per model with one run per task. Some reference rules mirror the broker's own
  definitions:
  - the "flat" HRV label is set by construction, and the broker calls a trend only when |t| ≥ 2.5;
  - "less than usual" is defined by quartiles of prior nights, while the broker uses an IQR baseline;
  - the windows say "ending yesterday", and the planner prompt holds exactly those window rules (`planner.ts:269-271`).

  This favours C in ways the paper does not discuss.
- **W3. The planner was tuned on, and selected with, the PHIA sample it is evaluated on.**
  - The refusal list in the prompt (`planner.ts:274-277`) closely follows the PHIA "unsupported" reasons in
    `NOTES.md`.
  - Five candidate planners were run, including two prompt versions (`planner-phia-v1-*.jsonl`), but only two are
    reported.
  - The "100% refusal" is therefore in-distribution and should not be presented as generalisation.
- **W4. The PHIA engine number is presented as more than it is.**
  - 94.7% is computed on 1,837 of 4,000 questions (46%), using hand-mapped oracle QuerySpecs, under PHIA's
    window convention rather than the engine's own. The engine's own convention gives 78.1%.
  - 1,289 of the 1,837 mapped questions (70%) are answered by harness-side reductions (sum, mean, first N, Nth)
    over a level-3 session list. That is computation outside the engine.
  - End-to-end planner-plus-engine accuracy on PHIA is never reported, although it could be computed from data
    already logged.
- **W5. No ablation isolates what produces the effect.** The paper has no B condition with a deterministic gate
  and no metric layer, no C with an oracle planner, and no B with the packet's caveats. The paper names these
  baselines as missing (Scope, Baselines), but the central causal story ("computation outside the model helps")
  rests on them.
- **W6. The privacy result is partly true by construction, and it is still pending.** In C, the canary (weight)
  and resting HR are never in the grant, so the gate cannot release them. A comparison of prompt-stated policy
  (A and B) against an enforced grant (C) mostly measures whether enforcement works, which the code already
  guarantees. The informative part is the residual leakage in C and the leak detector's validity, which is weak
  (see Section 4).
- **W7. One threshold question shows a significant C deficit, and the abstract omits it.** On "any night under
  6 h", C scored 79% against A's 96%. Pooled over models the paired difference is C-only 1 against A-only 18
  (exact p ≈ 7.6e-5). "Significantly less accurate for none" is true per model but hides this.
- **W8. Run handling is undisclosed.**
  - Errored runs are excluded and retried until success: 537 C and 270 B rows ended in HTTP 401 errors.
  - 84 C runs were "invalidated" after the fact and rerun, keyed on an outcome (an "unsupported" packet during a
    token-expiry window).
  - I checked the invalidations: 82 of the 84 originals were already correct, so they did not bias the result.
  - The paper should still state the retry and invalidation policy.

**Score: 4 / 10 (borderline reject) at a top ML or security venue in its current form. Reviewer confidence: 4 / 5.**

The system idea is sound and the reporting infrastructure is better than average. The headline accuracy result
(5 of 10 models) is driven by three weak open models, one of whose B baseline is an artifact. The privacy result
is pending and partly tautological. The PHIA results are in-distribution. With the B artifact fixed, the planner
study fully reported, an ablation or two from existing data, privacy and repeatability completed, and an honest
treatment of the threshold deficit, this would be a solid 6: a systems or measurement paper at a workshop or
second-tier venue, or a borderline accept at a security venue.

---

## 2. Factual check

Each row gives the location, what the text says, and what the data, code or source says. Counted mismatches are
numbered. Uncounted framing problems are in Section 3.

### 2a. Against data and code (11)

1. **`results.tex:51-52` and `discussion.tex:34-35`.**
   - Text: llama-4-scout "answered 71 of its 100 B questions without calling any tool, that is, it invented the
     answer"; "with open tools one model invented most of its answers without fetching anything."
   - Data: in 69 of those 71 runs the final text is a textual tool call, for example
     `[get_daily(metric=steps, start=2026-11-18, end=2026-11-24)]`. The provider did not parse it into
     `tool_calls`. The parser's last-line number fallback (`tasks.ts:87-94`) then read the year "2026" as the
     answer in 52 runs.
   - Correct statement: the model attempted tool calls that the serving stack returned as plain text. These are
     harness or provider failures, not invented answers.
   - Excluding these runs, llama-4-scout B accuracy is 14/29. The same failure affects 3 llama-3.3-70b B runs.
2. **`results.tex:121-122`.**
   - Text: "Most of these errors [sleep under 6 h, C] were runs in which the planner refused or failed … after
     which the agent answered `unknown`."
   - Data: C has 21 errors on this question. In 9 the broker refused and the agent answered `unknown`; in 10 the
     broker refused in total. In 11 a packet was released, and the agent then answered `unknown` (6) or a wrong
     `yes` (5).
   - Correct statement: 10 of 21 (48%) followed a refusal. The rest occurred after a packet was released.
3. **`results.tex:123-124`.**
   - Text: "the sensitive-category false positives described above fell on this question" (the week-over-week step
     comparison).
   - Data: 16 of the 27 "period" false positives fell on `steps_week_vs_prev`. The other 11 fell on
     `steps_total_7d` (5), `rhr_avg_14d` (3), `hrv_trend_28d` (2) and `workouts_14d` (1).
   - Also, only 1 of the 9 C errors on `steps_week_vs_prev` followed a refusal; 8 had a packet released.
4. **`introduction.tex:61`.**
   - Text: "from open-weight models with 17B active parameters to frontier systems."
   - Fact: gemma-4-26b is `gemma-4-26b-a4b-it` (`llm.ts:146`), with about 4B active parameters. gpt-oss-20b has
     about 3.6B active.
   - Correct statement: the smallest active parameter count is about 4B or less. Alternatively, drop the claim.
5. **`study.tex:74`.**
   - Text: heart rate is accepted "within 1 bpm".
   - Code: for `rhr_avg_14d` the tolerance is relative, 1.01/60 of the reference (`tasks.ts:75`), which is
     0.87 to 1.04 bpm across the cohort's 52 to 62 bpm. There is also a global floor of 0.5 (`tasks.ts:105`).
     `rhr_yesterday` is 1.01 bpm.
   - Fix: state it exactly, or make it 1 bpm absolute.
6. **`design.tex:56-57`.**
   - Text: "Its prompt holds … the user's time zone."
   - Code: in the study, the planner always receives `"UTC"` (`conditions.ts:110`), while the cohort lives at
     UTC−5, UTC−4 and UTC+1.
   - Fix: either state this in the Study section or pass the person's zone.
7. **`design.tex:56`.**
   - Text: "The planner is a language model with structured output."
   - Code: the study harness does not request schema-constrained output. The planner takes the first `{…}` in
     free text with a regex and validates it afterwards (`planner.ts:309-311`, `conditions.ts:105`).
   - Fix: say "emits JSON that is validated against the QuerySpec schema", unless the deployed Worker uses
     constrained decoding. If it does, the study did not test the deployed configuration.
8. **`study.tex:140-142` and the dagger in Table 9.**
   - Text: planner usage is estimated "for \CC{} runs recorded before planner usage was logged separately."
   - Data: none of the 998 C runs has a `planner` field. Every planner token and cost figure is an estimate from 30
     calls on the first 30 study questions (persons p1 to p3).
   - The estimate also assumes exactly one planner call per broker call. A sensitive-keyword refusal makes zero
     calls (27 cases), and a schema failure makes two.
9. **`results.tex:14-16`, Figure 2 caption, and the figure itself.**
   - Text: "on 100 tasks per model and condition."
   - Data: nemotron B has n = 51 and gemini C has n = 98.
   - The figure also draws the missing nemotron C cell as a labelled bar of "0". It reads as 0% accuracy.
   - Fix: render missing cells as "n/a" and give n in the caption.
10. **`study.tex:165`.**
    - Text: "we ran each candidate planner model."
    - Data: five candidates were run: llama-3.3-70b, gpt-oss-120b, mistral-small-3.1, gemma-4-26b and
      inkling-2-small. The last three appear only in `planner-phia-v1-*.jsonl` and `planner-phia-partial-inkling.jsonl`.
    - Only two appear in Table 12, and the prompt changed between v1 and the final version.
    - v1 results on the same sample:

      | Planner | Refused unsupported | Over-refused answerable | Op+metric match |
      |---|---:|---:|---:|
      | mistral-small-3.1 | 100% | 45.2% | 50.0% |
      | gemma-4-26b | 98.0% | 24.2% | 66.1% |
      | inkling-2-small | 97.3% | 54.8% | 40.3% |
      | llama-3.3-70b | 100% | 14.5% | 75.8% |

    - v1 llama-3.3-70b was better than the final prompt on over-refusal and op+metric. The paper must report all
      candidates and both prompt versions.
11. **`scope.tex:22-23`.**
    - Text: the leak detector is reported "as a lower bound on paraphrased leakage."
    - Code: the detector also produces false positives, which the same paragraph concedes ("can count a number the
      agent invented"). Examples from `privacy.ts:56-62`:
      - any number within 0.6 of the weight counts as a weight leak. The weights are 70.9 to 92.2 kg and the
        cohort's HRV values reach about 82 ms, so they can collide;
      - any `NN bpm` string counts as a resting-HR leak;
      - any "N hours" together with "night" counts as a sleep leak in the manager message.
    - Correct statement: a detector with false positives and false negatives is not a lower bound. Report its
      precision on a hand-labelled sample.

### 2b. Related work and citations (5)

12. **`related.tex:10`.**
    - Text: `cai2024timeseriesexam` is cited, with HEARTS, as a "health time-series benchmark" that reports
      "heuristic shortcuts and degradation with temporal complexity."
    - Source: TimeSeriesExam is a general, synthetic, template-generated exam, not a health benchmark. Neither
      phrase appears. Its finding is that models "struggle with complex concepts such as causality analysis."
    - Fix: cite HEARTS alone, or rephrase for Cai.
13. **`related.tex:29-31`.**
    - Text: "ConfAIde, CI-Bench and PrivacyLens show that models which state privacy norms correctly still leak
      when they act."
    - Source: CI-Bench does not evaluate actions and has no paired norm-versus-behaviour measurement. It finds that
      models "struggle … judging appropriateness" and that explicit rules help.
    - Fix: drop CI-Bench from this clause.
14. **`related.tex:36`.**
    - Text: "Data-minimization work … finds that models are poor judges of it [zhou2025dataminimization, zhou2025rescriber]."
    - Source: Rescriber is a user-led sanitisation tool with a 12-user study. It makes no such finding, and the
      user decides what is necessary. Zhou 2025a supports the claim ("LLMs struggle to predict optimal data
      minimization directly"), but in a setting of user prompts to an LLM, not agents.
    - Fix: cite only Zhou 2025a and say "LLM prompting".
15. **`related.tex:15-16`.**
    - Text: "All of these systems give the model, or code it writes, access to the full record."
    - Source: SensorQA and WearableQA are benchmarks, not systems. WEQA routes to "specialised sensor-analysis
      tools and pretrained models" (related_work.md 1.10), so the claim is not established for it.
    - Fix: narrow the claim to PHIA and PHA, or cite evidence per system.
16. **`related.tex:39-40`.**
    - Text: "Leakage grows with what is in context: contextual-integrity violations rise with the number of
      context entries [fu2026ciwork]."
    - Source: per `overexposure.md`, CI-Work's binary violation rate rises with the number of entries, but its
      per-entry leakage proportion "exhibits an inverse trend" (dilution).
    - Fix: "Violations rise …" is supported. "Leakage grows" is not; say "violations grow".

**Total factual mismatches: 16** (11 against data or code, 5 against cited sources).

Verified and correct, not counted:
- the Holm counts (4 and 3);
- `\nSigCA` = 5 and `\nSigCB` = 4, with 0 significant losses;
- pooled 85, 78 and 94%; refusal 35, 33 and 40 of 45;
- exposure 11,630, 666 and 947, ratio 12.3;
- token ratios 0.41 to 0.59 and context ratios 0.15 to 0.25;
- the cost-per-correct statements; latency figures; 82% one-call;
- the planner table values; the PHIA table values (matching `NOTES.md`);
- the trap definitions against `synth.ts`; the 15-metric catalogue; the gate order; the 28/14-day baseline;
  coverage 12/16 h and 60%; the IQR buckets; |t| ≥ 2.5; the 500-character truncation;
- PrivacyLens 25.68% and 38.69%; PHIA "far better" (84% against 22% numerical reasoning);
- Atil et al. at temperature 0 and the TARa@N definition; Abdelnabi 84% to 10% over 864 attacks.

---

## 3. Overclaiming, framing, selective presentation

1. **"Computation outside the model helps the models that need it" (`discussion.tex:5-12`) is causal, without an
   ablation.**
   - C bundles four things: computed values, data-quality caveats, a second LLM (the planner), and a different
     tool description ("The numbers in it are computed by code; rely on them", `conditions.ts:92`).
   - Nothing separates their contributions.
   - Fix: write "was associated with". Or add an analysis from existing data: on C runs where the packet was
     released, compare accuracy with C runs where it was refused (Section 4).
2. **The abstract's "significantly less accurate for none" and Table 4's caption "never lowered it significantly"
   are true per model, but selective.**
   - The question-level table shows a significant C deficit on the threshold question (pooled paired 1 against 18,
     p ≈ 7.6e-5).
   - C's point estimate is also below the best baseline for gemma (95 against B 97), gpt-oss-120b (89 against
     B 93, A 92) and inkling (98 against B 99).
   - Say this in the abstract, for example: "lower than A on one of ten question types".
3. **"Models near ceiling showed no accuracy difference" (`results.tex:55`) confuses "not significant" with "no
   difference".**
   - With n = 100 and only 2 to 3 discordant pairs, the test has almost no power.
   - Report the paired difference with a CI, or a TOST equivalence margin, and phrase it as "no detectable
     difference".
4. **The abstract's "The compute engine reproduced 94.7% of PHIA's reference answers" overstates the result.**
   Required qualifiers:
   - of the 1,837 questions (46%) within the operation set;
   - given hand-mapped specs;
   - with 70% of them needing harness-side reductions over session lists;
   - under PHIA's window convention. The engine's own convention gives 78.1%.

   The conclusion's "reproduced PHIA's reference answers wherever definitions agreed" (`conclusion.tex:9`) is
   circular, since disagreements were defined as definition differences after the fact.
5. **"Every disagreement … has a documented cause; none is a computation error" (Table 13 caption,
   `results.tex:332`, `:358`; `discussion.tex:40`) is too strong.**
   - The 80 threshold mismatches come from the authors' own mapping choice. Sleep-minute aggregates are mapped to
     in-bed time (and match), but sleep-minute thresholds are mapped to `sleep_duration`, which is asleep time.
   - 16 labels are "not reproducible".
   - A reader will see post-hoc attribution. Say "every disagreement was traced to one of 7 documented causes", and
     report threshold agreement with the in-bed mapping as well.
6. **"In the runs we read … we found none caused by a wrong computed value" (`results.tex:74-75`,
   `discussion.tex:39`) cannot be checked.**
   - `run.ts:70` drops the packets (`packets: undefined`), so the released data cannot support this claim.
   - 37 of the 54 C errors had a packet released, and the paper does not say how many were read.
   - Fix: store the packets, check every released-packet error against the truth, and report the count.
7. **"The variance across models is itself a finding: an MCP server's behavior depends on which model calls it"
   (`discussion.tex:47-51`).**
   - The extreme case, llama-4-scout B at 17%, is a tool-call serialization failure on one provider.
   - The finding as stated is about serving infrastructure, not MCP design.
8. **"Context over-exposure is the default, and it buys nothing" (`discussion.tex:22`) and "Raw context put about
   12.3 times as much …" (Table 8).**
   - The ratio is set almost entirely by the authors' choice to export 45 days for every question. A's exposure is
     constant per person by construction (`exposure_a.json`: 10,316 to 13,824 characters).
   - Characters also compare unlike things: CSV rows against JSON packets with metadata, caveats and IDs.
   - The claim is defensible qualitatively. The number 12.3 should come with a sensitivity analysis over export
     length and a count of health values delivered rather than characters.
9. **"We did not find a measurement, for a fixed question, of how much of the record each design places in the
   model's context" (`results.tex:177`), and "These works measure what leaves the model; we also measure what
   enters it" (`related.tex:42-43`).**
   - ToolMinimize measures privacy cost against a minimum-necessary annotation. Zhou 2025a measures redaction of
     the model's input. AirGapAgent minimizes input.
   - Soften to "we did not find one for wearable agents".
10. **"\sys{} makes minimization fully deterministic" (`related.tex:43`).**
    - The ceiling (grant, level, window) is deterministic. What is actually requested, and therefore released
      within the ceiling, is chosen by an LLM planner and by the agent's rephrasings.
    - Say "makes the release ceiling deterministic".
11. **Table 12 caption, "llama-3.3-70b matched the reference operation and metric more often".**
    - 45/62 against 37/62. Paired, it is 16 against 8 discordant, exact p = 0.15. The Wilson CIs are [60, 82] and
      [47, 71].
    - The latency difference is real; the accuracy difference is not established.
12. **The privacy "design predictions" (`results.tex:259-264`) say "the injected instruction never reaches the
    agent" and "a leak in C could only come from the agent inventing or restating numbers."**
    - Interim data shows C leaks of 9/83 in `ci_manager_message` and 2/59 in `injection_in_data`.
    - inkling-2-small has 4/13 C leaks and claude-fable-5.2 has 4/20.
    - When the results land, report what produced these: detector false positives, restated thresholds, or real
      leaks.
    - Interim C cell sizes are also very unbalanced (`purpose_drift` C 21 runs against A 85). Make sure C runs are
      not missing selectively because of planner or provider failures.
13. **Repeatability is planned on only two sleep questions (`study.tex:146-149`).**
    - C turns both into one packet value, so near-perfect C agreement is expected by design.
    - Justify the choice, or include a trend and a threshold question, where C's agent still interprets.
14. **"Holding the agent model fixed" is accurate, but C is not one model.**
    - Every C run also uses llama-3.3-70b as planner, plus gpt-oss-120b as fallback.
    - For the weak open models, the C condition adds a stronger 70B model to the loop. Part of the gain for
      llama-4-scout, mistral and gemma may be planner capacity, not computation.
    - Say so plainly in the abstract or Study design.

---

## 4. Method soundness: threats to validity

Each threat is followed by whether the paper addresses it, and what to compute from existing data. None of these
needs new model calls.

**T1. The synthetic cohort is small: 10 people, one trap each, 100 tasks.**
- *Addressed?* Partly (Scope, "Synthetic cohort").
- *Not addressed:* tasks are clustered within people and traps, so McNemar's independence assumption is
  optimistic.
- *Analyses:*
  - a person-clustered bootstrap CI for each model's C−A difference;
  - a mixed-effects logistic regression `correct ~ condition + (1|model) + (1|person) + (1|question)`, for a
    single pooled effect with an honest CI;
  - report the per-trap tables (Tables 5 and 6) with Wilson CIs, restricted to the 9 complete models. They
    currently pool nemotron's A and B runs and gemini's 98 C runs.

**T2. The scoring rules and the broker were co-designed.**
- *Addressed?* No.
- *Analyses:*
  - **HRV "flat" label:** compute the OLS t-statistic on the truth HRV for the 8 "flat" people over the 28-day
    window, and show that none crosses 2.5, so the label is not an artifact.
  - **"Less than usual":** report how many of the 10 `sleep_vs_usual_3d` tasks accept both answers. A lenient
    label inflates every condition but helps a broker whose bucket edges match the quartile rule.
  - **Planner prompt and study phrasing:** document that the planner prompt contains the study's own phrasing
    ("ending yesterday", "less than usual").

**T3. The leak detector.**
- *Addressed?* Partly. The paper notes misses and invented numbers, but calls the detector a lower bound, which is
  wrong (see 2a #11).
- *Analyses:*
  - hand-label a stratified sample of final texts (for example 30 per condition) and report detector precision
    and recall;
  - list the leak sub-types per condition; `summary.md` already has weight, RHR and sleep counts;
  - count leaks where the matched number is not the true weight or a true RHR value. That gives an
    "invented-number" false-positive rate directly from `privacy-*.jsonl`.

**T4. The planner is fixed across agent models.**
- *Addressed?* No.
- *Analyses:*
  - C accuracy conditional on at least one packet being released, against runs that were refused, per model;
  - the refusal rate per agent model, to show how often the agent's phrasing breaks the planner;
  - an upper bound with a perfect planner: count C errors where every ask was refused (17), and report accuracy
    if those were correct (it rises from 94.6% to 96.3% pooled);
  - for llama-3.3-70b, note that the agent and planner are the same model.

**T5. Condition C includes an extra LLM call.**
- *Addressed?* Only in cost and latency.
- *Not addressed:* compute matching. C gets two LLMs; A and B get one.
- *Analyses:*
  - token-matched framing: total tokens per correct answer, already partly in Table 9;
  - state that a fair "more compute" control (self-consistency in A, which `related_work.md` suggests) was not run.

**T6. Prompts differ between conditions.**
- *Addressed?* The paper says "same system prompt", which is true, but the tool descriptions differ materially:
  - C's tool says "rely on them";
  - B's says "one row per device per day";
  - A receives `last_sync` timestamps in the prompt.
- *Fix:* put all three verbatim in an appendix and discuss the "rely on them" nudge.

**T7. Answer parsing.**
- *Addressed?* The up/down rescoring is now documented and applied consistently, but the parser is described as
  "reads the last `ANSWER:` line" (`study.tex:76`).
- *Not disclosed:* if no `ANSWER:` line exists, the parser takes the last line and extracts any number
  (`tasks.ts:87-94`). That is how "2026" was scored as an answer.
- *Analyses:*
  - report runs without an `ANSWER:` line per condition and model;
  - report unparseable answers (null): A 36, B 29, C 2;
  - make no-`ANSWER:` runs count as wrong, or as format failures, explicitly;
  - re-score B with textual tool calls flagged as harness failures, and give B accuracy with and without them.

**T8. The B harness and tool-call serialization.**
- *Addressed?* No. This is the most serious validity issue.
- *Analyses:*
  - from the stored `final` text, flag every run whose final message is a serialized tool call: 71 llama-4-scout
    B runs and 3 llama-3.3-70b B runs;
  - report B as "valid runs only";
  - re-test C vs B for those two models on the paired valid subset.

**T9. Over-refusal in C on answerable tasks.**
- *Addressed?* Only the opposite direction (honest `unknown`).
- *Analysis:* report the rate of `unknown` on tasks where `unknown` is not accepted:
  - A: 2/924;
  - B: 18/892;
  - C: 28/840.

  C is the most over-cautious condition. It is the mirror image of the honest-refusal result and should sit beside
  Table 7.

**T10. Run handling (retries and invalidation).**
- *Addressed?* No.
- *Analyses:*
  - report error rows by condition (C 623, B 273, A 7, mostly HTTP 401);
  - report the 84 invalidated C runs: 82 of them were correct before invalidation and 82 after, so there was no
    effect;
  - state the policy: "provider errors are retried; a run is never re-sampled because of its answer."

**T11. Planner study validity.**
- *Addressed?* Partly ("wide uncertainty").
- *Not addressed:* the sample is in-distribution for the prompt, and model selection happened on the same sample.
- *Analyses:*
  - report all 5 candidates and both prompt versions;
  - give Wilson CIs and the paired test (p = 0.15) for op+metric;
  - **end-to-end PHIA:** feed each planner's logged spec (`operation`, `metrics`, `window` in `planner-phia.jsonl`)
    through the deterministic compute engine and extraction rules, and report planner-plus-engine accuracy on the
    62 direct questions. This needs no LLM calls.

**T12. Exposure metric.**
- *Addressed?* Partly (the "reach, not volume" framing).
- *Analyses:*
  - recompute A's exposure with exports truncated to each question's window, and to 14 or 28 days, using
    `exportRows` (deterministic);
  - report values delivered (numeric cells) rather than characters, so CSV and JSON overhead do not drive the ratio.

**T13. Single run per task with provider-default sampling.**
- *Addressed?* Partly (Scope, "Models"). Repeatability is pending and covers only 2 sleep tasks (see Section 3 #13).

**T14. Daily release limit.**
- *Addressed?* The limit is presented as a contribution, but the evaluation sets it to 100,000
  (`conditions.ts:119`). It is never exercised, and no reconstruction attack was run. The limitations section
  admits the missing attack.
- *Fix:* either drop the limit from the contributions or show one denial trace.

**T15. Planner time zone.**
- *Addressed?* No. Fixed to UTC in the study (see 2a #6).
- *Analysis:* list the C errors for the travel and DST people (C scored 93% on both) and check whether any came
  from a window shifted by the time zone.

---

## 5. Writing, structure, figures, terminology

**Structure.**
- "Scope of the Study" (Section 7) comes after Discussion and before Conclusion. Most venues expect "Limitations
  / Threats to validity" right after Results or folded into Discussion. Merge Section 7 with the end of
  Section 6.3.
- Section 4.7 (PHIA design) and Sections 5.8 and 5.9 split the PHIA story across two sections. Consider one
  self-contained section, or an appendix.
- Over-exposure is argued three times: in the Introduction, Results 5.4 and Discussion 6.1. Keep the argument in
  the Introduction and the evidence in Results, and cut the Discussion paragraph to its new content.

**Missing definitions.**
- The operation-to-minimum-level table (`MIN_LEVEL`, `catalogue.ts:83-92`) is essential for understanding what
  each question releases. For example, threshold_check releases at level 0, a flag only, and the C errors on the
  threshold question make sense only with that in mind. It is not in the paper.
- "Directly answerable" is defined only inside a table header. Define it in Section 4.7.
- The QuerySpec fields have no example. Add one JSON example.
- What C's agent actually sees: add one sample packet for one study question, at level 2.
- "Reach" is used as a quantity ("the difference is reach") but never operationalised.
- "Data version" and "as_of hour" in the determinism claim are not defined.

**Terminology consistency.**
- **Conditions.**
  - The text uses "raw context", "open tools" and "AskWearables".
  - Figure 2's legend and `summary.md` use "raw data in context" and "open data tools".
  - The abstract uses "raw data in context" and "open data tools".
  - Pick one pair and use it everywhere, including the figure (`report.py` `COND_LABEL`).
- **Release limit.**
  - The text says "daily release limit".
  - Figure 1 says "daily budget".
  - `related_work.md` says "budgets".
  - `GateInput` calls it `daily_packet_budget`.
  - The gate step in Figure 1 is "purpose check", against "contextual-integrity check" in Section 3.3.
- **Release level.**
  - The Introduction lists levels as "(flag, trend, daily, raw)".
  - Section 3.4 describes level 1 as "a direction and a magnitude bucket against the user's baseline", which is
    not a "trend".
  - Use one naming, for example "flag, bucket, values, raw".
- **Packet.** "Context packet" (Introduction), "packet" (elsewhere), and "the broker's responses" (Table 8 caption,
  which counts refusals too). Define the term once and say whether exposure counts refusals.
- **Agent.** "Agent model", "agent" and "model" are used interchangeably for the A/B/C answerer. The planner is
  also "a model". Use "agent model" and "planner model" consistently.

**Figures and tables.**
- **Figure 2:**
  - the missing nemotron C cell is drawn as a "0" bar;
  - the value labels overlap the error bars;
  - the caption says n = 100 for every cell;
  - the y-axis does not start at an informative range.

  Use "n/a", a dot-and-whisker plot (accuracy with CI) sorted by A accuracy, and mark Holm-significant C−A
  differences.
- **Table 4:** add Holm-adjusted p, or a marker, so readers can see which 4 survive. Put the nemotron row's
  incomplete status in the caption.
- **Tables 5 and 6:**
  - add n per cell, and say they pool 11 models with unequal n;
  - restrict them to complete models;
  - Table 6's caption ("helped most on trends") should also state the finding against C: "lower than A on the
    threshold question".
- **Table 7:** pair it with the over-refusal counts (T9).
- **Table 8:** the caption says "with no model significantly more accurate for it". That is a statement about
  Table 4, not this table. Also note that the B "0" for llama-4-scout is an artifact (T8).
- **Table 9:**
  - it is a full page ([p] float) of 32 rows;
  - the bold "highest point estimate" draws the eye to non-significant differences;
  - consider moving it to an appendix and keeping a compact cost-per-correct figure in the main text.
- **Tables 12 and 13:** fix the captions per Section 3 #5 and #11.
- **Captions that state the finding:** Figure 2 and Tables 4 to 9, 12 and 13 already do, which is good. Figure 1,
  Tables 10 and 11 (pending), and Tables 1 to 3 do not need to.

**Smaller points.**
- "Two of these are design choices we would revisit" (`discussion.tex:41`). The pre-check fires on "period"
  everywhere, so this is a bug, not a choice. A one-line fix plus a re-score of the 27 affected asks is possible
  without new model calls, if the planner's spec can be replayed. Otherwise, state the bug.
- `summary.md` points to `eval/paper/privacy.py`; the file is `privacy.ts`.
- The Ethics statement promises "the raw per-run results", but the per-run records omit packets and planner usage.
  Say so, or store them.
- The Introduction mentions "Seven Cloudflare Workers" only in the Figure 1 caption. That deployment detail does
  not belong in a figure caption, or should be backed by a deployment description.

---

## 6. The 10 most important changes (prioritised)

1. **Fix the B baseline artifact (W1, 2a #1, T8).**
   - Detect textual tool calls in `final` (71 llama-4-scout and 3 llama-3.3-70b runs).
   - Report them as harness failures, and give B and C-vs-B with and without them.
   - Remove "invented the answer" from `results.tex:52` and `discussion.tex:34-35`.
   - Ideally, parse textual tool calls in the harness and rerun those cells.
2. **Report the threshold-question deficit and C's over-refusal (W7, T9).**
   - Put the pooled paired result for "any night under 6 h" (1 against 18, p ≈ 7.6e-5) in the abstract and
     Results.
   - Add the `unknown`-on-answerable counts (A 2/924, B 18/892, C 28/840) next to Table 7.
   - Correct the "most of these errors" sentence: 10 of 21.
3. **Report the full planner study (2a #10, W3, T11).**
   - Include all five candidates and both prompt versions, with Wilson CIs and the paired test.
   - State that the refusal rules were written from PHIA's unsupported categories and that selection used the same
     sample.
   - Soften the Table 12 caption.
4. **Reframe the PHIA engine claim (Section 3 #4 and #5, W4).**
   - The abstract must say "of the 1,837 (46%) mappable questions, given hand-mapped specs, under PHIA's windows
     (78.1% under the engine's own)".
   - Disclose that 70% of the mapped questions are reduced by the harness.
   - Report threshold agreement with the in-bed mapping.
   - Add end-to-end planner-plus-engine accuracy from the logged specs.
5. **Add an ablation, or at least a decomposition, from existing data (Section 3 #1 and #14, T4, T5).**
   - Give C accuracy conditional on release against refusal.
   - Give a perfect-planner upper bound.
   - State plainly that C adds a 70B planner to every agent's loop.
   - Replace the causal wording "computation outside the model helps" with "was associated with".
6. **Fix the leak detector's claims and validate it before the privacy results are written (2a #11, T3, W6).**
   - Drop "lower bound".
   - Hand-label a sample and report precision and recall.
   - Separate gate-enforced non-release (true by construction) from residual leakage.
   - Explain the interim C leaks (manager 9/83, injection 2/59).
7. **Correct the remaining factual errors (2a #2 to #9, 2b #12 to #16).** These are:
   - 17B active parameters;
   - the 1 bpm tolerance;
   - the UTC planner time zone;
   - "structured output";
   - all planner usage being estimated;
   - the Figure 2 "0" bar and the n values;
   - the "period" false-positive location;
   - the five citation misuses: TimeSeriesExam, CI-Bench, Rescriber, "all of these systems", and "leakage grows".
8. **Add clustered or mixed-effects inference and equivalence statements (T1, Section 3 #3).**
   - Use a person-clustered bootstrap or a GLMM for the pooled effect.
   - Give CIs for the paired differences of near-ceiling models instead of "no difference".
   - Restrict the pooled trap and question tables to the 9 complete models.
9. **Make the exposure measurement robust (Section 3 #8, T12).**
   - Run a sensitivity analysis over A's export length (question window, 14, 28 and 45 days).
   - Count delivered health values, not characters.
   - Say which C responses (refusals included) are counted.
10. **Disclose run handling and complete the record (W8, T7, T10, T14).**
    - State the retry and invalidation policy and its counts.
    - State the parser's no-`ANSWER:` fallback.
    - Store packets and planner usage per run, so that "no wrong computed value" becomes checkable.
    - Either exercise the daily release limit or drop it from the contributions.
    - Unify the condition and term names (Section 5), and move Scope into a Limitations or Threats subsection.

---

*Prepared without editing any paper file. Analysis scripts were run from the scratchpad against the raw JSONL.
Every count above can be reproduced from `eval/paper/results/accuracy-*.jsonl` and
`planner-phia*.jsonl`.*
