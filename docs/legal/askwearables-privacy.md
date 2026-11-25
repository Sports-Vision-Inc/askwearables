# AskWearables Privacy Policy

Effective date: 25 November 2026. Last updated: 25 November 2026.

> **Summary**
>
> - AskWearables lets AI agents ask questions about your wearable data. It answers with small computed summaries, only within limits you approve.
> - We use your Health Data only to answer questions your Grants allow, and to run and secure the service.
> - We do **not** sell your data. We do **not** use it for advertising. We do **not** use your Health Data to train AI models, ours or anyone else's.
> - The AI model that reads a question (the Planner) sees the question text. It never sees your Health Data.
> - Agents get only what your Grant allows. Every answer released, and every request denied, is recorded in your Receipts.
> - You can pause all sharing, revoke any Agent, export or correct your data, or delete everything at any time.
> - Once an answer reaches an Agent, what that Agent's company keeps is governed by that company's policy, not ours.
> - AskWearables is for general wellness. It is not medical advice. Do not use it in an emergency.
> - You must be 18 or older. AskWearables is offered in the United States only.

## 1. Who we are

AskWearables is a product of **Sports Vision, Inc.** ("Sports Vision", "we", "us", "our").

| | |
|---|---|
| Company | Sports Vision, Inc. |
| Address | [street address], Minnetonka, Minnesota, USA |
| Contact for everything, including privacy and security | contact@sportsvision.ai |

This policy covers the AskWearables website (askwearables.app), the console (app.askwearables.app), the API and MCP server, the sign-in and consent screens, and the AskWearables phone sync apps (together, the "Service").

**Where we offer the Service.** AskWearables is offered in the United States only. AskWearables is not offered in the EU or UK yet.

This policy does not cover other Sports Vision products, which have their own policies. **Nothing in those policies that permits AI training on user content applies to AskWearables.**

## 2. Words we use

- **Health Data**: data about your body or activity that comes from a wearable device, a phone health app or a file you import. Examples are steps, sleep, heart rate and workouts. We treat all Health Data as sensitive. All Health Data is also "consumer health data" under the laws described in section 15.
- **Sensitive Categories**: four kinds of Health Data that get extra protection. They are blood glucose, cycle tracking, ECG and rhythm notifications, and sleep apnea events.
- **Source**: where Health Data comes from. A Source may be a wearable provider's cloud service (such as Oura or WHOOP), a phone sync app (Apple Health or Health Connect), or a file you import.
- **Agent**: an AI assistant or app that asks questions about your data through AskWearables.
- **Grant**: the permission you give one Agent on the consent screen. It sets eight limits, listed in section 6.
- **Packet**: one computed answer released to an Agent.
- **Receipt**: our record of one release or denial.
- **Planner**: the AI model we use to turn a question into a structured query.
- **Developer**: a company or person who builds an app on AskWearables and holds a Developer account.

## 3. What AskWearables does

AskWearables sits between your Health Data and AI Agents. It works like this:

1. An Agent asks a question in plain words, such as "How did I sleep this week?"
2. The Planner turns the question into a structured query. The Planner sees only the question, the date, your time zone and our list of metrics. It does not see your Health Data.
3. A policy gate, written in ordinary code, checks the query against your Grant. It removes anything the Grant does not allow.
4. Our tested code computes the answer from your Health Data.
5. The Agent receives a small Packet at the lowest level of detail that answers the question.
6. We write a Receipt.

## 4. Data we collect

| Category | What it includes | Where it comes from |
|---|---|---|
| Health Data | Steps, active energy, heart rate, resting heart rate, heart-rate variability, sleep duration, sleep stages and efficiency, blood oxygen, respiratory rate, skin temperature deviation, VO2 max estimates, weight, workouts, and vendors' own scores (such as readiness or recovery). Free text attached to workouts, such as titles and notes | The Sources you connect, the files you import, or a Developer's app acting for you |
| Sensitive Categories | Blood glucose, cycle tracking, ECG and rhythm notifications, sleep apnea events | **Not imported by default.** Our file importers do not bring them in. They are stored only if a sync app or a Developer's app sends them, and released only when you name each one in a Grant |
| Source details | Which provider and device, when it was connected and last synced. For cloud Sources, the access tokens the provider gives us | You, when you connect a Source |
| Account data | An internal user ID, your time zone, your declaration that you are 18 or older, and the public key of your passkey (never the passkey itself). For a Developer's users, the ID the Developer assigned | You or the Developer |
| Grants and Agents | Which Agents you connected, and the eight limits of each Grant | You, on the consent screen |
| Receipts | For each release or denial: the time, the Agent, the purpose, the query, the level of detail, the metrics, the date window, a fingerprint (hash) of the Packet, and the reasons for the decision | Created by the Service |
| Questions | The text of the questions Agents send | The Agent |
| Developer data | Organisation name, Agent name, webhook address, hashed API keys, encrypted signing and webhook secrets, and daily usage counts | The Developer |
| Technical data | Request metadata needed to run and secure the Service, such as time, path, response code and the IP address seen by our hosting provider. Never Health Data values | Created automatically |

**Cookies.** The console uses one sign-in cookie, which is strictly necessary. The public website sets no cookies and loads no analytics or advertising scripts.

**What we do not collect.** We do not collect precise location, contacts, photos or advertising identifiers. We do not buy data about you from anyone.

## 5. How we use your data

We use Health Data **only** for these purposes:

1. To answer questions from Agents you approved, within the Grant you approved.
2. To show you your own data, baselines and Receipts in the console.
3. To compute your personal baselines (your usual range) and data-quality notes. These compare you only with your own history.
4. To keep a tamper-evident record of every release and denial.

We use other data (account, technical and Developer data) to run the Service, to keep it secure, to prevent abuse, to enforce rate limits, and to meet legal duties.

### What we never do with your Health Data

- **No AI training.** We do not use your Health Data, your questions or your Receipts to train, fine-tune or evaluate any AI model, whether ours or a third party's. This applies to the Planner too. Our research and testing use synthetic data and public research datasets only.
- **No sale.** We do not sell or rent your data, and we do not exchange it for anything of value.
- **No advertising.** We do not use your data for advertising or marketing. We do not share it for cross-context behavioural advertising.
- **No decisions about you.** We do not use your data to make decisions about your insurance, employment, credit, housing or similar.
- **No other purposes.** We do not use your Health Data for any purpose your Grants do not cover, except to show it to you, to keep the Service secure, or where the law requires.

If we ever want to use Health Data in a new way, we will ask for your consent first. We will not rely on a policy update alone.

## 6. Agents and your Grants

### What you approve

When an Agent asks to connect, you see our consent screen. Nothing is ticked for you. You approve one Grant with eight parts:

1. **Which Agent.** Its name, whether its domain is verified, and who registered it.
2. **For what purpose.** Chosen from a fixed list. The Agent cannot change the purpose later.
3. **Which metrics.** Only those you tick. Sensitive Categories stay excluded unless you name each one.
4. **How much detail.** One of four levels: a flag (yes, no or unknown), a trend against your usual range, daily values, or raw samples.
5. **How far back.** A date window, in days.
6. **How often.** A maximum number of answers per day.
7. **Until when.** An end date, 90 days at most.
8. **What is not approved.** Raw data (unless you chose it), metrics you did not tick, Sensitive Categories you did not name, any change to your data, passing your data to another agent, and anything older than your window.

You approve the boundary, not each question. Our gate enforces the boundary in code before any data is read. The gate may also lower the level of detail if a request does not fit the purpose you chose. It never raises it.

### What an Agent receives

An Agent receives only Packets within your Grant. A Packet is a computed summary: for example, "resting heart rate is within your usual range this week". It is not a copy of your records. Free text such as workout titles is released only at the raw level.

### Receipts

Every release and every denial gets a Receipt. Receipts are chained together by fingerprints (hashes), so a change to an earlier Receipt can be detected. You can read all your Receipts in the console.

### Revoking and pausing

You can revoke any one Agent at any time. Its Grant ends, its access tokens are cancelled, and later requests are denied. You can also pause all releases at once.

If you use AskWearables through a Developer's app, that app must let you revoke its access (our Developer Terms require it). You can also revoke it by emailing contact@sportsvision.ai. We act on revocation requests within 2 business days.

### After release

**Once a Packet reaches an Agent, AskWearables cannot control it.** What the Agent, or the company that runs its AI model, stores or does with a Packet is governed by that company's terms and privacy policy. Before you approve an Agent, read its policy. Choose the lowest level of detail that meets your needs.

### The Planner

The Planner is an AI model that runs on **Cloudflare Workers AI**. Today it is Meta's Llama 3.3 70B, with OpenAI's gpt-oss-120b as a fallback. Both are open-weight models that Cloudflare hosts on its own infrastructure, so the question does not go to Meta or OpenAI. The Planner receives the question text, the date, your time zone and our metric list. **It never receives your Health Data.** Cloudflare states that it does not use Workers AI inputs to train models.

Questions may contain personal information if an Agent includes it. Our Developer Terms forbid Developers to put Health Data or names in questions.

## 7. Wearable Sources and their terms

When you connect a cloud Source, you sign in with that provider and approve the access it shows you. We store the provider's access tokens, encrypted. We use them only to fetch your data into your own store.

Each provider has its own terms. Some of them limit how their data may be used with AI:

- **Some providers forbid giving their data to AI models**, or forbid services that act as intermediaries. AskWearables records these rules as flags on each Source. **Our gate will not release data from a flagged Source to an Agent.** We treat every Agent as one that may pass data to an AI model.
- Because of these rules, we may be unable to connect some Sources, or able to connect them only for your own viewing. Strava's API policy, for example, bans AI use and aggregators, so a Strava connection is not offered. Oura's API agreement restricts giving Oura data to AI models, so Oura is not offered while that restriction stands.
- Some providers require us to show their name next to their data, or to describe our use of AI before you connect. We do so where required.

The console shows which Sources are available. At the date of this policy, no cloud Source is switched on. Data arrives only from file imports and the operator's own phone sync apps.

The provider's own privacy policy also applies to the data while the provider holds it. Disconnecting a Source in AskWearables does not delete data held by the provider.

## 8. Who receives your data

| Recipient | What they receive | Why |
|---|---|---|
| Agents you approve | Packets within your Grant | To answer your questions |
| The Developer of an app you use | Packets within that app's Grant, and usage counts with no Health Data | To run the app you chose |
| Sub-processors (section 9) | What each needs to provide its service to us | To host and run the Service |
| The Sources you connect | Your sign-in with them, and our requests for your data | To fetch your data |
| Authorities | Only what the law requires | Legal duty. We will tell you about a request unless the law forbids it |
| A buyer of the business | Your data, under this policy | If Sports Vision or AskWearables is sold or merged. The buyer must keep this policy's promises or ask for your consent |

The sign-in page loads its passkey library from our own domain. No third-party script or CDN is involved in sign-in.

## 9. Sub-processors

| Sub-processor | What it does for us | Data it handles |
|---|---|---|
| Cloudflare, Inc. (United States) | Hosting, storage (Durable Objects, D1, KV, R2), Workers AI for the Planner, logs and rate limiting | All data we hold, encrypted at rest. Question text, for the Planner |

We will list any other sub-processor in this section. We will give you 30 days' notice, in the console (and by email if you have given us one), before a new sub-processor starts handling your data.

## 10. Where your data is stored

Your data is stored on Cloudflare's network. Each user's Health Data lives in its own storage unit (a Durable Object).

## 11. How long we keep data

| Data | How long |
|---|---|
| Health Data and Source tokens | Until you disconnect the Source, delete the data, or delete everything |
| Inactive accounts | Deleted after 24 months without a sign-in, sync or Agent request. We tell you in the console (and by email if you have given us one) 30 days before |
| Packets | An encrypted copy is kept for about 24 hours so the Agent can fetch it again. Then it is deleted |
| Grants | Until they expire (90 days at most) or you revoke them. A revoked Grant's metadata is then kept for 90 days, then deleted |
| Receipts | Kept while your account exists. After "delete everything", the Receipt chain keeps only hashes, times, sequence numbers, Agent IDs, Grant IDs, release levels and decisions (no Health Data). Everything else in each Receipt is made unreadable (section 12) |
| Daily integrity anchors | A copy of your Receipt chain's latest hash, stored once a day so tampering can be detected. Your user ID in each anchor is stored only as a hash |
| Operational logs | No longer than 30 days. They never contain Health Data values |
| Agent access tokens | One hour |
| Consent links | One hour |
| Replay-protection records | Five minutes |

## 12. Your controls

In the console you can:

- **See** every release and denial in your Receipts.
- **Pause** all releases at once, and resume them later.
- **Revoke** any Agent. Its Grant ends and its tokens are cancelled.
- **Export** all your data as a file: Sources, samples, sessions, daily totals, baselines, vendor scores and Receipts.
- **Delete everything.** This deletes your Health Data and your Source tokens. It revokes every Grant and key. It also destroys your personal encryption key. Without that key, the stored details of every Receipt can never be read again by anyone, including us. This is called crypto-erasure. The Receipt chain itself stays, with only hashes, times, sequence numbers, Agent IDs, Grant IDs, release levels and decisions (no Health Data), so the record that releases happened can still be checked, but not what they contained.

Deletion cannot be undone. Data already released to an Agent is not recalled; ask that Agent's company to delete it.

**Account recovery.** Your passkey is how you prove who you are. If you lose every device that holds your passkey, email contact@sportsvision.ai. We will verify the email address you write from and check your identity before we restore access to your account. We cannot restore access to your Health Data without a passkey or an active console session. If we cannot verify you, you can still ask us to delete your account.

**If you use AskWearables through a Developer's app**, use that app's controls, or email contact@sportsvision.ai. We act on revocation requests within 2 business days.

## 13. Your rights

Everyone who uses AskWearables has these rights, wherever they live in the United States:

- **Access**: know what data we hold, and see it.
- **Export**: get a copy in a file you can take elsewhere.
- **Correct**: fix your account details in the console or by writing to contact@sportsvision.ai. Health Data comes from your Sources, so correct it at the Source and sync again, or delete it and import it again.
- **Delete**: delete any Source's data, or everything.
- **Withdraw consent**: revoke any Agent, or disconnect any Source, at any time.

Most of these you can do yourself in the console. For anything else, email contact@sportsvision.ai. We will answer within 30 days, or sooner if your state's law requires. We may need to verify your identity first. If we refuse a request, you can appeal by replying to our answer, and we will tell you the result of the appeal and how to contact your state attorney general. We will not treat you differently for using your rights. You may use an authorised agent where your state's law allows.

## 14. Security

Here is what we have built. We describe it plainly; we do not claim any certification.

- **Separate storage for each user.** Each user's Health Data is held in its own isolated store. Only one internal service can read it, and that service has no public address.
- **Per-user encryption keys.** Each user has their own AES-256 data key. It encrypts their Source tokens, Receipt details and stored Packets. That key is itself encrypted by a master key held as a platform secret. Numeric Health Data is protected by Cloudflare's storage encryption and per-user isolation, because our code must be able to add it up.
- **Separated services.** The Service is split into separate parts with four trust levels. The parts reachable from the internet hold no Health Data and no long-lived secrets. A test checks these boundaries.
- **Hash-chained Receipts.** Each Receipt includes a fingerprint of the one before it. Once a day, the latest fingerprint is copied to separate storage, so tampering can be detected.
- **No Health Data in logs.** Our code does not write Health Data values to logs.
- **Short-lived, revocable access.** Agent tokens last one hour, apply to one resource, and are checked again by the gate on every request. Developer requests are signed and cannot be replayed.
- **Passkeys.** The console uses passkeys, not passwords.
- **HTTPS everywhere.**

No system is perfectly secure. To report a security problem, email contact@sportsvision.ai.

### If there is a breach

We treat the FTC Health Breach Notification Rule as applying to AskWearables. Under that rule, a breach includes any acquisition of Health Data that you did not authorise, not only a hack. If there is a breach of your Health Data:

- we will notify you as the rule requires, without unreasonable delay and no later than 60 calendar days after we discover it;
- we will notify the FTC as the rule requires;
- where the rule requires it, we will also notify the media;
- we will also give any notice that state breach laws require.

## 15. Consumer health data

This section is our consumer health data privacy policy under the Washington My Health My Data Act and similar state laws, such as those of Nevada and Connecticut. It applies to all Health Data, which these laws call "consumer health data".

- **What we collect, and from where.** The Health Data and Sensitive Categories listed in section 4, from the Sources you connect, the files you import, or a Developer's app acting for you.
- **Why we collect and use it.** Only for the purposes in section 5: to answer questions within your Grants, to show you your own data, to compute your baselines, and to keep Receipts.
- **Your consent to collect.** We collect Health Data only after you agree: when you connect a Source or import a file. Sensitive Categories are not imported by default.
- **Your separate consent to share.** We share Health Data with an Agent only after you approve a Grant for that Agent on the consent screen. Each Grant is a separate consent, for one Agent.
- **Who receives it.** The Agents you approve, the Developer of an app you use, and our sub-processors (sections 8 and 9).
- **No sale.** We never sell consumer health data.
- **No geofencing.** We do not set up virtual boundaries around health care facilities to track people or send them messages.
- **Your rights.** You can see which Agents received your Health Data in your Receipts. You can withdraw consent, delete your data and get a copy, as sections 12 and 13 describe. Email contact@sportsvision.ai, and we will answer within the time the law sets. You can appeal a refusal as section 13 describes.

## 16. Other laws

This section explains how we approach the other main US laws for consumer health-adjacent apps. It is not a claim of compliance.

| Law | How AskWearables approaches it |
|---|---|
| **California CCPA/CPRA and other state privacy laws** (including Minnesota's Consumer Data Privacy Act) | Health Data is sensitive data. We collect it only with your consent, and use it only to provide the Service you asked for. We do not sell or share it for advertising. The rights in section 13 apply to everyone |
| **FTC Act Section 5** | We aim to describe our practices accurately and to keep every promise in this policy |
| **FTC Health Breach Notification Rule** | Treated as applying. See section 14 |
| **COPPA** | AskWearables is not for children. You must be 18 or older (section 18) |
| **HIPAA** | AskWearables is not a HIPAA covered entity or business associate, and it does not sign business associate agreements. Your data in AskWearables is not "protected health information" under HIPAA |
| **EU and UK data protection law** | AskWearables is not offered in the EU or UK yet |

## 17. Not medical advice

AskWearables gives general wellness information. It does not diagnose, treat or prevent any disease. It does not give medical advice. Wearable readings are estimates and can be wrong. Do not use AskWearables in an emergency. If you think you have a medical problem, contact a healthcare professional. In an emergency, call 911 or your local emergency number.

## 18. Children

AskWearables is only for people aged 18 or older. You confirm your age when you sign up. We do not knowingly collect data from anyone under 18. If we learn that we have, we will delete it. If you believe a child has given us data, email contact@sportsvision.ai.

## 19. Changes to this policy

We will post changes here with a new date. For a material change, we will tell you in the console (and by email if you have given us one) at least 30 days before it takes effect. If a change would use your Health Data in a new way, we will ask for your consent first.

## 20. Contact

Sports Vision, Inc.
[street address]
Minnetonka, Minnesota, USA
Email (including privacy and security): contact@sportsvision.ai

See also our [Terms of Service](askwearables-terms.md) and [Developer Terms](askwearables-developer-terms.md).
