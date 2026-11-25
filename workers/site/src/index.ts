// site: askwearables.app. Static assets only: no data bindings, no service bindings, no secrets.
// Scripts: only same-origin files under /js/ (the results charts); no inline script, no third-party origin.
// The Worker runs first so every response, including 404s, carries the security headers.

export interface Env {
  ASSETS: Fetcher;
}

export const SECURITY_HEADERS: Record<string, string> = {
  // Scripts, styles, images and fetches only from this origin, never inline; nothing can frame the site.
  "content-security-policy":
    "default-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; " +
    "script-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; upgrade-insecure-requests",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const method = request.method;
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD", ...SECURITY_HEADERS } });
    }
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    // The OpenAPI document is meant to be read by tools on other origins.
    if (new URL(request.url).pathname === "/openapi.json") {
      out.headers.set("access-control-allow-origin", "*");
      out.headers.set("cross-origin-resource-policy", "cross-origin");
    }
    return out;
  },
} satisfies ExportedHandler<Env>;
