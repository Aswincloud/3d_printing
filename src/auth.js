// Owner sign-in via the central broker at auth.aswincloud.com.
//
// Ported from ~/projects/invoicer/src/oauth-routes.js, with one substantive
// simplification: invoicer mints a D1-backed session keyed to a users row. Here
// there is exactly one PRIVILEGED user, so the admin session needs no lookup —
// it's a signed token carrying the verified email, re-checked against the
// allowlist on every request.
//
// Customers are a separate thing entirely (src/customers.js, ap_user cookie,
// its own token purpose). The only place the two meet is currentAdmin() below,
// which will accept a customer session IF its email is on the owner allowlist.
//
//   GET /api/auth/providers                → broker's provider list for this site
//   GET /api/auth/login/:provider          → nonce cookie + 302 to the broker
//   GET /api/auth/callback/:provider       → verify relay, check policy, set session
//   POST /api/auth/logout                  → clear the session
//   GET /api/auth/me                       → { signedIn, email }

import {
  verifyRelay, signToken, verifyToken, emailAllowed, parseAccessMode, parseAllowlist,
} from "@aswincloud/auth";
import { json, randToken, cookie, parseCookies } from "./lib.js";
// Safe: customers.js does not import this module, so there is no cycle.
import { currentCustomer } from "./customers.js";

const SESSION_COOKIE = "ap_session";
const SESSION_PURPOSE = "owner_session";
const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;      // 14 days
const NONCE_COOKIE = "ap_oauth_nonce";
const NONCE_PURPOSE = "broker_nonce";
const NONCE_TTL_SECONDS = 10 * 60;
// MUST equal the Worker name, because the provisioner registers a site under
// the Worker's name (invoicer: worker "invoicer", SITE_ID "invoicer", broker
// entry "invoicer" — all three identical, which is why its SSO works). This was
// "3dprints" while the Worker is "3d-printing", so every broker lookup would
// have come back unknown_site even after provisioning.
const SITE_ID = "3d-printing";
const KNOWN_PROVIDERS = ["google", "github", "microsoft"];

export const ssoConfigured = (env) =>
  Boolean(env.AUTH_BROKER_URL && env.RELAY_SECRET && env.SESSION_SECRET);

const brokerBase = (env) => String(env.AUTH_BROKER_URL || "").replace(/\/$/, "");

// ── the security gate ─────────────────────────────────────────────
// `emailAllowed(mode:"owners")` delegates to `isOwner`, and isOwner treats an
// EMPTY allowlist as "allow anybody authenticated" — verified by reading
// @aswincloud/auth@0.5.0 dist/owner.js:
//
//     if (allow.size === 0) return true;
//
// That default is reasonable for the package (some sites genuinely want any
// signed-in user) but catastrophic here: a typo'd or unset OWNER_EMAIL would
// silently expose customer names, addresses, phone numbers and payment ids to
// anyone with a Google account. So the allowlist being non-empty is checked
// FIRST, independently, and a missing one denies everyone.
export function ownerAllowed(env, email) {
  const owners = env.OWNER_EMAIL || "";
  if (parseAllowlist(owners).size === 0) {
    console.error("OWNER_EMAIL is unset — denying all admin access (fail closed)");
    return false;
  }
  return emailAllowed({
    mode: parseAccessMode(env.ACCESS_MODE),   // unknown/empty → "owners"
    email,
    owners,
    domains: env.ACCESS_DOMAINS,
  });
}

// Returns the verified owner email, or null. Every /api/admin/* request calls
// this; there is no in-memory session state to go stale.
export async function currentOwner(request, env) {
  if (!ssoConfigured(env)) return null;
  const tok = parseCookies(request)[SESSION_COOKIE];
  if (!tok) return null;
  const email = await verifyToken(env.SESSION_SECRET, tok, SESSION_PURPOSE);
  if (!email) return null;
  // Re-check the policy on every request: removing an email from OWNER_EMAIL
  // must revoke access immediately, not whenever the cookie happens to expire.
  return ownerAllowed(env, email) ? email : null;
}

// Admin identity from EITHER transport:
//
//   1. a broker session (ap_session / "owner_session") — Google/GitHub/Microsoft
//   2. a customer session (ap_user / "customer_session") whose verified email is
//      on the OWNER_EMAIL allowlist
//
// The second exists because the broker has no registration for site=3dprints,
// which left the dashboard unreachable. Both routes end at the SAME
// `ownerAllowed()` check, so the allowlist stays the single source of who is an
// admin — a second transport, not a second policy.
//
// The security trade is worth stating plainly: route 2 makes admin access
// email-strength. Whoever can read aswin@aswincloud.com can issue refunds and
// read customer addresses. Route 1 is stronger and should be preferred once the
// broker knows this site; nothing here blocks that.
//
// What this is NOT: a way for a customer to self-promote. The email must already
// be on the allowlist, which only a Worker var can change.
export async function currentAdmin(request, env) {
  // Prefer the broker session when present.
  const viaBroker = await currentOwner(request, env);
  if (viaBroker) return viaBroker;

  const user = await currentCustomer(request, env);
  if (!user?.email) return null;

  // Same fail-closed allowlist check. An unset OWNER_EMAIL denies everyone,
  // including here — see the note on ownerAllowed().
  return ownerAllowed(env, user.email) ? user.email : null;
}

// ── routes ────────────────────────────────────────────────────────
export async function providersResponse(env) {
  const headers = { "content-type": "application/json", "cache-control": "max-age=300" };
  const empty = () => new Response(JSON.stringify({ providers: [] }), { headers });
  if (!ssoConfigured(env)) return empty();
  try {
    const r = await fetch(`${brokerBase(env)}/api/oauth/providers?site=${SITE_ID}`, {
      headers: { accept: "application/json" },
    });
    if (!r.ok) return empty();
    const body = await r.json();
    return new Response(
      JSON.stringify({ providers: Array.isArray(body.providers) ? body.providers : [] }),
      { headers },
    );
  } catch {
    return empty();
  }
}

export async function loginStart(env, provider) {
  const redirect = (to, extraCookie) => {
    const h = new Headers({ Location: to });
    if (extraCookie) h.append("Set-Cookie", extraCookie);
    return new Response(null, { status: 302, headers: h });
  };

  if (!ssoConfigured(env)) return redirect("/shop?auth=config");

  const prov = KNOWN_PROVIDERS.includes(provider) ? provider : "google";

  // A fresh nonce binds this attempt to the relay that comes back, so a relay
  // captured from another flow can't be replayed here.
  const nonce = randToken(16);
  const nonceTok = await signToken(env.SESSION_SECRET, nonce, NONCE_PURPOSE, NONCE_TTL_SECONDS);

  const start = new URL(`${brokerBase(env)}/api/oauth/${prov}/start`);
  start.searchParams.set("site", SITE_ID);
  start.searchParams.set("return", `${env.APP_BASE_URL}/api/auth/callback/${prov}`);
  start.searchParams.set("nonce", nonce);

  return redirect(start.toString(), cookie(NONCE_COOKIE, nonceTok, { maxAge: NONCE_TTL_SECONDS }));
}

export async function loginCallback(env, provider, request) {
  const clearNonce = cookie(NONCE_COOKIE, "", { del: true });
  const fail = (why) => {
    const h = new Headers({ Location: `/shop?auth=${why}` });
    h.append("Set-Cookie", clearNonce);
    return new Response(null, { status: 302, headers: h });
  };

  if (!ssoConfigured(env)) return fail("config");

  const url = new URL(request.url);
  if (url.searchParams.get("relay_error")) return fail("denied");

  const relay = url.searchParams.get("relay");
  if (!relay) return fail("state");

  const claims = await verifyRelay(env.RELAY_SECRET, relay);
  if (!claims) return fail("state");

  const nonceTok = parseCookies(request)[NONCE_COOKIE];
  const expected = nonceTok
    ? await verifyToken(env.SESSION_SECRET, nonceTok, NONCE_PURPOSE)
    : null;
  if (!expected || expected !== claims.nonce) return fail("state");

  const email = String(claims.email || "").trim().toLowerCase();
  if (!ownerAllowed(env, email)) {
    console.warn("admin sign-in denied for", email);
    return fail("denied");
  }

  const session = await signToken(env.SESSION_SECRET, email, SESSION_PURPOSE, SESSION_TTL_SECONDS);
  const h = new Headers({ Location: "/shop?auth=ok" });
  h.append("Set-Cookie", cookie(SESSION_COOKIE, session, { maxAge: SESSION_TTL_SECONDS }));
  h.append("Set-Cookie", clearNonce);
  return new Response(null, { status: 302, headers: h });
}

// Clears BOTH sessions. The dashboard's sign-out button hits this endpoint, and
// an admin who arrived via the OTP route holds an ap_user cookie — clearing only
// ap_session would leave them apparently signed out while still authenticated.
export function logout() {
  const h = new Headers({ "content-type": "application/json" });
  h.append("Set-Cookie", cookie(SESSION_COOKIE, "", { del: true }));
  h.append("Set-Cookie", cookie("ap_user", "", { del: true }));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
}

// Backs the dashboard's sign-in probe, so it must agree with the /api/admin/*
// gate. Using currentOwner() here instead of currentAdmin() would leave an
// OTP-authenticated owner able to call the API while the UI insisted they were
// signed out.
export async function whoami(request, env) {
  const email = await currentAdmin(request, env);
  return json({
    signedIn: Boolean(email),
    email: email || null,
    configured: ssoConfigured(env),
  });
}
