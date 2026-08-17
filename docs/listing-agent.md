# The listing agent's credential

A second credential that can create product listings for **newly pushed photos** and
do nothing else. It exists so the agent that pushes images can also price and
describe them, without holding the owner session — which grants every product edit,
every order, refunds, and coupons.

## Setup (once)

Generate a token and store it as a Worker secret. Do both in one pipe so the value
never lands in a file or a shell history:

    openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put AGENT_TOKEN

Then give the same value to the agent. It is never in `wrangler.toml`, never in the
repo, and never printed by any of this code.

To rotate, run the command again — the new value replaces the old one and the old
token stops working on the next deploy.

## What the agent does

**1. Ask which photos have no product row yet.**

    curl -sS https://3d-prints.aswincloud.com/api/admin/products/unlisted \
      -H "Authorization: Bearer $AGENT_TOKEN"

**2. Create listings for some of them.**

    curl -sS -X POST https://3d-prints.aswincloud.com/api/admin/products/batch \
      -H "Authorization: Bearer $AGENT_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"items":[
            {"file":"batman_figurine.jpg","price_paise":44900,
             "category":"figurine","description":"Two sentences about the print."},
            {"file":"gta6_stand.jpg","price_paise":59900,
             "category":"functional","description":"..."}
          ]}'

`price_paise` is in **paise**: ₹449 is `44900`. Getting this wrong is the single
most likely mistake, so it is also what the bounds below are tuned to catch.

Response is `201` with the created slugs, or `400` with a message naming the
offending file. **The batch is all-or-nothing** — one bad row and nothing is written.

## What the token cannot do

Not by convention — by construction, in two independent layers.

**Layer 1: only two routes.** The token authorises exactly
`GET /api/admin/products/unlisted` and `POST /api/admin/products/batch`, matched on
method *and* full path. Everything else under `/api/admin/` returns **403**, including
`PATCH /api/admin/products` — the bulk price editor over existing rows, which is
precisely the power being withheld. A prefix rule would have let that through, so the
match is exact.

**Layer 2: those two handlers physically cannot edit anything.**
`writeProductRows()` issues a single `INSERT INTO products`. There is no `UPDATE` and
no `DELETE` reachable from either route. And `planRowsFor()` independently rejects:

- any file not in `public/assets/images.json` (so: not pushed to the repo)
- **any file that already has a product row** — this is the "new items only" rule
- the same file twice in one request
- anything containing a scheme or `..`

So even if the route allowlist were bypassed, the SQL on the other side still cannot
touch an existing product.

`test/agent.mjs` asserts all of it from the attacker's side — 14 named capabilities
the token must not have, and that the write path stays INSERT-only.

## Bounds on what it may write

Aswin chose *live immediately*: a price the agent picks is the price a customer pays,
with no review in between. These are sanity rails, not a pricing policy — they cannot
tell a good price from a bad one, only catch the ones that are obviously not prices.

| Rule | Value | Why |
|---|---|---|
| Minimum price | ₹49 | Below this is almost certainly a paise/rupee mix-up |
| Maximum price | ₹15,000 | The dearest real product is ₹12,000 |
| Items per request | 20 | A normal week's photos; more is a runaway loop |
| Description | required, non-empty | A listing with no words is worse than the quote-only card it replaces |

**The total blast radius is bounded by the repo.** Each photo can be listed once, so
even an agent stuck in a loop can create at most one row per unpriced photo already
pushed. It cannot invent new ones.

## You get told

Every agent-created batch emails `OWNER_EMAIL` with each product, its price, and a
link — sent via `ctx.waitUntil`, so it does not slow the agent's request. This is the
only compensating control for publishing without review, so if the mail stops
arriving, treat that as a fault rather than as quiet.

Every batch is also logged: `agent listed 3 product(s): slug@44900 ...`.

## If a price comes out wrong

Fix it in the dashboard as normal. **The agent cannot overwrite your correction** —
once a row exists, that file is "already listed" and every future agent request
refuses it by name.
