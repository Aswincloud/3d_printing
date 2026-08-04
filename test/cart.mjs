// Offline tests for the server-side cart.
//
// Invariant 9 is the one that matters: rows carry only (product_id, qty). If a
// price ever reached this table, priceCart() would stop being the single source
// of amounts, and a customer could edit their own cart into a cheaper charge.

import { getCart, putCart, mergeCart } from "../src/cart.js";
import { MAX_QTY } from "../src/shop.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const PRODUCTS = [
  { id: "p-small", name: "Kingfisher", price_paise: 34900, visible: 1 },
  { id: "p-large", name: "Elephant", price_paise: 89900, visible: 1 },
  { id: "p-hidden", name: "Spider-Man", price_paise: 54900, visible: 0 },
];
const USER = { id: "u-1", email: "a@example.com" };

function makeDB(cartRows = []) {
  const db = { products: PRODUCTS.map((p) => ({ ...p })), cart_items: cartRows.map((r) => ({ ...r })) };
  const run = (sql, a) => {
    const s = sql.replace(/\s+/g, " ").trim();

    if (s.startsWith("SELECT c.product_id, c.qty FROM cart_items c")) {
      const rows = db.cart_items
        .filter((r) => r.user_id === a[0])
        .filter((r) => db.products.some((p) => p.id === r.product_id && p.visible === 1))
        .sort((x, y) => x.updated_at - y.updated_at);
      return { results: rows.map((r) => ({ product_id: r.product_id, qty: r.qty })) };
    }
    if (s.startsWith("SELECT id FROM products WHERE visible = 1 AND id IN")) {
      const want = new Set(a);
      return { results: db.products.filter((p) => p.visible === 1 && want.has(p.id)).map((p) => ({ id: p.id })) };
    }
    if (s.startsWith("DELETE FROM cart_items WHERE user_id = ?")) {
      const n = db.cart_items.length;
      db.cart_items = db.cart_items.filter((r) => r.user_id !== a[0]);
      return { meta: { changes: n - db.cart_items.length } };
    }
    if (s.startsWith("INSERT INTO cart_items")) {
      db.cart_items.push({ user_id: a[0], product_id: a[1], qty: a[2], updated_at: a[3] });
      return { meta: { changes: 1 } };
    }
    throw new Error("unhandled SQL: " + s.slice(0, 100));
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
const envWith = (rows) => ({ DB: makeDB(rows) });
const read = async (res) => [res.status, await res.json()];

// ══ INVARIANT 9 ══════════════════════════════════════════════════
section("invariant 9 — the cart never stores a price");
{
  const env = envWith();
  await putCart(env, USER, {
    items: [{ product_id: "p-small", qty: 2, price_paise: 1, price: 1, name: "Free Sample", total: 1 }],
  });
  const row = env.DB._db.cart_items[0];
  ok("row has exactly the expected columns",
     Object.keys(row).sort().join(",") === "product_id,qty,updated_at,user_id",
     Object.keys(row).join(","));
  ok("no price_paise stored", !("price_paise" in row));
  ok("no name stored", !("name" in row));
  ok("qty is the one honoured", row.qty === 2);
  ok("nothing price-shaped anywhere in the table",
     !/price|amount|total/i.test(JSON.stringify(env.DB._db.cart_items)));
}

// ── read/write ────────────────────────────────────────────────────
section("PUT /api/me/cart");
{
  const env = envWith();
  const [status, out] = await read(await putCart(env, USER, {
    items: [{ product_id: "p-small", qty: 1 }, { product_id: "p-large", qty: 3 }],
  }));
  ok("200", status === 200);
  ok("returns both lines", out.items.length === 2);
  ok("quantities kept", out.items.find((i) => i.product_id === "p-large").qty === 3);

  // PUT replaces wholesale, so a shorter list must shrink the cart.
  const [, out2] = await read(await putCart(env, USER, { items: [{ product_id: "p-small", qty: 5 }] }));
  ok("replaces rather than merges", out2.items.length === 1);
  ok("new qty applied", out2.items[0].qty === 5);
}

section("PUT — bad input");
{
  for (const [label, body] of [
    ["missing items", {}],
    ["items not an array", { items: { product_id: "p-small", qty: 1 } }],
    ["items is a string", { items: "p-small" }],
    ["null items", { items: null }],
  ]) {
    ok(`${label} → 400`, (await read(await putCart(envWith(), USER, body)))[0] === 400);
  }
  // Malformed LINES are dropped rather than failing the request: a stale browser
  // cart shouldn't 400 the whole sync.
  const env = envWith();
  const [status, out] = await read(await putCart(env, USER, {
    items: [
      { product_id: "p-small", qty: 1 },
      { product_id: "", qty: 5 },
      { product_id: "p-large", qty: 0 },
      { product_id: "p-large", qty: "abc" },
      { qty: 3 },
      null,
    ],
  }));
  ok("200 despite malformed lines", status === 200);
  ok("only the valid line survives", out.items.length === 1 && out.items[0].product_id === "p-small");
}

section("PUT — hidden and unknown products are dropped");
{
  const env = envWith();
  const [, out] = await read(await putCart(env, USER, {
    items: [
      { product_id: "p-small", qty: 1 },
      { product_id: "p-hidden", qty: 1 },
      { product_id: "does-not-exist", qty: 1 },
    ],
  }));
  ok("only the visible product is kept", out.items.length === 1);
  ok("it is the right one", out.items[0].product_id === "p-small");
  ok("hidden product not stored", !env.DB._db.cart_items.some((r) => r.product_id === "p-hidden"));
}

section("PUT — quantity caps");
{
  const env = envWith();
  const [, out] = await read(await putCart(env, USER, { items: [{ product_id: "p-small", qty: MAX_QTY + 50 }] }));
  ok(`qty clamped to ${MAX_QTY}`, out.items[0].qty === MAX_QTY, String(out.items[0].qty));

  // Duplicate lines sum, then clamp.
  const env2 = envWith();
  const [, out2] = await read(await putCart(env2, USER, {
    items: [{ product_id: "p-small", qty: 60 }, { product_id: "p-small", qty: 60 }],
  }));
  ok("duplicates collapse to one line", out2.items.length === 1);
  ok("summed then clamped", out2.items[0].qty === MAX_QTY, String(out2.items[0].qty));

  // Too many distinct lines.
  const many = Array.from({ length: 60 }, (_, i) => ({ product_id: `p-${i}`, qty: 1 }));
  ok("more than 50 distinct lines → 400",
     (await read(await putCart(envWith(), USER, { items: many })))[0] === 400);
}

// ── merge ─────────────────────────────────────────────────────────
section("POST /api/me/cart/merge");
{
  // Guest cart merges INTO whatever the account already has: two on the phone
  // plus one on the laptop should be three, not one overwriting the other.
  const env = envWith([
    { user_id: USER.id, product_id: "p-small", qty: 2, updated_at: 1 },
  ]);
  const [status, out] = await read(await mergeCart(env, USER, {
    items: [{ product_id: "p-small", qty: 1 }, { product_id: "p-large", qty: 4 }],
  }));
  ok("200", status === 200);
  ok("existing + incoming summed", out.items.find((i) => i.product_id === "p-small").qty === 3,
     JSON.stringify(out.items));
  ok("new product added", out.items.find((i) => i.product_id === "p-large").qty === 4);
  ok("two lines total", out.items.length === 2);
  ok("reports how many incoming lines", out.merged === 2);
}

section("merge — caps and filtering still apply");
{
  const env = envWith([{ user_id: USER.id, product_id: "p-small", qty: 90, updated_at: 1 }]);
  const [, out] = await read(await mergeCart(env, USER, { items: [{ product_id: "p-small", qty: 50 }] }));
  ok("sum clamped at MAX_QTY", out.items[0].qty === MAX_QTY, String(out.items[0].qty));

  const env2 = envWith();
  const [, out2] = await read(await mergeCart(env2, USER, {
    items: [{ product_id: "p-hidden", qty: 1 }, { product_id: "nope", qty: 1 }],
  }));
  ok("hidden and unknown dropped on merge", out2.items.length === 0);

  ok("merge with a non-array → 400",
     (await read(await mergeCart(envWith(), USER, { items: "x" })))[0] === 400);
  // An empty guest cart must not wipe the account cart.
  const env3 = envWith([{ user_id: USER.id, product_id: "p-small", qty: 2, updated_at: 1 }]);
  const [, out3] = await read(await mergeCart(env3, USER, { items: [] }));
  ok("empty merge preserves the existing cart", out3.items.length === 1 && out3.items[0].qty === 2);
}

section("carts are per-user");
{
  const env = envWith([
    { user_id: USER.id, product_id: "p-small", qty: 2, updated_at: 1 },
    { user_id: "u-2", product_id: "p-large", qty: 7, updated_at: 1 },
  ]);
  const [, mine] = await read(await getCart(env, USER));
  ok("only my rows returned", mine.items.length === 1 && mine.items[0].product_id === "p-small");

  // Writing my cart must not touch anyone else's.
  await putCart(env, USER, { items: [{ product_id: "p-large", qty: 1 }] });
  const other = env.DB._db.cart_items.filter((r) => r.user_id === "u-2");
  ok("another user's cart untouched", other.length === 1 && other[0].qty === 7);
}

section("hidden-since products disappear from an existing cart");
{
  // Somebody had it in their cart, then it was unlisted. It must not still show.
  const env = envWith([{ user_id: USER.id, product_id: "p-hidden", qty: 1, updated_at: 1 }]);
  const [, out] = await read(await getCart(env, USER));
  ok("unlisted product not returned", out.items.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
