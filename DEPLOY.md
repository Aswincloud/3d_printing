# Go-live runbook

State: code is on `main`, `3dprints-db` exists and is migrated, and the Worker
**is deployed and serving** at

    https://3d-printing.aswincloud.workers.dev

Note the deployed name is **`3d-printing`** (Workers Builds took it from the
repo), not the `3d-prints` in `wrangler.toml`. The deployed name wins — use
`--name 3d-printing` for every wrangler command below.

`3d-prints.aswincloud.com` is still served by the last GitHub Pages build, so
the leaked token is still exposed until step 5.

Steps 1–3 are yours (dashboard + account actions). Everything after is
verification, and can be re-run any time.

---

## 0. Revoke the leaked GitHub token — do this first

The last Pages build has a real PAT baked into its JavaScript:

```
https://3d-prints.aswincloud.com/assets/js/main.js
→ DISPATCH_TOKEN = 'ghp_…'      scope: public_repo, account: Aswinmcw
```

It has been publicly readable for as long as that build has been live, so treat
it as compromised regardless of what replaces it. **github.com/settings/tokens →
delete it.** Nothing in the current code uses it; the quote form now posts to
`/api/quote` and the credential lives only as a Worker secret.

Then check for misuse across *all* public repos, not just this one:

```bash
gh api /users/Aswinmcw/events --jq '.[] | "\(.created_at) \(.type) \(.repo.name)"' | head -40
```

## 1. Connect Workers Builds — DONE

Deployed as `3d-printing` in the AswinCloud account
(`e38978124c8fdb38dc80c04cda318ab3`), with `DB` → `3dprints-db` and all nine
vars bound. Verified serving. Every push to `main` now deploys; don't run
`wrangler deploy` by hand.

## 2. Set the Worker secrets

None are set yet (`wrangler secret list --name 3d-printing` → `[]`).

```bash
export CLOUDFLARE_API_TOKEN="$CF_TOKEN"
export CLOUDFLARE_ACCOUNT_ID=e38978124c8fdb38dc80c04cda318ab3
N="--name 3d-printing"

npx wrangler secret put RESEND_API_KEY          $N   # re_…
npx wrangler secret put RAZORPAY_KEY_ID         $N   # rzp_test_…
npx wrangler secret put RAZORPAY_KEY_SECRET     $N   # the 24-char one
npx wrangler secret put RAZORPAY_WEBHOOK_SECRET $N   # NOT the above — see below
```

### The three Razorpay values are three different things

| Value | Where it comes from | What it's for |
|---|---|---|
| `RAZORPAY_KEY_ID` | Razorpay issues it | Public. Ships to the browser. |
| `RAZORPAY_KEY_SECRET` | Razorpay issues it | API password; signs the checkout callback. |
| `RAZORPAY_WEBHOOK_SECRET` | **You invent it** | Signs webhooks. Typed into the dashboard's "Secret" field when creating the webhook. |

The third is not the second. Razorpay never issues it. Setting them to the same
string makes every webhook fail signature verification, which means paid orders
never leave `pending`.

Until they are set the Worker still serves: the site, gallery and catalogue all
work, and the quote form / checkout / webhook each return a 503 with a clear
message rather than a 500. So a missed secret is visible, not silent.

Without `RAZORPAY_WEBHOOK_SECRET`, **paid orders never leave `pending`**: no
fulfilment, no emails. The customer is charged and sees a receipt, and you never
find out. It's the one secret whose absence is damaging rather than merely
obvious.

Phase 4 sign-in also needs `SESSION_SECRET` and `RELAY_SECRET` from
`provision.aswincloud.com` for `site=3dprints`. Without them the dashboard shows
"sign-in is not configured" — the shop is unaffected.

## 3. Register the Razorpay webhook

Razorpay dashboard → Settings → Webhooks → Add:

- URL: `https://3d-printing.aswincloud.workers.dev/api/webhook/razorpay`
  (switch to `https://3d-prints.aswincloud.com/api/webhook/razorpay` after step 5)
- Secret: the same string you set as `RAZORPAY_WEBHOOK_SECRET`
- Events: `order.paid` and `payment.failed`

Only those two. `payment.captured` fires alongside `order.paid` and would be
handled twice. (The event-id dedup would catch it, but there is no reason to
subscribe to it.)

## 4. Verify on `*.workers.dev` before moving the domain

Already run once and passing: 26 products from remote D1, all three admin
routes 401, quote/checkout/webhook each 503 (no secrets yet), no credential of
any kind in the served JS, dashboard and the new poster both 200. Re-run after
setting secrets — the 503s should become real responses.

```bash
W=https://3d-printing.aswincloud.workers.dev

curl -s $W/api/health                       # {"ok":true,...}
curl -s $W/api/products | head -c 200       # 26 products
curl -s -o /dev/null -w '%{http_code}\n' $W/            # 200, the site itself
curl -sL -o /dev/null -w '%{http_code}\n' $W/shop     # 200, sign-in panel

# every admin route must refuse an unauthenticated caller
for p in stats products orders; do
  curl -s -o /dev/null -w "$p %{http_code}\n" $W/api/admin/$p
done                                        # all 401

# no secret reached the browser
curl -s $W/assets/js/main.js | grep -c 'rzp_\|re_\|_secret'   # 0
```

Then click through it: gallery lightbox, add to cart, cart persists on reload,
checkout validation, and the Razorpay modal opening with the right amount.

## 5. Move the domain

Only after step 4 passes.

1. Cloudflare → Workers & Pages → `3d-printing` → Settings → Domains & Routes →
   **Add custom domain** → `3d-prints.aswincloud.com`
2. GitHub → repo Settings → Pages → set Source to **None** (disables Pages)

DNS is already Cloudflare-managed, so propagation is quick. `CNAME` is already
deleted from the repo, and the Pages workflow is gone, so nothing will
re-deploy the old build.

**Rollback:** re-add a `CNAME` file containing `3d-prints.aswincloud.com`,
restore `.github/workflows/deploy.yml` from `git show 83cd615:.github/workflows/deploy.yml`,
and re-enable Pages. Worth knowing the old build *contains the leaked token*, so
rolling back re-exposes it — revoke it (step 0) and rollback stays safe.

## 6. Post-cutover

```bash
curl -s https://3d-prints.aswincloud.com/api/health
curl -s https://3d-prints.aswincloud.com/assets/js/main.js | grep -c ghp_   # must be 0
```

Then a real ₹1 test order:

1. Temporarily set one product to ₹1 in the dashboard
2. Buy it with a **domestic** test card — `5267 3181 8797 5449`, CVV `123`,
   expiry `12/28`, OTP `1111`. (`4111 1111 1111 1111` is classed international
   and fails on a stock test account.)
3. Confirm the order flips `pending → paid` in the dashboard — that proves the
   webhook is reaching you, which is the one thing local testing cannot show
4. Confirm both emails arrive
5. Put the price back

## Still open after go-live

- **Prices are placeholders.** Four bands (₹349/₹549/₹899/₹1299) guessed from
  apparent size, not filament and time. Correct them in the dashboard before
  live keys.
- **Live mode needs KYC** (~3 business days) plus live keys, a live webhook, and
  a fresh ₹1 test. Confirm Razorpay accepts "custom 3D printed goods" during
  onboarding.
- **Licensed IP.** Five products depicting third-party characters (Marvel, DC,
  Disney, Cloudco, Daher) are seeded `visible = 0`. Selling them is commercial
  use of someone else's character — a takedown and aggregator-compliance risk.
  Decide per item. Two gallery-only collection photos also show Kratos,
  Deadpool, Naruto and Toothless; portfolio use is the lower-risk position.
