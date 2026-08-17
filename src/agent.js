// Capability-scoped access for the image-listing agent.
//
// THE PROBLEM
// -----------
// Photos are pushed to the repo by a separate AI agent. To turn one into a real
// product it needs a price and a description, and the only way to write those today
// is the dashboard — which authenticates as the owner and therefore grants
// everything: edit any product, change any price, delete rows, read orders, issue
// refunds, mint coupons. Handing that to an agent so it can fill in two fields is
// the whole shop's blast radius for a fraction of its surface.
//
// THE SHAPE OF THE FIX
// --------------------
// A second credential that authorises a strict subset. Not a weaker owner — a
// DIFFERENT actor, allowed exactly two routes and nothing else:
//
//   GET  /api/admin/products/unlisted   — which photos have no product row yet
//   POST /api/admin/products/batch      — create rows for some of them
//
// The reason that pair is safe is not the token, it is what those two handlers can
// physically do. writeProductRows() issues a single INSERT INTO products, and
// planRowsFor() rejects any file that is not in the image manifest, any file that
// already has a product row, any duplicate within one request, and anything with a
// scheme or ".." in it. There is no UPDATE and no DELETE reachable from either
// route. So "can only touch new items" is enforced by the SQL that exists, not by
// this file trusting the caller to behave.
//
// This file adds the second half: that the agent cannot reach any OTHER handler,
// where those guarantees do not hold.
//
// WHY AN EXACT-MATCH ALLOWLIST
// ---------------------------
// "METHOD path" strings compared exactly — not a prefix test. A prefix like
// "/api/admin/products" would also match /api/admin/products (PATCH), the bulk
// price editor over every existing row, which is precisely the power being withheld.
// The same reasoning as CACHEABLE_API in index.js, and for the same reason: this
// project has already shipped one bug where a rule matched a route nobody meant to
// include.
export const AGENT_ROUTES = new Set([
  "GET /api/admin/products/unlisted",
  "POST /api/admin/products/batch",
  // Fill in a description that is MISSING. Added because the division of labour is
  // real: Aswin bulk-lists photos from the dashboard in seconds, and the agent writes
  // the copy afterwards. Four products sat undescribed because create-only had no way
  // to express that, so the agent's only route was a migration it has no credentials
  // to apply — it wrote 0017 and then could do nothing with it.
  //
  // This is the one route that touches an existing row, so it is the one to be
  // suspicious of. The limit is not "the agent promises to only fill blanks": the
  // UPDATE statement itself carries `AND (description IS NULL OR TRIM(description) =
  // '')`, so overwriting is not a thing the SQL can do. See describeProducts().
  "POST /api/admin/products/describe",
]);

// The shop's filter sidebar is built from whatever categories exist in the table, so
// a typo does not fail — it silently adds a category chip with one product in it.
// Nothing validated this before; category was only length-clipped.
export const CATEGORIES = new Set(["figurine", "decor", "functional", "set"]);

// A short token is a guessable token, and this one creates live shop listings.
// Below this length the credential is refused outright rather than accepted weakly —
// the failure is then loud at setup time instead of silent until someone brute-forces
// it.
export const MIN_TOKEN_LENGTH = 32;

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Decide what an /api/admin/ request carrying no owner session may do.
 *
 * Returns one of:
 *   "anonymous" — no bearer token presented; caller should answer 401 as before
 *   "forbidden" — the agent token is valid but this route is not on its allowlist
 *   "agent"     — valid token, allowed route
 *
 * Never returns "agent" for a route outside AGENT_ROUTES, and never falls back to
 * owner. A token that authenticates is still not authorised for anything else.
 */
export async function agentVerdict(request, env, method, path) {
  const header = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return "anonymous";
  const presented = m[1].trim();

  const secret = String(env.AGENT_TOKEN || "");
  // Fail closed, and say why in the log. An unset AGENT_TOKEN must never mean
  // "everyone is the agent" — the same trap OWNER_EMAIL is guarded against in
  // auth.js, where an unset allowlist would have opened the dashboard to anyone.
  if (!secret) {
    console.error("AGENT_TOKEN is unset — refusing all agent access (fail closed)");
    return "anonymous";
  }
  if (secret.length < MIN_TOKEN_LENGTH) {
    console.error(
      `AGENT_TOKEN is ${secret.length} chars, minimum ${MIN_TOKEN_LENGTH} — refusing`);
    return "anonymous";
  }

  // Compared as SHA-256 digests, so the comparison is over two fixed-length hex
  // strings. Comparing the raw tokens would leak their length through the
  // length check, and comparing with === would leak a prefix through timing.
  const [a, b] = await Promise.all([sha256Hex(presented), sha256Hex(secret)]);
  if (!timingSafeHex(a, b)) return "anonymous";

  // Authenticated. Authorisation is a separate question, and the answer is this
  // set — deliberately checked AFTER the token, so a wrong token on an allowed
  // route and a right token on a forbidden route are both refused.
  return AGENT_ROUTES.has(`${method} ${path}`) ? "agent" : "forbidden";
}

// Local copy rather than lib.js's timingSafeEqualHex, only so this module has no
// import cycle with lib. Same algorithm: length first (fixed 64 here, so it leaks
// nothing), then an XOR accumulation that cannot short-circuit.
function timingSafeHex(x, y) {
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// ── what the agent may write, as opposed to which routes it may call ─────────
//
// Aswin chose "live immediately": a price this agent picks is the price a customer
// pays, with no human in between. So the bounds below are the only thing standing
// between a model's arithmetic slip and a real sale at the wrong number.
//
// These are sanity rails, NOT a pricing policy. They cannot tell a good price from a
// bad one; they exist to catch the failures that are obviously not prices at all — a
// paise/rupee mix-up, a stray zero, a decimal that moved. The live catalogue runs
// Rs99 to Rs12,000, so the window is set a little outside that in both directions.
export const AGENT_LIMITS = {
  minPaise: 49 * 100,        // below this a listing is almost certainly a unit error
  maxPaise: 15000 * 100,     // above the dearest real product, with headroom
  // Smaller than the owner's 100. A batch this size is a normal week's photos; a
  // request much larger is a runaway loop, and it should be stopped at the door
  // rather than after it has written a hundred rows.
  maxItems: 20,
  // Matches the "thin description" threshold in test/verify-catalogue.sh, so the
  // agent cannot write copy that the catalogue check immediately reports.
  minDescription: 60,
};

/**
 * Extra validation applied only to agent-authored batches. Returns an error string,
 * or null when every entry is within bounds.
 *
 * Deliberately runs BEFORE planRowsFor, so a rejected batch writes nothing at all —
 * the endpoint's single-transaction guarantee is about partial failure inside the
 * write, not about validating first.
 */
export function checkAgentEntries(entries) {
  if (entries.length > AGENT_LIMITS.maxItems) {
    return `This token may list at most ${AGENT_LIMITS.maxItems} photos per request ` +
           `(got ${entries.length}).`;
  }
  for (const e of entries) {
    const file = String(e.file || "a photo").replace(/^.*\//, "");
    if (e.price < AGENT_LIMITS.minPaise || e.price > AGENT_LIMITS.maxPaise) {
      return `Price for "${file}" is Rs${(e.price / 100).toFixed(0)}, outside the ` +
             `Rs${AGENT_LIMITS.minPaise / 100}–Rs${AGENT_LIMITS.maxPaise / 100} this ` +
             `token may set. List it from the dashboard if that is deliberate.`;
    }
    // A listing with no words is a worse product page than the quote-only card it
    // replaces, and writing the description is half of what this agent is for.
    if (!String(e.description || "").trim()) {
      return `"${file}" has no description. This token may only create listings that ` +
             `have one.`;
    }
    // Category is REQUIRED here, unlike on the owner path where an empty one is
    // merely untidy. planRowsFor clips a missing category to "", and a product with
    // category "" is one that test/verify-catalogue.sh reports as unknown and that
    // the shop sidebar cannot file under any chip. Requiring it costs the agent one
    // field and removes a way for it to create a row that fails the catalogue check.
    const cat = String(e.category || "").trim();
    if (!cat) return `"${file}" has no category. One of: ${[...CATEGORIES].join(", ")}.`;
    if (!CATEGORIES.has(cat)) {
      return `"${file}" has category "${cat}", which is not one of ` +
             `${[...CATEGORIES].join(", ")}. A new one would add a filter chip to the ` +
             `shop with a single product under it.`;
    }
  }
  return null;
}

/**
 * Validation for filling in a MISSING description on a product that already exists.
 *
 * The overwrite protection is NOT here — it is in the UPDATE's WHERE clause, because
 * a check in JavaScript is a check that has to be reached. This is about the quality
 * of what gets written, plus a readable error before the write is attempted.
 */
export function checkDescribeEntries(entries) {
  if (entries.length > AGENT_LIMITS.maxItems) {
    return `This token may describe at most ${AGENT_LIMITS.maxItems} products per ` +
           `request (got ${entries.length}).`;
  }
  for (const e of entries) {
    const slug = String(e.slug || "a product");
    const desc = String(e.description || "").trim();
    if (!desc) {
      return `"${slug}" has an empty description. Filling a blank with a blank is not ` +
             `worth a write.`;
    }
    // 60 characters is the threshold test/verify-catalogue.sh already calls "thin".
    // Matching it means the agent cannot write something that the catalogue check
    // will turn around and flag.
    if (desc.length < AGENT_LIMITS.minDescription) {
      return `Description for "${slug}" is ${desc.length} characters; ` +
             `${AGENT_LIMITS.minDescription} is the minimum, which is the same ` +
             `threshold the catalogue check calls thin.`;
    }
    // Optional here — an existing row already has a category. Validated when given.
    if (e.category != null && e.category !== "" && !CATEGORIES.has(String(e.category))) {
      return `"${slug}" has category "${e.category}", which is not one of ` +
             `${[...CATEGORIES].join(", ")}.`;
    }
  }
  return null;
}
