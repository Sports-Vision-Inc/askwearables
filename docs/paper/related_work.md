# AskWearables: Related Work Survey

Compiled 2026-11-24. Every entry under "Verified" was opened: arXiv entries through their abstract page metadata (arXiv API, `export.arxiv.org`, which returns the abs-page record including title, full author list, abstract and comments); non-arXiv entries through the page or PDF listed, or the Crossref record for the DOI where the publisher page blocked automated access. BibTeX keys refer to `references.bib` in this folder. Venues are given only where the arXiv record, the publisher record, or the page itself states them; otherwise the entry is cited as an arXiv preprint.

Notation: "What" = two sentences on the paper, "vs. AskWearables" = one sentence on how this work relates or differs.

---

## 1. LLMs over wearable and personal health data (13 verified)

**1.1 Transforming Wearable Data into Personal Health Insights using Large Language Model Agents (PHIA)**
Merrill et al., 2024. arXiv:2406.06464 (arXiv comment: accepted to Nature Communications). URL: https://arxiv.org/abs/2406.06464. Key: `merrill2024phia`
- What: Introduces the Personal Health Insights Agent, a ReAct-style agent that writes and runs Python code and uses web search to answer questions over a user's wearable data. It releases two benchmarks with over 4,000 health-insight questions (objective and open-ended) and shows, with 650 hours of expert evaluation, that the agent beats a code-generation baseline and direct numeric reasoning.
- vs. AskWearables: PHIA supplies our accuracy benchmark (objective questions) and is the closest prior system, but its agent receives the full data frame and generates arbitrary code, whereas AskWearables restricts the model to typed queries over a precomputed metric layer behind a policy gate.

**1.2 Towards a Personal Health Large Language Model (PH-LLM)**
Cosentino et al., 2024. arXiv:2406.06474. URL: https://arxiv.org/abs/2406.06474. Key: `cosentino2024phllm`
- What: Fine-tunes Gemini to reason over numerical time-series personal health data for sleep and fitness coaching. It evaluates on 857 expert-written case studies, professional certification-style exams, and prediction of self-reported sleep outcomes.
- vs. AskWearables: PH-LLM improves the model so it can read raw sensor summaries; AskWearables takes the opposite route and keeps numeric work out of the model entirely, so it works with any off-the-shelf open-weight model.

**1.3 Health-LLM: Large Language Models for Health Prediction via Wearable Sensor Data**
Kim et al., 2024. arXiv:2401.06866. URL: https://arxiv.org/abs/2401.06866. Key: `kim2024healthllm`
- What: Evaluates 12 LLMs with prompting and fine-tuning on ten consumer health prediction tasks over four public wearable datasets (PMData, LifeSnaps, GLOBEM, AW_FB). It finds that context enhancement and fine-tuning substantially improve performance on these prediction tasks.
- vs. AskWearables: Health-LLM serialises sensor values into the prompt, which is the "raw data in context" pattern we use as baseline A.

**1.4 Large Language Models are Few-Shot Health Learners**
Liu et al., 2023. arXiv:2305.15525. URL: https://arxiv.org/abs/2305.15525. Key: `liu2023fewshot`
- What: Shows that with few-shot tuning an LLM can ground physiological and behavioural time series and make inferences on clinical and wellness tasks. It is an early demonstration that LLMs can consume numeric health signals at all.
- vs. AskWearables: It motivates putting numbers in front of the model; AskWearables asks whether that is necessary when a deterministic metric layer can supply the derived quantities.

**1.5 Language Models Still Struggle to Zero-shot Reason about Time Series**
Merrill et al., 2024. arXiv:2404.11757. URL: https://arxiv.org/abs/2404.11757. Key: `merrill2024timeseries`
- What: Builds an evaluation of etiological, question-answering and context-aided forecasting reasoning over multi-scale time series with captions across ten domains. Models score marginally above random on etiological and QA tasks, up to 30 points below humans.
- vs. AskWearables: This is direct evidence for our design premise that the model should not be the component that reads and reasons over raw series.

**1.6 Are Language Models Actually Useful for Time Series Forecasting?**
Tan et al., 2024. NeurIPS 2024 (Spotlight). arXiv:2406.16964. URL: https://arxiv.org/abs/2406.16964. Key: `tan2024forecasting`
- What: Ablates the LLM component in popular LLM-based forecasters and finds that removing it or replacing it with simple attention layers does not hurt and often helps. It also finds that pretrained LLMs do no better than models trained from scratch at capturing sequential dependencies.
- vs. AskWearables: Supports delegating trend and baseline computation to code rather than to the language model.

**1.7 Time-LLM: Time Series Forecasting by Reprogramming Large Language Models**
Jin et al., 2024. ICLR 2024. arXiv:2310.01728. URL: https://arxiv.org/abs/2310.01728. Key: `jin2024timellm`
- What: Reprograms time-series patches into text-prototype embeddings so a frozen LLM can be used as a forecaster. It reports state-of-the-art forecasting, including few- and zero-shot settings.
- vs. AskWearables: Represents the "make the LLM a numeric model" line that [Tan 2024] questions; AskWearables uses the LLM only for language understanding and explanation.

**1.8 The Anatomy of a Personal Health Agent**
Heydari et al., 2025. arXiv:2508.20148. URL: https://arxiv.org/abs/2508.20148. Key: `heydari2025anatomy`
- What: Designs a multi-agent personal health agent (data-science, domain-expert and health-coach sub-agents) that reasons over consumer wearable data and health records, grounded in an analysis of real user needs. It evaluates the system on 10 benchmark tasks with more than 7,000 annotations and 1,100 hours of expert and end-user effort.
- vs. AskWearables: Its data-science sub-agent still executes generated code over the user's data; AskWearables is a broker layer that such an agent could call, adding grants, release levels and audit.

**1.9 SensorQA: A Question Answering Benchmark for Daily-Life Monitoring**
Reichman et al., 2025. arXiv:2501.04974. URL: https://arxiv.org/abs/2501.04974. Key: `reichman2025sensorqa`
- What: Introduces a human-created QA dataset of 5.6K questions over long-term sensor time series from daily life. It benchmarks current models, including on edge devices, and finds a substantial gap to optimal QA performance.
- vs. AskWearables: A candidate second accuracy benchmark beyond PHIA's objective questions.

**1.10 WEQA: Wearable hEalth Question Answering with Query-Adaptive Agentic Reasoning**
Zhang et al., 2026. arXiv:2606.18147. URL: https://arxiv.org/abs/2606.18147. Key: `zhang2026weqa`
- What: Proposes an LLM controller that plans and routes each wearable-health query to specialised sensor-analysis tools and pretrained models, then audits its answer against external knowledge. It curates a benchmark over four open wearable datasets and reports 24% higher accuracy than LLM and agentic baselines.
- vs. AskWearables: WEQA also routes questions to tools, but optimises accuracy only; AskWearables adds a typed query interface constrained by policy, release levels and reconstruction budgets.

**1.11 WearableQA: A Benchmark for Health Reasoning over Real-World Wearable Data**
Lee et al., 2026. arXiv:2609.05405. URL: https://arxiv.org/abs/2609.05405. Key: `lee2026wearableqa`
- What: Releases 4,084 ten-option multiple-choice questions built from wearable time series, blood biomarkers and demographics of 200 real participants with up to 500 days each. Questions span 16 types along data-vs-health reasoning and single-vs-cross-signal axes.
- vs. AskWearables: A recent benchmark whose "data reasoning" split maps directly onto our metric layer and should be added to the evaluation.

**1.12 HEARTS: Benchmarking LLM Reasoning on Health Time Series**
Li et al., 2026. arXiv:2603.06638. URL: https://arxiv.org/abs/2603.06638. Key: `li2026hearts`
- What: Integrates 16 datasets, 12 health domains and 20 signal modalities into 110 tasks across perception, inference, generation and deduction. Across 16 LLMs it finds that models underperform specialised models, rely on heuristics, and degrade with temporal complexity.
- vs. AskWearables: Further evidence that direct LLM numeric reasoning over health series is unreliable, which motivates computing metrics in code.

**1.13 TimeSeriesExam: A Time Series Understanding Exam**
Cai et al., 2024. NeurIPS 2024 Workshop on Time Series in the Age of Large Models. arXiv:2410.14752. URL: https://arxiv.org/abs/2410.14752. Key: `cai2024timeseriesexam`
- What: A procedurally generated multiple-choice exam of over 700 questions testing pattern recognition, noise, similarity, anomaly and causality understanding. All tested models struggle with complex concepts such as causality.
- vs. AskWearables: A general diagnostic of model time-series understanding, complementary to our health-specific setting.

---

## 2. Tool-using and code-executing agents for numeric reasoning (8 verified)

**2.1 PAL: Program-aided Language Models**
Gao et al., 2022. arXiv:2211.10435. URL: https://arxiv.org/abs/2211.10435. Key: `gao2022pal`
- What: Has the LLM write a Python program as its reasoning chain and delegates the actual computation to an interpreter. It outperforms much larger chain-of-thought models on mathematical and symbolic reasoning benchmarks.
- vs. AskWearables: AskWearables pushes the same separation further: the computation is not even generated by the model, it is fixed, tested code in the metric layer.

**2.2 Program of Thoughts Prompting: Disentangling Computation from Reasoning for Numerical Reasoning Tasks**
Chen et al., 2023. TMLR 2023. arXiv:2211.12588. URL: https://arxiv.org/abs/2211.12588. Key: `chen2023pot`
- What: Expresses reasoning as a program executed externally, separating computation from reasoning on math and financial QA. It reports around 12% average gains over chain-of-thought.
- vs. AskWearables: Same motivation (LLMs compute poorly); we remove generated code, which also removes a source of variance and an execution attack surface.

**2.3 Toolformer: Language Models Can Teach Themselves to Use Tools**
Schick et al., 2023. arXiv:2302.04761. URL: https://arxiv.org/abs/2302.04761. Key: `schick2023toolformer`
- What: Self-supervises a language model to decide when to call APIs such as a calculator, search and QA system. Tool use improves zero-shot performance without sacrificing language modelling.
- vs. AskWearables: Our typed query API is a tool, but one whose outputs are shaped by a policy rather than returned in full.

**2.4 ReAct: Synergizing Reasoning and Acting in Language Models**
Yao et al., 2023. ICLR 2023. arXiv:2210.03629. URL: https://arxiv.org/abs/2210.03629. Key: `yao2023react`
- What: Interleaves reasoning traces with actions against an environment so that the model can gather information while it reasons. It improves QA, fact verification and interactive decision-making.
- vs. AskWearables: ReAct is the agent loop used by PHIA and by our baseline B; AskWearables constrains what each action can return.

**2.5 Chain of Code: Reasoning with a Language Model-Augmented Code Emulator**
Li et al., 2024. ICML 2024. arXiv:2312.04474. URL: https://arxiv.org/abs/2312.04474. Key: `li2024chaincode`
- What: Lets the model write code where some lines are executed by an interpreter and others are emulated by the LM, mixing semantic and numeric reasoning. It improves over chain-of-thought on BIG-Bench Hard.
- vs. AskWearables: Shows the value of executable computation; we place all numeric execution in deterministic code and leave only semantics to the model.

**2.6 Faith and Fate: Limits of Transformers on Compositionality**
Dziri et al., 2023. arXiv:2305.18654. URL: https://arxiv.org/abs/2305.18654. Key: `dziri2023faith`
- What: Studies multi-digit multiplication, logic puzzles and dynamic programming as computation graphs. It argues transformers solve these by linearised subgraph matching and that errors compound with depth.
- vs. AskWearables: A mechanistic account of why direct numeric reasoning over many daily values (our baseline A) is expected to fail.

**2.7 Can Large Language Models Solve Engineering Equations? A Systematic Comparison of Direct Prediction and Solver-Assisted Approaches**
Kodathala and Vunnam, 2026. arXiv:2601.01774. URL: https://arxiv.org/abs/2601.01774. Key: `kodathala2026equations`
- What: Compares direct numerical prediction by six frontier models with a hybrid where the LLM formulates equations and Newton-Raphson solves them, over 100 engineering problems. Solver assistance reduces mean relative error by 67.9% to 81.8%.
- vs. AskWearables: Same "model formulates, code computes" finding in a different domain; AskWearables also fixes the formulation (typed queries) to gain repeatability.

**2.8 InfiAgent-DABench: Evaluating Agents on Data Analysis Tasks**
Hu et al., 2024. arXiv:2401.05507. URL: https://arxiv.org/abs/2401.05507. Key: `hu2024dabench`
- What: A benchmark of 257 closed-form data-analysis questions over 52 CSV files for LLM agents that interact with an execution environment. It evaluates many models and agent frameworks on end-to-end analysis.
- vs. AskWearables: Characterises the "unrestricted code over raw tables" agent that our baseline B approximates.

---

## 3. Privacy for LLM agents (12 verified)

**3.1 Can LLMs Keep a Secret? Testing Privacy Implications of Language Models via Contextual Integrity Theory (ConfAIde)**
Mireshghallah et al., 2024. ICLR 2024 (Spotlight). arXiv:2310.17884. URL: https://arxiv.org/abs/2310.17884. Key: `mireshghallah2024confaide`
- What: Introduces a multi-tier benchmark grounded in contextual integrity to test whether LLMs reveal private information in inappropriate contexts. GPT-4 and ChatGPT leak in a large fraction of cases even with privacy-inducing prompts.
- vs. AskWearables: Provides attack templates for our contextual-integrity evaluation; AskWearables enforces flow norms outside the model rather than relying on the model's judgement.

**3.2 PrivacyLens: Evaluating Privacy Norm Awareness of Language Models in Action**
Shao et al., 2024. NeurIPS 2024 Datasets and Benchmarks. arXiv:2409.00138. URL: https://arxiv.org/abs/2409.00138. Key: `shao2024privacylens`
- What: Turns privacy-sensitive seeds into vignettes and agent trajectories to measure leakage in LM agents' actions, not just their answers to probing questions. It finds a large gap between models' stated privacy norms and their behaviour as agents.
- vs. AskWearables: Our contextual-integrity attacks should follow PrivacyLens' trajectory-based leakage measurement, applied to health data flows.

**3.3 Privacy in Action: Towards Realistic Privacy Mitigation and Evaluation for LLM-Powered Agents (PrivacyChecker, PrivacyLens-Live)**
Wang et al., 2025. Findings of EMNLP 2025. arXiv:2509.17488. URL: https://arxiv.org/abs/2509.17488. Key: `wang2025privacyinaction`
- What: Proposes PrivacyChecker, a model-agnostic, contextual-integrity-based mitigation that cuts leakage from about 36% to 7% (DeepSeek-R1) and 33% to 8% (GPT-4o). It also introduces PrivacyLens-Live, which turns static benchmarks into dynamic MCP and Agent-to-Agent environments where measured risk is substantially higher.
- vs. AskWearables: PrivacyChecker is an LLM-based mitigation that still sees the data; AskWearables enforces minimisation deterministically, and PrivacyLens-Live's MCP setting is the right environment for our baseline B.

**3.4 AirGapAgent: Protecting Privacy-Conscious Conversational Agents**
Bagdasarian et al., 2024. ACM CCS 2024. arXiv:2405.05175. URL: https://arxiv.org/abs/2405.05175. Key: `bagdasarian2024airgap`
- What: Restricts a conversational agent to only the user data necessary for the task, selected by a separate minimiser that never sees third-party input, defending against context-hijacking. Against a single-query context-hijacking attack on Gemini Ultra, data protection falls from 94% to 45% for the plain agent, while AirGapAgent keeps 97%.
- vs. AskWearables: The closest privacy architecture; AskWearables replaces the LLM-based minimiser with a deterministic, per-purpose grant and release-level policy plus budgets and audit.

**3.5 CI-Bench: Benchmarking Contextual Integrity of AI Assistants on Synthetic Data**
Cheng et al., 2024. arXiv:2409.13903. URL: https://arxiv.org/abs/2409.13903. Key: `cheng2024cibench`
- What: A synthetic benchmark covering contextual-integrity dimensions (roles, information types, transmission principles) for evaluating whether assistants protect personal data during inference. It contributes a scalable multi-step synthetic data pipeline.
- vs. AskWearables: A source of CI scenarios that could be specialised to health metrics.

**3.6 Operationalizing Data Minimization for Privacy-Preserving LLM Prompting**
Zhou et al., 2025. arXiv:2510.03662. URL: https://arxiv.org/abs/2510.03662. Key: `zhou2025dataminimization`
- What: Formally defines data minimisation as the least revealing disclosure that preserves utility, and finds it with a priority-queue tree search over privacy-ordered transformations. Larger models tolerate far more minimisation, and LLMs are poor at predicting the optimal minimisation themselves.
- vs. AskWearables: Supports making minimisation a system decision (release levels) rather than a model decision.

**3.7 Rescriber: Smaller-LLM-Powered User-Led Data Minimization for LLM-Based Chatbots**
Zhou et al., 2025. CHI 2025. arXiv:2410.11876. URL: https://arxiv.org/abs/2410.11876. Key: `zhou2025rescriber`
- What: A browser extension that uses a small local LLM to help users detect and sanitise personal information before sending prompts. A user study shows it reduces unnecessary disclosure.
- vs. AskWearables: User-led minimisation at the prompt; AskWearables minimises at the data broker, per agent and purpose.

**3.8 Privacy Preference Controls for Agentic Systems**
Kochar et al., 2026. arXiv:2610.29929. URL: https://arxiv.org/abs/2610.29929. Key: `kochar2026preference`
- What: Develops a taxonomy of enforceable privacy preferences for agentic systems from law, existing privacy tools and an audit of 30 assistants and agent platforms. It builds eight open-source prototypes showing how the taxonomy integrates into MCP and Agent2Agent.
- vs. AskWearables: Our grants and release levels are one concrete instance of such enforceable preferences for health data.

**3.9 Puda: Private User Dataset Agent for User-Sovereign and Privacy-Preserving Personalized AI**
Maeda et al., 2026. arXiv:2602.08268. URL: https://arxiv.org/abs/2602.08268. Key: `maeda2026puda`
- What: A user-sovereign, client-side architecture that lets users share personal data with agents at three privacy levels (detailed history, extracted keywords, predefined category subsets). The coarsest level retains 97.2% of personalisation performance in a travel-planning task.
- vs. AskWearables: Puda's tiered disclosure is analogous to our four release levels, but it lacks per-purpose grants, budgets against repeated queries and audit receipts.

**3.10 Minim: Privacy-Aware Minimal View for Agents via Trusted Local Sanitization**
Yu et al., 2026. ICML 2026. arXiv:2606.13949. URL: https://arxiv.org/abs/2606.13949. Key: `yu2026minim`
- What: A trusted local broker that scores UI elements for sensitivity and task necessity and keeps, abstracts or removes each before observations leave the device. Grounded in contextual integrity, it prunes aggressively while preserving task success on WebArena-derived observations.
- vs. AskWearables: Same "trusted broker before the model" principle, but learned and for UI state; ours is deterministic and for numeric health data.

**3.11 ToolMinimize: Auditing and Rewriting LLM Agent Tool Calls to Minimize Privacy Exposure**
Li and Xu, 2026. arXiv:2608.24957. URL: https://arxiv.org/abs/2608.24957. Key: `li2026toolminimize`
- What: Measures that 81 to 88% of tool calls by production LLMs include unnecessary sensitive data, and builds middleware that rewrites arguments to the minimum necessary. It reduces privacy cost by 81 to 92% while keeping argument-level task validity.
- vs. AskWearables: Minimises outbound tool arguments; AskWearables minimises inbound data released to the agent.

**3.12 AgentCIScope: Grounded Contextual Integrity Evaluation for LLM Agents**
Guo et al., 2026. arXiv:2610.19158. URL: https://arxiv.org/abs/2610.19158. Key: `guo2026agentciscope`
- What: Evaluates whether agents' information flows across email, documents and other applications comply with context-specific disclosure constraints, grounded in executed tool calls. It addresses limitations of model-level or static CI evaluation.
- vs. AskWearables: A candidate harness for grounded CI leakage measurement of baselines A and B.

---

## 4. Authorization and guardrails outside the model (19 verified)

**4.1 Defeating Prompt Injections by Design (CaMeL)**
Debenedetti et al., 2025. arXiv:2503.18813. URL: https://arxiv.org/abs/2503.18813. Key: `debenedetti2025camel`
- What: Extracts control and data flow from the trusted user query so untrusted data can never change program flow, and attaches capabilities to values to block exfiltration over unauthorised flows. It solves 77% of AgentDojo tasks with provable security, against 84% for an undefended system.
- vs. AskWearables: Shares the "policy outside the model" principle; AskWearables specialises it to data release (what values and at what granularity) rather than control-flow integrity.

**4.2 The Dual LLM pattern for building AI assistants that can resist prompt injection**
Willison, 2023. Blog post. URL: https://simonwillison.net/2023/Apr/25/dual-llm-pattern/. Key: `willison2023dual`
- What: Proposes a privileged LLM that never sees untrusted content and a quarantined LLM that processes it, with a controller passing opaque references between them. It is the informal origin of control/data separation for LLM assistants.
- vs. AskWearables: Our broker returns derived values in a fixed packet so the agent never holds raw records, an analogue of passing references instead of data.

**4.3 Securing AI Agents with Information-Flow Control (FIDES)**
Costa et al., 2025. arXiv:2505.23643. URL: https://arxiv.org/abs/2505.23643. Key: `costa2025fides`
- What: Formalises agent planners and characterises properties enforceable by dynamic taint tracking. Fides tracks confidentiality and integrity labels and deterministically enforces security policies, with primitives for selectively hiding information.
- vs. AskWearables: Label-based IFC could complement our release levels; AskWearables enforces at a single data boundary rather than tracking labels through the whole plan.

**4.4 aiAuthZ: Off-Host, Identity-Bound Authorization for AI Agents**
Kodathala, 2026. arXiv:2607.05518 (technical report). URLs: https://arxiv.org/abs/2607.05518 and https://github.com/Sports-Vision-Inc/aiAuthZ. Key: `kodathala2026aiauthz`
- What: Shows model refusal of eight attack scenarios ranges from 100% down to 38% across 15 models, and presents a gateway that verifies caller identity with per-message HMAC signatures and evaluates a role- and argument-level policy the agent cannot read or modify. Every decision joins a SHA-256 hash-chained audit log, and residual attack success drops to 0% with at most 0.03 ms added latency.
- vs. AskWearables: AskWearables reuses the off-host gate and hash-chained receipts, and adds data-specific semantics: purpose-bound grants, release levels, minimum-necessary shaping and reconstruction budgets.

**4.5 Design Patterns for Securing LLM Agents against Prompt Injections**
Beurer-Kellner et al., 2025. arXiv:2506.08837. URL: https://arxiv.org/abs/2506.08837. Key: `beurerkellner2025patterns`
- What: Proposes principled design patterns (e.g. action-selector, plan-then-execute, dual LLM, context minimisation) with provable resistance to prompt injection. It analyses their utility/security trade-offs through case studies.
- vs. AskWearables: AskWearables can be read as a combination of their context-minimisation and constrained-action patterns, applied to health data.

**4.6 Progent: Securing AI Agents with Privilege Control**
Shi et al., 2025. arXiv:2504.11703. URL: https://arxiv.org/abs/2504.11703. Key: `shi2025progent`
- What: Expresses privilege as symbolic rules over tool names and arguments, checked deterministically at every tool call, with an LLM proposing the initial policy and an SMT solver allowing only narrowing updates without approval. It significantly reduces attack success on AgentDojo and ASB while keeping utility high.
- vs. AskWearables: Progent decides whether a call may happen; AskWearables also decides how much information an allowed call may return.

**4.7 IsolateGPT: An Execution Isolation Architecture for LLM-Based Agentic Systems**
Wu et al., 2025. NDSS 2025. arXiv:2403.04960. URL: https://arxiv.org/abs/2403.04960. Key: `wu2025isolategpt`
- What: Isolates the execution of third-party apps in LLM systems, with a hub mediating all cross-app interaction. It defends against many security, privacy and safety issues with low overhead for most queries.
- vs. AskWearables: A system-level mediation design comparable to our broker, but not specialised to data granularity.

**4.8 Contextual Agent Security: A Policy for Every Purpose (Conseca)**
Tsai and Bagdasarian, 2025. HotOS 2025. arXiv:2501.17070. URL: https://arxiv.org/abs/2501.17070. Key: `tsai2025conseca`
- What: Argues that agent safety needs context-specific policies and proposes generating just-in-time, human-verifiable policies from trusted context. Policies are then enforced deterministically.
- vs. AskWearables: Our per-purpose grants are a manually authored instance of purpose-bound policies.

**4.9 AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents**
Debenedetti et al., 2024. arXiv:2406.13352. URL: https://arxiv.org/abs/2406.13352. Key: `debenedetti2024agentdojo`
- What: An extensible environment of realistic tasks and security test cases for prompt-injection attacks and defences. It is the standard benchmark for agent injection robustness.
- vs. AskWearables: Our adversarial evaluation should report on AgentDojo or an AgentDojo-style health suite for comparability.

**4.10 InjecAgent: Benchmarking Indirect Prompt Injections in Tool-Integrated Large Language Model Agents**
Zhan et al., 2024. Findings of ACL 2024. arXiv:2403.02691. URL: https://arxiv.org/abs/2403.02691. Key: `zhan2024injecagent`
- What: 1,054 test cases over 17 user tools and 62 attacker tools, with attack goals of direct harm and private data exfiltration. ReAct-prompted GPT-4 is vulnerable 24% of the time, higher with reinforced attacks.
- vs. AskWearables: Its exfiltration class is the threat our release levels and budgets bound.

**4.11 Not what you've signed up for: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection**
Greshake et al., 2023. arXiv:2302.12173. URL: https://arxiv.org/abs/2302.12173. Key: `greshake2023indirect`
- What: Introduces indirect prompt injection, where instructions planted in retrieved content manipulate LLM-integrated applications. It demonstrates data theft and other attacks on real systems.
- vs. AskWearables: The threat model that motivates enforcing policy outside the model.

**4.12 StruQ: Defending Against Prompt Injection with Structured Queries**
Chen et al., 2025. USENIX Security 2025. arXiv:2402.06363. URL: https://arxiv.org/abs/2402.06363. Key: `chen2025struq`
- What: Separates prompt and data into two channels through a secure front end and fine-tunes a model to follow only the prompt channel. It substantially improves resistance to prompt injection.
- vs. AskWearables: A model-side control/data separation; AskWearables needs no fine-tuning and works with any open-weight model.

**4.13 Model Context Protocol (MCP): Landscape, Security Threats, and Future Research Directions**
Hou et al., 2025. arXiv:2503.23278. URL: https://arxiv.org/abs/2503.23278. Key: `hou2025mcp`
- What: Surveys MCP architecture and the server lifecycle and catalogues security threats at each phase. It proposes mitigations and research directions.
- vs. AskWearables: Frames the risks of baseline B (unrestricted MCP access).

**4.14 MCP Safety Audit: LLMs with the Model Context Protocol Allow Major Security Exploits**
Radosevich and Halloran, 2025. arXiv:2504.03767. URL: https://arxiv.org/abs/2504.03767. Key: `radosevich2025mcpaudit`
- What: Demonstrates that frontier LLMs using standard MCP servers can be coerced into malicious code execution, credential theft and remote access. It introduces MCPSafetyScanner, an agentic tool for auditing MCP servers.
- vs. AskWearables: Shows that exposing broad MCP tools to a model is dangerous, which our broker avoids by exposing only typed, policy-gated queries.

**4.15 Model Context Protocol (MCP) at First Glance: Studying the Security and Maintainability of MCP Servers**
Hasan et al., 2025. arXiv:2506.13538. URL: https://arxiv.org/abs/2506.13538. Key: `hasan2025mcp`
- What: Analyses 1,899 open-source MCP servers for health, security and maintainability. It identifies eight vulnerability classes, five specific to MCP, and tool-poisoning in a share of servers.
- vs. AskWearables: Empirical backdrop for the risks of off-the-shelf health MCP servers.

**4.16 Before the Tool Call: Deterministic Pre-Action Authorization for Autonomous AI Agents (Open Agent Passport)**
Uchibeke, 2026. arXiv:2603.20953. URL: https://arxiv.org/abs/2603.20953. Key: `uchibeke2026oap`
- What: Specifies and implements a synchronous pre-execution authorization layer that evaluates tool calls against a declarative policy and emits a signed audit record. In a live adversarial testbed it reduced attacker success from 74.6% under a permissive policy to 0%.
- vs. AskWearables: Same deterministic pre-action gate with signed audit, without data-granularity controls or reconstruction budgets.

**4.17 AgentCap: Capability-Based Runtime Authorization for Secure LLM Agent Execution**
Suresh and Gao, 2026. NeurIPS 2026 Agents in the Wild workshop (non-archival). arXiv:2611.00729. URL: https://arxiv.org/abs/2611.00729. Key: `suresh2026agentcap`
- What: Externalises authorization from the model via an MCP wrapper that issues short-lived, budget-bounded capability tokens after evaluating intent, provenance and workflow constraints. It reduces attack success across AgentDojo and InjecAgent.
- vs. AskWearables: Its budget-bounded capabilities are close to our per-grant daily budgets; ours bound information released rather than calls made.

**4.18 Treating the Model as an Untrusted Component: Deterministic Policy Enforcement, Human Approval and Taint Tracking Against Prompt Injection in Tool-Using Agents, with Validation on Open-Weights Models**
Aljumaily et al., 2026. arXiv:2611.11571. URL: https://arxiv.org/abs/2611.11571. Key: `aljumaily2026untrusted`
- What: Compares in-prompt defences with four deterministic reference monitors, human approval and taint tracking using an effect-based oracle and open-weight Qwen2.5 models. In-prompt guardrails depend on the model and collapse under adaptive attack, while task-bound monitors keep admission low.
- vs. AskWearables: Methodologically closest to our open-weight evaluation of gate vs. no gate, but on action safety rather than data leakage.

**4.19 Approve What, Exactly? Effect Binding and Trusted Rendering for Agent Step-Up Authorization**
Kodathala et al., 2026. arXiv:2610.21063. URL: https://arxiv.org/abs/2610.21063. Key: `kodathala2026stepup`
- What: Defines twelve attacks on agent approval paths and audits ten runtimes, finding no third-party verifiable approval record. It builds a gateway that renders approvals from a canonical effect descriptor signed by a passkey, with Tamarin proofs.
- vs. AskWearables: Relevant if raw-level release requires user step-up; AskWearables' receipts could bind to the same effect descriptor.

---

## 5. Reconstruction from aggregate queries and differential privacy (6 verified)

**5.1 Revealing Information while Preserving Privacy**
Dinur and Nissim, 2003. PODS 2003, pp. 202-210, doi:10.1145/773153.773173. URL opened: https://crypto.stanford.edu/seclab/sem-03-04/psd.pdf (author PDF; ACM page blocked automated access, DOI confirmed via Crossref). Key: `dinur2003revealing`
- What: Gives polynomial-time algorithms that reconstruct a database from noisy subset-sum answers, showing that perturbation of magnitude o(sqrt(n)) permits near-complete reconstruction. It establishes that answering too many aggregate queries too accurately destroys privacy.
- vs. AskWearables: The theoretical basis for our daily query budgets: unrestricted repeated "trend" or "daily" queries could reconstruct raw series.

**5.2 Calibrating Noise to Sensitivity in Private Data Analysis**
Dwork et al., 2006. TCC 2006, LNCS 3876, pp. 265-284, doi:10.1007/11681878_14. Verified via Crossref record (Springer page blocked automated access). Key: `dwork2006calibrating`
- What: Introduces calibrating additive noise to a function's sensitivity, the foundation of differential privacy. It shows how to answer queries with privacy guarantees that compose.
- vs. AskWearables: Our budgets are a non-noisy, accounting-based approximation; adding calibrated noise to trend outputs is a natural extension.

**5.3 The Algorithmic Foundations of Differential Privacy**
Dwork and Roth, 2014. Foundations and Trends in Theoretical Computer Science 9(3-4):211-487. URL: https://www.cis.upenn.edu/~aaroth/Papers/privacybook.pdf. Key: `dwork2014algorithmic`
- What: The standard monograph on differential privacy, covering mechanisms, composition and lower bounds including reconstruction attacks. It formalises privacy budgets under composition.
- vs. AskWearables: Reference for the composition reasoning behind per-agent daily budgets.

**5.4 Understanding Database Reconstruction Attacks on Public Data**
Garfinkel et al., 2018. ACM Queue 16(5):28-53, doi:10.1145/3291276.3295691. Verified via Crossref record (ACM Queue page blocked automated access). Key: `garfinkel2018reconstruction`
- What: Demonstrates with a SAT solver how published census-style tabulations can be reconstructed into individual records. It explains why the US Census Bureau adopted differential privacy.
- vs. AskWearables: A practical illustration that aggregates (our "trend" and "daily" levels) are not safe by default.

**5.5 Exposed! A Survey of Attacks on Private Data**
Dwork et al., 2017. Annual Review of Statistics and Its Application 4:61-84, doi:10.1146/annurev-statistics-060116-054123. Verified via Crossref record (publisher page blocked automated access). Key: `dwork2017exposed`
- What: Surveys reconstruction and tracing attacks on aggregate statistics. It argues that any sufficiently accurate release of many statistics leaks individual data.
- vs. AskWearables: Background for treating repeated agent queries as an aggregate release.

**5.6 Simulatable Auditing**
Kenthapadi et al., 2005. PODS 2005, pp. 118-127, doi:10.1145/1065167.1065183. Verified via Crossref record (ACM page blocked automated access). Key: `kenthapadi2005simulatable`
- What: Shows that query auditors whose denials depend on the true data can themselves leak information. It proposes simulatable auditing, where the deny decision depends only on past queries and answers.
- vs. AskWearables: Our budget refusals should be simulatable (depend only on query history, not on data values), which this paper justifies.

---

## 6. LLM answer instability and reproducibility (6 verified)

**6.1 Non-Determinism of "Deterministic" LLM Settings**
Atil et al., 2024. arXiv:2408.04667. URL: https://arxiv.org/abs/2408.04667. Key: `atil2024nondeterminism`
- What: Runs five LLMs configured to be deterministic ten times on eight tasks and finds accuracy variation up to 15% and best-to-worst gaps up to 70%. It introduces TARr@N and TARa@N agreement metrics over raw and parsed outputs.
- vs. AskWearables: We should report TARa@N for answer repeatability so our numbers are comparable.

**6.2 Understanding and Mitigating Numerical Sources of Nondeterminism in LLM Inference**
Yuan et al., 2025. arXiv:2506.09501. URL: https://arxiv.org/abs/2506.09501. Key: `yuan2025nondeterminism`
- What: Shows that batch size, GPU count and GPU type change outputs under greedy decoding, with up to 9% accuracy variation for reasoning models in bfloat16. It traces this to non-associative floating-point arithmetic and proposes mitigations.
- vs. AskWearables: Explains why baselines vary even at temperature zero; AskWearables makes the numeric part bit-exact by computing it in code.

**6.3 Defeating Nondeterminism in LLM Inference**
He and Thinking Machines Lab, 2025 (Sept 10). Blog post. URL: https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/. Key: `he2025nondeterminism`
- What: Identifies lack of batch invariance in inference kernels as the main cause of run-to-run variation at temperature zero. It presents batch-invariant kernels that make inference reproducible.
- vs. AskWearables: An inference-level fix complementary to our architecture-level one; serving settings should be reported.

**6.4 Self-Consistency Improves Chain of Thought Reasoning in Language Models**
Wang et al., 2023. ICLR 2023. arXiv:2203.11171. URL: https://arxiv.org/abs/2203.11171. Key: `wang2023selfconsistency`
- What: Samples multiple reasoning paths and takes the majority answer. This improves accuracy on arithmetic and commonsense benchmarks.
- vs. AskWearables: A costly way to stabilise answers by resampling; a natural extra baseline when comparing tokens and repeatability.

**6.5 SelfCheckGPT: Zero-Resource Black-Box Hallucination Detection for Generative Large Language Models**
Manakul et al., 2023. EMNLP 2023. arXiv:2303.08896. URL: https://arxiv.org/abs/2303.08896. Key: `manakul2023selfcheckgpt`
- What: Detects hallucinations by checking consistency among multiple sampled responses. Facts the model knows tend to be consistent across samples, while hallucinated facts diverge.
- vs. AskWearables: Treats inconsistency as an error signal, which supports measuring repeatability as a proxy for reliability.

**6.6 Same Question, Different Answers: Evaluating LLM Reliability Beyond Accuracy**
Faghih et al., 2026. arXiv:2607.22554. URL: https://arxiv.org/abs/2607.22554. Key: `faghih2026samequestion`
- What: Across four benchmarks and 13 models, meaning-preserving paraphrases flip instance-level answers in over 23% of cases while aggregate accuracy barely moves. It argues single-prompt correctness is a poor indicator of reliability.
- vs. AskWearables: Suggests adding a paraphrase-robustness test, since typed queries should map paraphrases to the same metric.

---

## Unverified or excluded

- **PHIA in Nature Communications (journal version).** Not opened; only the arXiv record's comment ("accepted to Nature Communications") was seen. Cite the arXiv version, or open the journal page and update `merrill2024phia` before submission.
- **Publisher landing pages for Dinur-Nissim (ACM), Dwork et al. 2006 (Springer), Garfinkel et al. (ACM Queue), Dwork et al. 2017 (Annual Reviews), Kenthapadi et al. (ACM).** These pages returned bot-protection challenges. Bibliographic data was confirmed through the Crossref API record for each DOI (and, for Dinur-Nissim, the author PDF was opened). They are kept as verified; recheck page numbers against the publisher PDFs if the venue requires it.
- No requested paper was left unfound. "PrivacyChecker" and "PrivacyLens-Live" are both contributions of the single paper [Wang 2025], not separate papers.

---

## Draft Related Work section (about 700 words)

Disambiguation for same author-year citations: Merrill 2024a = `merrill2024phia`, Merrill 2024b = `merrill2024timeseries`; Li 2026a = `li2026hearts`, Li 2026b = `li2026toolminimize`; Zhou 2025a = `zhou2025dataminimization`, Zhou 2025b = `zhou2025rescriber`; Kodathala 2026a = `kodathala2026equations`, 2026b = `kodathala2026aiauthz`, 2026c = `kodathala2026stepup`; Wang 2025 = `wang2025privacyinaction`, Wang 2023 = `wang2023selfconsistency`; Chen 2023 = `chen2023pot`, Chen 2025 = `chen2025struq`; Debenedetti 2024 = AgentDojo, Debenedetti 2025 = CaMeL.

**LLMs over personal health data.** A growing body of work asks language models to interpret wearable data. Early studies serialised physiological series into prompts and showed that few-shot tuning or fine-tuning lets LLMs make useful health predictions [Liu 2023; Kim 2024], and PH-LLM fine-tuned Gemini for sleep and fitness coaching [Cosentino 2024]. Evidence on whether models actually reason over the numbers is less encouraging: language models remain near chance on zero-shot time-series reasoning [Merrill 2024b], LLM components add little to forecasters [Tan 2024; cf. Jin 2024], and recent health time-series benchmarks report heuristic shortcuts and degradation with temporal complexity [Li 2026a; Cai 2024]. PHIA [Merrill 2024a] responded by giving a ReAct agent [Yao 2023] a code interpreter and web search, and released the objective question set we use. Later systems route queries to specialised tools [Zhang 2026] or combine data-science, domain and coaching sub-agents [Heydari 2025], and new benchmarks such as SensorQA [Reichman 2025] and WearableQA [Lee 2026] probe question answering over longitudinal records. All of these systems give the model, or code it writes, access to the full record and optimise for accuracy. AskWearables keeps the record behind a broker and measures privacy, repeatability and cost alongside accuracy.

**Computation outside the model.** Program-aided reasoning delegates arithmetic to an interpreter [Gao 2022; Chen 2023; Li 2024], and tool-augmented models learn when to call calculators and APIs [Schick 2023]. These gains reflect a structural limitation: transformers solve compositional numeric tasks by pattern matching, and their errors compound with depth [Dziri 2023], and solver-assisted pipelines cut error by large margins in engineering domains [Kodathala 2026a]. Data-analysis agent benchmarks [Hu 2024] assume the agent writes arbitrary code over raw tables. AskWearables goes one step further: the computation is neither performed nor generated by the model, but fixed and tested in a metric layer that the model reaches only through typed queries.

**Privacy for LLM agents.** Contextual integrity has become the dominant lens for agent privacy. ConfAIde [Mireshghallah 2024], CI-Bench [Cheng 2024] and PrivacyLens [Shao 2024] show that models that state privacy norms correctly still leak in action, and PrivacyLens-Live finds higher leakage in live MCP and agent-to-agent settings [Wang 2025], with grounded evaluations extending to workspace tools [Guo 2026]. Mitigations largely remain model-mediated: PrivacyChecker prompts the model to reason about flows [Wang 2025], and AirGapAgent uses a separate LLM minimiser isolated from third-party input [Bagdasarian 2024]. Data-minimisation work formalises the least revealing useful disclosure and finds that models are poor judges of it [Zhou 2025a; Zhou 2025b], while brokers that minimise before data leave the device [Yu 2026], rewrite outbound tool arguments [Li 2026b], offer tiered disclosure [Maeda 2026], or encode enforceable user preferences [Kochar 2026] move the decision toward the system. AskWearables makes minimisation fully deterministic for health data, with per-purpose grants, four release levels and budgets.

**Authorization outside the model.** Indirect prompt injection [Greshake 2023] and benchmarks such as InjecAgent and AgentDojo [Zhan 2024; Debenedetti 2024] show that agents cannot be trusted to police themselves. Defences that separate control from data range from the dual-LLM pattern [Willison 2023] and design patterns [Beurer-Kellner 2025] to CaMeL's capability-tagged interpreter [Debenedetti 2025], information-flow control in FIDES [Costa 2025], app isolation [Wu 2025], and channel separation by fine-tuning [Chen 2025]. A parallel line enforces deterministic policy at the tool boundary: Progent's privilege rules [Shi 2025], purpose-specific policies [Tsai 2025], signed pre-action authorization [Uchibeke 2026], budget-bounded capability tokens [Suresh 2026], reference monitors validated on open-weight models [Aljumaily 2026], and aiAuthZ's off-host, identity-bound gateway with hash-chained audit [Kodathala 2026b], extended to verifiable step-up approval [Kodathala 2026c]. MCP analyses document how broad tool exposure enables exploitation [Hou 2025; Radosevich 2025; Hasan 2025]. These systems decide whether a call may run; AskWearables also decides how much information an allowed call returns.

**Reconstruction and budgets.** Answering many aggregate queries accurately permits reconstruction of the underlying data [Dinur 2003; Dwork 2017; Garfinkel 2018], the observation behind differential privacy and its composition accounting [Dwork 2006; Dwork 2014]. Auditors whose refusals depend on the data can leak through their denials [Kenthapadi 2005]. Our daily budgets apply this accounting, with refusals that depend only on query history, to agents issuing repeated trend and daily queries.

**Repeatability.** LLM outputs vary across runs even at temperature zero [Atil 2024], because of floating-point and batching effects [Yuan 2025; He 2025] and paraphrase sensitivity [Faghih 2026]. Sampling-based remedies such as self-consistency [Wang 2023] and consistency checks [Manakul 2023] trade tokens for stability. By computing every reported number in code, AskWearables makes the numeric content of an answer reproducible by construction.

---

## Suggested baselines and missing benchmarks

**Baselines the paper should compare against (beyond A and B):**
1. **PHIA as published** [Merrill 2024a]: a ReAct agent with a Python interpreter over the full data frame, on the same open-weight models. This is the strongest accuracy baseline for the objective questions, and reviewers will expect it by name. Baseline B should either be PHIA or be shown to match it.
2. **A model-mediated minimiser**, AirGapAgent [Bagdasarian 2024] and/or PrivacyChecker [Wang 2025], in front of raw or MCP access. This isolates whether a deterministic gate beats an LLM-based privacy filter at equal accuracy.
3. **A deterministic tool-call gate without the metric layer or release levels**, e.g. Progent-style rules [Shi 2025] or a CaMeL-style policy [Debenedetti 2025] over the same MCP tools. This separates the contribution of the gate from that of the typed metric layer and budgets (an ablation reviewers will ask for). Self-consistency [Wang 2023] is a cheap optional fourth baseline for the repeatability and token axes.

**Standard benchmarks and metrics currently missing:**
- **PrivacyLens / PrivacyLens-Live** [Shao 2024; Wang 2025] (and ConfAIde tiers [Mireshghallah 2024]) for contextual-integrity leakage, ideally instantiated with health-metric seeds, rather than only custom attacks.
- **AgentDojo** [Debenedetti 2024] or **InjecAgent** [Zhan 2024] for the prompt-injection and exfiltration results, so attack success is comparable with CaMeL, Progent and AgentCap.
- A second wearable accuracy set beyond PHIA: **WearableQA** [Lee 2026] (data-reasoning split) or **SensorQA** [Reichman 2025].
- Report repeatability with **TARa@N** [Atil 2024], and state inference serving settings (batch size, hardware) given [Yuan 2025; He 2025].
- A **reconstruction attack** in the style of [Dinur 2003] against the daily budget (an adversarial agent issuing overlapping trend queries), reporting reconstruction error versus budget.
