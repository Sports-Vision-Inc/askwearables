# Over-exposure: terminology and evidence for the AskWearables paper

Compiled 2026-11-24. Claim to support: giving an LLM more data than the question needs is itself a privacy harm (over-exposure), separate from whether the model then leaks it.

Method: every source below was opened (arXiv abstract page or HTML full text, OWASP pages, GDPR text, NIST CSRC glossary, 45 CFR 164.502 via Cornell LII). Quotes are verbatim from those pages. Keys marked "existing" are already in `references.bib` and `related_work.md`; keys marked "NEW" are in the BibTeX block at the end. `references.bib` was not edited.

---

## (a) Recommended terminology

There is no single established LLM term for "the model receives more information than the task requires". Recent agent-privacy papers say "data minimization", "minimum necessary", "over-sharing", "task-irrelevant" data, or "information far exceeding what that context requires". Searches for "context overexposure" and "context minimization" found no established usage. The security term with the right meaning is OWASP's "excessive data exposure". Recommendation: use **data minimization** as the principle, and introduce **context over-exposure** as the paper's own name for the failure, defined by analogy to OWASP API3:2019. Say explicitly that you are coining it.

| Term | One-line definition (for the paper) | Who uses it (verified) |
|---|---|---|
| **Data minimization** (principle; use as the main term) | Personal data given to a processor (here, the model) should be limited to what is necessary for the purpose. | GDPR Art. 5(1)(c): "adequate, relevant and limited to what is necessary in relation to the purposes for which they are processed" [GDPR 2016]. For LLMs: "the least privacy-revealing disclosure that maintains utility" [Zhou 2025a, existing]. Also [Zhou 2025b] Rescriber, [Yu 2026] Minim, [Li 2026b] ToolMinimize (all existing). |
| **Minimum necessary** (health-specific variant; recommended for a health paper) | The HIPAA standard: limit PHI to the minimum necessary for the intended purpose. | 45 CFR 164.502(b): "make reasonable efforts to limit protected health information to the minimum necessary to accomplish the intended purpose of the use, disclosure, or request" [HHS 45 CFR 164.502]. ToolMinimize rewrites arguments "to the minimum data necessary for tool functionality" [Li 2026b]. AirGapAgent restricts "the agent's access to only the data necessary for a specific task" [Bagdasarian 2024, existing]. |
| **Purpose limitation** | Data is collected for specified purposes and not processed further in incompatible ways; the purpose fixes what "necessary" means. | GDPR Art. 5(1)(b): "collected for specified, explicit and legitimate purposes and not further processed in a manner that is incompatible with those purposes" [GDPR 2016]. Close in spirit to Conseca's purpose-specific policies [Tsai 2025, existing] and "purpose- and destination-aware inspection" [Dong 2026, NEW]. |
| **Excessive data exposure** (security source of the analogy) | An interface returns more object properties than the client needs and relies on the client to filter them. | OWASP API3:2019: "APIs rely on clients to perform the data filtering"; prevention: "Never rely on the client side to filter sensitive data" [OWASP 2019]. Folded in 2023 into API3:2023 Broken Object Property Level Authorization ("previously named: 'Excessive Data Exposure'"); prevention: "Keep returned data structures to the bare minimum, according to the business/functional requirements for the endpoint" [OWASP 2023]. |
| **Context over-exposure** (proposed by this paper) | The LLM's context window receives sensitive data beyond what the question requires; the model is the "client" that is trusted to filter. | Coined here. Supporting phrasing: "information far exceeding what that context requires" [Abdelnabi 2025, NEW]; "task-irrelevant sensitive leakage" [Yu 2026]; "private information not relevant to the task at hand" [Bagdasarian 2024]. |
| **Over-sharing** | The agent (or user) sends more sensitive data outward than the recipient or tool needs. Direction is outbound, so it is the downstream symptom, not the inbound exposure. | ToolMinimize: "81--88% of tool calls include unnecessary PSD ... explicit privacy instructions still leave 36--76% over-sharing" [Li 2026b]. "users routinely overshare sensitive information" [Xiao 2026, NEW]. |
| **Least privilege** / **excessive permissions** | Each entity gets only the minimum resources and authorizations needed for its function. Applies to access rights (which tools and data a model may reach), not to the content of one answer. | NIST SP 800-53 Rev. 5 (via CSRC glossary): "each entity is granted the minimum system resources and authorizations" it needs to perform its function [NIST 2020]. OWASP LLM06:2025 Excessive Agency, root cause "excessive permissions": an extension has "permissions on downstream systems that are not needed for the intended operation of the application" [OWASP 2025]. Progent [Shi 2025, existing]; MCP measurement [Li 2025, NEW]. |
| **Contextual integrity** | Privacy as appropriate information flow given context norms (actors, information type, transmission principle). Used to judge whether an output flow is a leak. | ConfAIde, PrivacyLens, CI-Bench, PrivacyLens-Live, AgentCIScope (existing); CI-Work [Fu 2026, NEW]; CIMemories [Mireshghallah 2025, NEW]. |
| **Need-to-know** | Classic access-control synonym for least privilege applied to information. | No source was opened for it in this pass. Avoid it, or cite it only alongside least privilege [NIST 2020]. |

Suggested usage in the paper: "data minimization (GDPR Art. 5(1)(c); HIPAA minimum necessary)" for the principle, "context over-exposure" for the failure we measure, and "leakage" (as in contextual-integrity benchmarks) for what the model does next. Keep the two apart. Over-exposure is a property of the input to the model and can be measured without running any attack. Leakage is a property of the output.

---

## (b) Strongest evidence (numbers quoted verbatim)

1. **More context entries cause more violations (dose-response).** CI-Work [Fu 2026, NEW], arXiv:2604.21308, https://arxiv.org/abs/2604.21308. Section 5.2 "Quantity": "when the number of contextual entries increases from 1 to 12 for both sensitive and essential entries", "violations rise monotonically while conveyance drops substantially", because "multi-entity contexts introduce interference, impairing the model's ability to adhere to contextual constraints". Abstract: "violation rates range from 15.8%–50.9%, with leakage reaching up to 26.7%". Caveat: the per-entry *leakage proportion* "exhibits an inverse trend" (a "dilution effect"), but the binary violation rate rises. Exact per-step values are only in Fig. 4(a), which was not readable.

2. **Exposure accumulates with use.** CIMemories [Mireshghallah 2025, NEW], arXiv:2511.14937, https://arxiv.org/abs/2511.14937. Profiles hold "over 100 attributes per user", and "frontier models exhibit up to 69% attribute-level violations". "Violations accumulate across both tasks and runs: as usage increases from 1 to 40 tasks, GPT-5's violations rise from 0.1% to 9.6%, reaching 25.1% when the same prompt is executed 5 times". "Privacy-conscious prompting does not solve this - models overgeneralize, sharing everything or nothing".

3. **Restricting the agent to task-necessary data defeats context hijacking.** AirGapAgent [Bagdasarian 2024, existing], arXiv:2405.05175, https://arxiv.org/abs/2405.05175. The attack tricks agents "into revealing private information not relevant to the task at hand". "a single-query context hijacking attack on a Gemini Ultra agent reduces its ability to protect user data from 94% to 45%, while an AirGapAgent achieves 97% protection".

4. **Models leak what is in context even when they know it is sensitive.** PrivacyLens [Shao 2024, existing], https://arxiv.org/abs/2409.00138: "GPT-4 and Llama-3-70B, leak sensitive information in 25.68% and 38.69% of cases, even when prompted with privacy-enhancing instructions." ConfAIde [Mireshghallah 2024, existing], https://arxiv.org/abs/2310.17884: GPT-4 and ChatGPT "reveal private information in contexts that humans would not, 39% and 57% of the time, respectively." Privacy in Action [Wang 2025, existing], https://arxiv.org/html/2509.17488: the agent identifies the data as sensitive "98.0% of the time, yet still leaks private details in 33.1% of cases."

5. **Live, tool-rich, noisier contexts leak more.** Privacy in Action [Wang 2025]: baseline leak rates (Table 3) are 17.4% static, 26.3% MCP, 24.3% MCP+A2A; "leakage rates increase in 3-tool workflows" (Table 4: static 17.4% to 22.6%; MCP+A2A 24.3% to 28.6%); "This underscores information noise as a key factor in privacy leakage during live runs." The Table values are read from the HTML tables, not quoted sentences.

6. **Most agent tool calls carry data the tool does not need, and prompting does not fix it.** ToolMinimize [Li 2026b, existing], https://arxiv.org/abs/2608.24957: "81--88% of tool calls include unnecessary PSD under default prompts"; "explicit privacy instructions still leave 36--76% over-sharing"; minimization middleware "reduces privacy cost by 81.2--92.0%". Claw in Plain Sight [Dong 2026, NEW], https://arxiv.org/abs/2608.20658: "legitimate access to contextual information does not imply authorization to transmit that information"; "session-level disclosure rates range from 20.8% to 75.0%"; "prompt-level policies do not provide a portable enforcement boundary."

7. **Projecting data to task granularity before it crosses a boundary works.** Firewalls for agentic networks [Abdelnabi 2025, NEW; TMLR 2026], https://arxiv.org/abs/2502.01822: "both sides of the communication carry information far exceeding what that context requires"; the data firewall "projects outgoing information onto the granularity appropriate for the task" rather than "binary disclose-or-redact filtering"; over 864 attacks, the privacy attack success rate for GPT-5 drops from 84% to 10%, and task completion quality is maintained or improved (numbers as stated in the abstract).

8. **Much of a prompt's sensitive content is unnecessary for utility.** Operationalizing data minimization [Zhou 2025a, existing], https://arxiv.org/abs/2510.03662: data minimization is "the least privacy-revealing disclosure that maintains utility"; the minimizer can redact a great deal for frontier models, "(85.7% redaction for GPT-5 vs. 19.3% for Qwen2.5-0.5B)". This is a quantitative upper bound on over-exposure: in their setting, most of the sensitive content in prompts was not needed.

9. **Whatever is in context can be exfiltrated (structural argument).** Greshake et al. [Greshake 2023, existing], https://arxiv.org/abs/2302.12173: "LLM-Integrated Applications blur the line between data and instructions", enabling "data theft, worming, information ecosystem contamination". MCP ecosystems grant broad access: "any plugin can inherit broad system privileges with minimal isolation or oversight", with network and system resource APIs "affecting 1,438 and 1,237 servers" out of 2,562 [Li 2025, NEW], https://arxiv.org/abs/2507.06250.

### (3) Quantitative measures of exposure found

- **Input-side (closest to "exposure"):** ToolMinimize's "privacy cost" of tool arguments versus a minimum-necessary annotation [Li 2026b]; Zhou et al.'s redaction rate at constant utility [Zhou 2025a]; CI-Work's count of sensitive and essential context entries (1 to 12) [Fu 2026]; CIMemories' attribute-level accounting over a 100+ attribute profile [Mireshghallah 2025].
- **Output-side:** leakage rate per trajectory (PrivacyLens, PrivacyLens-Live), proportion of sensitive entries disclosed (CI-Work "leakage"), binary any-leak "violation" (CI-Work), attack success rate (AirGapAgent, Firewalls).
- **Gap:** no paper found measures, for a fixed question, the number of sensitive fields or values placed in the model's context against the number the question needs. This is the metric AskWearables can contribute, e.g. exposure ratio = sensitive values (or tokens) in context / sensitive values needed by the reference computation, reported per question for baseline A (raw record), baseline B (MCP) and the broker.

---

## (c) Suggested paragraphs

**Introduction (about 185 words).**
Privacy evaluations of LLM agents mostly ask whether the model leaks: whether sensitive information in its context reaches an output where it should not [Mireshghallah 2024; Shao 2024]. We argue that the earlier step is already a harm. Data protection law requires that personal data be "limited to what is necessary" for the purpose [GDPR 2016], and health law requires the "minimum necessary" [HHS 45 CFR 164.502]. API security has long treated an interface that returns more fields than the client needs, and trusts the client to filter, as a vulnerability in its own right [OWASP 2019; OWASP 2023]. An agent given a raw wearable record is exactly such a client. We call this *context over-exposure*. It matters because models are unreliable filters: they leak in 25 to 39% of agentic cases even when asked not to [Shao 2024], violations rise with the number of entries in context [Fu 2026] and accumulate with use [Mireshghallah 2025], and anything in context can be exfiltrated by injected instructions [Greshake 2023; Bagdasarian 2024]. AskWearables therefore minimises what enters the context, not only what leaves it.

**Discussion (about 180 words).**
Our results separate two quantities the literature usually merges: *exposure*, what the model is given, and *leakage*, what it reveals. Leakage depends on the model, the prompt and the adversary. Prompt-level privacy instructions reduce it but do not bound it [Li 2026b; Dong 2026], and the same prompt leaks different attributes on different runs [Mireshghallah 2025]. Exposure is fixed by the system before the model runs, so it can be measured, audited and guaranteed. Minimising it upstream has worked in other settings: restricting agents to task-necessary data defeats context hijacking [Bagdasarian 2024], projecting data to task granularity cuts privacy attacks from 84% to 10% [Abdelnabi 2025], and rewriting tool arguments to the minimum necessary removes most over-sharing [Li 2026b]. AskWearables applies the same principle deterministically, deciding through computed release levels rather than through a second model. One limitation remains. Minimal answers can still compose into a reconstruction of the record [Dinur 2003; Patil 2025], which is why our budgets account for repeated queries. Exposure should be reported alongside accuracy in future wearable-agent benchmarks.

---

## (d) New BibTeX entries (verified; not added to references.bib)

All arXiv entries were checked on their abstract pages on 2026-11-24 (title, authors, date, comments). Venue fields appear only where the page states them.

```bibtex
@misc{fu2026ciwork,
  title = {{CI-Work: Benchmarking Contextual Integrity in Enterprise LLM Agents}},
  author = {Wenjie Fu and Xiaoting Qin and Jue Zhang and Qingwei Lin and Lukas Wutschitz and Robert Sim and Saravan Rajmohan and Dongmei Zhang},
  year = {2026},
  howpublished = {arXiv preprint arXiv:2604.21308},
  eprint = {2604.21308},
  archivePrefix = {arXiv},
  url = {https://arxiv.org/abs/2604.21308}
}

@misc{mireshghallah2025cimemories,
  title = {{CIMemories: A Compositional Benchmark for Contextual Integrity of Persistent Memory in LLMs}},
  author = {Niloofar Mireshghallah and Neal Mangaokar and Narine Kokhlikyan and Arman Zharmagambetov and Manzil Zaheer and Saeed Mahloujifar and Kamalika Chaudhuri},
  year = {2025},
  howpublished = {arXiv preprint arXiv:2511.14937},
  eprint = {2511.14937},
  archivePrefix = {arXiv},
  url = {https://arxiv.org/abs/2511.14937}
}

@article{abdelnabi2025firewalls,
  title = {{Firewalls to Secure Dynamic LLM Agentic Networks}},
  author = {Sahar Abdelnabi and Amr Gomaa and Eugene Bagdasarian and Per Ola Kristensson and Reza Shokri},
  journal = {Transactions on Machine Learning Research (TMLR)},
  year = {2026},
  note = {arXiv:2502.01822, first posted 2025},
  eprint = {2502.01822},
  archivePrefix = {arXiv},
  url = {https://arxiv.org/abs/2502.01822}
}

@misc{dong2026claw,
  title = {{The Claws in Plain Sight: Unauthorized Context Disclosure through LLM Agent Tool Calls}},
  author = {Ben Dong and Zhonghao Guo and Tianyi Lu and Qian Wang},
  year = {2026},
  howpublished = {arXiv preprint arXiv:2608.20658},
  eprint = {2608.20658},
  archivePrefix = {arXiv},
  url = {https://arxiv.org/abs/2608.20658}
}

@misc{li2025mcpprivilege,
  title = {{We Urgently Need Privilege Management in MCP: A Measurement of API Usage in MCP Ecosystems}},
  author = {Zhihao Li and Kun Li and Boyang Ma and Minghui Xu and Yue Zhang and Xiuzhen Cheng},
  year = {2025},
  howpublished = {arXiv preprint arXiv:2507.06250},
  eprint = {2507.06250},
  archivePrefix = {arXiv},
  url = {https://arxiv.org/abs/2507.06250}
}

@misc{patil2025sumleaks,
  title = {{The Sum Leaks More Than Its Parts: Compositional Privacy Risks and Mitigations in Multi-Agent Collaboration}},
  author = {Vaidehi Patil and Elias Stengel-Eskin and Mohit Bansal},
  year = {2025},
  howpublished = {arXiv preprint arXiv:2509.14284},
  eprint = {2509.14284},
  archivePrefix = {arXiv},
  url = {https://arxiv.org/abs/2509.14284}
}

@misc{xiao2026sufficiency,
  title = {{Say Something Else: Rethinking Contextual Privacy as Information Sufficiency}},
  author = {Yunze Xiao and Wenkai Li and Xiaoyuan Wu and Ningshan Ma and Yueqi Song and Weihao Xuan},
  year = {2026},
  howpublished = {arXiv preprint arXiv:2604.06409},
  eprint = {2604.06409},
  archivePrefix = {arXiv},
  url = {https://arxiv.org/abs/2604.06409}
}

@misc{lahjouji2026agentsknow,
  title = {{Agents That Know Too Much: A Data-Centric Survey of Privacy in LLM Agents}},
  author = {Nada Lahjouji and Ashwin Gerard Colaco},
  year = {2026},
  howpublished = {arXiv preprint arXiv:2606.26627},
  eprint = {2606.26627},
  archivePrefix = {arXiv},
  url = {https://arxiv.org/abs/2606.26627}
}

@misc{owasp2019api3,
  title = {{API3:2019 Excessive Data Exposure}},
  author = {{OWASP Foundation}},
  howpublished = {OWASP API Security Top 10 (2019 edition)},
  year = {2019},
  url = {https://owasp.org/API-Security/editions/2019/en/0xa3-excessive-data-exposure/}
}

@misc{owasp2023api3,
  title = {{API3:2023 Broken Object Property Level Authorization}},
  author = {{OWASP Foundation}},
  howpublished = {OWASP API Security Top 10 (2023 edition)},
  year = {2023},
  url = {https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/}
}

@misc{owasp2025llm06,
  title = {{LLM06:2025 Excessive Agency}},
  author = {{OWASP Gen AI Security Project}},
  howpublished = {OWASP Top 10 for LLM Applications 2025},
  year = {2025},
  url = {https://genai.owasp.org/llmrisk/llm062025-excessive-agency/}
}

@misc{gdpr2016,
  title = {{Regulation (EU) 2016/679 of the European Parliament and of the Council (General Data Protection Regulation), Article 5: Principles relating to processing of personal data}},
  author = {{European Parliament and Council of the European Union}},
  howpublished = {Official Journal of the European Union, L 119},
  year = {2016},
  url = {https://gdpr-info.eu/art-5-gdpr/}
}

@misc{hipaa164502,
  title = {{45 CFR \S 164.502(b): Standard: Minimum necessary}},
  author = {{U.S. Department of Health and Human Services}},
  howpublished = {Code of Federal Regulations, Title 45, Part 164 (HIPAA Privacy Rule)},
  url = {https://www.law.cornell.edu/cfr/text/45/164.502}
}

@misc{nist2020sp80053,
  title = {{Security and Privacy Controls for Information Systems and Organizations}},
  author = {{Joint Task Force}},
  howpublished = {NIST Special Publication 800-53, Revision 5},
  institution = {National Institute of Standards and Technology},
  year = {2020},
  doi = {10.6028/NIST.SP.800-53r5},
  note = {Definition of least privilege as given in the NIST CSRC glossary},
  url = {https://csrc.nist.gov/glossary/term/least_privilege}
}
```

Verification notes:
- OWASP 2019 and 2023 URLs now redirect (308) to `api-security.owasp.org/editions/...`. Content was read at the redirected URLs. Either URL works.
- `hipaa164502` has no year field. The regulation text was read on Cornell LII; eCFR and HHS.gov blocked automated access. Add a "last amended" year from eCFR if the venue requires it.
- `nist2020sp80053`: the definition was read on the CSRC glossary, which attributes it to SP 800-53 Rev. 5. The SP PDF itself was not opened. The DOI is the standard one for SP 800-53r5; confirm it before submission.
- Abdelnabi et al.: "Accepted to TMLR 2026" is taken from the arXiv comments field. The TMLR/OpenReview page was not opened.
- CI-Work: a Microsoft-hosted PDF named `CI_Work_ACL.pdf` appeared in search results, but the arXiv page names no venue, so it is cited as a preprint.
- Not verified, so not included: Greshake et al. venue (AISec 2023). The arXiv page lists no venue, and the existing `greshake2023indirect` entry already cites it as a preprint.
