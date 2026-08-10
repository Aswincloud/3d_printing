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

Nothing.

The previous entry proposed hiding the eight "Poster ..." rows as non-products.
That was wrong: Aswin ships the real print, and the ad graphic was only standing
in as the product photo. The photos were re-cropped instead, and the rows are
renamed and described in `0012_poster_products.sql`.
