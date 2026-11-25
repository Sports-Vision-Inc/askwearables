# AskWearables Terms of Service

Effective date: 25 November 2026. Last updated: 25 November 2026.

> **Summary**
>
> - These Terms are a contract between you and Sports Vision, Inc. for using AskWearables.
> - You must be 18 or older and in the United States.
> - AskWearables gives wellness information only. It is not medical advice and not for emergencies.
> - You decide which Agents may ask about your data, and within what limits. You can revoke them at any time.
> - Your data stays yours. We do not sell it, use it for ads, or use your Health Data to train AI models.
> - Some wearable providers restrict AI use, so some Sources may not be available.
> - Do not misuse the Service or try to get around its limits.
> - The Service is provided "as is". Our liability is capped at the greater of what you paid us in the last 12 months or US$100, except for fraud and wilful misconduct.
> - Minnesota law applies. Disputes go to the courts in Hennepin County, Minnesota, or to small-claims court. There is no arbitration.
> - Developers must also accept the [Developer Terms](askwearables-developer-terms.md).

## 1. About these Terms

These Terms of Service ("Terms") are an agreement between you and **Sports Vision, Inc.**, of Minnetonka, Minnesota, USA ("Sports Vision", "we", "us", "our"). They cover your use of AskWearables: the website, console, API, MCP server, sign-in and consent screens, and phone sync apps (the "Service").

When you create an account, you tick a box to accept these Terms and the Privacy Policy. We record which version you accepted, and when. If you use AskWearables through a Developer's app, our consent screen links to both documents. If you do not agree, do not use the Service.

Our [Privacy Policy](askwearables-privacy.md) explains how we handle your data. It forms part of these Terms. If you build on the Service, the [Developer Terms](askwearables-developer-terms.md) also apply.

The defined words in the Privacy Policy (such as Health Data, Agent, Grant, Packet, Receipt, Source and Developer) mean the same here.

## 2. What the Service is

AskWearables is a broker between your wearable data and AI Agents. It stores Health Data from the Sources you connect. It answers an Agent's questions with small computed summaries, only within the Grant you approve. It records every release and denial in your Receipts.

The Service is in early development. Features, Sources and limits may change.

## 3. Not medical advice

- AskWearables is for **general wellness** only. It does not diagnose, treat, cure or prevent any disease or condition.
- Nothing in the Service is medical advice. Agents, including third-party AI models, may misread or misstate a Packet.
- Wearable readings are estimates. They can be missing, late or wrong.
- **Do not use the Service in an emergency.** Call your local emergency number.
- Talk to a qualified healthcare professional before you make health decisions.

## 4. Who can use the Service

- You must be **at least 18 years old** and able to form a binding contract. You confirm your age when you sign up.
- You must not be barred from using the Service under the laws that apply to you.
- If you use the Service for an organisation, you confirm that you may bind that organisation to these Terms.
- AskWearables is offered in the **United States only**. It is not offered in the EU or UK yet.

## 5. Your account and passkeys

- You sign in with a **passkey**. A passkey is stored on your device or in your password manager. Keep that device and account secure.
- You are responsible for what happens under your account. Tell us at once at contact@sportsvision.ai if you think someone else has used it.
- We never see your passkey's private key. If you lose every device holding your passkey, email contact@sportsvision.ai. We will verify the email address you write from and check your identity before we restore access to your account. We cannot restore access to your Health Data without a passkey or an active console session.
- Keep your API keys and sync keys secret. Revoke any key you think is exposed.
- Give accurate information, and keep your time zone current. Your answers depend on it.

## 6. Your data and your choices

- **You own your Health Data.** We claim no ownership of it.
- You give us permission to store, process and compute your Health Data, **only** to provide the Service to you and to release Packets within your Grants. This permission ends when you delete the data, except for the limited records described in the Privacy Policy.
- We do not sell your data. We do not use it for advertising. **We do not use your Health Data to train AI models.**
- You choose what each Agent may see. You can pause all releases, revoke any Agent, export your data, or delete everything, at any time, in the console.
- You must have the right to upload any data you import. Do not upload anyone else's data without their permission.

## 7. Agents and third-party AI

- **Agents are not ours.** They are run by other companies, under their own terms and privacy policies. We do not control what an Agent, or the AI model behind it, does with a Packet after release.
- Before you approve an Agent, read its terms. Choose the narrowest Grant that meets your needs.
- An Agent's answer to you is the Agent's, not ours. We are not responsible for it.
- The Planner, our own AI model, turns questions into queries. It can misunderstand a question. When it cannot plan a question safely, it refuses.

## 8. Wearable Sources and their terms

- When you connect a Source, you also accept that provider's terms. You must follow them.
- **Some providers restrict or forbid AI use of their data,** or forbid intermediaries. We record these rules as flags on each Source, and our gate enforces them. As a result:
  - some Sources may not be available at all;
  - data from some Sources may be shown to you but never released to an Agent;
  - a Source may be switched off later if its provider changes its terms.
- We are not responsible for a provider's service, its data quality, or its decision to change or end access.
- Some providers ask us to credit them where their data appears. We do so.

## 9. Acceptable use

You must not:

- use the Service to break any law, or anyone's rights;
- upload, request or release Health Data about another person without their permission;
- try to get around the gate, the Grant limits, the daily budgets, the terms flags or any other limit, for example by splitting one request into many to rebuild data you were not granted;
- probe, scan or test the Service's security, except with our written permission;
- put Health Data, names or other identifiers into question text, or try to inject instructions into the Planner;
- impersonate a person, company or Agent, or misstate an Agent's identity on the consent screen;
- overload, disrupt or attack the Service, or exceed its rate limits;
- scrape, resell or sublicense the Service, or use it to build a competing data set from other users' data;
- use the Service to make decisions about a person's eligibility for insurance, employment, credit, housing or similar;
- use the Service for diagnosis, treatment or emergencies;
- use the Service in a way that breaks a wearable provider's terms.

## 10. Our intellectual property

- The Service, including its software, design, documentation and brand, belongs to Sports Vision or its licensors.
- We give you a personal, non-exclusive, non-transferable, revocable licence to use the Service under these Terms.
- "AskWearables" and the AskWearables logo are our brand. Do not use them in a way that suggests we endorse you.
- **Feedback.** If you send us ideas or suggestions, we may use them without paying you. We will not identify you publicly without your permission.

## 11. Open-source components

- Parts of the Service and its client libraries are open source. The TypeScript SDK is published under the MIT licence.
- The website uses Lucide icons (ISC licence) and Twemoji (CC-BY 4.0), credited on the homepage.
- Open-source components are governed by their own licences. Nothing in these Terms limits your rights under those licences.

## 12. Changes to the Service

We may add, change or remove features, Sources or limits. If we remove a feature you rely on, we will try to give you notice and a chance to export your data. We may switch off a Source at once if its provider requires it.

## 13. Suspension and ending

- **You may stop at any time.** Delete everything in the console, or email contact@sportsvision.ai.
- **We may suspend or end your access** if you break these Terms, if your use creates a security or legal risk, or if the law requires it. Where we can, we will tell you why and give you a chance to fix the problem first. You may ask us to reconsider at contact@sportsvision.ai.
- If we end the Service as a whole, we will give at least 30 days' notice, in the console (and by email if you have given us one), so you can export your data.
- After your access ends, we delete your data as the Privacy Policy describes.
- Sections 6 (ownership), 10, 14, 15, 16, 17 and 19 survive the end of these Terms.

## 14. Disclaimers

To the fullest extent the law allows:

- THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE". WE MAKE NO WARRANTIES, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY AND NON-INFRINGEMENT.
- We do not promise that the Service will be uninterrupted, error-free or secure, or that any Packet will be accurate or complete.
- AI output, including the Planner's and any Agent's, can be wrong, incomplete or biased.

Some states do not allow these exclusions. If you live in one of them, some of these exclusions may not apply to you. Nothing in these Terms limits rights you have under consumer law that cannot be waived.

## 15. Limitation of liability

To the fullest extent the law allows:

- We are not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue or data.
- Our total liability for all claims about the Service is limited to the greater of (a) the amount you paid us for the Service in the 12 months before the claim and (b) US$100.
- We are not liable for what an Agent, an AI model provider or a wearable provider does with your data, or for decisions you make based on an answer.

**These limits do not apply** to our fraud or our wilful misconduct, or to any other liability that the law does not allow us to limit.

## 16. Indemnity

You agree to cover our reasonable losses and costs from claims by others that result from your breach of these Terms or your violation of the law. You are not responsible for claims that arise only from your ordinary, lawful use of the Service. We will tell you promptly about any such claim and let you take part in the defence.

## 17. Governing law and disputes

- These Terms are governed by the laws of the **State of Minnesota**, USA, without regard to its conflict-of-law rules.
- **Talk to us first.** Before filing a claim, email contact@sportsvision.ai with a description of the problem. We will try to resolve it within 60 days.
- If that fails, claims will be heard in the state or federal courts located in **Hennepin County, Minnesota**. You and we agree to those courts' jurisdiction.
- Either of us may bring a qualifying claim in **small-claims court** instead.
- There is **no arbitration** and **no class-action waiver** in these Terms.

## 18. Changes to these Terms

We may update these Terms. For a material change, we will tell you in the console (and by email if you have given us one) at least 30 days before it takes effect. If you do not agree with the change, you may stop using the Service and export your data. Changes do not apply to disputes that arose before the change.

## 19. General

- **Entire agreement.** These Terms, the Privacy Policy and (for Developers) the Developer Terms are the whole agreement between us about the Service.
- **Order of precedence.** If these Terms and the Privacy Policy conflict on how your data is handled, the Privacy Policy wins.
- **Assignment.** You may not transfer these Terms without our written consent. We may transfer them as part of a merger, acquisition or sale of assets, if the new owner keeps the Privacy Policy's promises.
- **Severability.** If a court finds part of these Terms unenforceable, the rest still applies.
- **No waiver.** If we do not enforce a term, we keep the right to enforce it later.
- **Force majeure.** Neither of us is liable for delays caused by events outside reasonable control.
- **Notices.** We send notices in the console, and by email if you have given us one. You may send notices to contact@sportsvision.ai.
- **Export controls.** You must follow US export and sanctions laws.
- **App stores.** If you use our phone apps, the app store's terms also apply.

## 20. Contact

Sports Vision, Inc.
[street address]
Minnetonka, Minnesota, USA
Email (including privacy and security): contact@sportsvision.ai
