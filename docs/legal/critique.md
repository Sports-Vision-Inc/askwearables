# Critique of the current Sports Vision policies

> **DRAFT, pending review by counsel.** This is an engineering and product reading of the published policies, not legal advice. Every finding below needs a lawyer's confirmation before anyone acts on it.

| | |
|---|---|
| Documents reviewed | Sports Vision Privacy Policy and Terms of Service, both "Last Updated: March 12, 2025", as extracted to `source-sportsvision/privacy-2025-03-12.md` and `source-sportsvision/terms-2025-03-12.md` |
| Product they cover | SV Broadcast and related apps: an AI platform for sports video |
| Reviewed on | 24 November 2026 |
| Clause references | "PP" is the Privacy Policy and "ToS" is the Terms of Service. Numbers are the documents' own section numbers |

## Summary

The two documents were written for a small sports-video app in early 2025. They have four basic problems.

1. **They contradict each other and themselves.** Examples are the age rules, the content licence, the list of countries served, the list of service providers and retention.
2. **They promise things the product probably does not do.** Examples are "no IP addresses", "no cookies", and age checks done by Google.
3. **They use people's video, including bystanders and children, to train AI models with no opt-in and no opt-out.**
4. **They are out of date for 2026.** They predate Minnesota's own privacy law, the amended COPPA Rule, and the 2025–2026 guidance on AI training.

None of these documents should be reused for AskWearables. AskWearables handles health data, so most of these problems would be more serious there. The AskWearables drafts in this folder start fresh and borrow only the company identity and some general clauses.

## Top 10 findings

| # | Finding | Clauses | Why it matters |
|---|---|---|---|
| 1 | "Available to users of all ages", while the homepage claims COPPA compliance and the policy relies on Google for age checks | ToS 2.1; PP 6; PP 1.1 (collects age) | The service has no COPPA compliance mechanism (no verifiable parental consent, no direct notice to parents). Collecting age gives actual knowledge when a user enters an age under 13. Google sign-in does not verify age for third-party apps |
| 2 | User video is used to train AI with no opt-in or opt-out. Face masking is the only safeguard | PP 2.2; ToS 3.2, 3.3, 5.3 | Masking faces does not de-identify video. Bystanders and minors in the video never agreed. The face detection used for masking may itself be biometric processing. The FTC has ordered models deleted when they were trained on data without proper consent (Everalbum 2021; WW/Kurbo 2022) |
| 3 | Two different content licences for the same videos | ToS 3.3 vs ToS 5.3 vs PP 2.2 | 3.3 is non-exclusive and limited to "providing and improving". 5.3 adds "transferable, sub-licensable … distribute, and display". Neither says the licence ends when the content is deleted. Neither says the user keeps ownership |
| 4 | Data is retained "indefinitely" | PP 3.2; ToS 3.4 | This contradicts the claim in PP 10.1 that the GDPR storage-limitation principle is followed. California law requires a retention period, or the criteria for one, for each category (Cal. Civ. Code §1798.100(a)(3)). ToS 3.4 points to "our data retention policies", which are not published |
| 5 | The service-provider list is incomplete, so it contradicts other clauses | PP 5.1 ("only Google") vs PP 4 ("Microsoft Azure security standards") vs PP 3.1 (regional servers) | Azure (or whoever hosts the servers) is a processor and is not disclosed. "Prior notice" before adding new third parties (PP 5.1, ToS 6.2) is not consent |
| 6 | The claims "no IP addresses, no location, no cookies" are probably inaccurate | PP 1.3 vs PP 1.4 | Choosing a regional server by device "without location or IP" is implausible. Google sign-in and any web session use cookies or similar storage. Cloud hosts log IP addresses. An untrue privacy statement is a deceptive practice under FTC Act §5 and state laws |
| 7 | The GDPR and CCPA sections list principles but not the disclosures those laws require | PP 10.1, 10.2 | GDPR: no legal bases, no named controller, no transfer mechanism, no right to complain, no EU representative (Arts. 13, 27, 44–49). CCPA: no CPRA rights (to correct, or to limit use of sensitive data), no categories table, no description of how requests are verified. |
| 8 | Minnesota's own privacy law is missing | Whole PP; ToS 11 | The company is in Minnesota and chose Minnesota law, but the policy does not address the Minnesota Consumer Data Privacy Act (in force 31 July 2025). Counsel should check whether its thresholds apply. Its unique rights include the right to question a profiling decision and the right to a list of specific third parties |
| 9 | The liability, indemnity and change clauses are one-sided enough to risk being unenforceable | ToS 8, 9, 10; preamble | There is no cap on liability and no carve-outs. The user indemnifies the company for any "use of the Service". Acceptance is by continued use (browsewrap). Under EU and UK consumer law, and in some US courts, these may be void, or may undermine the rest of the contract |
| 10 | The contact details are incomplete and inconsistent | ToS 14 (empty); PP 11; PP intro | ToS "Contact Us" ends with no contact details. PP names an individual ("Developer: Varun Kodathala") in the role the company should fill. It gives no street address and no privacy-specific contact. It uses support@sportsvision.ai, but contact@sportsvision.ai is the address for AskWearables |

## Detailed findings, Privacy Policy

### Introduction

- **The company and an individual are conflated.** It says "Sports Vision, Inc., developed and published by Varun Kodathala". The data controller should be the company alone. Naming an individual blurs who is responsible, and it publishes a personal name where a company role would do.
- **Scope does not match the Terms.** The PP covers "SV Broadcast and related applications". The ToS covers "Sports Vision … our artificial intelligence platform". Readers cannot tell whether one policy covers every product.
- **It claims agreement by use.** "By accessing or using our Service, you … agree to the practices described." A privacy notice informs users; it is not a contract. Under GDPR, consent cannot be inferred from use (Art. 4(11), Art. 7). This sentence also appears at the end of PP 11.

### 1. Information we collect

- **1.1 Age "to understand our user demographics".** This purpose is weak for a field that creates COPPA actual knowledge. If age is collected, it should screen users out (an age gate), not feed analytics.
- **1.1 "Favorite sport", "Role".** These are fine, but there is no statement of which fields are optional.
- **1.2 Video content.** The policy does not say that videos can show other people, including minors, or reveal health information (injuries) or biometric features. It sets no rules for uploading other people's images.
- **1.3 and 1.4 contradict each other.** Device information is used "to determine which regional server" (1.3), yet "we do not collect IP addresses, location data, or use cookies" (1.4). Routing by region without IP or location is implausible, and hosting providers log IP addresses by default. If the statement is untrue, it is a deceptive statement.
- **1.4 Collection sources.** Only "directly from you" and "Google authentication" are listed. Usage analytics are not listed, although ToS 3.1 lists "Usage data and analytics" and PP 2.1 says "Analyze usage patterns".

### 2. How we use your information

- **2.1 Purposes are listed without legal bases.** GDPR Art. 13(1)(c) requires a legal basis for each purpose.
- **2.2 AI model training.** This is the most serious clause.
  - It has no opt-in and no opt-out. Training runs by default for every uploaded video.
  - "Face masking" is presented as removing "personally identifiable information". It does not. Bodies, jersey numbers and names, voices, team and venue context, and metadata can still identify people.
  - Detecting faces in order to mask them processes facial geometry. Counsel should check this against biometric laws: Illinois BIPA, Texas CUBI, Washington RCW 19.375, and GDPR Art. 9 if the processing is for unique identification.
  - People in the video other than the uploader (opponents, spectators, children in youth sports) have no notice and no choice.
  - It does not say whether a deleted video is removed from training sets, or what happens to models already trained on it.
  - The FTC has warned that quietly changing terms to allow AI training may be unfair or deceptive (FTC Technology Blog, February 2024). It has also ordered companies to delete models built on improperly obtained data (Everalbum, 2021; WW/Kurbo, 2022).
  - Under the EU AI Act (Regulation 2024/1689), providers of general-purpose AI models have had transparency duties since 2 August 2025, and the Art. 50 transparency duties apply from 2 August 2026. Counsel should check which of these applies to Sports Vision's models.
- **2.3 "Aggregated, non-identifiable".** No de-identification standard is given. The CCPA's definition of "deidentified" requires a public commitment not to re-identify and contractual controls on recipients (Cal. Civ. Code §1798.140(m)).
- **2.4 No marketing.** This is good practice. However, the policy never mentions service emails (sign-in, security, policy changes), which the company will send anyway. It should say they are sent and that they are not marketing.

### 3. Data storage and retention

- **3.1 Storage location.** Users in "all other countries" are stored in East US. That includes the EEA and UK, so transfers need a mechanism such as Standard Contractual Clauses or the EU-US Data Privacy Framework (GDPR Ch. V). None is named.
- **3.2 Indefinite retention.** See top finding 4. "We determine there is no longer a purpose" is not a period or a criterion.
- **Section 8 undermines 3.1.** "We may transfer some data to the United States for the purpose of improving our AI models." So the regional storage in 3.1 is not a firm commitment, and training is the stated reason for the transfer.

### 4. Data security

- **"Protected according to Microsoft Azure security standards."** This relies on the vendor's posture instead of describing the company's own measures. It also reveals an undisclosed processor (see top finding 5).
- **No breach notification commitment.** All US states have breach-notification laws. GDPR Arts. 33–34 require notifying the regulator within 72 hours and notifying affected people without undue delay. The policy is silent.
- **The 2025 COPPA amendments** require a written information security program for children's data. That is relevant only if children are allowed, which top finding 1 says they are.

### 5. Data sharing

- **5.1 "Only Google" for authentication.** This omits the hosting provider and any analytics, email or error-tracking tools.
- **5.1 and ToS 6.2 promise "prior notice" for new sharing.** For sensitive data and for children's data, the law requires consent, not notice.
- **5.2 Business transfers.** The clause should commit that any successor is bound by the policy, or that users will be asked for consent before material changes. The FTC has taken this position in bankruptcy sales.
- **5.3 Legal requests.** There is no commitment to tell users about a request where the law allows, and no transparency statement.
- **5.4 Aggregated data shared with investors.** This should use the same de-identification standard as 2.3.
- **No "sale" or "sharing" analysis.** Under the CPRA, "sharing" means disclosure for cross-context behavioural advertising. The policy says only that it does not sell. It does not address the Global Privacy Control signal.

### 6. Children's privacy

- **"Google authentication … implements age verification measures."** Google does not verify ages for third-party apps. Children under 13 can hold Google accounts through Family Link. The claim is inaccurate, and the company cannot rely on it.
- **It conflicts with ToS 2.1 ("all ages") and with the homepage's COPPA claim** (per the brief; we have not seen the homepage). If the service is open to under-13s, COPPA requires a direct notice to parents, verifiable parental consent, a right for parents to review and delete, and (under the 2025 amendments, compliance date 22 April 2026) a written retention policy and separate consent before disclosure to third parties. None of these exists.
- **No process is described for parents to verify their identity and see their child's data.** The only remedy offered is a deletion email.

### 7. Your privacy rights

- **Rights not listed:** portability, objection, restriction, withdrawal of consent, the right to complain to a supervisory authority (GDPR), the right to correct and the right to limit use of sensitive data (CPRA), and the right to appeal a refused request. Virginia, Colorado, Connecticut, Minnesota and other states require an appeal process.
- **Hard deletion only by email.** Since 2022, Apple App Store Guideline 5.1.1(v) has required that account deletion can be started inside the app. Google Play requires a deletion link. ToS 2.3 repeats the email-only route.
- **"Within 30 days."** This matches GDPR's one month. It does not mention the allowed extensions, or the CCPA's 45 days. It does not say how requests are verified.

### 8. International data transfers

- "Any such transfers comply with applicable data protection laws." This states a conclusion, not a mechanism. See 3.1.

### 9. Updates

- Changes take effect by being posted. A material change in how data is used (for example, starting AI training) needs fresh consent for data already collected, according to the FTC and GDPR. Notice alone is not enough.

### 10. Compliance with privacy regulations

- **10.1 GDPR.** It recites the Art. 5 principles but omits the Art. 13 contents. It claims storage limitation while retaining data indefinitely (3.2). It names no EU representative (Art. 27), although it implicitly serves "all other countries".
- **10.2 CCPA.** It does not say whether Sports Vision meets the thresholds (roughly US$26.6M revenue in 2025, inflation-adjusted, or 100,000 California consumers). If it does not, promising CCPA rights is harmless but creates an enforceable promise under FTC Act §5. If it does, the section is far from complete: categories, sources, purposes, retention per category, sensitive data, the right to limit, how requests are verified, authorised agents, and metrics if thresholds are met.
- **10.3.** The third regional section cites a law that has since been replaced, so it is out of date. It should be removed or rewritten.
- **Missing regimes as of 2026:** the Minnesota Consumer Data Privacy Act; the other state comprehensive laws now in force (Texas, Oregon, Montana, Delaware, Iowa, Nebraska, New Hampshire, New Jersey, Tennessee, Maryland, Indiana, Kentucky, Rhode Island and others); state biometric laws; the UK GDPR as amended by the Data (Use and Access) Act 2025; and the EU AI Act.

### 11. Contact

- It names an individual developer. It gives no street address, and no privacy-specific address. The address is support@sportsvision.ai, while contact@sportsvision.ai is the AskWearables contact. The company should pick one address and use it everywhere.
- It repeats "By using our Service, you … agree to its terms", which is the same problem as the introduction.

## Detailed findings, Terms of Service

### Preamble

- **Browsewrap acceptance** ("By accessing or using …"). US courts often refuse to enforce terms that users were not clearly shown and did not actively accept (*Nguyen v. Barnes & Noble*, 9th Cir. 2014; *Berman v. Freedom Financial*, 9th Cir. 2022). The fix is a clickwrap at sign-up, with a record of which version the user accepted.

### 2. Eligibility and accounts

- **2.1 "All ages", with a vague parental-consent suggestion.** See top finding 1. Minors can also void contracts in most US states, so terms accepted by a minor are weak in any case.
- **2.2 Google-only sign-in.** This is fine, but there is no fallback if a Google account is lost.
- **2.3 Termination "at our discretion".** There is no notice, no reason and no appeal. The clause says nothing about what happens to the user's data after termination, or whether the user can export it.

### 3. Data collection and privacy (inside the Terms)

- **This section duplicates the PP and differs from it.** It adds "usage data and analytics" and "Develop new features". It mixes privacy notice with contract, which makes the user appear to "agree" to processing. The Terms should point to the PP instead.
- **3.3 "Will not be tagged to your personal identifiers".** This is a different promise from the face masking in PP 2.2. The two cannot both be the full description of the safeguard.
- **3.4 "Our data retention policies".** None is published.

### 4. User conduct

- **"Purposes other than sports-related activities".** This is vague and hard to enforce.
- **Missing:** a rule against uploading content the user has no rights to (broadcast footage is the obvious risk for a product named "SV Broadcast"); rules about uploading identifiable minors; and a ban on scraping.
- **There is no DMCA notice-and-takedown process and no designated agent.** Without these, the company may lose the 17 U.S.C. §512 safe harbour for user-uploaded footage.

### 5. Intellectual property

- **5.2 "Using our Service … for commercial purposes without our consent".** This conflicts with the stated audience of coaches and athletes (ToS 1), many of whom use the service professionally.
- **5.3 Licence.** See top finding 3. It does not say the user keeps ownership. It has no end date and no limit to the time the content is held. It does not say what happens to derivative works and trained models after deletion. It does not ask the user to warrant that they hold the rights to what they upload.
- **Missing:** who owns AI outputs, a feedback clause, and notices for open-source components.

### 6. Third-party services

- **6.2 "Notice of such integrations before sharing".** This is notice, not consent. See PP 5.1.

### 7. Disclaimers

- **7 and 7.1 are generally reasonable.** The AI-output disclaimer is good practice. However, there is no "some jurisdictions do not allow" savings language, and no carve-out for EU, UK or Australian consumers, whose statutory guarantees cannot be excluded. A disclaimer that cannot work in some places can make the whole clause look unfair.

### 8. Limitation of liability

- **No cap amount.** A typical clause sets the greater of fees paid or a fixed sum.
- **No carve-outs** for death or personal injury caused by negligence, for fraud, or for gross negligence. In the UK and EU, such exclusions are void (UK Consumer Rights Act 2015 s.65; EU Unfair Contract Terms Directive).
- **It excludes liability for "unauthorized access … of your transmissions or content".** In practice, that means data breaches. This is high-risk if the company's own security failure caused the breach, and it reads badly to regulators.

### 9. Indemnification

- **The user indemnifies the company for "your use of the Service".** That includes lawful use, which is overbroad for consumers. Some courts find this unconscionable. There is no procedure for notice or for control of the defence.

### 10. Changes to Terms

- **Unilateral change with acceptance by continued use.** This creates a risk that the contract is illusory, and the risk is worse if an arbitration clause is added later (*Douglas v. U.S. District Court*, 9th Cir. 2007). Material changes should be notified in advance, and the user should be asked to accept them again.

### 11. Governing law and dispute resolution

- **Minnesota law and exclusive Minnesota courts.** This is sensible for a Minnesota company. However, EU consumers can always sue at home (Brussels I Recast, Art. 18), and some US states limit forum clauses for consumers.
- **There is no arbitration clause.** The brief asked us to check one. There is none: no class-action waiver, no informal-resolution step, no small-claims carve-out. For AskWearables, the owner has decided to keep courts, not arbitration: Minnesota law, the state and federal courts in Hennepin County, small claims allowed, and no class-action waiver (see `open-questions.md`).

### 12. International users

- **Availability is limited to two named countries.** This contradicts PP 3.1 ("all other countries … East US") and PP 10.1 (a GDPR section for EEA users). The company should either geo-restrict and say so, or support other regions properly.

### 13. General provisions

- **Missing:** a survival clause, force majeure, a notices clause (how the company may contact the user electronically), export controls, and the terms Apple requires for a custom licence agreement. Apple's minimum terms require naming Apple as a third-party beneficiary when an iOS app uses its own terms instead of Apple's standard licence.
- **13.1 Entire agreement.** This would arguably exclude the Privacy Policy unless the PP is incorporated by reference. It is not.

### 14. Contact us

- **The section is empty.** The extracted text ends at "please contact us at:" with nothing after it. Check the Notion source. If it is empty there too, the published Terms have no contact point.

## What carries over to AskWearables, and what must not

| Carry over (rewritten) | Must not carry over |
|---|---|
| Company identity (Sports Vision, Inc., Minnetonka, MN) | Any AI training on user content (PP 2.2, ToS 3.2, 3.3, 5.3). AskWearables must say plainly that health data is never used to train AI models |
| No sale of data, no marketing use (PP 2.4) | "All ages" (ToS 2.1) |
| Minnesota governing law (ToS 11), flagged for counsel | Indefinite retention (PP 3.2) |
| An AI-output disclaimer, strengthened into "not medical advice" | Consent by use, and "prior notice" in place of consent (PP intro, 5.1; ToS 6.2) |
| Structure of the general provisions (ToS 13) | Uncapped liability exclusions and the "use of the Service" indemnity (ToS 8, 9) |
| | Statements of compliance (PP 10). The AskWearables drafts describe what is done and leave conclusions to counsel |
