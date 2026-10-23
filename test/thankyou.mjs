// /thank-you — the post-purchase page Google Ads counts a conversion on.
// Real SQLite with every migration applied.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { thankYouPage } from "../src/thankyou.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
function d1(db) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (sql) => wrap(sql) };
}
const db = new DatabaseSync(":memory:");
for (const f of readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) {
  db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
}
const env = { DB: d1(db) };
const T = (c) => c.repeat(32);
const order = (id, token, status, payId = null) => {
  db.prepare(`INSERT INTO orders (id, receipt, rzp_order_id, status, subtotal_paise, shipping_paise, total_paise, currency, delivery,
      cust_name, cust_email, cust_phone, created_at, pay_token, rzp_payment_id, discount_paise, coupon_code)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, "AP-" + id.padEnd(8, "0"), "r" + id, status, 54900, 0, 49400, "INR", "ship",
      "Surendra Reddy", "s@example.com", "9", Date.now(), token, payId, 5500, "WELCOME10");
  db.prepare(`INSERT INTO order_items (id, order_id, product_id, name, price_paise, qty, pos) VALUES (?,?,?,?,?,?,?)`)
    .run("i" + id, id, null, "Murugan <Box>", 54900, 1, 0);
};
order("aaaa1111", T("a"), "paid");
order("bbbb2222", T("b"), "pending", "pay_just_verified");
order("cccc3333", T("c"), "pending");
order("dddd4444", T("d"), "cancelled");
const get = async (q) => { const r = await thankYouPage(env, new URL("https://x/thank-you" + q)); return [r, await r.text()]; };

console.log("\nthank-you page");
{
  const [r, html] = await get("?t=" + T("a"));
  ok("paid order: thanks the customer by first name", html.includes("Thank you, Surendra!"));
  ok("shows the receipt", html.includes("AP-aaaa1111"));
  ok("shows the recorded total", html.includes("₹494"));
  ok("shows the coupon and free shipping", html.includes("WELCOME10") && html.includes(">Free<"));
  ok("item names are escaped", html.includes("Murugan &lt;Box&gt;") && !html.includes("<Box>"));
  ok("not cached, not indexed, no referrer", r.headers.get("cache-control") === "no-store" && /noindex/.test(r.headers.get("x-robots-tag")) && r.headers.get("referrer-policy") === "no-referrer");
}
{
  const [, html] = await get("?t=" + T("b"));
  ok("just verified (webhook still on its way): already a thank-you", html.includes("Thank you, Surendra!"));
}
for (const [label, q] of [["never paid", "?t=" + T("c")], ["cancelled", "?t=" + T("d")]]) {
  const [, html] = await get(q);
  ok(`${label}: no thank-you, offers to complete payment`, !html.includes("Thank you, Surendra") && html.includes("Payment not completed"), html.slice(0, 120));
}
for (const [label, q] of [["no token", ""], ["unknown token", "?t=" + T("e")], ["malformed token", "?t=../../x"], ["uppercase", "?t=" + T("A")]]) {
  const [r, html] = await get(q);
  ok(`${label}: generic page, reveals no order`, r.status === 200 && !html.includes("AP-") && !html.includes("Surendra"));
}

console.log("\nwiring");
{
  const orders = readFileSync(new URL("../src/orders.js", import.meta.url), "utf8");
  const v = orders.slice(orders.indexOf("export async function verifyOrderHandler"), orders.indexOf("export async function getOrderHandler"));
  ok("verify returns the thank-you link only after the signature check", v.indexOf("verifyCallbackSignature") < v.indexOf("thanks:") && v.includes("`/thank-you?t=${row.pay_token}`"));
  const main = readFileSync(new URL("../public/assets/js/main.js", import.meta.url), "utf8");
  ok("checkout goes there, only to a same-origin token path", main.includes("/^\\/thank-you\\?t=[0-9a-f]{32}$/.test(out.thanks)") && main.includes("location.replace(out.thanks)"));
  ok("the Worker serves it first", /"\/thank-you", "\/thank-you\/"/.test(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
