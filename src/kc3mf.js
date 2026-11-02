// The custom keychain print file, Worker side (2026-11-02).
//
// The .3mf itself is built in the owner's browser by public/assets/js/kc-build.js
// — the shop runs on Cloudflare's free plan, 10 ms of CPU per request, and a
// build takes 50-300 ms. All this file does is hand the OWNER the inputs for one
// order line: the design (re-validated), quantity, colours, the font file name,
// and the two private files from the UPLOADS bucket:
//   - the keychain BODY mesh (the "Recessed Heart Keyring" blank body, used with
//     the designer's permission) — never in this public repo;
//   - the Bambu A1 project-settings TEMPLATE (scripts/build-kc-template.py).
// Both are passed through as stored bytes: no parsing, no CPU to speak of.
import { COLOURS, FONTS, parseDesign } from "./keychain.js";
import { bad } from "./lib.js";

export const BODY_KEY = "private/keychain/heart-body.json";
export const TEMPLATE_KEY = "private/keychain/a1-template.json";

// GET /api/admin/orders/<id>/print/<pos> — owner-only: it sits under the
// /api/admin/ gate in index.js, the only way to read the private body.
export async function printJob(env, orderId, pos) {
  const row = await env.DB.prepare(
    `SELECT o.receipt, i.design_id, i.qty FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE i.order_id = ? AND i.pos = ?`).bind(orderId, pos).first();
  const design = row && parseDesign(row.design_id);
  if (!design) return bad("No print file for that line.", 404);
  if (!env.UPLOADS) return bad("File storage isn't configured.", 503);
  const [body, template] = await Promise.all([env.UPLOADS.get(BODY_KEY), env.UPLOADS.get(TEMPLATE_KEY)]);
  if (!body || !template) {
    console.error("keychain print inputs missing from UPLOADS", { body: Boolean(body), template: Boolean(template) });
    return bad("The keychain model files are missing from storage.", 500);
  }
  // Stitched as text, not parsed and re-serialised: the body is ~100 KB of
  // numbers and parsing it would spend the CPU this design exists to avoid.
  const head = JSON.stringify({
    receipt: row.receipt, design, qty: Math.max(1, Number(row.qty) || 1),
    colours: [COLOURS[design.base].hex, COLOURS[design.ink].hex],
    font: `/assets/fonts3d/${FONTS[design.font].file}`,
  });
  const out = `${head.slice(0, -1)},"body":${await body.text()},"template":${await template.text()}}`;
  return new Response(out, { headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  } });
}
