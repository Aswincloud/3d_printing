// Catalogue reads and the money maths.
//
// The amount functions live here rather than in the order handler because
// they're the part that must be unit-testable in isolation: they are the only
// thing standing between a tampered cart and a wrong charge.

import { json, now } from "./lib.js";
import { applyCoupon } from "./coupons.js";
// Shared with the dashboard's unlisted-photos panel, so a synthesised card and
// the admin form suggest the same name for the same file.
import { suggestName } from "./admin.js";

// ── products ──────────────────────────────────────────────────────
// Public listing. Only visible rows, and deliberately no internal columns.
//
// Returns two kinds of card:
//
//   1. Product rows, as always. price_paise > 0 means buyable; 0 means the photo
//      is in the shop but not priced yet.
//   2. SYNTHESISED cards for photos in assets/images.json that no product row
//      points at — pushed but never listed.
//
// (2) is what makes "push a photo and it appears" work. Doing it at request time
// rather than in a migration is the point: a migration runs once, and the whole
// value here is that FUTURE photos appear without anyone doing anything.
export async function listProducts(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, slug, name, description, price_paise, image, images, category, sort,
            personalise_label, personalise_required, pinned
       FROM products WHERE visible = 1
      ORDER BY pinned DESC, (sort = 0), sort ASC, name ASC`
  ).all();

  const rows = results || [];

  // The manifest carries a content hash per photo. Appending it as ?v= makes every
  // image URL change when its bytes change, which is what lets cacheImages() in
  // index.js hand out an immutable year-long cache with no risk of a stale photo —
  // see the note there. Read once here and passed down, rather than fetched twice.
  const manifest = await readImageManifest(env);
  const version = new Map(
    (manifest?.images || []).filter((i) => i.hash).map((i) => [i.file, i.hash]));

  const products = rows.map((r) => stampVersion(shape(r), version));

  // Ordering: pinned first, then buyable, then priced-at-zero, then synthesised.
  //
  // Someone browsing a shop should meet the things they can actually buy before
  // the things they have to ask about. Within each group the existing
  // sort/name order from the query is preserved.
  //
  // Pin is the OUTER key, above the buyable split. A pin has to mean the top of
  // the page or it isn't a pin — including for an unpriced piece Aswin wants
  // people to ask about, which is a legitimate thing to lead with.
  products.sort((a, b) =>
    Number(b.pinned) - Number(a.pinned) ||
    Number(a.quote_only) - Number(b.quote_only));

  return json({
    products: [...products, ...(await synthesised(env, rows, manifest, version))],
    shipping: shippingConfig(env),
    // Absent when there is nothing live to advertise, so the banner has nothing
    // to render rather than rendering something stale.
    promo: await featuredPromo(env),
  });
}

// ── the featured promo, for the homepage banner ───────────────────
//
// READ FROM THE COUPON ROW, never hardcoded. A banner is a promise: if it says
// 10% off and checkout disagrees, the customer is the one who finds out. So the
// terms shown are computed from the same row priceCart() will apply, and the
// banner simply does not render if the code is not usable right now.
//
// PROMO_CODE names which coupon to feature — config, so featuring a different one
// is a wrangler.toml edit rather than a deploy of new logic. Unset means no
// banner, which is also how you turn it off without touching the coupon itself.
//
// Every reason a code could fail is checked here rather than trusted: paused,
// expired, or out of uses. Aswin pausing WELCOME10 in the dashboard takes the
// banner down on its own, with nothing else to remember.
async function featuredPromo(env) {
  const code = String(env.PROMO_CODE || "").trim();
  if (!code) return null;

  const row = await env.DB.prepare(
    `SELECT code, kind, value, min_order_paise, max_discount_paise, expires_at,
            max_uses, uses, active, once_per_customer
       FROM coupons WHERE code = ?`
  ).bind(code).first();

  if (!row) return null;
  if (!row.active) return null;
  if (row.expires_at && row.expires_at <= now()) return null;
  if (row.max_uses !== null && row.uses >= row.max_uses) return null;

  // Only percentage and fixed codes have terms worth putting on a banner; a
  // shipping code's value is already covered by the free-shipping note.
  if (row.kind !== "percent" && row.kind !== "fixed") return null;

  return {
    code: row.code,
    kind: row.kind,
    value: row.value,
    max_discount_paise: row.max_discount_paise ?? null,
    min_order_paise: row.min_order_paise || 0,
    // A display hint, so the banner can say "one use per customer" rather than
    // the customer discovering it at checkout.
    once_per_customer: Boolean(row.once_per_customer),
  };
}

// Photos with no product row, as quote-only cards.
//
// `id: null` is deliberate and load-bearing. These have no database row, so
// there is nothing to add to a cart even if the frontend tried: the cart keys on
// product id, priceCart looks the id up in `products`, and null resolves to
// nothing. The card is a picture and a quote button, not a half-built product.
async function synthesised(env, rows, manifest, version) {
  if (!manifest) return [];

  // Every path the catalogue already uses — primary image AND each entry of the
  // comma-separated `images` column. Without the second, a photo used only as a
  // secondary view of an existing product would be synthesised as a separate
  // card: the same object appearing twice, once buyable and once not.
  const used = new Set();
  for (const r of rows) {
    const add = (p) => { const f = String(p || "").trim(); if (f) used.add(f.replace(/^.*\//, "")); };
    add(r.image);
    for (const extra of String(r.images || "").split(",")) add(extra);
  }

  // Hidden products count as used too, or hiding one would resurrect it as a
  // synthesised card on the very next request — the opposite of what hiding
  // means. This query is separate from the visible one above precisely because
  // that one filters them out.
  const { results: hidden } = await env.DB.prepare(
    `SELECT image, images FROM products WHERE visible = 0`
  ).all();
  for (const r of hidden || []) {
    const add = (p) => { const f = String(p || "").trim(); if (f) used.add(f.replace(/^.*\//, "")); };
    add(r.image);
    for (const extra of String(r.images || "").split(",")) add(extra);
  }

  return manifest.images
    .filter((i) => !used.has(i.file))
    .map((i) => ({
      // No row, no id, no slug — so no product page and no cart entry.
      id: null,
      slug: null,
      name: suggestName(i.file) || "Custom piece",
      description: "",
      price_paise: 0,
      quote_only: true,
      // No row means nothing to pin. Stated rather than left undefined so every
      // card the API returns has the same shape.
      pinned: false,
      // Versioned like the real products, off the same manifest entry — a
      // synthesised card shows a real photo and should earn the same immutable
      // cache. No hash means no ?v=, which falls back to the short cache.
      image: i.hash ? `assets/images/${i.file}?v=${i.hash}` : `assets/images/${i.file}`,
      images: [],
      category: "",
    }));
}

// The manifest is the only record of what photos exist — a Worker cannot list a
// directory. Read through the ASSETS binding so a new photo needs no code change.
// Any failure yields no synthesised cards, which degrades to today's behaviour
// rather than breaking the shop.
async function readImageManifest(env) {
  if (!env.ASSETS?.fetch) return null;
  try {
    const res = await env.ASSETS.fetch(new Request("https://assets.local/assets/images.json"));
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.images) ? data : null;
  } catch (e) {
    console.error("image manifest unreadable", e?.message || e);
    return null;
  }
}

// `images` is stored comma-separated; the API hands back an array so the
// frontend never has to know that.
// Appends the content hash to an image path, so the URL identifies its contents.
//
// Leaves the path alone when the photo has no hash — a file in the database but
// missing from the manifest. That combination then gets the SHORT cache in index.js
// rather than an immutable one, which is the safe way round.
function stampVersion(p, version) {
  const file = String(p.image || "").replace(/^.*\//, "");
  const h = version.get(file);
  if (h) p.image = `${p.image}?v=${h}`;
  return p;
}

function shape(r) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description || "",
    price_paise: r.price_paise,
    // 0 means "not priced yet", not "free". Surfaced as a flag so the frontend
    // reads intent rather than inferring meaning from a magic number — and so
    // that a future real change to the sentinel touches one line.
    //
    // Enforced server-side in priceCart(): a quote_only product cannot be
    // bought, whatever the UI does.
    quote_only: !(r.price_paise > 0),
    image: r.image,
    images: r.images ? r.images.split(",").filter(Boolean) : [],
    category: r.category || "",
    // What this product asks the buyer for, and whether an answer is needed.
    // An empty label means it asks nothing, which is how the cart and checkout
    // decide whether to render a field at all. Sent as a flag rather than
    // inferred from the description text, for the same reason quote_only is.
    //
    // Advisory: priceCart() re-reads both from the row and refuses the order
    // itself, so a client that ignores these gets a 400 rather than a free pass.
    personalise_label: r.personalise_label || "",
    personalise_required: Boolean(r.personalise_required),
    // Drives the "Featured" badge, and the pin toggle an admin sees in its place.
    // Not sensitive: it is already readable from the order of the grid.
    pinned: Boolean(r.pinned),
  };
}

// ── shipping ──────────────────────────────────────────────────────
// Both amounts are wrangler.toml vars, so they're editable without a code
// change. They arrive as strings; coerce once, here.
// The fallbacks must track wrangler.toml. They are what applies if a var is
// missing or unparseable, so a stale fallback would silently give away shipping
// at the old, lower threshold on any deploy where the var did not come through.
export function shippingConfig(env) {
  return {
    flat_paise: intVar(env.FLAT_SHIP_PAISE, 9900),
    free_threshold_paise: intVar(env.FREE_SHIP_THRESHOLD_PAISE, 200000),
  };
}

function intVar(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Free over the threshold, flat rate otherwise.
// `>=` is intentional: an order exactly at the threshold ships free.
//
// The `delivery` parameter is kept in the signature but no longer branches on:
// pickup was withdrawn (everything ships now), and the old `if (delivery ===
// "pickup") return 0` was a free-shipping path reachable by anyone who could set
// that field. createOrderHandler now hardcodes "ship", so this is belt-and-braces
// — a second place the value would have to be honoured for the bug to return.
export function shippingFor(subtotalPaise, delivery, env) {
  const { flat_paise, free_threshold_paise } = shippingConfig(env);
  return subtotalPaise >= free_threshold_paise ? 0 : flat_paise;
}

// ── cart pricing ──────────────────────────────────────────────────
// THE security-critical function. Takes only {product_id, qty} pairs and
// returns amounts derived entirely from D1. Any `price` field on the input is
// ignored — it is never read, so a tampered cart cannot change the charge.
//
// `couponCode` extends that rule rather than breaking it: the client sends a
// CODE and nothing else. The percentage, the amount, the minimum and the expiry
// are all read from the coupons table here. A `discount_paise` in the request is
// ignored exactly as `price_paise` is.
//
// Returns { items, subtotal_paise, discount_paise, coupon_code, shipping_paise,
// total_paise } or { error }.
export const MAX_QTY = 100;
// Long enough for a company name and two contact lines on a business card,
// short enough that it cannot be used as free storage. Clipped, never rejected:
// losing an order over a long line of text would be the worse failure.
export const MAX_PERSONALISATION = 120;

export async function priceCart(env, rawItems, delivery, couponCode = null, email = null) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { error: "Your cart is empty." };
  }
  if (rawItems.length > 50) {
    return { error: "Too many different items in one order." };
  }

  // Collapse duplicate product_ids so the same item twice can't bypass the
  // per-line qty cap.
  const wanted = new Map();
  // What to print, per product. One value per product per order, which is why it
  // can live in the same collapse as the quantity: two lines of the same product
  // are one line, so they are one personalisation. First non-empty wins — a
  // client that sends the id twice with a value and a blank meant the value.
  const personalise = new Map();
  for (const it of rawItems) {
    const id = String(it?.product_id ?? "").trim();
    const qty = parseInt(it?.qty, 10);
    if (!id) return { error: "Invalid item in cart." };
    if (!Number.isFinite(qty) || qty < 1) return { error: "Invalid quantity." };
    wanted.set(id, (wanted.get(id) || 0) + qty);
    const pz = String(it?.personalisation ?? "").trim().slice(0, MAX_PERSONALISATION);
    if (pz && !personalise.get(id)) personalise.set(id, pz);
  }

  for (const qty of wanted.values()) {
    if (qty > MAX_QTY) return { error: `Maximum ${MAX_QTY} of any one item per order.` };
  }

  const ids = [...wanted.keys()];
  const placeholders = ids.map(() => "?").join(",");
  // `price_paise > 0` is a SECURITY control, not a display rule.
  //
  // A price of 0 means "not priced yet": the shop auto-lists every pushed photo
  // as a quote-only card, and those carry 0 until a real price is set. Without
  // this clause such a row is visible = 1 and therefore priceable — addable to a
  // cart and checkoutable for ₹0, or for the shipping alone, producing a real
  // Razorpay order for a real product at no charge.
  //
  // Hiding the Add-to-cart button does NOT close that. There is a live precedent
  // in this file: `delivery: "pickup"` used to reach shippingFor() and return 0
  // shipping, and removing the radio from the form would not have fixed it —
  // hardcoding the value server-side did. Same shape of risk, same shape of fix.
  //
  // An unpriced id then falls into the `missing` branch below and the whole cart
  // is refused, which is the right answer: better than silently dropping an item
  // the customer believed they were buying.
  const { results } = await env.DB.prepare(
    `SELECT id, name, price_paise, personalise_label, personalise_required
       FROM products
      WHERE visible = 1 AND price_paise > 0 AND id IN (${placeholders})`
  ).bind(...ids).all();

  const found = new Map((results || []).map((r) => [r.id, r]));

  // A missing id means either a bogus product or one that's been hidden since
  // the cart was filled. Either way, refuse rather than silently dropping it —
  // a customer must never be charged for a different basket than they saw.
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    return { error: "An item in your cart is no longer available. Please refresh and try again." };
  }

  // Preserve the order the client sent, for display.
  const items = [];
  let subtotal = 0;
  let pos = 0;
  for (const id of ids) {
    const row = found.get(id);
    const qty = wanted.get(id);
    subtotal += row.price_paise * qty;
    // A product that does not ask gets nothing stored, whatever was sent. The
    // client decides what to SHOW; the row decides what is real — the same split
    // as the price two lines up.
    const label = String(row.personalise_label || "").trim();
    const pz = label ? (personalise.get(id) || "") : "";

    // The whole point of the feature. Refused here rather than in the browser
    // because the browser is where it was already possible to skip it: Buy-now
    // hands off straight to checkout, and the API takes a cart from anywhere.
    if (label && row.personalise_required && !pz) {
      return { error: `${row.name}: please fill in "${label}" before checking out.` };
    }

    items.push({
      product_id: row.id,
      name: row.name,          // snapshot
      price_paise: row.price_paise, // snapshot
      qty,
      personalisation: pz,     // snapshot, for the same reason
      pos: pos++,
    });
  }

  // Discount BEFORE shipping is decided. A ₹2,100 cart with 10% off becomes
  // ₹1,890, which is under the ₹2,000 free-shipping threshold, so ₹99 shipping
  // applies. Deciding shipping on the pre-discount subtotal instead would let a
  // coupon give away shipping as well as the discount — a deliberate choice, and
  // the one asserted in test/coupons.mjs so a refactor can't silently flip it.
  let discount = 0;
  let couponRow = null;
  let freeShipping = false;

  if (couponCode) {
    const r = await applyCoupon(env, couponCode, subtotal, email);
    // Refuse the order rather than dropping an invalid code silently: the
    // customer was shown a discounted total, and charging them the full amount
    // instead is the same class of bug as charging for a different basket.
    if (r.error) return { error: r.error };
    discount = r.discount_paise;
    couponRow = r.coupon;
    freeShipping = r.free_shipping;
  }

  const discounted = subtotal - discount;
  const shipping = freeShipping ? 0 : shippingFor(discounted, delivery, env);

  return {
    items,
    subtotal_paise: subtotal,
    discount_paise: discount,
    coupon_code: couponRow?.code ?? null,
    shipping_paise: shipping,
    total_paise: discounted + shipping,
  };
}
