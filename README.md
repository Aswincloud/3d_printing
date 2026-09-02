<div align="center">

<img src="public/assets/images/IMG20260403160453.jpg" alt="AswinPrints Banner" width="100%" style="border-radius:12px;max-height:320px;object-fit:cover;" />

<br /><br />

# 🖨️ AswinPrints

### Your Ideas, Printed in 3D — Pondicherry, India

[![Live Site](https://img.shields.io/badge/🌐_Live_Site-3d--prints.aswincloud.com-ff6b00?style=for-the-badge)](https://3d-prints.aswincloud.com/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers_+_D1-f38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Printer](https://img.shields.io/badge/Printer-Bambu_Lab_A1-ff6b00?style=for-the-badge)](https://bambulab.com)
[![Instagram](https://img.shields.io/badge/📸_@3dprinthub.offl-E4405F?style=for-the-badge)](https://www.instagram.com/3dprinthub.offl)
[![Location](https://img.shields.io/badge/📍_Location-Pondicherry,_India-3b82f6?style=for-the-badge)](#)

</div>

---

## ✨ About

**AswinPrints** is a custom 3D printing business run by [Aswin Zayasankaran](https://www.aswincloud.com), based in Pondicherry, India. Powered by the **Bambu Lab A1**, I print everything from intricate figurines and decorative pieces to functional prototypes and personalised gifts.

> 🎯 **Goal**: Make 3D printing accessible to everyone — fast turnaround, fair pricing, quality you can see.

---

## 🎨 Sample Prints

<div align="center">

| | | |
|---|---|---|
| <img src="public/assets/images/IMG20260725_toothless_collection.jpg" width="220" /> | <img src="public/assets/images/IMG20260531_laughing_buddha.jpg" width="220" /> | <img src="public/assets/images/IMG20260725_robot_articulated.jpg" width="220" /> |
| <img src="public/assets/images/IMG20260725_elephant.jpg" width="220" /> | <img src="public/assets/images/IMG20260521_vases_temple.jpg" width="220" /> | <img src="public/assets/images/IMG20260725_dahlias.jpg" width="220" /> |

*[View full gallery →](https://3d-prints.aswincloud.com/#gallery)*

</div>

---

## 🛠️ Services

| Service | Description |
|---|---|
| 🎨 **Custom Figurines** | Characters, mascots, collectibles printed with fine detail |
| ⚙️ **Functional Parts** | Replacement components, brackets, mechanical parts |
| 🏠 **Home Décor** | Vases, wall art, organizers, decorative accents |
| 🎁 **Personalised Gifts** | Name plates, keychains, one-of-a-kind custom pieces |
| 🔬 **Prototypes** | Rapid prototyping for product ideas and engineering models |
| 📦 **Small Batch Runs** | Multiple copies with consistent quality |

---

## 📐 How It Works

| Step | What Happens |
|---|---|
| **1 · Send Your Request** | Fill in the [quote form](https://3d-prints.aswincloud.com/#quote) with your idea. Attach an `STL`, `OBJ`, or `3MF` file if you have one — otherwise just describe it. |
| **2 · Get a Quote** | I review the model, materials and quantity, then reply with pricing. Usually within a few hours. |
| **3 · Print & Review** | Once approved, your piece goes on the printer. I share photos before it ships. |
| **4 · Deliver** | Pickup in Pondicherry, or shipping anywhere in India. |

---

## ⚙️ Tech Stack

| | Tool |
|---|---|
| **Printer** | Bambu Lab A1 |
| **Materials** | PLA · PETG · TPU — with custom colour matching |
| **File Formats** | STL · OBJ · 3MF |
| **Frontend** | Pure HTML / CSS / JS — no framework, no build step |
| **Backend** | Cloudflare Worker (`src/`) — static assets + `/api/*` |
| **Database** | Cloudflare D1 (SQLite) — products and orders |
| **Payments** | [Razorpay](https://razorpay.com) Standard Checkout |
| **Email** | [Resend](https://resend.com), sent from the Worker |

---

## 🚀 How the Site Works

A single Cloudflare Worker serves the static site and the API. Paths matching a
file in `public/` are served by the assets binding; everything else falls
through to the Worker, so `/api/*` is handled in `src/`.

```
3d_printing/
├── public/                      # Static site (served via [assets])
│   ├── index.html               # Main website — shop, cart, sign-in, account menu
│   ├── shop.html                # Owner dashboard (orders, products, quotes, coupons)
│   ├── 3d-printing-in-pondicherry.html   # Local landing page
│   ├── contact/privacy/refunds/shipping/terms.html
│   └── assets/
│       ├── css/                 # style.css (site), admin.css (dashboard), pdp.css
│       ├── js/                  # main.js, admin.js, product.js, quote-modal.js, chat.js
│       ├── images/              # ~86 product photos
│       └── images.json          # Generated manifest — `npm run images`, never by hand
├── src/                         # Worker
│   ├── index.js                 # Router: /api/* → api(), else ASSETS.fetch
│   ├── lib.js                   # JSON/HMAC/cookies/escaping/Resend helpers
│   ├── security.js              # CSP + security headers, rate-limit rules
│   ├── shop.js                  # Catalogue reads + cart pricing (server-side)
│   ├── razorpay.js              # REST client, payment links, signature verification
│   ├── orders.js                # Order create/verify/receipt + webhook
│   ├── quotes.js                # Quote requests, and answering one with a price
│   ├── invoicing.js             # Hands a paid order to invoicer.aswincloud.com
│   ├── auth.js                  # Owner sign-in via the auth.aswincloud.com broker
│   ├── customers.js             # Customer sign-in (OTP/OAuth) + /api/me
│   ├── cart.js                  # Server-side cart + guest merge
│   ├── coupons.js               # Discount codes
│   ├── chatcoupons.js           # The chat bot's on-demand discount code
│   ├── agent.js                 # The listing agent's capability boundary
│   ├── admin.js                 # Owner-only: product CRUD, orders, refunds
│   ├── pdp.js                   # Product detail page HTML
│   ├── productpage.js           # /p/<slug> routing
│   ├── seo.js                   # sitemap, robots, JSON-LD, homepage rewriting
│   └── emails.js                # Email HTML templates
├── migrations/                  # D1 schema (forward-only, 0001 … 0019)
├── test/                        # Offline unit tests (`npm test`)
│   └── browser/                 # Cross-engine layout checks (chromium + webkit)
├── wrangler.toml                # Worker + D1 config; vars only, no secrets
└── .github/workflows/
    ├── test.yml                 # npm test, and the hero geometry check
    └── auto-approve.yml         # Dependabot auto-approval
```

### Local development

```bash
npm install
cp .dev.vars.example .dev.vars    # fill in; gitignored, never committed
npm run db:migrate:local
npm run dev                       # http://localhost:8787
npm test                          # offline unit tests, no network
npm run images                    # regenerate assets/images.json after adding a photo
```

### CI

`.github/workflows/test.yml` runs on every push and pull request.

**`npm test`** — around 1,400 offline assertions over pricing, payments, refunds,
order state, the admin auth gate, coupons and quotes. No network, no D1, no
secrets, so there is nothing to configure and it finishes in about 20 seconds.

For four months this repo had no CI at all: the only automated things that
happened to a pull request were *approve it* and *deploy it*.

**Hero geometry, in Chromium and WebKit** (`test/browser/hero-geometry.mjs`) — a
separate job, so the unit suite stays a 20-second answer. It serves `public/`
statically, because this is CSS geometry and needs no Worker.

It asserts the two engines agree on each hero card's **shape**, that nothing
scrolls sideways — the page *or* the strip — and that no card hides more than 25%
of its photo. Agreement is the assertion rather than any particular ratio, so it
holds no opinion about the design and only fails when two browsers disagree
about it.

It exists because they did. A card sized from its image's intrinsic width came
out 221px in Chromium and 335px in WebKit — a cropped photo on every iPhone,
invisible to anyone testing in Chromium, and reported from a real phone rather
than by anything in this repo. A browser that fails to start is a check that is
not running, so `CI=true` makes that fatal rather than skipped.

**The pin control, in Chromium and WebKit** (`test/browser/pin-control.mjs`) —
same job, same static server, with `/api/*` stubbed. It is the only admin control
on a public page, so *which element each visitor gets* is a browser question the
server tests cannot answer: a customer must get a plain badge and no controls, an
admin the toggle in its place. It also holds a bug it caught before release —
re-ordering the product array in place made pinning look right and left an
**unpinned** card stranded at the top until reload. See
[Pinning](#pinning-and-the-order-of-the-catalogue).

**The order tracker, in Chromium and WebKit** (`test/browser/order-tracker.mjs`) —
the six-stage progress bar in My Orders, rendered from a stubbed payload in the
shapes real order data actually takes. See [Order stages](#order-stages).

**The promo banner, in Chromium and WebKit** (`test/browser/promo-banner.mjs`) —
who the homepage banner is shown to. The offer comes from a **shared, edge-cached**
response and is withdrawn by a **per-session** one, so the decision is split across
two requests that arrive in either order; this pins down that race, and that a
hidden banner leaves the nav flush rather than floating above a transparent gap.

**Checkout on a phone, in Chromium and WebKit** (`test/browser/checkout-mobile.mjs`)
— the promo row's proportions at 360/390/430px, that no checkout field is under
16px (iOS Safari zooms the viewport on focus below that), that desktop keeps its
smaller field size, and that arriving at `/#cart` opens the drawer. Both defects
it guards were reported from a real phone and were invisible on a desktop.

**Deploys are not run from CI.** Cloudflare Workers Builds deploys `main` on
push; branches produce an unpromoted preview version. **Migrations are never run
by the deploy** — apply them yourself with `npm run db:migrate:remote`.

### Quote form pipeline

The form posts JSON to `POST /api/quote`. The Worker validates it server-side,
records the request, then sends two emails through Resend:

1. **To me** — the full request, with `reply_to` set to the customer.
2. **To the customer** — an acknowledgement summarising what they submitted.

The customer copy is sent via `ctx.waitUntil()`, so a slow send never delays
the response.

The row comes first, and its failure is non-fatal. A request used to exist only
as two emails, so losing the email lost the job — including the uploaded model,
which was a link inside that one message and nowhere else. But a D1 outage must
not swallow a real customer's request when the mail would have gone out fine, so
a failed insert is logged and the emails still send.

**→ [Quotes, and answering one with a price](#quotes)** below.

### Asking about something that isn't listed

Every photo in `public/assets/images/` is a listed product or a quote-only card;
migration 0005 named the 18 that once carried `alt="3D print sample"`. The
catalogue is around 86 photos and grows whenever the listing agent pushes one, so
this README does not quote a count that would be wrong a week later —
`assets/images.json` is the list, and it is generated, never hand-written.

Every gallery photo also has **"Request a quote for this"** in its
lightbox, every product card has **"Different colour or size?"**, and every
product page has both. All of them open a **modal** — `assets/js/quote-modal.js`
— carrying a thumbnail and the item's name, which travels as `ref_item` and
appears as an "About" row in the owner email. Without that, a request about one
of the 18 would arrive with no way to tell which photo it meant.

They used to scroll to the page-bottom form instead, and from a product page they
navigated to it. Both took away the photo, the price and the size the question was
about, which is most of what the person was looking at when they decided to ask.

The modal posts to the **same `POST /api/quote`** as that form — same server-side
validation, same `RL_QUOTE` rate limit, same two emails (owner with `Reply-To` set
to the customer, customer acknowledgement via `ctx.waitUntil`). A second endpoint
would have been a second thing to remember to rate limit.

It asks for name, email, phone, quantity and details. It does **not** ask the
category the page-bottom form asks for — someone who clicked "different colour or
size" on a specific product has already answered that — so `type` is sent as
"Variation of a listed item".

The script is shared by the homepage and the product pages, which load different
scripts (`main.js` and `product.js`), and it builds its own markup rather than
having it written into both `public/index.html` and `src/pdp.js`, where the two
copies would drift. The product-page links keep their `href` to `/#quote` as a
no-JS fallback; the click is intercepted only when the modal is actually loaded.

The page-bottom form stays: it is the `#quote` anchor target, it takes file
attachments, and it handles requests that aren't about any one product.

`ref_item` is customer-controlled text, so it's clipped and escaped like every
other field — never used as a URL or a lookup key.

### Shop and cart

`GET /api/products` returns the visible catalogue from D1 plus the shipping
config; `assets/js/main.js` renders the grid and the cart drawer from it.

**Search and category filters are entirely client-side.** That one request
already returns the whole catalogue, so filtering locally is instant and needs no
round trip. Category chips are built from the categories actually present, so
adding one to the database needs no code change; `CATEGORY_LABELS` in `main.js`
maps the internal slugs to the friendlier wording used elsewhere on the page
(`figurine` → "Figurines", `decor` → "Home Décor"), falling back to the
capitalised slug for anything unmapped.

A multi-word search matches all terms in any order across name, description and
category, so "run marble" finds both marble runs. A search that matches nothing
offers the quote form and carries the search term into its description — the best
hint available about what they actually wanted.

The cart in `localStorage` stores **only `{id, qty}`** — no prices, no names.
Everything displayed is re-derived from the API on load, and when checkout
lands the browser will post only those id/qty pairs. `priceCart()` in
`src/shop.js` reads prices from D1 and computes the amount server-side, so a
hand-edited cart can change what you *see* but never what you *pay*.

Money is stored as **integer paise** (`34900` = ₹349), matching Razorpay's API
and avoiding float rounding when summing line items.

### Payments

Razorpay Standard Checkout, called through the REST API with `fetch` and signed
with WebCrypto. The `razorpay` npm SDK is deliberately **not** used: it does
`require("crypto")` and bundles axios's Node HTTP adapter, so it can't build for
a Worker without `nodejs_compat` (`wrangler deploy --dry-run` fails with
`Could not resolve "crypto"`).

```
browser  POST /api/orders  {items:[{product_id,qty}], customer, delivery}
                           ↑ no amount — the server prices it
worker   priceCart() → Razorpay Orders API → insert order (pending)
browser  Razorpay Checkout modal
   ├── success  → POST /api/orders/verify   (shows a receipt; does NOT mark paid)
   ├── dismiss  → order stays pending, nothing charged
   └── failed   → error shown, order stays pending
razorpay POST /api/webhook/razorpay          ← the source of truth
                           marks paid, sends both emails
```

Two things worth knowing before touching this code:

**Two different secrets.** `KEY_SECRET` signs the checkout callback
(`HMAC(order_id|payment_id)`); `WEBHOOK_SECRET` signs webhooks (`HMAC(raw
body)`). `WEBHOOK_SECRET` is a string you choose in the dashboard. Conflating
them is the most common Razorpay bug, so `test/payments.mjs` asserts each is
rejected in the other's place.

**Testing with cards.** Use a **domestic** test card — `5267 3181 8797 5449`
(Mastercard), CVV `123`, any future expiry, OTP `1111` (4+ digits succeeds,
fewer fails). The card most tutorials give, `4111 1111 1111 1111`, is classed as
*international* by Razorpay and fails on a stock test account with
`international_transaction_not_allowed`. The checkout modal also rejects some
obviously-fake mobile numbers (`9876543210` among them); `9000090000` works.

**The webhook, not the browser, marks an order paid.** `/api/orders/verify`
only proves the callback is genuine so the customer sees a receipt. If the
browser could set `paid`, anyone could POST a fabricated callback; if only the
browser could, a closed tab would lose the order. The webhook route is also
dispatched *before* the router's shared `request.json()`, because its HMAC
covers the exact bytes received — re-serialising parsed JSON breaks
verification.

Five products depicting licensed characters are seeded `visible = 0` — they
stay in the portfolio gallery but aren't listed for sale. Prices in
`0002_seed_products.sql` are **placeholders** and are meant to be corrected in
the admin dashboard before live keys are enabled.

> **Note:** the quote form previously ran on GitHub Actions via `repository_dispatch`,
> which required a GitHub PAT injected into `main.js` at deploy time — readable
> by anyone who viewed source. Now the only credential is a Worker secret and
> nothing sensitive reaches the browser.

---

### Customer accounts

Customers sign in **on the main page** — an inline modal, no separate route —
with **Google, GitHub or Microsoft**, or a **6-digit code emailed to them** — no
password to set, forget, or leak. Built on `@aswincloud/auth`'s OTP primitives
(`generateOtp`/`hashOtp`/`otpHashEquals` and the `otp_codes` table), so codes are
stored peppered-and-hashed with an attempt counter, never in plaintext. Its
higher-level `signup()`/`verifyOtp()` flows are deliberately unused: both require
a password.

Signing in changes the account button into a menu: **My orders** (a second tab
in the cart drawer), **Sign out**, and — only when `/api/me` reports `is_admin` —
**Dashboard**. That menu entry is the only route to `/shop`; nothing else links
it. The flag is a display hint, so a client faking it just gets a link that 401s.

`/shop` is the one page that remains separate, because a 31-row product editor
and an order table need the room.

**Two auth schemes, kept apart.** Admin uses `ap_session` with token purpose
`owner_session`; customers use `ap_user` with purpose `customer_session`. The
purpose is bound into the HMAC, so a customer cookie replayed at `/api/admin/*`
fails signature verification rather than a string comparison someone could later
refactor away. `test/customers.mjs` asserts this in both directions.

**Order history is scoped by the session and nothing else.** `myOrders(env, user)`
takes no url or query argument, so there is no parameter by which one customer
could request another's orders — the function has nowhere to put one. Tested
against a seeded second account with `?user_id=`, `?email=`, `?receipt=` and
`?id=` all attempted.

**The server cart still carries no price.** Rows are `(user_id, product_id, qty)`.
`priceCart()` remains the only thing that decides an amount.

**OAuth is treated as equivalent proof to an emailed code.** Google and GitHub
verify the address, so one account per email regardless of which route was used,
and guest orders are claimed either way. Identities link on
`(provider, provider_user_id)` rather than email — the provider's id is stable
and an email is not, so linking on email would orphan a customer from their own
order history the day they change their Google address.

The callback signs everyone in as a customer, and issues an **additional** admin
cookie when the email is on the `OWNER_EMAIL` allowlist. Being a customer never
implies being an admin.

**Guest orders are claimed on first sign-in** — `UPDATE orders SET user_id …
WHERE user_id IS NULL AND lower(cust_email) = ?`. The code proves control of the
mailbox the order was placed with. Worth being plain about: order history is
therefore only as strong as the customer's email, and an order already attached
to another account is never re-claimed.

**Rate limiting.** `POST /api/auth/code` is unauthenticated and sends email, so:
5 sends per address per hour, the package's 5-attempt cap per code, its 60s
resend cooldown, and `{ok:true}` returned for unknown / throttled / failed-send
alike so the endpoint can't be used to discover which addresses have accounts.
There is no per-IP limit yet — Cloudflare's Rate Limiting binding is the right
tool and needs a dashboard change.

### Dashboard

Reachable two ways, both ending at the same `OWNER_EMAIL` allowlist check:

1. **Broker OAuth** (`ap_session`) — preferred, but needs `site=3dprints`
   registered at `provision.aswincloud.com`.
2. **An emailed code** (`ap_user`) — sign in at `/login` with an address on the
   allowlist. This exists because the broker has no registration for this site
   yet, which left the dashboard unreachable and the placeholder prices
   uneditable.

`currentAdmin()` in `src/auth.js` tries the broker session first, then falls back
to a customer session whose verified email passes `ownerAllowed()`. It is a
second *transport*, not a second policy — a customer cannot self-promote, because
the allowlist only changes via a Worker var.

The trade is worth stating: route 2 makes admin access **email-strength**.
Whoever can read the owner's inbox can issue refunds and read customer addresses.
Prefer route 1 once the broker knows this site.

### Pinning, and the order of the catalogue

Products come out in this order, set by one clause in `listProducts()`
(`src/shop.js`) that both the shop and the dashboard share:

```sql
ORDER BY pinned DESC, created_at DESC, (sort = 0), sort ASC, name ASC
```

1. **Pinned** products.
2. **Newest first** — this is a made-to-order shop and new pieces are added
   weekly, so burying today's print under a batch from three weeks ago is the
   wrong default.
3. **Within one batch**, the curated `sort` sequence, then alphabetically.

The last two keys coexist only because of a fact about the data: all 49 curated
products share a single `created_at`, so ordering by age moves them as one block
and leaves their chosen sequence intact.

This clause has been wrong twice, which is why it is tested the way it is. It
began as plain `ORDER BY sort ASC` — and since `sort` defaults to `0`, the 36
products nobody had ordered sorted *above* the 49 that had been. Fixing that with
`(sort = 0)` then surfaced the opposite problem: the curated batch is the oldest,
so putting it first pushed every new piece to the bottom.

`test/shop.mjs` runs the **shipped** clause against real SQLite rather than a
fake, because the fake does not implement `ORDER BY` and would have proved
nothing. It also asserts the dashboard's clause is character-for-character the
same, since the failure nobody notices is changing one and not the other.

**Pinning is done from the shop itself, not the dashboard.** Signed in as an
admin, every product card grows a **Pin** button in the top-left of its photo;
pinned cards read **Featured**, which is the same badge customers see. It is the
one piece of admin UI on a public page, so it is worth knowing where it lives.

It writes through the existing `PATCH /api/admin/products/:id` — no new route and
no new capability. `is_admin` from `/api/me` only decides whether the button is
*drawn*; the allowlist is re-checked server-side, so faking it in devtools buys a
button that earns a 401. Because `/api/products` is edge-cached for 60 seconds, a
pin reaches other visitors within a minute, while the admin's own tab reorders
immediately.

`test/browser/pin-control.mjs` covers this in chromium and webkit: a customer gets
a badge and no controls, an admin gets the toggle, and unpinning returns the card
to where it came from.

### The promo banner, and who sees it

`PROMO_CODE` names a coupon the homepage advertises. `featuredPromo()`
(`src/shop.js`) only offers a code that would actually work — active, unexpired,
within `max_uses` — so the banner cannot advertise something checkout would then
refuse.

With one exception it could not see: **a customer who has already used a
once-per-customer code.** That answer is per-customer, and `/api/products` is
shared and edge-cached (`cdn-cache-control: s-maxage=60`), so putting it there
would compute it for whoever missed the cache and serve it to everyone else for
the next minute. It rides on `/api/me` instead — per-session and `no-store` — as
`promo_used`, and the banner withdraws itself.

This is **cosmetic**: `applyCoupon()` (`src/coupons.js`) refuses the second
redemption regardless, so nobody can double-redeem either way. What it prevents is
advertising a discount and then declining it at checkout.

The consequence is that the banner's fate depends on two responses that can arrive
in either order, which is most of what `test/browser/promo-banner.mjs` exists to
pin down. A guest who used the code while signed out still sees the banner — there
is no identity to check it against, and inventing one is not worth it.

### Order stages

An order used to have two states a customer ever saw: paid, then shipped. Between
them sat every day the print was actually being made, and nothing was said. The
pipeline is now six stages, defined once in `ORDER_STAGES` (`src/lib.js`) and
enforced by `ALLOWED_TRANSITIONS` (`src/admin.js`):

```
Placed → Confirmed → In production → Ready to ship → Shipped → Delivered
```

**Skipping forward is legal.** `paid → shipped` is still one click, so something
already on the shelf does not need four. `cancelled`, `refunded` and `failed` end
the pipeline rather than advancing it, and render a badge instead of a tracker.

Two invariants survive unchanged: `paid` is set **only** by the Razorpay webhook,
never from the dashboard, and `refunded` is reachable only through the refund
action that actually moves the money.

**Four of the six email.** Confirmed, in production, shipped, delivered. *Ready to
ship* advances the tracker and sends nothing — it is usually hours before shipping,
and two mails that close together read as padding. That decision is implemented as
its absence from `STAGE_EMAIL`, nothing more. Every send fires on the **transition
only**, so correcting a typo'd tracking number a day later does not tell the
customer their order shipped again.

Nothing auto-advances. There is no courier webhook, so `delivered` is a dashboard
click; guessing it from elapsed days would put a claim in a customer's inbox that
nothing verified.

**The tracker is computed on the server.** `stageTimeline()` returns the six
stages with `done` / `current` / `at`, so main.js, the dashboard and the chat bot
cannot drift into different ideas of what a stage is called. A stage counts as
reached when it is at or before the current status, or carries a timestamp, or a
later stage does — three clauses because order data arrives incomplete in three
ways: a skipped stage, rows predating the timestamp columns, and rows carrying a
status with no timestamp at all. The third was found by running the tracker over
the dev database, where such a row drew as one step done beneath a badge reading
*Shipped*; production has none today, but the schema permits one. The orders that
shipped before this feature are the second case, and they are live.

`test/browser/order-tracker.mjs` covers the rendering in chromium and webkit,
including all three of those shapes.

### Quotes, and answering one with a price
<a id="quotes"></a>

A quote request is a **row**, not just an email. `/shop` has a Quotes tab: the
request, the customer's contact details, the attached STL or image, and a status
(`new` → `replied` → `paid`, plus a manual `won` / `lost`).

Answering one prices the job, creates a **Razorpay payment link**, and sends a
branded quotation carrying it. Every reply used to be hand-typed, so pricing
emails looked different each time; now there is one format with the price in a
block of its own.

**A paid link becomes an ordinary order.** `payment_link.paid` carries the link's
`reference_id` — which is the quote's receipt, `QT-<8hex>`, and the only field of
ours that survives the round trip — alongside order and payment entities. The
webhook looks the quote up by it, inserts a paid order with its own `AP-` receipt
and one line item whose `product_id` is NULL, and hands off to the *same*
notification path a checkout order takes. `notifyPaid()` is shared rather than
copied: a second copy is how one of them quietly stops invoicing.

The guards exist because this amount is **typed by hand** rather than computed
from the catalogue, which is the one place in this codebase where that is true:

| guard | why |
|---|---|
| ₹1 floor, ₹5,00,000 ceiling, checked before Razorpay | catches an extra two zeros |
| One live link per quote — handler *and* a `UNIQUE` column | a double-clicked Send would leave two payable links for one job |
| Links expire, 7 days by default | a quoted price should not still be payable next season |
| The link is stored *before* the email is sent | mailing a link we have no record of is the one unrecoverable outcome |
| `paid` cannot be set from the dashboard | same rule as orders: never claim money moved when it did not |

**A payment that matches no quote emails the owner**, with the reference, link id,
Razorpay order id, payment id and amount. Money arriving with nothing created for
it is the one webhook outcome that must not be a log line nobody reads — and it
doubles as the tripwire if Razorpay's payload shape ever moves.

A quote request never asks for a delivery address, so an order created this way
starts without one and the dashboard flags it.

### Made-to-order details

Three products ask the buyer for something the shop used to collect nowhere —
a name on a keychain, the details on a business card, a colour on a stand — while
checkout had one optional order-level Notes box. An order could be paid in full
with no idea what to print.

`products.personalise_label` carries both the flag and the wording: empty means
the product does not ask, so the two cannot disagree. `personalise_required` is
separate, because the stand has a default colour and a blank is a real answer
there, while a keychain with no name is not a product.

The field appears on the cart line **and** in the checkout summary, from one
renderer — because two paths skip the cart entirely (Buy-now on a product page,
and Buy-now in the lightbox). `priceCart()` refuses the order regardless, which is
what actually holds: the API takes a cart from anywhere.

### Listing photos from another agent — `AGENT_TOKEN`

**→ [docs/listing-agent.md](docs/listing-agent.md)** — setup, the exact `curl` calls,
and what the token cannot do.

Photos are pushed to this repo by a separate AI agent, and pricing and describing them
used to mean holding the owner session — which grants every product edit, every order,
refunds and coupons. `AGENT_TOKEN` is a second credential authorising exactly three
routes and nothing else:

| Route | What it does |
|---|---|
| `GET /api/admin/products/unlisted` | which pushed photos have no product row yet |
| `POST /api/admin/products/batch` | create listings — file, `price_paise`, `category`, `description` |
| `POST /api/admin/products/describe` | fill in a description that is **missing** |

Everything else under `/api/admin/` returns 403, including `PATCH /api/admin/products`
— the bulk price editor over existing rows, which is the power being withheld.

The safety is not the allowlist. `writeProductRows()` is a single `INSERT`, and the
describe route's `UPDATE` carries `AND (description IS NULL OR TRIM(description) = '')`
— so **an existing price, name or description cannot be changed through this token at
all**, whatever reaches the handler. `price_paise` is not even in that statement.

Products can be edited **in bulk**: change any number of prices, visibility
toggles or descriptions, then "Save all changes" sends one
`PATCH /api/admin/products` instead of one request per row. The write is
all-or-nothing — every row is validated before anything is written, because a
partial write would leave you unable to tell which of them took. Per-row
Save is still there for a single tweak.

A **search box** filters the list by name, slug, description or category. It runs
against the catalogue already in the page — `/api/admin/products` returns every
row in one response, so there is nothing a round trip could add. A row hidden by
the search keeps any unsaved edit, and the bulk bar says how many of the changes
it is counting are currently out of view, because otherwise "3 unsaved changes"
above a single highlighted row reads as two of them having been lost.

**Descriptions are editable here**, in a panel that opens under the row. Before
this they could only be written by the listing agent or by hand in a migration,
which is why two rows sat blank for weeks; rows without one are now flagged in the
list, so the search finds them. `updateProduct()` already accepted the field — it
was the UI that never sent it. Widening the bulk route does **not** widen the
listing agent: `AGENT_ROUTES` omits `PATCH /api/admin/products` by exact match,
and `test/agent.mjs` asserts it.

`/shop.html` — orders (with status controls and refunds) and products (price,
visibility and description editing, with search). Sign-in goes through the central broker at
`auth.aswincloud.com`: it authenticates with Google/GitHub/Microsoft and relays
the verified email back, signed with this site's `RELAY_SECRET`. There are no
local user or session tables — the session is a signed token in a cookie, and
the email is re-checked against `OWNER_EMAIL` on **every** request, so removing
an address revokes access immediately rather than whenever the cookie lapses.

Two deliberate restrictions:

- **`OWNER_EMAIL` must be non-empty.** `@aswincloud/auth`'s `isOwner()` treats
  an empty allowlist as "allow any authenticated user" — fine for a public site,
  catastrophic for a page showing customer addresses and payment ids. `auth.js`
  therefore checks the allowlist is non-empty *first* and denies everyone if it
  isn't. `test/admin.mjs` asserts this in five ways.
- **The dashboard cannot mark an order paid.** Only the Razorpay webhook does.
  Similarly, `refunded` is only reachable through the refund action, so the
  status can't claim money moved when it didn't.

Deleting a product that appears in any order **hides** it instead, because
`order_items` snapshots the name and price and order history must survive.

## 📬 Get a Quote

Want something printed? Head to the [quote form](https://3d-prints.aswincloud.com/#quote) on the site, or reach out directly:

- 🌐 [aswincloud.com](https://www.aswincloud.com)
- 📧 aswin@aswincloud.com
- 📸 [@3dprinthub.offl](https://www.instagram.com/3dprinthub.offl)
- 📍 Pondicherry, India

---

## 📄 License

© 2026 Aswin Zayasankaran. All rights reserved.
