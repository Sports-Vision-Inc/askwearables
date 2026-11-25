# AskWearables Developer Terms

Effective date: 25 November 2026. Last updated: 25 November 2026.

> **Summary**
>
> - These terms apply if you build an app or Agent on AskWearables. They add to the [Terms of Service](askwearables-terms.md).
> - Keep your API key and signing secret on your server. Sign every request.
> - Your users must approve your access themselves, on our hosted consent screen. You cannot approve for them.
> - Never try to get around the gate, the Grant limits or a provider's terms.
> - Use Packets only to serve the user who approved them. Do not sell them, use them for ads, or train AI models on them.
> - Let Your Users revoke your access in your app. They can also revoke it by emailing us. When they do, stop using their data and delete what you no longer need.
> - You are responsible to your users for your own app, your own privacy policy and your own AI model provider.

## 1. Who these terms apply to

These Developer Terms apply to anyone who holds an AskWearables Developer account, or uses a Developer API key ("you"). They are an agreement between you and **Sports Vision, Inc.** ("we", "us"). They add to the [Terms of Service](askwearables-terms.md) and the [Privacy Policy](askwearables-privacy.md). If they conflict with the Terms of Service, these Developer Terms win for Developer use.

"Your Users" are the people whose data your app sends to, or asks about through, AskWearables.

**Status.** AskWearables is offered in the United States only. It is not offered in the EU or UK yet. Test with synthetic records, not real ones.

## 2. Your account and credentials

- When you register, you receive an **API key**, a **signing secret** and, if you give a webhook address, a **webhook secret**. They are shown once.
- Keep all three on your server. Never put them in a browser, a phone app, a public repository or an AI model's context.
- You are responsible for all use of your credentials. If one is exposed, revoke it and tell us at contact@sportsvision.ai without delay.
- Give accurate details. The organisation name and Agent name you give are shown to Your Users on the consent screen. They must not mislead.

## 3. Signed requests

- Sign every Developer request as the documentation describes: HMAC-SHA256 over the timestamp, a single-use nonce, the method, the path and a hash of the body.
- Requests older than 300 seconds, or with a nonce already used, are refused. Do not try to replay requests.
- Verify the signature on every webhook we send you before acting on it.

## 4. Consent from Your Users

- **Your Users must approve your access themselves**, on the AskWearables hosted consent screen, reached through a one-time consent link. A link expires after one hour.
- You may ask for a purpose, a set of metrics, a level of detail, a window, a daily limit and a duration. Your User can narrow any of these. They cannot be widened.
- You may not request Sensitive Categories through a consent link.
- Do not pre-fill, script, automate, frame or click through the consent screen for Your User. Do not reward or pressure Your Users to approve more than your feature needs.
- Ask only for what your feature needs. The narrowest Grant that works is the right one.
- Before you send Your User to the consent screen, tell them plainly in your own app what your feature does with their data, and which AI model provider will see it.

## 5. The gate and its limits

- **Do not try to get around the gate.** This includes:
  - splitting requests to rebuild data you were not granted;
  - restating a purpose in a request to get more (the purpose is fixed in the Grant);
  - registering several Agents to multiply daily limits;
  - asking for data from a Source whose provider forbids AI use.
- We treat every Agent as **model-facing**: we assume Packets may reach an AI model. Data from a Source flagged "no AI" is never released to you.
- Do not put Health Data, names or other identifiers into question text.
- Do not try to inject instructions into the Planner.

## 6. Using Packets

- Use Packets **only** to provide the feature Your User approved, to that User.
- **Do not** sell Packets, rent them, use them for advertising, or share them with data brokers.
- **Do not** use Packets, or anything derived from them, to train, fine-tune or evaluate AI models. This applies to you and to your AI model provider. This ban is absolute: a User's consent does not lift it. Choose a model provider whose terms prevent training on your inputs, or that lets you turn training off.
- **Do not** combine Packets with other data to identify a person, or to infer a Sensitive Category the User did not name.
- **Do not** use Packets to make decisions about eligibility for insurance, employment, credit, housing or similar.
- Keep Packets only as long as your feature needs them. A Packet can be re-fetched from us for 24 hours, so you rarely need to store one.
- Do not present a Packet as medical advice. Show the caveats it carries.

## 7. Revocation

- **You must let Your Users revoke your access** from inside your app, at any time, in no more steps than it took to grant it.
- Your Users can also revoke your access without you, by emailing contact@sportsvision.ai. We act within 2 business days. Do not discourage them from doing so.
- If you gave a webhook address, you receive a `grant.revoked` event when a Grant is revoked. Later requests are denied.
- When a Grant is revoked or expires, stop using that User's Packets for new purposes. Delete stored Packets you no longer need within 30 days.
- If Your User asks you to delete their data, also delete it from AskWearables through the API, and help them with any request they make to us.

## 8. Your obligations to Your Users

You are responsible for your own app. In particular:

- Publish your own privacy policy. It must describe your use of AskWearables and of any AI model provider.
- Have a lawful basis for sending Your Users' data to AskWearables and for asking about it. Where required, this means consent, including explicit consent for health data. You decide why Your Users' data is processed; we process it for you under these terms.
- Follow every law that applies to you, including health-data, privacy, consumer-protection and breach-notification laws.
- Offer the Service only to people aged 18 or older in the United States.
- Follow the terms of the wearable providers whose data you send or request.
- If you are a HIPAA covered entity or business associate, do not send protected health information to AskWearables. AskWearables is not a HIPAA covered entity or business associate, and we do not sign business associate agreements.
- Tell us without undue delay, and in any case within 72 hours, if you learn of a security incident affecting data obtained through AskWearables.

## 9. Attribution

- When your app shows information from AskWearables, you may say "Powered by AskWearables". Do not suggest that we endorse your app, or that we are responsible for your answers. Attribution is optional.
- Where a wearable provider requires credit for its data (Polar, for example, asks for "Polar Ecosystem"), keep that credit wherever you show the data.
- Do not use our name or marks in a way that could confuse people.

## 10. Rate limits and fair use

- API requests are rate-limited, currently to 120 per minute for each credential. Each Grant also has a daily limit on Packets. We may change these limits, with notice under section 13.
- If you get a `429` response, wait for the time in the `Retry-After` header.
- Do not try to evade limits, for example with extra keys or accounts.

## 11. Suspension and ending

- We may suspend or revoke your keys at once if you break these Developer Terms, if your use puts Users or the Service at risk, or if a wearable provider or the law requires it. Where we safely can, we will tell you why and give you a chance to fix the problem first.
- You may close your Developer account at any time.
- When your account ends, your keys stop working. We delete your Developer data as the Privacy Policy describes. Sections 6, 7, 8 and 12 survive the end of these terms.

## 12. Liability and indemnity

- The disclaimers and limits of liability in the Terms of Service apply to you.
- You will defend and indemnify Sports Vision against claims by Your Users, wearable providers or regulators that arise from your app, your breach of these Developer Terms, or your breach of the law.

## 13. Changes

We may update these Developer Terms. For a material change, we will email the contact on your account at least 30 days before it takes effect. Changes required by law or by a wearable provider may take effect sooner.

## 14. Contact

Sports Vision, Inc., Minnetonka, Minnesota, USA. Email, including for security reports: contact@sportsvision.ai.
