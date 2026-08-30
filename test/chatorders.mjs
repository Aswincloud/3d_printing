// The chat assistant's order lookup.
//
// The question this file has to answer is not "does it work" but "can it be made
// to return somebody else's orders". Everything below is written from the
// attacker's side: the bot secret without a token, a token without the secret, a
// token minted for something else, an expired one, a replayed request, and a
// second customer sitting in the same database waiting to be leaked.

import { chatOrdersHandler } from "../src/chatorders.js";
import { hmacHex } from "../src/lib.js";
import { signToken } from "@aswincloud/auth";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);
const read = async (res) => [res.status, await res.json()];

const BOT_SECRET = "test_chat_bot_secret";
const SESSION_SECRET = "test_session_secret_value";

const ALICE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const MALLORY = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const ORDERS = [
  { id: "o-a1", user_id: ALICE, receipt: "AP-AAAA1111", status: "shipped",
    total_paise: 44900, created_at: 1000, paid_at: 1001, shipped_at: 1002,
    courier: "Blue Dart", tracking_id: "BD123",
    cust_email: "alice@example.com", cust_phone: "9000090000",
    addr_line: "1 Alice Street", addr_city: "Pondicherry",
    rzp_payment_id: "pay_ALICE_SECRET" },
  { id: "o-m1", user_id: MALLORY, receipt: "AP-MMMM9999", status: "paid",
    total_paise: 99900, created_at: 2000, paid_at: 2001, shipped_at: null,
    courier: null, tracking_id: null,
    cust_email: "mallory@example.com", cust_phone: "9111111111",
    addr_line: "9 Mallory Lane", addr_city: "Chennai",
    rzp_payment_id: "pay_MALLORY_SECRET" },
];
const ITEMS = [
  { order_id: "o-a1", name: "Batman Figurine", qty: 1, pos: 0 },
  { order_id: "o-m1", name: "Spiderman Crouch", qty: 2, pos: 0 },
];

function ENV() {
  const run = (sql, a) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT id, receipt, status, total_paise, created_at, paid_at, shipped_at, courier, tracking_id FROM orders WHERE user_id = ?")) {
      const limit = a[1];
      return { results: ORDERS.filter((o) => o.user_id === a[0])
        .sort((x, y) => y.created_at - x.created_at).slice(0, limit) };
    }
    if (s.startsWith("SELECT order_id, name, qty FROM order_items")) {
      const want = new Set(a);
      return { results: ITEMS.filter((i) => want.has(i.order_id)) };
    }
    throw new Error("unhandled SQL: " + s.slice(0, 90));
  };
  return {
    CHAT_BOT_SECRET: BOT_SECRET,
    SESSION_SECRET,
    DB: {
      prepare(sql) {
        return { bind(...a) { this._a = a; return this; },
          async all() { return run(sql, this._a || []); } };
      },
    },
  };
}

const post = async (body, { secret = BOT_SECRET, sig = null } = {}) => {
  const raw = JSON.stringify(body);
  return new Request("http://x/api/chat/orders", {
    method: "POST",
    headers: { "x-chat-signature": sig ?? await hmacHex(raw, secret) },
    body: raw,
  });
};

const tokenFor = (id, purpose = "chat_lookup", ttl = 900) =>
  signToken(SESSION_SECRET, id, purpose, ttl);

// ══ THE CALLER MUST PROVE IT IS THE BOT ══════════════════════════
section("proof 1 — that the caller is the bot");
{
  const t = await tokenFor(ALICE);
  const raw = JSON.stringify({ token: t, ts: Date.now() });

  const noSig = new Request("http://x/api/chat/orders", { method: "POST", body: raw });
  ok("no signature → 401", (await read(await chatOrdersHandler(noSig, ENV())))[0] === 401);

  const wrongSig = await post({ token: t, ts: Date.now() }, { secret: "not_the_secret" });
  ok("signature from the wrong secret → 401",
     (await read(await chatOrdersHandler(wrongSig, ENV())))[0] === 401);

  const garbage = await post({ token: t, ts: Date.now() }, { sig: "deadbeef" });
  ok("garbage signature → 401",
     (await read(await chatOrdersHandler(garbage, ENV())))[0] === 401);

  // Fails CLOSED: an unconfigured Worker must not serve order history.
  const bare = await post({ token: t, ts: Date.now() });
  const [s503] = await read(await chatOrdersHandler(bare, { ...ENV(), CHAT_BOT_SECRET: "" }));
  ok("no bot secret configured → 503, not open", s503 === 503, String(s503));
}

// ══ AND PROVE WHICH CUSTOMER ═════════════════════════════════════
section("proof 2 — which customer, and only from a signed token");
{
  const env = ENV();
  const valid = await post({ token: await tokenFor(ALICE), ts: Date.now() });
  const [status, out] = await read(await chatOrdersHandler(valid, env));
  ok("200 for a good pair", status === 200, String(status));
  ok("returns Alice's order", out.orders.length === 1 && out.orders[0].receipt === "AP-AAAA1111",
     JSON.stringify(out.orders));

  // The whole point. A perfectly valid bot signature over a body naming Mallory's
  // order, receipt or email must not reach it — none of those select anything.
  for (const [label, body] of [
    ["a receipt in the body", { token: await tokenFor(ALICE), ts: Date.now(), receipt: "AP-MMMM9999" }],
    ["a user_id in the body", { token: await tokenFor(ALICE), ts: Date.now(), user_id: MALLORY }],
    ["an email in the body", { token: await tokenFor(ALICE), ts: Date.now(), email: "mallory@example.com" }],
    ["an order id in the body", { token: await tokenFor(ALICE), ts: Date.now(), id: "o-m1" }],
  ]) {
    const [, o] = await read(await chatOrdersHandler(await post(body), ENV()));
    const blob = JSON.stringify(o);
    ok(`${label} does not reach Mallory`,
       !blob.includes("MMMM9999") && !blob.includes("Spiderman") && !blob.includes("mallory"),
       blob);
  }

  // Only the token selects, so Mallory's token returns Mallory's order — proving
  // the isolation above is real scoping and not the fake DB returning nothing.
  const [, m] = await read(await chatOrdersHandler(
    await post({ token: await tokenFor(MALLORY), ts: Date.now() }), ENV()));
  ok("Mallory's own token returns Mallory's order",
     m.orders.length === 1 && m.orders[0].receipt === "AP-MMMM9999", JSON.stringify(m.orders));
}

section("the token must be the right token");
{
  for (const [label, tok] of [
    ["missing", ""],
    ["gibberish", "not-a-token"],
    ["tampered", (await tokenFor(ALICE)).slice(0, -1) + "x"],
    ["expired", await tokenFor(ALICE, "chat_lookup", -10)],
    // The session cookie is signed with the SAME secret. Purpose-binding is what
    // stops one being replayed as the other in either direction.
    ["minted for a customer session", await tokenFor(ALICE, "customer_session")],
    ["minted for an owner session", await tokenFor(ALICE, "owner_session")],
  ]) {
    const [status] = await read(await chatOrdersHandler(
      await post({ token: tok, ts: Date.now() }), ENV()));
    ok(`${label} token → 401`, status === 401, String(status));
  }
}

section("a captured request cannot be replayed forever");
{
  const stale = await post({ token: await tokenFor(ALICE), ts: Date.now() - 20 * 60 * 1000 });
  ok("20 minutes old → 401", (await read(await chatOrdersHandler(stale, ENV())))[0] === 401);
  const future = await post({ token: await tokenFor(ALICE), ts: Date.now() + 20 * 60 * 1000 });
  ok("20 minutes in the future → 401", (await read(await chatOrdersHandler(future, ENV())))[0] === 401);
}

// ══ WHAT LEAVES THE BUILDING ═════════════════════════════════════
section("the response is minimised — everything here goes to Groq");
{
  const [, out] = await read(await chatOrdersHandler(
    await post({ token: await tokenFor(ALICE), ts: Date.now() }), ENV()));
  const blob = JSON.stringify(out);
  const o = out.orders[0];

  ok("carries the receipt", o.receipt === "AP-AAAA1111");
  ok("carries the status", o.status === "shipped");
  ok("carries the items", o.items[0] === "Batman Figurine x1", JSON.stringify(o.items));
  ok("carries tracking when shipped", o.courier === "Blue Dart" && o.tracking_id === "BD123");

  // The model needs none of these to say where a parcel is, and all of them
  // would leave this infrastructure in order to say it.
  ok("NO delivery address", !blob.includes("Alice Street") && !blob.includes("addr"));
  ok("NO phone number", !blob.includes("9000090000") && !blob.includes("phone"));
  ok("NO payment id", !blob.includes("pay_ALICE_SECRET") && !blob.includes("rzp"));
  ok("NO internal order id", !blob.includes("o-a1"));
  ok("NO email", !blob.includes("alice@example.com"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
