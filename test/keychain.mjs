// Custom name keychains: a design rides in the cart as its own id, and the
// server decodes, validates and prices it. Real SQLite with every migration.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { designId, parseDesign, validDesign, designPrice, designSummary, PRICE_ONE_PAISE, PRICE_TWO_PAISE, TEXT_RE, FONTS, STYLES } from "../src/keychain.js";
import { priceCart } from "../src/shop.js";

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
function setup({ keychain = true } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  }
  if (keychain) db.prepare(`INSERT INTO products (id, slug, name, price_paise, image, visible, created_at, updated_at) VALUES ('kc1','custom-name-keychain','Custom Name Keychain',19900,'a.jpg',1,1,1)`).run();
  db.prepare(`INSERT INTO products (id, slug, name, price_paise, image, visible, created_at, updated_at) VALUES ('p1','box','Murugan Box',54900,'b.jpg',1,1,1)`).run();
  return { db, env: { DB: d1(db), FLAT_SHIP_PAISE: "0", FREE_SHIP_THRESHOLD_PAISE: "200000" } };
}

section("design ids");
{
  const a = designId({ text: "ASWIN", font: "script", base: "red", ink: "red" });
  ok("a design has a stable id", a === designId({ text: "  ASWIN ", font: "script", base: "red" }), a);
  ok("…which parses back to the same design", JSON.stringify(parseDesign(a)) === '{"text":"ASWIN","font":"script","base":"red","ink":"red","style":"heart","accent":"red"}');
  ok("different names are different ids", a !== designId({ text: "PRIYA", font: "script", base: "red" }));
  for (const [label, d] of [
    ["empty text", { text: "  ", font: "script", base: "red" }],
    ["13 characters", { text: "ABCDEFGHIJKLM", font: "script", base: "red" }],
    ["markup", { text: "<b>x</b>", font: "script", base: "red" }],
    ["an unknown font", { text: "A", font: "comic", base: "red" }],
    ["a retired font (bold, before 2026-11-02)", { text: "A", font: "bold", base: "red" }],
    ["an unknown colour", { text: "A", font: "script", base: "purple" }],
    ["an unknown text colour", { text: "A", font: "script", base: "red", ink: "silver" }],
    ["a prototype key as a font", { text: "A", font: "toString", base: "red" }],
  ]) ok(`refused: ${label}`, validDesign(d) === null && designId(d) === null);
  ok("12 characters is the limit and allowed", validDesign({ text: "ABCDEFGHIJKL", font: "script", base: "red" }) !== null);
}

section("a hand-crafted id is refused");
{
  const enc = (arr) => "kc~" + Buffer.from(JSON.stringify(arr)).toString("base64url");
  for (const [label, id] of [
    ["not base64", "kc~!!!!"],
    ["not JSON", "kc~" + Buffer.from("hello").toString("base64url")],
    ["an extra field (a price)", enc(["ASWIN", "script", "red", "red", 1])],
    ["an object instead of an array", enc({ text: "ASWIN" })],
    ["markup inside", enc(["<img src=x>", "script", "red", "red"])],
    ["a non-canonical spelling (padding, spaces)", enc([" ASWIN ", "script", "red", "red"])],
    ["far too long", "kc~" + "A".repeat(300)],
  ]) ok(`refused: ${label}`, parseDesign(id) === null);
}

section("pricing: one colour ₹199, two colours ₹299 — from the rule, never the id");
{
  const one = { text: "ASWIN", font: "script", base: "red", ink: "red" };
  const two = { text: "PRIYA", font: "brush", base: "blue", ink: "gold" };
  ok("one colour", designPrice(validDesign(one)) === PRICE_ONE_PAISE && PRICE_ONE_PAISE === 19900);
  ok("two colours", designPrice(validDesign(two)) === PRICE_TWO_PAISE && PRICE_TWO_PAISE === 29900);
  ok("summary reads for the owner", designSummary(validDesign(two)) === '"PRIYA" · Brush font · Blue base, Gold text', designSummary(validDesign(two)));
  ok("one-colour summary", designSummary(validDesign(one)) === '"ASWIN" · Script font · Red, one colour');
}

section("priceCart: designs as their own lines, through the real pricing code");
{
  const { env } = setup();
  const a = designId({ text: "ASWIN", font: "script", base: "red" });
  const b = designId({ text: "PRIYA", font: "brush", base: "blue", ink: "gold" });
  const r = await priceCart(env, [{ product_id: a, qty: 2 }, { product_id: b, qty: 1 }, { product_id: "p1", qty: 1 }], "ship");
  ok("priced", !r.error, r.error);
  ok("three lines (two designs + a product)", r.items?.length === 3, JSON.stringify(r.items?.map((i) => i.product_id)));
  ok("subtotal = 2×199 + 299 + 549", r.subtotal_paise === 2 * 19900 + 29900 + 54900, String(r.subtotal_paise));
  const kc = r.items.filter((i) => i.product_id === "kc1");
  ok("design lines record the REAL keychain product id", kc.length === 2);
  ok("…with the design to print", kc.some((i) => i.personalisation === '"ASWIN" · Script font · Red, one colour' && i.qty === 2 && i.price_paise === 19900)
     && kc.some((i) => i.personalisation === '"PRIYA" · Brush font · Blue base, Gold text' && i.price_paise === 29900), JSON.stringify(kc));
  ok("the same design twice adds up on one line", (await priceCart(env, [{ product_id: a, qty: 1 }, { product_id: a, qty: 3 }], "ship")).items[0].qty === 4);
}
{
  const { env } = setup();
  const bad = "kc~" + Buffer.from(JSON.stringify(["ASWIN", "script", "red", "red", 1])).toString("base64url");
  const r = await priceCart(env, [{ product_id: bad, qty: 1 }], "ship");
  ok("a tampered design refuses the whole cart", Boolean(r.error) && !r.items, JSON.stringify(r));
  const r2 = await priceCart(env, [{ product_id: designId({ text: "A", font: "script", base: "red" }), qty: 1, price_paise: 1 }], "ship");
  ok("a price sent from the browser is ignored", r2.subtotal_paise === 19900);
  const off = setup({ keychain: false });
  const r3 = await priceCart(off.env, [{ product_id: designId({ text: "A", font: "script", base: "red" }), qty: 1 }], "ship");
  ok("no keychain product at all → refused", Boolean(r3.error), JSON.stringify(r3));
  // Hiding the product in the dashboard must switch the designer off, and an
  // unpriced (0) row must never sell keychains at ₹199 off a rule.
  const hid = setup(); hid.db.exec("UPDATE products SET visible = 0 WHERE slug = 'custom-name-keychain'");
  ok("a HIDDEN keychain product → refused", Boolean((await priceCart(hid.env, [{ product_id: designId({ text: "A", font: "script", base: "red" }), qty: 1 }], "ship")).error));
  const unp = setup(); unp.db.exec("UPDATE products SET price_paise = 0 WHERE slug = 'custom-name-keychain'");
  ok("an UNPRICED keychain product → refused", Boolean((await priceCart(unp.env, [{ product_id: designId({ text: "A", font: "script", base: "red" }), qty: 1 }], "ship")).error));
  // The keychain product bought directly is a BLANK keychain: refused, alone or
  // alongside a real design.
  const blank = await priceCart(env, [{ product_id: "kc1", qty: 1 }], "ship");
  ok("the bare keychain product alone → refused", Boolean(blank.error) && /designer/.test(blank.error), JSON.stringify(blank));
  const mixed = await priceCart(env, [{ product_id: "kc1", qty: 1 }, { product_id: designId({ text: "A", font: "script", base: "red" }), qty: 1 }], "ship");
  ok("…and alongside a design → refused", Boolean(mixed.error));
  const r4 = await priceCart(env, [{ product_id: "p1", qty: 1 }], "ship");
  ok("an ordinary cart is unaffected", !r4.error && r4.subtotal_paise === 54900);
}

section("every allowed character has a glyph in every font (else the preview shows '?')");
{
  const probe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&.-'!";
  // Every char the rule accepts, from the probe set plus anything it allows.
  const allowed = [...probe].filter((c) => TEXT_RE.test(c));
  ok("the rule accepts exactly the probe set", allowed.length === probe.length, allowed.join(""));
  ok("♥ is not allowed (no font has it)", !TEXT_RE.test("♥"));
  for (const [k, { file }] of Object.entries(FONTS)) {
    const glyphs = JSON.parse(readFileSync(new URL(`../public/assets/fonts3d/${file}`, import.meta.url), "utf8")).glyphs;
    const missing = allowed.filter((c) => !glyphs[c]);
    ok(`font ${k} draws every allowed character`, missing.length === 0, missing.join(""));
  }
  const js = readFileSync(new URL("../public/assets/js/keychain.js", import.meta.url), "utf8");
  ok("the designer uses the same rule", js.includes("const TEXT_RE = /^[A-Za-z0-9 &.\\-'!]+$/u;"));
}

section("styles");
{
  const old = designId({ text: "ASWIN", font: "script", base: "red" });
  const heart = designId({ text: "ASWIN", font: "script", base: "red", style: "heart" });
  ok("a heart design keeps the original 4-field id (old carts still match)", old === heart && JSON.parse(Buffer.from(old.slice(3), "base64url")).length === 4);
  const b = designId({ text: "Priya", font: "script", base: "white", ink: "pink", style: "bubble" });
  ok("another style's id round-trips", parseDesign(b)?.style === "bubble" && parseDesign(b)?.text === "Priya");
  ok("an unknown style is refused", designId({ text: "A", font: "script", base: "red", style: "spaceship" }) === null);
  const enc = (a) => "kc~" + Buffer.from(JSON.stringify(a)).toString("base64url");
  ok("a hand-made id with an unknown style is refused", parseDesign(enc(["A", "script", "red", "red", "spaceship", "red"])) === null);
  ok("5 fields is refused", parseDesign(enc(["A", "script", "red", "red", "bubble"])) === null);
  ok("a style with no accent part ignores a sent accent (no hidden third colour)",
     parseDesign(designId({ text: "A", font: "script", base: "red", style: "bubble", accent: "gold" }))?.accent === "red");
  ok("…and a hand-made id claiming one is refused, not coerced",
     parseDesign(enc(["A", "script", "red", "red", "bubble", "gold"])) === null);
  const tri = validDesign({ text: "A", font: "script", base: "white", ink: "pink", style: "charm", accent: "gold" });
  ok("three colours price as multi-colour (₹299)", designPrice(tri) === PRICE_TWO_PAISE);
  ok("an accent alone makes it multi-colour", designPrice(validDesign({ text: "A", font: "script", base: "white", style: "charm", accent: "gold" })) === PRICE_TWO_PAISE);
  ok("one colour in any style is ₹199", Object.keys(STYLES).every((s) => designPrice(validDesign({ text: "A", font: "script", base: "red", style: s })) === PRICE_ONE_PAISE));
  ok("the summary names style and every colour", designSummary(tri) === '"A" · Flower charm · Script font · White base, Pink text, Gold flower', designSummary(tri));
}

section("the browser's design id matches the server's");
{
  const js = readFileSync(new URL("../public/assets/js/keychain.js", import.meta.url), "utf8");
  // Run the designer's own designId (lifted out of the module) against the
  // server's, for every style: a mismatch would make every cart line invalid.
  const src = js.slice(js.indexOf("function designId(d) {"), js.indexOf("\n}\n", js.indexOf("function designId(d) {")) + 2);
  const browserId = new Function(`${src}; return designId;`)();
  const { STYLES: SERVER_STYLES } = await import("../src/keychain.js");
  for (const style of Object.keys(SERVER_STYLES)) {
    const d = validDesign({ text: "Priya", font: "script", base: "blue", ink: "gold", style, accent: "pink" });
    ok(`designer and server agree on the id (${style})`, browserId(d) === designId(d), `${browserId(d)} vs ${designId(d)}`);
  }
  for (const k of ["white", "black", "brown", "gold", "orange", "blue", "red", "green", "pink", "skin"]) ok(`colour ${k} offered in the designer`, js.includes(`${k}: [`));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
