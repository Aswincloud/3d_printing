// Seasonal sales on a calendar: DIWALI26 (Nov) → NEWYEAR27 (Dec) → PONGAL27 (Jan),
// each live only in its own window. Real SQLite with every migration applied;
// the clock is moved with Date.now so the dates are exercised, not assumed.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { featuredPromo, salesCalendar, saleGift } from "../src/shop.js";
import { offerParts } from "../src/seo.js";
import { applyCoupon } from "../src/coupons.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);
function d1(db) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (sql) => wrap(sql) };
}
const IST = (s) => Date.parse(s + "+05:30");
const NOV30_END = IST("2026-11-30T23:59:59.999"), DEC1 = IST("2026-12-01T00:00:00"), DEC31_END = IST("2026-12-31T23:59:59.999");
const JAN1 = IST("2027-01-01T00:00:00"), JAN31_END = IST("2027-01-31T23:59:59.999");
function setup() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  }
  const ins = db.prepare(`INSERT INTO coupons (id, code, kind, value, min_order_paise, max_discount_paise, starts_at, expires_at, uses, max_uses, once_per_customer, active, occasion, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,1)`);
  ins.run("c1", "DIWALI26", "percent", 26, 0, 10000, null, NOV30_END, 0, null, 1, 1, "🪔 Diwali deals");
  ins.run("c2", "NEWYEAR27", "percent", 27, 0, 10000, DEC1, DEC31_END, 0, null, 1, 1, "🎉 New Year sale");
  ins.run("c3", "PONGAL27", "percent", 27, 0, 10000, JAN1, JAN31_END, 0, null, 1, 1, "🌾 Pongal sale");
  ins.run("c4", "WELCOME10", "percent", 10, 0, 10000, null, null, 3, null, 1, 0, null);
  ins.run("c5", "SECRET50", "percent", 50, 0, null, DEC1, null, 0, null, 0, 1, null);
  return { db, env: { DB: d1(db), PROMO_CODE: "WELCOME10" } };
}
const realNow = Date.now;
const at = (t) => { Date.now = () => t; };

section("the featured sale follows the calendar");
{
  const { env } = setup();
  for (const [when, t, want] of [
    ["1 Nov", IST("2026-11-01T10:00:00"), "DIWALI26"],
    ["30 Nov, last minute", IST("2026-11-30T23:59:00"), "DIWALI26"],
    ["1 Dec, just after midnight", IST("2026-12-01T00:00:30"), "NEWYEAR27"],
    ["31 Dec", IST("2026-12-31T22:00:00"), "NEWYEAR27"],
    ["1 Jan", IST("2027-01-01T09:00:00"), "PONGAL27"],
    ["1 Feb (all over, WELCOME10 paused)", IST("2027-02-01T09:00:00"), null],
  ]) {
    at(t);
    const p = await featuredPromo(env);
    ok(`${when}: ${want || "nothing"}`, (p?.code ?? null) === want, p?.code);
  }
  at(IST("2026-12-05T12:00:00"));
  const p = await featuredPromo(env);
  ok("the sale carries its own occasion label", p.label === "🎉 New Year sale" && p.value === 27 && p.max_discount_paise === 10000 && p.once_per_customer === true, JSON.stringify(p));
}
{
  const { db, env } = setup();
  db.exec("UPDATE coupons SET active = 1 WHERE code = 'WELCOME10'");
  at(IST("2027-02-10T09:00:00"));
  ok("after the sales, PROMO_CODE (WELCOME10) is featured again", (await featuredPromo(env))?.code === "WELCOME10");
  at(IST("2026-11-10T09:00:00"));
  ok("…but a live sale takes precedence over it", (await featuredPromo(env))?.code === "DIWALI26");
  db.exec("UPDATE coupons SET active = 0 WHERE code = 'DIWALI26'");
  ok("a paused sale steps aside for PROMO_CODE", (await featuredPromo(env))?.code === "WELCOME10");
}

section("two sales live at once: the one ending soonest is featured");
{
  const { db, env } = setup();
  // A flash sale inside December that ends before NEWYEAR27 does.
  db.prepare(`INSERT INTO coupons (id, code, kind, value, min_order_paise, max_discount_paise, starts_at, expires_at, uses, once_per_customer, active, occasion, created_at, updated_at)
    VALUES ('c9','XMAS15','percent',15,0,null,?,?,0,1,1,'🎄 Christmas flash',1,1)`).run(IST("2026-12-24T00:00:00"), IST("2026-12-25T23:59:59"));
  at(IST("2026-12-24T12:00:00"));
  ok("XMAS15 (ends 25 Dec) beats NEWYEAR27 (ends 31 Dec)", (await featuredPromo(env))?.code === "XMAS15");
  at(IST("2026-12-26T12:00:00"));
  ok("after it ends, NEWYEAR27 again", (await featuredPromo(env))?.code === "NEWYEAR27");
}

section("each start-date check stands on its own");
{
  // The SQL filter and the JS check both refuse a not-yet-started sale. Each is
  // proved alone: (1) a fake SELECT that ignores the WHERE and returns only the
  // future NEWYEAR27, so only the JS check stands; (2) the SQL run directly.
  const { db, env } = setup();
  at(IST("2026-11-15T12:00:00"));
  let used = 0;
  const flat = (q) => q.replace(/\s+/g, " ");
  const onlyFuture = { ...env, PROMO_CODE: "", DB: { prepare: (sql) => {
    if (flat(sql).includes("FROM coupons WHERE occasion IS NOT NULL") && flat(sql).includes("starts_at <= ?")) {
      return { bind: () => ({ all: async () => { used++; return { results: db.prepare("SELECT * FROM coupons WHERE code = 'NEWYEAR27'").all() }; } }) };
    }
    return env.DB.prepare(sql);
  } } };
  const p = await featuredPromo(onlyFuture);
  ok("the JS check alone refuses a not-yet-started sale", used === 1 && p === null, `used=${used} got=${p?.code}`);
  const rows = db.prepare(`SELECT code FROM coupons WHERE occasion IS NOT NULL AND occasion != '' AND active = 1
      AND (starts_at IS NULL OR starts_at <= ?) AND (expires_at IS NULL OR expires_at > ?)`).all(Date.now(), Date.now());
  const src = flat(readFileSync(new URL("../src/shop.js", import.meta.url), "utf8"));
  ok("the SQL alone filters a not-yet-started sale (and is the query featuredPromo runs)",
     !rows.some((r) => r.code === "NEWYEAR27") && src.includes("AND (starts_at IS NULL OR starts_at <= ?) AND (expires_at IS NULL OR expires_at > ?)"));
}

section("checkout refuses a sale before it starts — with the unknown-code message");
{
  const { env } = setup();
  at(IST("2026-11-15T12:00:00"));
  const early = await applyCoupon(env, "NEWYEAR27", 54900, "a@example.com");
  const unknown = await applyCoupon(env, "NOSUCHCODE", 54900, "a@example.com");
  ok("NEWYEAR27 in November is refused", Boolean(early.error), JSON.stringify(early));
  ok("…with exactly the unknown-code message", early.error === unknown.error, early.error);
  ok("an unannounced future code is refused the same way", (await applyCoupon(env, "SECRET50", 54900, "a@example.com")).error === unknown.error);
  at(IST("2026-12-01T00:00:30"));
  const live = await applyCoupon(env, "NEWYEAR27", 54900, "a@example.com");
  ok("NEWYEAR27 on 1 Dec: 27% capped at ₹100", live.discount_paise === 10000, JSON.stringify(live));
  ok("DIWALI26 on 1 Dec has expired", Boolean((await applyCoupon(env, "DIWALI26", 54900, "a@example.com")).error));
}

section("the Offers menu lists live and upcoming sales, labelled ones only");
{
  const { env } = setup();
  at(IST("2026-11-15T12:00:00"));
  const cal = await salesCalendar(env);
  ok("three sales, soonest first", cal.map((x) => x.code).join(",") === "DIWALI26,NEWYEAR27,PONGAL27", cal.map((x) => x.code).join(","));
  ok("only DIWALI26 is live", cal.map((x) => x.live).join(",") === "true,false,false");
  ok("upcoming ones carry their dates", cal[1].starts_at === DEC1 && cal[1].expires_at === DEC31_END);
  ok("unlabelled codes are never listed (WELCOME10, SECRET50)", !cal.some((x) => ["WELCOME10", "SECRET50"].includes(x.code)));
  at(IST("2026-12-10T12:00:00"));
  ok("in December: Diwali gone, New Year live, Pongal upcoming", (await salesCalendar(env)).map((x) => `${x.code}:${x.live}`).join(",") === "NEWYEAR27:true,PONGAL27:false");
  at(IST("2027-02-10T12:00:00"));
  ok("after January: nothing to list", (await salesCalendar(env)).length === 0);
}
{
  const { db, env } = setup();
  db.exec("UPDATE coupons SET active = 0 WHERE code = 'PONGAL27'");
  const pid = db.prepare("SELECT id FROM products LIMIT 1").get().id;
  db.prepare("INSERT INTO coupon_products (coupon_id, product_id) VALUES ('c2', ?)").run(pid);
  at(IST("2026-11-15T12:00:00"));
  const codes = (await salesCalendar(env)).map((x) => x.code);
  ok("a paused sale is not listed", !codes.includes("PONGAL27"));
  ok("a product-scoped sale is not listed (not storewide)", !codes.includes("NEWYEAR27"), codes.join(","));
}
section("the Diwali free gift: amount paid of ₹999 and above, only while the sale is live");
{
  const { db, env } = setup();
  db.exec("UPDATE coupons SET gift_min_paise = 99900, gift_text = 'a free 3D-printed surprise gift' WHERE code = 'DIWALI26'");
  at(IST("2026-11-15T12:00:00"));
  ok("₹999 exactly earns it", (await saleGift(env, 99900)) === "a free 3D-printed surprise gift");
  ok("₹998 does not", (await saleGift(env, 99800)) === null);
  ok("₹12,099 does", (await saleGift(env, 1209900)) === "a free 3D-printed surprise gift");
  const p = await featuredPromo(env);
  ok("the featured promo carries the gift", p.gift?.min_paise === 99900 && p.gift?.text === "a free 3D-printed surprise gift", JSON.stringify(p.gift));
  ok("homepage gift line", offerParts(p).gift === "🎁 Orders of ₹999 and above get a free 3D-printed surprise gift", offerParts(p).gift);
  ok("the Offers menu lists it with the sale", (await salesCalendar(env))[0].gift?.min_paise === 99900);
  at(IST("2026-12-01T00:00:30"));
  ok("1 Dec: Diwali is over, so no gift (New Year has none)", (await saleGift(env, 500000)) === null);
  ok("…and no gift line", offerParts(await featuredPromo(env)).gift === "");
  db.exec("UPDATE coupons SET gift_text = '   ' WHERE code = 'DIWALI26'");
  at(IST("2026-11-15T12:00:00"));
  ok("a blank gift text is no gift", (await saleGift(env, 500000)) === null);
  // A gift on a plain fallback code (no occasion) is not a sale's gift.
  db.exec("UPDATE coupons SET gift_text = 'a free 3D-printed surprise gift', active = 0 WHERE code = 'DIWALI26'");
  db.exec("UPDATE coupons SET active = 1, gift_min_paise = 99900, gift_text = 'a mug' WHERE code = 'WELCOME10'");
  ok("WELCOME10 (featured, but not a sale) gives no gift", (await featuredPromo(env))?.code === "WELCOME10" && (await saleGift(env, 500000)) === null);
}

Date.now = realNow;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
