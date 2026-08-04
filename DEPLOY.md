# Go-live runbook

**LIVE at https://3d-prints.aswincloud.com** (also reachable at
https://3d-printing.aswincloud.workers.dev).

Cutover completed: all four secrets set, the Pages CNAME replaced with a Worker
custom domain, and GitHub Pages disabled. Verified on the live domain — 26
products from D1, admin routes 401, no credential in any client asset, and a
real Razorpay order created with an injected `price_paise: 1` correctly ignored.

The Worker is named **`3d-printing`** (Workers Builds took it from the repo);
`wrangler.toml` now matches, so a plain `wrangler deploy` updates the live one.

**Still outstanding: revoke the leaked GitHub PAT (step 0).** It is no longer
served anywhere, but it was public for weeks and is still valid.

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

## 2. Set the Worker secrets — DONE

All four are set: `RESEND_API_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
`RAZORPAY_WEBHOOK_SECRET`. Verified live: checkout creates real Razorpay orders,
the webhook rejects a bad signature with 400 (not 503), and the quote form sends
through Resend.

To rotate any of them:

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

## 5. Move the domain — DONE

The Pages CNAME (`3d-prints` → `aswincloud.github.io`) was deleted and replaced
with a Worker custom domain; Cloudflare refuses to attach one while an
externally-managed record exists, so the delete has to come first. GitHub Pages
is now disabled, which removed the build containing the token.

**Rollback** (now slower, since Pages is disabled): re-enable Pages on `main`,
restore `.github/workflows/deploy.yml` from
`git show 83cd615:.github/workflows/deploy.yml`, re-add a `CNAME` file, then
recreate the DNS record — `CNAME 3d-prints.aswincloud.com → aswincloud.github.io`,
unproxied, TTL auto. Note the rebuilt Pages site would contain the leaked token
again unless it's been revoked.

## 6. Post-cutover — the ₹1 test is still to do

Health and the token check both pass. What remains is the one thing that can't
be verified without a public URL and a real payment:

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
