# The listing agent's credential

A second credential that can create product listings for **newly pushed photos** and
do nothing else. It exists so the agent that pushes images can also price and
describe them, without holding the owner session — which grants every product edit,
every order, refunds, and coupons.

## Setup (once)

Generate a token, upload it, and keep one copy long enough to hand to the agent:

    TOKEN=$(openssl rand -base64 48 | tr -d '\n')
    printf '%s' "$TOKEN" | npx wrangler secret put AGENT_TOKEN
    printf '%s\n' "$TOKEN" > ~/agent-token.txt && chmod 600 ~/agent-token.txt
    # paste into the agent's config, then: shred -u ~/agent-token.txt

`printf '%s'`, not `echo`. `echo` appends a newline and wrangler stores it as part of
the secret; the token then never matches, and the failure looks exactly like a wrong
token.

The obvious one-liner — piping `openssl` straight into `wrangler secret put` — uploads
a value you never see, which is no use when the whole point is to give it to a second
party. That mistake was made here first.

The value is never in `wrangler.toml`, never in the repo, and never printed by any of
this code. To rotate, run the three lines again: the new value replaces the old one
immediately.

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
`category` is required and must be one of `figurine`, `decor`, `functional`, `set` —
anything else would add a filter chip to the shop with one product under it.

Response is `201` with the created slugs, or `400` with a message naming the
offending file. **The batch is all-or-nothing** — one bad row and nothing is written.

**3. Fill in a description that is missing.**

For products that already exist but have no description — the ones Aswin bulk-listed
from the dashboard and left blank:

    curl -sS -X POST https://3d-prints.aswincloud.com/api/admin/products/describe \
      -H "Authorization: Bearer $AGENT_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"items":[
            {"slug":"batman-figurine","description":"Two or three sentences.",
             "category":"figurine"}
          ]}'

`category` is optional here; omit it to leave the existing one alone. Descriptions
must be at least **60 characters** — the same threshold `test/verify-catalogue.sh`
calls thin, so the agent cannot write copy the catalogue check then reports.

This route exists because the agent used to have no way to express it and wrote a
migration instead — which it has no credentials to apply. Migration `0017` sat unapplied
for exactly that reason.

## What the token cannot do

Not by convention — by construction, in two independent layers.

**Layer 1: only three routes.** The token authorises exactly
`GET /api/admin/products/unlisted`, `POST /api/admin/products/batch` and
`POST /api/admin/products/describe`, matched on method *and* full path. Everything
else under `/api/admin/` returns **403**, including `PATCH /api/admin/products` — the
bulk price editor over existing rows, which is precisely the power being withheld. A
prefix rule would have let that through, so the match is exact.

**The describe route is the only one that writes to a row the agent did not create,**
so it is the one to be suspicious of. What stops it overwriting is not the validation
in front of it — validation only runs if it is reached. It is the statement itself:

    UPDATE products
       SET description = ?, category = COALESCE(?, category), updated_at = ?
     WHERE slug = ?
       AND (description IS NULL OR TRIM(description) = '')

Overwriting is not a thing that statement can do. `price_paise`, `name`, `slug` and
`visible` are absent from it entirely, so money and shelf presence are not editable
through this route at any privilege level — **not even by the owner**.

That guard is tested by simulating the race it exists for: the fake database reports
every description as empty while the stored rows keep theirs, so the check waves the
write through and only the `WHERE` clause stops it. Delete the clause and that test
fails. Without it the check answered first and the guard was never exercised — proving
the clause was *present*, not that it *worked*.

**Layer 2: the two creating handlers physically cannot edit anything.**
`writeProductRows()` issues a single `INSERT INTO products`. There is no `UPDATE` and
no `DELETE` reachable from the unlisted or batch routes at all. And `planRowsFor()`
independently rejects:

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
| Description | required, ≥60 chars when describing | 60 is the threshold the catalogue check already calls thin |
| Category | must be one of the four | A fifth value silently adds a filter chip with one product under it |

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
