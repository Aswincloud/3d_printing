// The listing agent's credential — what it may do, and everything it may not.
//
// This is an authorisation boundary on a live shop, so the tests are written from
// the attacker's side: the interesting assertions are all NEGATIVE. A token that can
// create listings is only useful if it provably cannot do the twenty other things
// the owner session can, and "we only call it from two places" is not a control.
//
//   node test/agent.mjs
import { agentVerdict, checkAgentEntries, checkDescribeEntries, AGENT_ROUTES,
         AGENT_LIMITS, MIN_TOKEN_LENGTH, CATEGORIES } from "../src/agent.js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const TOKEN = "x".repeat(20) + "-a-perfectly-fine-length-token";
const env = { AGENT_TOKEN: TOKEN };
const req = (token) => new Request("https://x/", {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});
const verdict = (path, { method = "POST", token = TOKEN, e = env } = {}) =>
  agentVerdict(req(token), e, method, path);

console.log("\nthe two routes the token exists for");
ok("POST /api/admin/products/batch → agent",
   await verdict("/api/admin/products/batch") === "agent");
ok("GET /api/admin/products/unlisted → agent",
   await verdict("/api/admin/products/unlisted", { method: "GET" }) === "agent");

console.log("\nEVERYTHING else under /api/admin/ is refused");
// The list is deliberately long and concrete. Each line is a capability the owner
// session has that this token must not: editing live prices, reading customer
// orders, moving money, minting discounts.
for (const [m, p, why] of [
  // Bulk now sets descriptions as well as prices, so this line guards more than it
  // used to: the agent's describe route can only fill a BLANK description, while
  // this one overwrites any of them.
  ["PATCH",  "/api/admin/products",              "bulk price/visibility/description edit over EXISTING rows"],
  ["POST",   "/api/admin/products",              "single create, no manifest check"],
  ["GET",    "/api/admin/products",              "full product list"],
  ["DELETE", "/api/admin/products/abc",          "delete a product"],
  ["PATCH",  "/api/admin/products/abc",          "edit one product"],
  ["POST",   "/api/admin/products/hide",         "hide existing products"],
  ["GET",    "/api/admin/orders",                "customer orders and addresses"],
  ["PATCH",  "/api/admin/orders/abc",            "change an order"],
  ["POST",   "/api/admin/orders/abc/refund",     "move money"],
  ["GET",    "/api/admin/stats",                 "revenue"],
  ["GET",    "/api/admin/coupons",               "coupons"],
  ["POST",   "/api/admin/coupons",               "mint a coupon"],
  ["PATCH",  "/api/admin/coupons/abc",           "edit a coupon"],
  ["GET",    "/api/admin/customers",             "customer list"],
]) {
  ok(`${m} ${p} → forbidden (${why})`, await verdict(p, { method: m }) === "forbidden");
}

console.log("\nmethod is part of the identity of a route");
// GET on the batch path and POST on the unlisted path are both off-list. A rule
// keyed on path alone would let PATCH /api/admin/products through on the strength of
// the batch route's prefix, which is the bulk editor.
ok("GET on the batch route → forbidden",
   await verdict("/api/admin/products/batch", { method: "GET" }) === "forbidden");
ok("POST on the unlisted route → forbidden",
   await verdict("/api/admin/products/unlisted", { method: "POST" }) === "forbidden");
ok("no allowlist entry is a bare prefix of an admin route",
   [...AGENT_ROUTES].every((r) => r.split(" ")[1].split("/").length >= 5),
   [...AGENT_ROUTES].join(","));

console.log("\nbad or missing credentials are anonymous, not forbidden");
// 'anonymous' becomes a 401 and 'forbidden' a 403. A wrong token must NOT get a 403,
// because the difference between the two answers would tell an attacker which of the
// token and the route they got right.
ok("no Authorization header → anonymous",
   await verdict("/api/admin/products/batch", { token: null }) === "anonymous");
ok("wrong token on an ALLOWED route → anonymous, not agent",
   await verdict("/api/admin/products/batch", { token: "y".repeat(50) }) === "anonymous");
ok("wrong token on a FORBIDDEN route → anonymous, not forbidden",
   await verdict("/api/admin/orders", { method: "GET", token: "y".repeat(50) }) === "anonymous");
ok("a token that is a prefix of the real one is refused",
   await verdict("/api/admin/products/batch", { token: TOKEN.slice(0, -1) }) === "anonymous");
ok("a token with the real one as a prefix is refused",
   await verdict("/api/admin/products/batch", { token: TOKEN + "z" }) === "anonymous");
ok("empty Bearer value is refused",
   await verdict("/api/admin/products/batch", { token: "   " }) === "anonymous");

console.log("\nunset or weak AGENT_TOKEN fails closed");
// The trap this mirrors: an unset OWNER_EMAIL would have made the dashboard public.
// An unset AGENT_TOKEN must never mean "every bearer token is the agent".
for (const [label, e] of [
  ["unset",        {}],
  ["empty string", { AGENT_TOKEN: "" }],
  ["undefined",    { AGENT_TOKEN: undefined }],
]) {
  ok(`AGENT_TOKEN ${label} → anonymous even with a token presented`,
     await verdict("/api/admin/products/batch", { token: "anything", e }) === "anonymous");
}
// Asserting the DIAGNOSTIC, not just the denial.
//
// Mutation showed the fail-closed branch could be deleted with every test still
// green: an empty secret never matches a non-empty presented token, so the digest
// compare rejects it regardless and the guard is redundant *for security*. What it
// is not redundant for is telling whoever set this up why their agent gets 401 on a
// correct token. Silent-and-correct is indistinguishable from silent-and-broken, and
// this is the kind of misconfiguration someone debugs for an hour.
async function captureErrors(fn) {
  const real = console.error;
  const seen = [];
  console.error = (...a) => seen.push(a.join(" "));
  try { await fn(); } finally { console.error = real; }
  return seen.join("\n");
}
ok("an unset AGENT_TOKEN is reported, not just silently denied",
   /AGENT_TOKEN is unset/.test(await captureErrors(() =>
     verdict("/api/admin/products/batch", { token: "anything", e: {} }))));
ok("a too-short AGENT_TOKEN says so, with the length",
   /AGENT_TOKEN is 8 chars/.test(await captureErrors(() =>
     verdict("/api/admin/products/batch",
             { token: "shorty12", e: { AGENT_TOKEN: "shorty12" } }))));
ok("a correctly configured token logs nothing",
   (await captureErrors(() => verdict("/api/admin/products/batch"))) === "");

const short = "s".repeat(MIN_TOKEN_LENGTH - 1);
ok(`a ${MIN_TOKEN_LENGTH - 1}-char AGENT_TOKEN is refused even when it matches`,
   await verdict("/api/admin/products/batch",
                 { token: short, e: { AGENT_TOKEN: short } }) === "anonymous");
ok(`a ${MIN_TOKEN_LENGTH}-char AGENT_TOKEN is accepted`,
   await verdict("/api/admin/products/batch",
                 { token: "s".repeat(MIN_TOKEN_LENGTH),
                   e: { AGENT_TOKEN: "s".repeat(MIN_TOKEN_LENGTH) } }) === "agent");

console.log("\nthe comparison is constant-time");
const src = readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");
ok("tokens are never compared with === or !==",
   !/presented\s*[!=]==\s*secret|secret\s*[!=]==\s*presented/.test(src));
ok("the compare accumulates rather than returning early",
   /diff \|=/.test(src), "no XOR accumulation found");
ok("comparison is over fixed-length digests, not raw tokens",
   /sha256Hex\(presented\)[\s\S]{0,60}sha256Hex\(secret\)/.test(src));

console.log("\nwhat the agent may write, given it publishes straight to the shop");
// category included because checkAgentEntries now requires a real one — a row with
// category "" is one verify-catalogue.sh reports as unknown.
const entry = (o = {}) => ({ file: "a.jpg", price: 49900, description: "words",
                            category: "figurine", ...o });
ok("a normal listing passes", checkAgentEntries([entry()]) === null);
ok("price below the floor is refused",
   /outside the/.test(checkAgentEntries([entry({ price: AGENT_LIMITS.minPaise - 1 })]) || ""));
ok("price above the ceiling is refused",
   /outside the/.test(checkAgentEntries([entry({ price: AGENT_LIMITS.maxPaise + 1 })]) || ""));
ok("exactly the floor is allowed", checkAgentEntries([entry({ price: AGENT_LIMITS.minPaise })]) === null);
ok("exactly the ceiling is allowed", checkAgentEntries([entry({ price: AGENT_LIMITS.maxPaise })]) === null);
// The paise/rupee mix-up this is really for: Rs499 typed as 499 paise, or as
// 49900 rupees.
ok("Rs499 sent as 499 paise (Rs4.99) is caught",
   checkAgentEntries([entry({ price: 499 })]) !== null);
ok("Rs499 sent as 49900 rupees is caught",
   checkAgentEntries([entry({ price: 4990000 })]) !== null);
ok("a listing with no description is refused",
   /no description/.test(checkAgentEntries([entry({ description: "" })]) || ""));
ok("whitespace is not a description",
   /no description/.test(checkAgentEntries([entry({ description: "   " })]) || ""));
ok("the offending file is named in every message",
   (checkAgentEntries([entry({ file: "batman.jpg", price: 1 })]) || "").includes("batman.jpg"));
ok(`more than ${AGENT_LIMITS.maxItems} items is refused`,
   /at most/.test(checkAgentEntries(Array.from({ length: AGENT_LIMITS.maxItems + 1 }, () => entry())) || ""));
ok(`exactly ${AGENT_LIMITS.maxItems} items is allowed`,
   checkAgentEntries(Array.from({ length: AGENT_LIMITS.maxItems }, () => entry())) === null);
ok("one bad row rejects the whole batch",
   checkAgentEntries([entry(), entry({ price: 1 }), entry()]) !== null);

console.log("\nthe gate in index.js is actually wired to all this");
// Mutation found the equivalent gap in apicache.mjs: deleting the call site left
// every assertion passing, because they exercised the extracted function directly.
const idx = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
ok("index.js calls agentVerdict", /agentVerdict\(request, env, m, p\)/.test(idx));
ok("it is only consulted when there is no owner session",
   /if \(!owner\) \{[\s\S]{0,400}agentVerdict/.test(idx));
ok("'forbidden' returns 403, not 401", /verdict === "forbidden"[\s\S]{0,200}403/.test(idx));
ok("anything else still 401s", /if \(!actor\) return bad\("unauthorized", 401\);/.test(idx));
ok("the actor is passed to the batch handler",
   /adminBatchCreate\(env, body, actor, ctx\)/.test(idx));

const adm = readFileSync(new URL("../src/admin.js", import.meta.url), "utf8");
ok("the batch handler applies checkAgentEntries for the agent",
   /actor === "agent"[\s\S]{0,120}checkAgentEntries\(entries\)/.test(adm));
ok("agent limits are checked BEFORE planRowsFor writes anything",
   adm.indexOf("checkAgentEntries(entries)") < adm.indexOf("await writeProductRows"));
ok("the owner path is unaffected (actor defaults to owner)",
   /batchCreateProducts\(env, body, actor = "owner"/.test(adm));
ok("Aswin is emailed when the agent lists something",
   /actor === "agent"[\s\S]{0,200}notifyAgentListings/.test(adm));

console.log("\nthe write path itself still cannot touch an existing product");
// The real guarantee behind all of the above. If an UPDATE or DELETE ever appears on
// this path, the token stops being safe no matter how tight the allowlist is.
// Ends at describeProducts, NOT at hideImages. describeProducts was inserted between
// the two and legitimately contains an UPDATE, so the wider slice reported the batch
// path as able to modify existing rows when nothing about it had changed.
const batchSection = adm.slice(adm.indexOf("export async function batchCreateProducts"),
                               adm.indexOf("// POST /api/admin/products/describe"));
ok("no UPDATE reachable from the batch handler", !/\bUPDATE\s+products\b/i.test(batchSection));
ok("no DELETE reachable from the batch handler", !/\bDELETE\s+FROM\b/i.test(batchSection));
ok("writeProductRows is INSERT-only",
   /INSERT INTO products/.test(adm.slice(adm.indexOf("function writeProductRows"),
                                         adm.indexOf("export async function updateProduct"))));
ok("planRowsFor still rejects an already-listed file",
   /alreadyListed\.has\(file\)[\s\S]{0,120}is already a product/.test(adm));
ok("planRowsFor still requires the file to be in the manifest",
   /!known\.has\(file\)/.test(adm));


console.log("\nthe describe route: fill a blank, never overwrite");
ok("POST /api/admin/products/describe → agent",
   await verdict("/api/admin/products/describe") === "agent");
ok("GET on the describe route → forbidden",
   await verdict("/api/admin/products/describe", { method: "GET" }) === "forbidden");
ok("PATCH on it → forbidden",
   await verdict("/api/admin/products/describe", { method: "PATCH" }) === "forbidden");

const d = (o = {}) => ({ slug: "blank-one", description: "x".repeat(80), ...o });
ok("a normal fill passes", checkDescribeEntries([d()]) === null);
ok("an empty description is refused",
   /empty description/.test(checkDescribeEntries([d({ description: "" })]) || ""));
ok(`under ${AGENT_LIMITS.minDescription} chars is refused`,
   /minimum/.test(checkDescribeEntries([d({ description: "x".repeat(AGENT_LIMITS.minDescription - 1) })]) || ""));
ok(`exactly ${AGENT_LIMITS.minDescription} chars is allowed`,
   checkDescribeEntries([d({ description: "x".repeat(AGENT_LIMITS.minDescription) })]) === null);
ok("the floor matches verify-catalogue.sh's 'thin' threshold", AGENT_LIMITS.minDescription === 60);
ok("an invented category is refused",
   /not one of/.test(checkDescribeEntries([d({ category: "gadgets" })]) || ""));
for (const c of CATEGORIES) {
  ok(`category "${c}" is accepted`, checkDescribeEntries([d({ category: c })]) === null);
}
ok("omitting category is fine", checkDescribeEntries([d({ category: undefined })]) === null);
ok("the slug is named in the message",
   (checkDescribeEntries([d({ slug: "radha-krishna", description: "no" })]) || "").includes("radha-krishna"));
ok(`more than ${AGENT_LIMITS.maxItems} is refused`,
   /at most/.test(checkDescribeEntries(Array.from({ length: AGENT_LIMITS.maxItems + 1 }, () => d())) || ""));

console.log("\ncreating a listing now requires a real category too");
// Without this the agent could create a row with category "", which
// verify-catalogue.sh reports as unknown and the shop sidebar cannot file.
const e2 = (o = {}) => ({ file: "a.jpg", price: 49900, description: "words", category: "figurine", ...o });
ok("a valid category passes", checkAgentEntries([e2()]) === null);
ok("a missing category is refused",
   /no category/.test(checkAgentEntries([e2({ category: "" })]) || ""));
ok("an invented category is refused",
   /not one of/.test(checkAgentEntries([e2({ category: "gizmos" })]) || ""));
ok("the four real categories all pass",
   [...CATEGORIES].every((c) => checkAgentEntries([e2({ category: c })]) === null));

console.log("\nthe overwrite guard is in the SQL, not just the validation");
// This is the assertion that matters most in the file. checkDescribeEntries can be
// skipped — it only runs for actor === "agent" — but the WHERE clause cannot.
const desc = adm.slice(adm.indexOf("export async function describeProducts"),
                       adm.indexOf("async function notifyAgentDescriptions"));
ok("the UPDATE carries AND (description IS NULL OR TRIM(description) = '')",
   /AND \(description IS NULL OR TRIM\(description\) = ''\)/.test(desc),
   "the only thing making an overwrite impossible is gone");
ok("it is an UPDATE of description/category only, not a general SET",
   /SET description = \?, category = COALESCE\(\?, category\), updated_at = \?/.test(desc));
// Money and shelf presence must be absent from the statement entirely.
for (const col of ["price_paise", "visible", "slug =", "name ="]) {
  const stmt = desc.slice(desc.indexOf("UPDATE products"), desc.indexOf("`)"));
  ok(`${col.replace(" =","")} is not assignable through this route`, !stmt.includes(col + " ="),
     `${col} appears in the UPDATE`);
}
ok("the guard is not weakened to a JS-only check",
   desc.indexOf("AND (description IS NULL") > 0 &&
   desc.indexOf("already has a description") > 0,
   "both layers should be present");
ok("it reports what the DATABASE changed, not what was asked",
   /meta\?\.changes/.test(desc), "a race would be reported as success");

console.log(`\n  agent: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
