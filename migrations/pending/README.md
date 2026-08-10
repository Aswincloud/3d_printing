# Held migrations

SQL that is written and reviewed but deliberately **not** applied, because the
decision it encodes is the shop owner's to make.

These files live outside `migrations/` for a mechanical reason, not a tidiness
one: `wrangler d1 migrations apply` runs **every** unapplied migration in order.
A held migration left in `migrations/` with a "do not apply" comment gets swept
along by the next unrelated migration, and the comment is not read by anything.
Moving it out is the only thing that actually prevents that.

To apply one, move it back into `migrations/` and renumber it after the current
highest, so the sequence stays monotonic:

    git mv migrations/pending/00NN_name.sql migrations/00NN_name.sql
    npx wrangler d1 migrations apply 3dprints-db --remote

## Currently held

- **0012_hide_non_products.sql** — withdraws 10 cards that are not products
  (8 Instagram marketing graphics listed as buyable at ₹129–₹349, and 2 group
  shots of a shelf at ₹999 with no defined contents). Aswin chose to keep them
  on sale for now and decide separately. Uses `visible = 0`, never `DELETE`, so
  applying it is reversible and no ids are lost.
