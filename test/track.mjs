// Order tracking for guests: receipt + email/phone, and the emailed ?t= link.
// Real SQLite with every migration applied.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { trackLookup, trackByToken, trackPage, orderHtml } from "../src/track.js";
import { trackingUrlFor } from "../src/lib.js";

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
  });
  return { prepare: (sql) => wrap(sql) };
}
const db = new DatabaseSync(":memory:");
for (const f of readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) {
  db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
}
const env = { DB: d1(db) };
const T = (c) => c.repeat(32);
function order(id, o = {}) {
  const r = { receipt: "AP-" + id, status: "paid", email: "Surendra@Example.com", phone: "+91 94949-54548",
    token: T("a"), courier: null, tracking: null, ...o };
  db.prepare(`INSERT INTO orders (id, receipt, rzp_order_id, status, subtotal_paise, shipping_paise, total_paise, currency, delivery,
      cust_name, cust_email, cust_phone, addr_line, created_at, paid_at, pay_token, courier, tracking_id, shipped_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, r.receipt, "r" + id, r.status, 79900, 0, 79900, "INR", "ship",
      "Surendra", r.email, r.phone, "12 Secret Street", Date.now(), Date.now(), r.token, r.courier, r.tracking,
      ["shipped", "delivered"].includes(r.status) ? Date.now() : null);
  db.prepare(`INSERT INTO order_items (id, order_id, product_id, name, price_paise, qty, personalisation, pos) VALUES (?,?,?,?,?,?,?,?)`)
    .run("i" + id, id, null, "Ayyappan 1ft Gold Idol", 79900, 1, "Sabarimala <b>", 0);
}
order("dd5b35c7");
order("aaaaaaaa", { status: "shipped", token: T("b"), courier: "Blue Dart", tracking: "BD123" });
order("bbbbbbbb", { status: "pending", token: T("c") });
order("cccccccc", { status: "paid", token: T("d"), courier: "Blue Dart", tracking: "EARLY1" });
const look = async (receipt, contact) => { const r = await trackLookup(env, { receipt, contact }); return [r.status, await r.json()]; };

section("lookup needs the receipt AND the matching email or phone");
{
  let [st, b] = await look("AP-dd5b35c7", "surendra@example.com");
  ok("email, any case", st === 200 && b.order.receipt === "AP-dd5b35c7", JSON.stringify(b).slice(0, 120));
  [st] = await look("AP-dd5b35c7", "9494954548"); ok("phone, bare digits", st === 200);
  [st] = await look("AP-dd5b35c7", "09494 954 548"); ok("phone with 0 and spaces", st === 200);
  [st] = await look("ap-DD5B35C7", "+919494954548"); ok("receipt in any case", st === 200);
  [st] = await look(" AP-dd5b35c7 ", " surendra@example.com "); ok("surrounding spaces ignored", st === 200);

  const misses = [
    ["wrong email", "AP-dd5b35c7", "someone@else.com"],
    ["wrong phone", "AP-dd5b35c7", "9000000000"],
    ["receipt alone (blank contact)", "AP-dd5b35c7", ""],
    ["a partial email", "AP-dd5b35c7", "surendra"],
    ["short digits", "AP-dd5b35c7", "954548"],
    ["unknown receipt", "AP-00000000", "surendra@example.com"],
    ["malformed receipt", "AP-dd5b35c7' OR 1=1", "surendra@example.com"],
    ["an abandoned checkout", "AP-bbbbbbbb", "surendra@example.com"],
  ];
  const bodies = new Set();
  for (const [label, r, c] of misses) {
    const [s, body] = await look(r, c);
    bodies.add(JSON.stringify(body));
    ok(`${label}: 404`, s === 404, String(s));
  }
  ok("every miss gives the identical message (never says which half was wrong)", bodies.size === 1, [...bodies].join(" | "));
}

section("what a customer sees");
{
  const [, b] = await look("AP-dd5b35c7", "surendra@example.com");
  const o = b.order;
  const flat = JSON.stringify(o);
  ok("no address, email, phone or payment ids", !/Secret Street|example\.com|94949|rzp|pay_|cust_/i.test(flat), flat);
  ok("progress stages", Array.isArray(o.stages) && o.stages.some((s) => s.current));
  ok("items with personalisation", o.items[0].name === "Ayyappan 1ft Gold Idol" && o.items[0].personalisation === "Sabarimala <b>");
  ok("no tracking before it ships", o.tracking_id === null && o.courier === null);
  const [, early] = await look("AP-cccccccc", "surendra@example.com");
  ok("a tracking number typed in early stays hidden until shipped", early.order.tracking_id === null);
  ok("…and so does the courier", early.order.courier === null && early.order.tracking_url === null, JSON.stringify(early.order));
  const [, s] = await look("AP-aaaaaaaa", "9494954548");
  ok("shipped: courier, tracking and an allowlisted link", s.order.courier === "Blue Dart" && s.order.tracking_id === "BD123"
     && s.order.tracking_url === "https://www.bluedart.com/tracking?trackingNo=BD123", JSON.stringify(s.order));
  const html = orderHtml(o);
  ok("rendered page escapes customer text", html.includes("Sabarimala &lt;b&gt;") && !html.includes("<b>"));
  ok("free shipping shows as Free", html.includes(">Free<"));
}

section("the emailed ?t= link");
{
  ok("a valid token opens that order", (await trackByToken(env, T("a")))?.receipt === "AP-dd5b35c7");
  for (const t of [T("e"), "../x", T("A"), "", null]) ok(`token ${JSON.stringify(String(t).slice(0, 6))} opens nothing`, (await trackByToken(env, t)) === null);
  ok("an abandoned checkout's token opens nothing", (await trackByToken(env, T("c"))) === null);
  const res = await trackPage(env, new URL("https://x/track?t=" + T("b")));
  const page = await res.text();
  ok("page renders the order and its tracking", page.includes("Order AP-aaaaaaaa") && page.includes("BD123"));
  ok("an order page is noindex, no-store, no-referrer", /noindex/.test(res.headers.get("x-robots-tag") || "") && res.headers.get("cache-control") === "no-store" && res.headers.get("referrer-policy") === "no-referrer");
  const plain = await (await trackPage(env, new URL("https://x/track"))).text();
  ok("the bare form page is indexable", !plain.includes('content="noindex'));
}

section("the emails' View Order button");
{
  const { orderInProductionEmail } = await import("../src/emails.js");
  const env2 = { APP_BASE_URL: "https://3d-prints.aswincloud.com" };
  const link = (tok) => orderInProductionEmail(env2, { receipt: "AP-11111111", cust_name: "A", pay_token: tok }).match(/href="([^"]*\/track[^"]*)"/)?.[1];
  ok("a real token opens that order", link(T("a")) === "https://3d-prints.aswincloud.com/track?t=" + T("a"));
  for (const bad of ["../x", '"><script>', T("A"), null]) {
    ok(`token ${JSON.stringify(String(bad).slice(0, 8))} falls back to the plain form`, link(bad) === "https://3d-prints.aswincloud.com/track", link(bad));
  }
}

section("security headers keep a page's stricter referrer policy");
{
  const { withSecurityHeaders } = await import("../src/security.js");
  const page = await trackPage(env, new URL("https://x/track?t=" + T("b")));
  ok("an order page keeps no-referrer after the site headers", withSecurityHeaders(page).headers.get("referrer-policy") === "no-referrer");
  const loose = withSecurityHeaders(new Response("x", { headers: { "referrer-policy": "unsafe-url", "content-security-policy": "default-src *" } }));
  ok("a page cannot weaken it", loose.headers.get("referrer-policy") === "strict-origin-when-cross-origin");
  ok("…nor any other header", loose.headers.get("content-security-policy") !== "default-src *");
  ok("an ordinary page gets the site default", withSecurityHeaders(new Response("x")).headers.get("referrer-policy") === "strict-origin-when-cross-origin");
}

section("wiring");
{
  const sec = readFileSync(new URL("../src/security.js", import.meta.url), "utf8");
  ok("the lookup is rate limited", /"\/api\/track" && m === "POST", limiter: "RL_TRACK"/.test(sec));
  ok("…and the limiter exists", /name = "RL_TRACK"/.test(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8")));
  const home = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  ok("homepage footer and menu link to /track", (home.match(/href="\/track"/g) || []).length === 2);
  ok("emails no longer use the dead ?receipt= link", !readFileSync(new URL("../src/emails.js", import.meta.url), "utf8").includes("?receipt="));
}

{
  // DTDC's old dtdc.in/tracking.asp link now redirects to its homepage and
  // drops the number, so the customer lands nowhere. The current page reads ?awb=.
  ok("DTDC links to its current tracking page with the AWB",
     trackingUrlFor("DTDC", "C5000946201") === "https://www.dtdc.com/track-your-shipment/?awb=C5000946201",
     trackingUrlFor("DTDC", "C5000946201"));
  ok("…matched loosely", trackingUrlFor("dtdc courier", "C1") === "https://www.dtdc.com/track-your-shipment/?awb=C1");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
