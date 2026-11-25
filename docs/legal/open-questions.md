# Decisions made, and recommended review

> The owner made these decisions on 24 and 25 November 2026 and published the three documents (`askwearables-privacy.md`, `askwearables-terms.md`, `askwearables-developer-terms.md`) as final, effective 25 November 2026. The only placeholder left in the Markdown is "[street address]"; the published pages omit that line and show "Minnetonka, Minnesota, USA".

## Decisions made

| Topic | Decision | Where it appears |
|---|---|---|
| Where offered | United States only at launch. "AskWearables is not offered in the EU or UK yet." No EU or UK representative, DPO or transfer mechanism. Access, delete, export and correct are rights for everyone | Privacy 1, 13, 16; Terms 4 |
| Minimum age | 18, by self-declaration at sign-up | Privacy 18; Terms 4 |
| Disputes | Minnesota law. State and federal courts in Hennepin County. Small claims allowed. No arbitration, no class-action waiver. 60 days of informal resolution first | Terms 17 |
| Published | Final, effective 25 November 2026. No draft banner, no noindex | All three; site pages |
| Consumer health data | A "Consumer health data" section in the privacy policy (`#consumer-health-data`), covering Washington's My Health My Data Act and similar state laws. Every footer links to it | Privacy 15; site footers |
| FTC Health Breach Notification Rule | Treated as applying. We notify affected users and the FTC (and the media where required) as the rule requires | Privacy 14 |
| HIPAA | Not a covered entity or business associate. No BAAs | Privacy 16; Developer Terms 8 |
| Liability | Cap at the greater of fees paid in the prior 12 months or US$100. Carve-outs for fraud and wilful misconduct | Terms 15 |
| Indemnity | Limited to the user's breach of the Terms or violation of law | Terms 16 |
| Changes and acceptance | 30 days' notice in the console (and by email if given) for material changes. At sign-up, the owner ticks a box accepting the Terms and Privacy Policy, and we record the version and time. For Developers' end users, the consent screen links to both documents | Privacy 19; Terms 1, 18; Developer Terms 13 |
| Retention | Inactive accounts deleted after 24 months, with notice 30 days before. Operational logs kept no longer than 30 days (Cloudflare Workers Logs keep 7), with no health values. Revoked Grants' metadata kept 90 days. After "delete everything", the Receipt chain keeps only hashes, times, Agent IDs and decisions. The user ID in daily integrity anchors is hashed | Privacy 11, 12 |
| Sensitive Categories | Not imported by default: the file importers do not map them | Privacy 4, 15 |
| Account recovery | Email contact@sportsvision.ai, then email verification and identity checks. No recovery of Health Data without a passkey or console session | Privacy 12; Terms 5 |
| Developers' end users | Developers must let users revoke in their app. Users can also revoke by emailing contact@sportsvision.ai; we act within 2 business days | Privacy 6, 12; Developer Terms 7 |
| Sub-processors | Cloudflare named (hosting, storage, Workers AI). Any others listed in the privacy policy's sub-processor section, with 30 days' notice | Privacy 9 |
| Contact | Sports Vision, Inc., Minnetonka, Minnesota, USA. contact@sportsvision.ai for everything, including privacy and security | All three |
| Effective date | 25 November 2026 | All three |
| Developer AI training | Absolute ban on training on Packets. A user's consent does not lift it | Developer Terms 6 |
| Attribution | "Powered by AskWearables" is optional. Provider credits (such as Polar's) are required | Developer Terms 9 |

## Recommended review by counsel (not blockers)

The documents are published. These three points are worth a lawyer's review when one is engaged. None of them blocks publication.

1. **Wearable provider terms before any connector is switched on.** Oura's API Agreement §4(d) bans giving Oura data to AI models except through Oura's own MCP server. WHOOP's terms §4.2.3 ban AI training, but inference is not named. Garmin §15.10 requires an AI Transparency Statement and explicit consent, and §5.2(o) limits passing data to third parties. Google Health's Limited Use policy also applies. Strava stays off. Counsel should say, for each provider, whether AskWearables may connect it, and under what conditions.
2. **The Receipt chain kept after "delete everything".** Hashes, times, Agent IDs and decisions remain. Counsel should confirm that keeping them is consistent with deletion rights under the Washington My Health My Data Act (which reaches archives and backups) and the CCPA. If it is not, the chain should be deleted too, or its retention limited.
3. **Consent wording on the consent screen and at sign-up.** The Washington Act and its Nevada and Connecticut counterparts require consent to collect and a separate consent to share that are clear, specific and affirmative. Counsel should review the Source-connection screen, the eight-part Grant screen and the sign-up clickwrap against those rules.

## Engineering follow-ups the documents now promise

These are commitments in the published documents that the code does not yet fully meet.

- **The user ID in daily anchors must be hashed.** `workers/vault/src/index.ts` `anchor()` writes the plain user ID today. The owner is changing it.
- **Receipt rows after deletion.** The documents say only hashes, times, Agent IDs and decisions remain. Today the rows also keep `seq`, `grant_id` and `level` in the clear (`packages/core/src/receipts.ts`). Either drop those at deletion, or add them to the policy text.
- **Sign-up clickwrap and consent-screen links.** `workers/auth/src/pages.ts` now shows the sign-up box (18+ and acceptance, with `TERMS_VERSION`) and links both documents from the consent screen. Confirm that the accepted version and time are stored server-side.
- **Scheduled jobs**: inactive-account deletion after 24 months with notice 30 days before, and deletion of revoked Grants' metadata after 90 days.
- **Revocation by email** within 2 business days needs a named owner for contact@sportsvision.ai.
- **The sign-in page loads its passkey library from unpkg.com.** The privacy policy discloses this. Self-hosting the file would remove the disclosure.
