// Response security headers and request rate limiting.
//
// Both were flagged as gaps in the pre-launch audit: the site had no CSP, no
// X-Frame-Options and no HSTS, and nothing but the OTP email throttle limited
// request rates (30 concurrent POSTs to /api/orders returned zero 429s).

import { json } from "./lib.js";

// ── Content-Security-Policy ───────────────────────────────────────
//
// The allowlist below is OBSERVED, not guessed. A CSP that blocks checkout is
// worse than no CSP, so the domains were collected by opening real Razorpay
// Standard Checkout in a browser and recording every origin it contacted:
//
//   checkout.razorpay.com              the script tag in index.html
//   api.razorpay.com                   the checkout iframe + its XHR
//   cdn.razorpay.com                   secondary bundles
//   checkout-static-next.razorpay.com  css, fonts, chunks
//   lumberjack.razorpay.com            their telemetry beacon (ping + xhr)
//   browser.sentry-cdn.com             Razorpay loads Sentry inside checkout
//
// The last two would never have been in a hand-written policy — omitting
// lumberjack breaks nothing visible, but omitting sentry-cdn logs console errors
// on every checkout, and both would show up as CSP violations in the customer's
// console. Re-run the discovery script if Razorpay changes their bundle.
const RAZORPAY = [
  "https://checkout.razorpay.com",
  "https://api.razorpay.com",
  "https://cdn.razorpay.com",
  "https://checkout-static-next.razorpay.com",
  "https://lumberjack.razorpay.com",
  "https://browser.sentry-cdn.com",
];

// Cloudflare injects its Web Analytics beacon into the HTML AFTER the Worker
// responds, so it appears in production but never in `wrangler dev` — the first
// deploy of this CSP blocked it, and local testing could not have caught that.
// Nothing customer-facing broke, but every visitor got a console violation and
// the analytics stopped reporting.
//
// Allowed rather than dropped, on the assumption the analytics are wanted. The
// alternative is turning Web Analytics off in the Cloudflare dashboard and
// removing this line — a smaller CSP is genuinely better, so that is the right
// move if the numbers are not being used.
const CF_ANALYTICS = "https://static.cloudflareinsights.com";

const CSP = [
  "default-src 'self'",

  // No 'unsafe-inline' here: there are zero inline <script> blocks in the
  // markup (verified), so script-src can stay strict. This is the directive
  // that actually stops an injected <script> from running, and weakening it
  // for convenience would forfeit most of the CSP's value.
  `script-src 'self' ${CF_ANALYTICS} ${RAZORPAY.join(" ")}`,

  // 'unsafe-inline' IS needed for styles: index.html carries 18 inline style=
  // attributes, and Razorpay's checkout injects its own. Inline style is a far
  // weaker vector than inline script — it cannot execute JS in any browser we
  // target — so this is an accepted trade rather than an oversight. Removing it
  // would mean rewriting those attributes into classes first.
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://checkout-static-next.razorpay.com`,

  "font-src 'self' https://fonts.gstatic.com https://checkout-static-next.razorpay.com",

  // data: for the inline SVG/PNG data URIs in the markup; blob: for the image
  // previews the quote uploader generates client-side.
  "img-src 'self' data: blob: https://*.razorpay.com",

  // litterbox.catbox.moe is the quote-form file uploader (see main.js).
  // cloudflareinsights also POSTs its collected metrics back, so allowing only
  // the script would still leave a violation on every page view.
  `connect-src 'self' https://litterbox.catbox.moe ${CF_ANALYTICS} ${RAZORPAY.join(" ")}`,

  // Razorpay Standard Checkout renders as an iframe from api.razorpay.com.
  "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com",

  // Clickjacking: nobody may frame US. This is the header-equivalent of
  // X-Frame-Options: DENY, and is the directive modern browsers actually honour.
  "frame-ancestors 'none'",

  "base-uri 'self'",
  "object-src 'none'",

  // form-action is deliberately NOT locked to 'self'. Netbanking and some UPI
  // flows POST the customer to their own bank's domain, and that set is large,
  // regional, and changes without notice — enumerating it would eventually break
  // a payment method silently, for one customer, with no error we would see. The
  // risk this directive mitigates (an injected form exfiltrating to an attacker)
  // is already covered by script-src, since injecting that form needs script
  // execution first. Named here so the omission reads as a decision.
  //
  // "form-action 'self'",

  "upgrade-insecure-requests",
].join("; ");

// Applied to every response, HTML and JSON alike. An attacker who can make the
// browser treat a JSON response as HTML gets XSS, so the JSON routes need
// nosniff just as much as the pages do.
const HEADERS = {
  "content-security-policy": CSP,

  // Belt-and-braces with frame-ancestors above: still honoured by older
  // browsers that ignore CSP Level 2.
  "x-frame-options": "DENY",

  "x-content-type-options": "nosniff",

  // Don't leak the full URL (which can carry a receipt id) to third parties.
  "referrer-policy": "strict-origin-when-cross-origin",

  // Two years, subdomains included. Safe here because the apex and every
  // subdomain in use are already HTTPS-only behind Cloudflare — but note this is
  // hard to walk back: browsers cache it for the full max-age, so any future
  // http-only subdomain would become unreachable until it expires.
  "strict-transport-security": "max-age=63072000; includeSubDomains",

  // Deny hardware the site never uses.
  "permissions-policy": "geolocation=(), microphone=(), camera=(), payment=()",

  // Legacy header, no effect in current Chrome/Firefox, and actively harmful in
  // old IE where its filter could be abused. Deliberately NOT set.
  // "x-xss-protection": "1; mode=block",
};

// Rebuilds the response because Response.headers is immutable for responses
// returned from the assets binding.
export function withSecurityHeaders(response) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(HEADERS)) h.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: h,
  });
}

// ── Rate limiting ─────────────────────────────────────────────────
//
// Uses Cloudflare's native Rate Limiting binding (configured in wrangler.toml),
// which counts at the edge rather than in D1. The existing OTP throttle stays as
// it is: it limits EMAILS SENT per address over an hour, which is a different
// control from requests-per-IP over a minute, and it must keep working even if
// an attacker rotates IPs.
//
// Keyed on the client IP from CF-Connecting-IP. That header is set by Cloudflare
// and cannot be spoofed by the client — an X-Forwarded-For here would be
// attacker-controlled and therefore useless as a rate-limit key.
function clientKey(request, scope) {
  const ip = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || "unknown";
  return `${scope}:${ip}`;
}

// Which limiter guards which routes. Ordered most-specific first.
//
// Writes that cost money or send email are limited hardest; reads are limited
// loosely so ordinary browsing never trips. GET /api/products is deliberately
// absent — it is cached by Cloudflare and cheap, and limiting it would throttle
// a legitimate visitor loading the catalogue.
const RULES = [
  // Each call creates a Razorpay order server-side, so this is the one that
  // costs something to abuse.
  { test: (p, m) => p === "/api/orders" && m === "POST", limiter: "RL_ORDER" },
  // Sends email.
  { test: (p, m) => p === "/api/quote" && m === "POST", limiter: "RL_QUOTE" },
  // Unauthenticated and sends email. The per-email cap in customers.js already
  // bounds damage to one mailbox; this bounds how fast one IP can spray many.
  { test: (p) => p.startsWith("/api/auth/code"), limiter: "RL_AUTH" },
  // Guessing a 6-digit code. The per-code attempt cap (OTP_MAX_ATTEMPTS) is the
  // real defence; this stops an attacker cycling fresh codes quickly.
  { test: (p) => p === "/api/auth/code/verify", limiter: "RL_AUTH" },
  // Unauthenticated, and it answers "is this a real coupon?" — which makes it an
  // enumeration oracle. Cheap to call, so nothing else bounds it. The error
  // messages are already written so unknown and deactivated codes are
  // indistinguishable; this bounds how fast someone can guess regardless.
  { test: (p, m) => p === "/api/coupon/check" && m === "POST", limiter: "RL_COUPON" },
];

export async function rateLimit(request, env, url) {
  const p = url.pathname;
  const m = request.method;

  const rule = RULES.find((r) => r.test(p, m));
  if (!rule) return null;

  const limiter = env[rule.limiter];
  // Fail OPEN, deliberately. If the binding is missing — a local `wrangler dev`
  // without it, or a partial deploy — the choice is between refusing all orders
  // and accepting unlimited ones. For a shop, silently rejecting real customers
  // is the worse failure, and the other controls (price from D1, webhook
  // signature, auth gates) do not depend on this one. Logged so it is visible.
  if (!limiter?.limit) {
    console.warn("rate limit binding missing:", rule.limiter);
    return null;
  }

  const { success } = await limiter.limit({ key: clientKey(request, rule.limiter) });
  if (success) return null;

  return json(
    { error: "Too many requests. Please wait a moment and try again." },
    429,
    { "retry-after": "60" },
  );
}
