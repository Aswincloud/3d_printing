-- Gallery photos stored in R2 rather than committed to the repo.
--
-- Until now the only record of what photos exist was public/assets/images.json,
-- generated from the files in public/assets/images/ and committed beside them.
-- That made git the upload protocol: a branch, a PR and two CI waits to add one
-- 250KB JPEG. This table is the other half of the fix (see src/gallery.js) —
-- the listing that R2 can provide and the [assets] binding cannot.
--
-- One row per uploaded photo. `file` is the primary key because it is also the
-- public URL (/assets/images/<file>) and the value written into products.image,
-- so two rows sharing a name could not both be served and must not both exist.
CREATE TABLE IF NOT EXISTS gallery_images (
  file         TEXT PRIMARY KEY,
  key          TEXT NOT NULL,
  bytes        INTEGER NOT NULL DEFAULT 0,
  -- First 8 hex of sha256(bytes), same as scripts/build-image-manifest.mjs, so
  -- the ?v= cache-buster in shop.js works identically for both kinds of photo.
  hash         TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  -- 'owner' or 'agent', matching the two actors in agent.js. Kept so an
  -- unexpected photo can be traced to which credential put it there.
  actor        TEXT NOT NULL DEFAULT 'owner',
  created_at   INTEGER NOT NULL
);

-- galleryImages() reads newest-first on every dashboard and shop request.
CREATE INDEX IF NOT EXISTS idx_gallery_images_created ON gallery_images (created_at DESC);
