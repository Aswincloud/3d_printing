// Owner sign-in via the central broker at auth.aswincloud.com.
//
// Ported from ~/projects/invoicer/src/oauth-routes.js, with one substantive
// simplification: invoicer is multi-user, so it keeps users / sessions /
// oauth_identities tables in D1 and mints a D1-backed session. This site has
// exactly one privileged user — Aswin — and no customer accounts at all
// (receipts are reached by an unguessable token). So there is nothing to look
// up: the session is a signed token in a cookie carrying the verified email,
// and every request re-checks that email against the allowlist. No new tables.
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

const SESSION_COOKIE = "ap_session";
const SESSION_PURPOSE = "owner_session";
const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;      // 14 days
const NONCE_COOKIE = "ap_oauth_nonce";
const NONCE_PURPOSE = "broker_nonce";
const NONCE_TTL_SECONDS = 10 * 60;
const SITE_ID = "3dprints";                          // registration id with the broker
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

  if (!ssoConfigured(env)) return redirect("/shop.html?auth=config");

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
    const h = new Headers({ Location: `/shop.html?auth=${why}` });
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
  const h = new Headers({ Location: "/shop.html?auth=ok" });
  h.append("Set-Cookie", cookie(SESSION_COOKIE, session, { maxAge: SESSION_TTL_SECONDS }));
  h.append("Set-Cookie", clearNonce);
  return new Response(null, { status: 302, headers: h });
}

export function logout() {
  return json({ ok: true }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, "", { del: true }) });
}

export async function whoami(request, env) {
  const email = await currentOwner(request, env);
  return json({
    signedIn: Boolean(email),
    email: email || null,
    configured: ssoConfigured(env),
  });
}
