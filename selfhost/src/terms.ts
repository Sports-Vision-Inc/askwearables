// Self-hosters are their own operator. The hosted service's Terms and Privacy Policy do not apply here:
// the setup clickwrap records acceptance of the software licence and of running this instance yourself.
import type { TermsCopy } from "../vendor/workers/auth/src/pages.js";

export const LICENSE_URL = "https://github.com/Sports-Vision-Inc/askwearables/blob/main/LICENSE";
export const REPO_URL = "https://github.com/Sports-Vision-Inc/askwearables";

const license = `<a href="${LICENSE_URL}" target="_blank" rel="noopener">MIT License</a>`;

/** Short notice shown on the setup page and in the console. */
export const OPERATOR_NOTICE = "You run this instance. Your data stays in your Cloudflare account; Sports Vision does not see it, cannot recover it, and does not operate this service.";

export const SELFHOST_TERMS: TermsCopy = {
  version: "selfhost-mit-2026-11-25",
  clickwrap:
    `<strong>You run this instance.</strong> Your data stays in your Cloudflare account; Sports Vision does not see it. ` +
    `I am 18 or older, I accept the ${license} under which this software is provided as is, without warranty, ` +
    `and I understand that its answers are not medical advice.`,
  missing: "Please confirm you are 18 or older and accept the licence terms.",
  consentFooter:
    `By allowing, you let this AskWearables instance, which you run, share data with this agent as described above. ` +
    `Sports Vision does not operate this instance. Software licence: ${license}.`,
};
