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
│   ├── index.html               # Main website (all sections)
│   └── assets/
│       ├── css/style.css        # All styling
│       ├── js/main.js           # Lightbox, animations, quote form, shop + cart
│       └── images/              # 60 sample print photos
├── src/                         # Worker
│   ├── index.js                 # Router: /api/* → api(), else ASSETS.fetch
│   ├── lib.js                   # JSON/HMAC/cookies/escaping/Resend helpers
│   ├── shop.js                  # Catalogue reads + cart pricing (server-side)
│   ├── razorpay.js              # REST client + signature verification
│   ├── orders.js                # Order create/verify/receipt + webhook
│   └── emails.js                # Email HTML templates
├── migrations/                  # D1 schema (forward-only)
│   ├── 0001_init.sql            # products, orders, order_items, webhook_events
│   └── 0002_seed_products.sql   # 31 products from the gallery
├── test/                        # Offline unit tests (`npm test`)
├── wrangler.toml                # Worker + D1 config; vars only, no secrets
└── .github/workflows/
    └── auto-approve.yml         # Dependabot auto-approval
```

### Local development

```bash
npm install
cp .dev.vars.example .dev.vars    # fill in; gitignored, never committed
npm run db:migrate:local
npm run dev                       # http://localhost:8787
npm test                          # offline unit tests, no network
```

### Quote form pipeline

The form posts JSON to `POST /api/quote`. The Worker validates it server-side,
then sends two emails through Resend:

1. **To me** — the full request, with `reply_to` set to the customer.
2. **To the customer** — an acknowledgement summarising what they submitted.

The customer copy is sent via `ctx.waitUntil()`, so a slow send never delays
the response.

### Shop and cart

`GET /api/products` returns the visible catalogue from D1 plus the shipping
config; `assets/js/main.js` renders the grid and the cart drawer from it.

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

## 📬 Get a Quote

Want something printed? Head to the [quote form](https://3d-prints.aswincloud.com/#quote) on the site, or reach out directly:

- 🌐 [aswincloud.com](https://www.aswincloud.com)
- 📧 aswin@aswincloud.com
- 📸 [@3dprinthub.offl](https://www.instagram.com/3dprinthub.offl)
- 📍 Pondicherry, India

---

## 📄 License

© 2026 Aswin Zayasankaran. All rights reserved.
