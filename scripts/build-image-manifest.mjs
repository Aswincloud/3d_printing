// Writes public/assets/images.json — the list of every product photo in the repo.
//
// ── Why this file exists ─────────────────────────────────────────────────────
//
// Photos live in public/assets/images/ and are committed to git; Cloudflare's
// [assets] binding serves them from the edge. That works well, but the binding
// has NO directory listing — a Worker can fetch /assets/images/x.jpg and cannot
// ask "what files are there?".
//
// So the admin dashboard cannot know a newly-pushed photo exists unless
// something tells it. This generator is that something: it is run alongside
// adding photos, and the manifest it writes is committed and deployed with them.
//
// Run: npm run images
//
// ── The staleness trade-off ──────────────────────────────────────────────────
//
// Push a photo without regenerating and the dashboard will not see it. That is
// the accepted cost of not having a runtime directory listing. It is mitigated
// two ways: test/manifest.mjs fails if the manifest disagrees with the
// directory, and the dashboard shows a hint when nothing is unlisted but the
// counts do not line up.

import { readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE_DIR = join(ROOT, "public", "assets", "images");
const OUT = join(ROOT, "public", "assets", "images.json");

// Only formats a browser will actually render as a product photo. A stray .txt
// or .DS_Store in the directory must not become a listable "product".
const ALLOWED = /\.(jpe?g|png|webp|avif|gif)$/i;

export function scanImages(dir = IMAGE_DIR) {
  return readdirSync(dir)
    .filter((f) => ALLOWED.test(f))
    .map((f) => {
      const s = statSync(join(dir, f));
      return { file: f, bytes: s.size, mtime: s.mtimeMs };
    })
    // Newest first: the reason you are looking at this list is almost always a
    // photo you just added.
    .sort((a, b) => b.mtime - a.mtime);
}

export function buildManifest() {
  const images = scanImages();
  return {
    // Stamped so the dashboard can say how fresh the manifest is. Deliberately
    // NOT a build hash — the useful question is "did I regenerate after adding
    // that photo?", which a date answers and a hash does not.
    generated_at: Date.now(),
    count: images.length,
    images: images.map(({ file, bytes }) => ({ file, bytes })),
  };
}

// Only write when something actually changed, so running this needlessly does
// not produce a diff that has to be reviewed and committed.
function main() {
  const next = buildManifest();
  let prev = null;
  try {
    prev = JSON.parse(readFileSync(OUT, "utf8"));
  } catch { /* first run */ }

  const same = prev
    && prev.count === next.count
    && JSON.stringify(prev.images) === JSON.stringify(next.images);

  if (same) {
    console.log(`images.json unchanged (${next.count} images)`);
    return;
  }

  writeFileSync(OUT, JSON.stringify(next, null, 2) + "\n");

  const before = new Set((prev?.images || []).map((i) => i.file));
  const added = next.images.filter((i) => !before.has(i.file)).map((i) => i.file);
  const afterSet = new Set(next.images.map((i) => i.file));
  const removed = (prev?.images || []).map((i) => i.file).filter((f) => !afterSet.has(f));

  console.log(`images.json written — ${next.count} images`);
  if (added.length) console.log(`  + ${added.length} new: ${added.slice(0, 6).join(", ")}${added.length > 6 ? "…" : ""}`);
  if (removed.length) console.log(`  - ${removed.length} gone: ${removed.slice(0, 6).join(", ")}${removed.length > 6 ? "…" : ""}`);
  if (added.length) console.log("  Commit images.json with the photos, then list them in the dashboard.");
}

// Importable for tests without running the write.
if (import.meta.url === `file://${process.argv[1]}`) main();
