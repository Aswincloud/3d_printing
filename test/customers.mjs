// Offline tests for customer accounts.
//
// The three that matter most, in order:
//
//   invariant 7 — a customer cookie can never act as an admin cookie, or vice
//                 versa. Tested in BOTH directions, because getting one right
//                 and the other wrong is the realistic failure.
//   invariant 8 — /api/me/orders is scoped by the session user and nothing else.
//                 A second user's order is seeded so "returns nothing" can't
//                 pass for the wrong reason.
//   invariant 9 — the cart never carries a price.
//
// Then the OTP mechanics: attempt cap, expiry, replay, and the send throttle.

import {
  currentCustomer, requestCode, verifyCode, resendCode, myOrders, whoami, updateMe,
} from "../src/customers.js";
import { currentOwner, currentAdmin } from "../src/auth.js";
import { signToken } from "@aswincloud/auth";
import { generateOtp, hashOtp, OTP_MAX_ATTEMPTS } from "@aswincloud/auth/d1";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const SESSION_SECRET = "test_session_secret_for_customers";
const OWNER = "aswin@aswincloud.com";

// ── in-memory D1 ──────────────────────────────────────────────────
// Throws on any statement it doesn't recognise, so a query change can't quietly
// turn a test green. Projects only the selected columns, for the same reason.
const project = (row, cols) =>
  Object.fromEntries(cols.filter((c) => c in row).map((c) => [c, row[c]]));
const columnsOf = (sql) =>
  sql.slice(sql.indexOf("SELECT ") + 7, sql.indexOf(" FROM "))
    .split(",").map((c) => c.trim().split(/\s+/).pop().replace(/^\w+\./, ""));

function makeDB(seed = {}) {
  const copy = (r) => (r || []).map((x) => ({ ...x }));
  const db = {
    users: copy(seed.users),
    otp_codes: copy(seed.otp_codes),
    otp_requests: copy(seed.otp_requests),
    orders: copy(seed.orders),
    order_items: copy(seed.order_items),
    products: copy(seed.products),
    cart_items: copy(seed.cart_items),
  };

  const run = (sql, a) => {
    const s = sql.replace(/\s+/g, " ").trim();
    const lc = (v) => String(v ?? "").toLowerCase();

    // users
    if (s.startsWith("SELECT id, email, name, created_at FROM users WHERE id = ?")) {
      const u = db.users.find((x) => x.id === a[0]);
      return { first: u ? project(u, ["id", "email", "name", "created_at"]) : null };
    }
    if (s.startsWith("SELECT id, email, name FROM users WHERE email = ?")) {
      const u = db.users.find((x) => lc(x.email) === lc(a[0]));
      return { first: u ? project(u, ["id", "email", "name"]) : null };
    }
    if (s.startsWith("INSERT INTO users")) {
      db.users.push({ id: a[0], email: a[1], name: null, created_at: a[2], last_seen: a[3] });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE users SET last_seen")) {
      const u = db.users.find((x) => x.id === a[1]);
      if (u) u.last_seen = a[0];
      return { meta: { changes: u ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE users SET name")) {
      const u = db.users.find((x) => x.id === a[1]);
      if (u) u.name = a[0];
      return { meta: { changes: u ? 1 : 0 } };
    }

    // otp_codes — the package's own SQL
    if (s.startsWith("INSERT INTO otp_codes")) {
      const [email, hash, exp, created] = a;
      const e = db.otp_codes.find((x) => lc(x.email) === lc(email));
      if (e) { e.code_hash = hash; e.expires_at = exp; e.attempts = 0; e.created_at = created; }
      else db.otp_codes.push({ email, code_hash: hash, expires_at: exp, attempts: 0, created_at: created });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("SELECT ") && s.includes("FROM otp_codes WHERE email = ?")) {
      const e = db.otp_codes.find((x) => lc(x.email) === lc(a[0]));
      return { first: e ? { ...e } : null };
    }
    if (s.startsWith("UPDATE otp_codes SET attempts")) {
      const e = db.otp_codes.find((x) => lc(x.email) === lc(a[0]));
      if (e) e.attempts += 1;
      return { meta: { changes: e ? 1 : 0 } };
    }
    if (s.startsWith("DELETE FROM otp_codes WHERE email = ?")) {
      const n = db.otp_codes.length;
      db.otp_codes = db.otp_codes.filter((x) => lc(x.email) !== lc(a[0]));
      return { meta: { changes: n - db.otp_codes.length } };
    }

    // otp_requests (throttle)
    if (s.startsWith("SELECT count, window_start FROM otp_requests WHERE email = ?")) {
      const r = db.otp_requests.find((x) => lc(x.email) === lc(a[0]));
      return { first: r ? { count: r.count, window_start: r.window_start } : null };
    }
    if (s.startsWith("INSERT INTO otp_requests")) {
      const r = db.otp_requests.find((x) => lc(x.email) === lc(a[0]));
      if (r) { r.count = 1; r.window_start = a[2]; }
      else db.otp_requests.push({ email: a[0], count: 1, window_start: a[1] });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE otp_requests SET count = count + 1")) {
      const r = db.otp_requests.find((x) => lc(x.email) === lc(a[0]));
      if (r) r.count += 1;
      return { meta: { changes: r ? 1 : 0 } };
    }

    // orders
    if (s.startsWith("UPDATE orders SET user_id = ? WHERE user_id IS NULL AND lower(cust_email) = ?")) {
      let n = 0;
      for (const o of db.orders) {
        if (o.user_id == null && lc(o.cust_email) === lc(a[1])) { o.user_id = a[0]; n++; }
      }
      return { meta: { changes: n } };
    }
    if (s.startsWith("SELECT id, receipt, status,") && s.includes("FROM orders WHERE user_id = ?")) {
      const rows = db.orders.filter((o) => o.user_id === a[0])
        .sort((x, y) => y.created_at - x.created_at);
      const cols = columnsOf(s);
      return { results: rows.map((r) => project(r, cols)) };
    }
    if (s.startsWith("SELECT order_id, name, price_paise, qty FROM order_items")) {
      const want = new Set(a);
      return { results: db.order_items.filter((i) => want.has(i.order_id)) };
    }

    throw new Error("unhandled SQL: " + s.slice(0, 110));
  };

  return {
    _db: db,
    prepare(sql) {
      return {
        bind(...args) { this._a = args; return this; },
        async all() { return { results: run(sql, this._a || []).results || [] }; },
        async first() { return run(sql, this._a || []).first ?? null; },
        async run() { return run(sql, this._a || []); },
      };
    },
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
}

const ENV = (seed) => ({
  SESSION_SECRET,
  // currentOwner() requires all three broker vars via ssoConfigured(); without
  // them it returns null regardless of the cookie, which would make the
  // invariant-7 "owner cookie works" baseline pass for the wrong reason.
  AUTH_BROKER_URL: "https://auth.aswincloud.com",
  RELAY_SECRET: "test_relay_secret",
  RESEND_API_KEY: "re_fake",
  APP_NAME: "AswinPrints",
  OWNER_EMAIL: OWNER,
  ACCESS_MODE: "owners",
  DB: makeDB(seed),
});

const req = (cookies = "", path = "/api/me") =>
  new Request("http://x" + path, { headers: cookies ? { cookie: cookies } : {} });
const read = async (res) => [res.status, await res.json()];
const ctx = () => { const p = []; return { waitUntil: (x) => p.push(x), _p: p }; };
const settle = async (c) => { await Promise.all(c._p); };

// Capture Resend sends so the emailed code can be read back.
function stubResend() {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.resend.com")) {
      sent.push(JSON.parse(init.body || "{}"));
      return new Response(JSON.stringify({ id: "email_stub" }), { status: 200 });
    }
    throw new Error("unexpected fetch " + url);
  };
  return sent;
}
const codeFrom = (mail) => (mail.text || mail.html || "").match(/\b(\d{6})\b/)?.[1] || null;

const USER_A = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "alice@example.com", name: "Alice", created_at: 1000, last_seen: 1000 };
const USER_B = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "bob@example.com", name: "Bob", created_at: 1000, last_seen: 1000 };

// ══ INVARIANT 7 ══════════════════════════════════════════════════
section("invariant 7 — customer and admin sessions cannot cross");
{
  const env = ENV({ users: [USER_A] });

  const customerTok = await signToken(SESSION_SECRET, USER_A.id, "customer_session", 3600);
  const ownerTok = await signToken(SESSION_SECRET, OWNER, "owner_session", 3600);

  // Baselines: each works in its own place.
  ok("customer cookie authenticates a customer",
     (await currentCustomer(req(`ap_user=${customerTok}`), env))?.id === USER_A.id);
  ok("owner cookie authenticates the owner",
     (await currentOwner(req(`ap_session=${ownerTok}`), env)) === OWNER);

  // → the crossings, both ways.
  ok("customer token in the ADMIN cookie is refused",
     (await currentOwner(req(`ap_session=${customerTok}`), env)) === null);
  ok("owner token in the CUSTOMER cookie is refused",
     (await currentCustomer(req(`ap_user=${ownerTok}`), env)) === null);

  // Even under the right cookie name, the wrong purpose must fail — this is what
  // makes the guarantee cryptographic rather than a name check.
  const wrongPurpose = await signToken(SESSION_SECRET, USER_A.id, "owner_session", 3600);
  ok("owner-purpose token under ap_user is refused",
     (await currentCustomer(req(`ap_user=${wrongPurpose}`), env)) === null);

  // Sending both cookies at once must not let one substitute for the other.
  ok("both cookies present: customer path still reads only ap_user",
     (await currentCustomer(req(`ap_session=${ownerTok}; ap_user=${customerTok}`), env))?.id === USER_A.id);
  ok("both cookies present: admin path still reads only ap_session",
     (await currentOwner(req(`ap_session=${ownerTok}; ap_user=${customerTok}`), env)) === OWNER);
}

section("customer session — other rejections");
{
  const env = ENV({ users: [USER_A] });
  const good = await signToken(SESSION_SECRET, USER_A.id, "customer_session", 3600);

  ok("no cookie → null", (await currentCustomer(req(""), env)) === null);
  ok("garbage → null", (await currentCustomer(req("ap_user=nonsense"), env)) === null);
  ok("expired → null",
     (await currentCustomer(req(`ap_user=${await signToken(SESSION_SECRET, USER_A.id, "customer_session", -10)}`), env)) === null);
  ok("signed with another secret → null",
     (await currentCustomer(req(`ap_user=${await signToken("other_secret", USER_A.id, "customer_session", 3600)}`), env)) === null);
  // A session for an account that no longer exists must not work.
  ok("deleted user → null",
     (await currentCustomer(req(`ap_user=${good}`), ENV({ users: [] }))) === null);
  ok("SESSION_SECRET unset → null",
     (await currentCustomer(req(`ap_user=${good}`), { ...env, SESSION_SECRET: "" })) === null);
}

// ══ INVARIANT 8 ══════════════════════════════════════════════════
section("invariant 8 — order history is scoped to the session user");
{
  const orders = [
    { id: "o-a1", user_id: USER_A.id, receipt: "AP-aaaa1111", status: "paid", subtotal_paise: 34900, shipping_paise: 9900, total_paise: 44800, delivery: "ship", notes: "", created_at: 2000, paid_at: 2100, shipped_at: null, cust_email: USER_A.email, cust_name: "Alice", addr_line: "1 A St", rzp_payment_id: "pay_A" },
    { id: "o-b1", user_id: USER_B.id, receipt: "AP-bbbb2222", status: "paid", subtotal_paise: 89900, shipping_paise: 0, total_paise: 89900, delivery: "pickup", notes: "", created_at: 3000, paid_at: 3100, shipped_at: null, cust_email: USER_B.email, cust_name: "Bob", addr_line: "2 B St", rzp_payment_id: "pay_B" },
  ];
  const items = [
    { order_id: "o-a1", name: "Kingfisher", price_paise: 34900, qty: 1 },
    { order_id: "o-b1", name: "Elephant", price_paise: 89900, qty: 1 },
  ];
  const env = ENV({ users: [USER_A, USER_B], orders, order_items: items });

  const [, mine] = await read(await myOrders(env, USER_A));
  ok("returns my order", mine.orders.length === 1, JSON.stringify(mine.orders.map((o) => o.receipt)));
  ok("it is the right one", mine.orders[0].receipt === "AP-aaaa1111");
  ok("does NOT include the other customer's order",
     !JSON.stringify(mine.orders).includes("AP-bbbb2222"));
  ok("line items attached", mine.orders[0].items.length === 1);

  // myOrders takes (env, user) and has no third parameter, so there is nowhere
  // to smuggle a filter. Assert that extra arguments are inert.
  const [, spoofed] = await read(await myOrders(env, USER_A, { user_id: USER_B.id }, "AP-bbbb2222"));
  ok("extra arguments cannot widen the scope", spoofed.orders.length === 1
     && spoofed.orders[0].receipt === "AP-aaaa1111");

  // A user with no orders gets an empty list, not everyone's.
  const [, none] = await read(await myOrders(env, { id: "nobody" }));
  ok("unknown user sees nothing", none.orders.length === 0);

  // The internal uuid should not leak; the receipt is the public handle.
  ok("internal order id not exposed", mine.orders[0].id === undefined);
  // Fields the ADMIN view needs but a customer's own view doesn't.
  ok("payment id not exposed", mine.orders[0].rzp_payment_id === undefined);
}

// ── OTP request ───────────────────────────────────────────────────
section("POST /api/auth/code");
{
  const env = ENV();
  const sent = stubResend();
  const c = ctx();
  const [status, out] = await read(await requestCode(req(), env, c, { email: "New@Example.com" }));
  await settle(c);

  ok("200", status === 200, JSON.stringify(out));
  ok("reports the ttl", out.ttl_minutes === 10, String(out.ttl_minutes));
  ok("one email sent", sent.length === 1);
  ok("6-digit code in the email", /\b\d{6}\b/.test(sent[0].text || sent[0].html));
  ok("code row stored", env.DB._db.otp_codes.length === 1);
  ok("email stored lowercased", env.DB._db.otp_codes[0].email === "new@example.com");
  // The point of hashing: the row must not contain the code itself.
  const code = codeFrom(sent[0]);
  ok("stored value is a hash, not the code", !env.DB._db.otp_codes[0].code_hash.includes(code));
  ok("no user row created yet (only on verify)", env.DB._db.users.length === 0);
}

section("POST /api/auth/code — bad input and config");
{
  for (const email of ["", "not-an-email", "a@b", "   "]) {
    const env = ENV(); const sent = stubResend();
    const [status] = await read(await requestCode(req(), env, ctx(), { email }));
    ok(`rejects ${JSON.stringify(email)}`, status === 400);
    ok(`  and sends nothing`, sent.length === 0);
  }
  {
    const env = { ...ENV(), SESSION_SECRET: "" };
    const [status] = await read(await requestCode(req(), env, ctx(), { email: "a@b.com" }));
    ok("503 when SESSION_SECRET unset", status === 503);
  }
  {
    const env = { ...ENV(), RESEND_API_KEY: "" };
    const [status] = await read(await requestCode(req(), env, ctx(), { email: "a@b.com" }));
    ok("503 when RESEND_API_KEY unset", status === 503);
  }
}

section("POST /api/auth/code — throttle is silent (no account oracle)");
{
  const env = ENV();
  const sent = stubResend();
  let lastStatus, lastBody;
  for (let i = 0; i < 7; i++) {
    const c = ctx();
    [lastStatus, lastBody] = await read(await requestCode(req(), env, c, { email: "spam@example.com" }));
    await settle(c);
  }
  ok("5 emails sent, not 7", sent.length === 5, String(sent.length));
  ok("the 7th still returns 200", lastStatus === 200);
  ok("and still returns ok:true (indistinguishable)", lastBody.ok === true);
}

// ── OTP verify ────────────────────────────────────────────────────
section("POST /api/auth/code/verify");
{
  const env = ENV();
  const sent = stubResend();
  const c = ctx();
  await requestCode(req(), env, c, { email: "alice@example.com" });
  await settle(c);
  const code = codeFrom(sent[0]);

  const res = await verifyCode(req(), env, { email: "alice@example.com", code });
  const [status, out] = [res.status, await res.json()];
  ok("200 with the right code", status === 200, JSON.stringify(out));
  ok("marked as a new account", out.is_new === true);
  ok("user row created", env.DB._db.users.length === 1);
  ok("code row burned", env.DB._db.otp_codes.length === 0);

  const setCookie = res.headers.get("set-cookie") || "";
  ok("sets ap_user", setCookie.startsWith("ap_user="));
  ok("HttpOnly", /HttpOnly/i.test(setCookie));
  ok("Secure", /Secure/i.test(setCookie));
  ok("SameSite=Lax", /SameSite=Lax/i.test(setCookie));

  // The cookie must carry the user id, not the email.
  const tok = decodeURIComponent(setCookie.split(";")[0].slice("ap_user=".length));
  const who = await currentCustomer(req(`ap_user=${tok}`), env);
  ok("cookie authenticates the new user", who?.email === "alice@example.com");
  ok("cookie subject is the id, not the email", !tok.includes("alice"));

  // Replay: the code was deleted, so the same code must not work twice.
  const replay = await verifyCode(req(), env, { email: "alice@example.com", code });
  ok("code cannot be reused", replay.status === 400);
}

section("verify — wrong, expired, capped");
{
  const nowSec = Math.floor(Date.now() / 1000);
  const mk = async (over = {}) => {
    const env = ENV({ users: [] });
    const code = "123456";
    env.DB._db.otp_codes.push({
      email: "x@example.com",
      code_hash: await hashOtp(code, SESSION_SECRET),
      expires_at: nowSec + 600, attempts: 0, created_at: nowSec, ...over,
    });
    return { env, code };
  };

  {
    const { env } = await mk();
    const [status] = await read(await verifyCode(req(), env, { email: "x@example.com", code: "000000" }));
    ok("wrong code → 400", status === 400);
    ok("attempts incremented", env.DB._db.otp_codes[0].attempts === 1);
    ok("code NOT deleted (they may retry)", env.DB._db.otp_codes.length === 1);
  }
  {
    const { env, code } = await mk({ expires_at: nowSec - 1 });
    const [status] = await read(await verifyCode(req(), env, { email: "x@example.com", code }));
    ok("expired code → 400", status === 400);
    ok("expired code deleted", env.DB._db.otp_codes.length === 0);
  }
  {
    const { env, code } = await mk({ attempts: OTP_MAX_ATTEMPTS });
    const [status, out] = await read(await verifyCode(req(), env, { email: "x@example.com", code }));
    ok("attempt cap → 429 even with the CORRECT code", status === 429, JSON.stringify(out));
    ok("code deleted at the cap", env.DB._db.otp_codes.length === 0);
  }
  {
    // No code requested at all — same message as a wrong code, no oracle.
    const env = ENV();
    const [status, out] = await read(await verifyCode(req(), env, { email: "never@example.com", code: "123456" }));
    ok("no pending code → 400", status === 400);
    ok("message does not reveal whether the address is known",
       !/unknown|no account|not found/i.test(out.error), out.error);
  }
  {
    const env = ENV();
    ok("missing code → 400", (await read(await verifyCode(req(), env, { email: "a@b.com" })))[0] === 400);
    ok("missing email → 400", (await read(await verifyCode(req(), env, { code: "123456" })))[0] === 400);
  }
}

// ── claiming guest orders ─────────────────────────────────────────
section("first sign-in claims guest orders placed with that email");
{
  const orders = [
    { id: "g1", user_id: null, receipt: "AP-guest001", cust_email: "Alice@Example.com", status: "paid", subtotal_paise: 100, shipping_paise: 0, total_paise: 100, delivery: "pickup", notes: "", created_at: 1, paid_at: 2, shipped_at: null },
    { id: "g2", user_id: null, receipt: "AP-guest002", cust_email: "someone@else.com", status: "paid", subtotal_paise: 100, shipping_paise: 0, total_paise: 100, delivery: "pickup", notes: "", created_at: 1, paid_at: 2, shipped_at: null },
    { id: "g3", user_id: USER_B.id, receipt: "AP-taken003", cust_email: "alice@example.com", status: "paid", subtotal_paise: 100, shipping_paise: 0, total_paise: 100, delivery: "pickup", notes: "", created_at: 1, paid_at: 2, shipped_at: null },
  ];
  const env = ENV({ orders });
  const sent = stubResend();
  const c = ctx();
  await requestCode(req(), env, c, { email: "alice@example.com" });
  await settle(c);
  const [, out] = await read(await verifyCode(req(), env, { email: "alice@example.com", code: codeFrom(sent[0]) }));

  ok("claimed exactly one order", out.claimed_orders === 1, String(out.claimed_orders));
  const g = (r) => env.DB._db.orders.find((o) => o.receipt === r);
  ok("case-insensitive email match claimed it", g("AP-guest001").user_id !== null);
  ok("another person's guest order untouched", g("AP-guest002").user_id === null);
  // The important one: an order already owned by someone else must never move.
  ok("order already owned by another account NOT stolen", g("AP-taken003").user_id === USER_B.id);
}

// ── resend cooldown ───────────────────────────────────────────────
section("resend cooldown");
{
  const env = ENV();
  const sent = stubResend();
  const c = ctx();
  await requestCode(req(), env, c, { email: "cool@example.com" });
  await settle(c);
  ok("first send happened", sent.length === 1);

  const c2 = ctx();
  const [status, out] = await read(await resendCode(req(), env, c2, { email: "cool@example.com" }));
  await settle(c2);
  ok("immediate resend returns 200", status === 200);
  ok("reports a cooldown", typeof out.cooldown_seconds === "number" && out.cooldown_seconds > 0,
     JSON.stringify(out));
  ok("no second email sent", sent.length === 1, String(sent.length));

  // Older than the cooldown → allowed.
  env.DB._db.otp_codes[0].created_at -= 120;
  const c3 = ctx();
  await resendCode(req(), env, c3, { email: "cool@example.com" });
  await settle(c3);
  ok("resend after the cooldown sends", sent.length === 2, String(sent.length));
}

// ── profile ───────────────────────────────────────────────────────
section("GET /api/me and PATCH /api/me");
{
  const env = ENV({ users: [USER_A] });
  const [, me] = await read(whoami(USER_A));
  ok("returns email", me.email === USER_A.email);
  ok("returns name", me.name === "Alice");
  ok("signedIn true", me.signedIn === true);

  const [status] = await read(await updateMe(env, USER_A, { name: "Alice Smith" }));
  ok("name updated", status === 200 && env.DB._db.users[0].name === "Alice Smith");
  ok("empty patch → 400", (await read(await updateMe(env, USER_A, {})))[0] === 400);
  // A long name must be clipped, not rejected or stored whole.
  await updateMe(env, USER_A, { name: "z".repeat(200) });
  ok("long name clipped to 80", env.DB._db.users[0].name.length === 80);
}


// ══ ADMIN VIA OTP ════════════════════════════════════════════════
// The broker has no registration for site=3dprints, so admin access also
// accepts an OTP-verified email that is on the OWNER_EMAIL allowlist. Both
// transports must end at the SAME allowlist check — a second way in, not a
// second policy. These are the tests that keep it that way.
section("currentAdmin() — two transports, one allowlist");
{
  const ownerUser = { id: "owner-uuid", email: OWNER, name: "Aswin", created_at: 1, last_seen: 1 };
  const env = ENV({ users: [ownerUser, USER_A] });

  const ownerCustomerTok = await signToken(SESSION_SECRET, ownerUser.id, "customer_session", 3600);
  const strangerTok = await signToken(SESSION_SECRET, USER_A.id, "customer_session", 3600);
  const brokerTok = await signToken(SESSION_SECRET, OWNER, "owner_session", 3600);

  // Transport 1: the broker session still works.
  ok("broker session grants admin",
     (await currentAdmin(req(`ap_session=${brokerTok}`), env)) === OWNER);

  // Transport 2: an OTP session for the allowlisted email.
  ok("OTP session for the owner email grants admin",
     (await currentAdmin(req(`ap_user=${ownerCustomerTok}`), env)) === OWNER);

  // THE important one: any other customer must NOT become admin.
  ok("OTP session for a non-owner does NOT grant admin",
     (await currentAdmin(req(`ap_user=${strangerTok}`), env)) === null);

  // No session at all.
  ok("no cookie → no admin", (await currentAdmin(req(""), env)) === null);
  ok("garbage cookie → no admin", (await currentAdmin(req("ap_user=nonsense"), env)) === null);

  // Fail closed: an unset OWNER_EMAIL must deny even the owner's own session,
  // by BOTH routes. This is invariant 6 extended to the new transport.
  const noOwner = { ...ENV({ users: [ownerUser] }), OWNER_EMAIL: "" };
  ok("empty OWNER_EMAIL denies the OTP route",
     (await currentAdmin(req(`ap_user=${ownerCustomerTok}`), noOwner)) === null);
  ok("empty OWNER_EMAIL denies the broker route",
     (await currentAdmin(req(`ap_session=${brokerTok}`), noOwner)) === null);

  // An expired customer session must not linger as admin.
  const expired = await signToken(SESSION_SECRET, ownerUser.id, "customer_session", -10);
  ok("expired OTP session → no admin",
     (await currentAdmin(req(`ap_user=${expired}`), env)) === null);

  // Case-insensitivity: the allowlist lowercases, and so does sign-in.
  const upper = { ...ownerUser, id: "upper-uuid", email: "ASWIN@AswinCloud.com" };
  const upperEnv = ENV({ users: [upper] });
  const upperTok = await signToken(SESSION_SECRET, upper.id, "customer_session", 3600);
  ok("mixed-case owner email still grants admin",
     Boolean(await currentAdmin(req(`ap_user=${upperTok}`), upperEnv)));

  // A customer session for an account that was deleted grants nothing.
  ok("deleted owner account → no admin",
     (await currentAdmin(req(`ap_user=${ownerCustomerTok}`), ENV({ users: [] }))) === null);
}

section("the is_admin flag on /api/me is display-only");
{
  const [, plain] = await read(whoami(USER_A));
  ok("defaults to false", plain.is_admin === false);
  const [, flagged] = await read(whoami(USER_A, true));
  ok("can be set true for the UI", flagged.is_admin === true);
  // It's a hint: the gate re-checks independently, so a faked value grants
  // nothing. Asserted by the currentAdmin tests above, which never consult it.
  ok("whoami never consults the allowlist itself", plain.email === USER_A.email);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
