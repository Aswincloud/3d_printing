// Render the 170x70mm QR card to print-ready PDF and a preview PNG.
//
// PDF via Chromium's print path rather than a screenshot, so the QR and the type
// stay vector — the card can be scaled or printed at any DPI without the code
// softening. The PNG is a preview only.
//
// Two PDFs are produced:
//   trim  — exactly 170x70mm, for home printing or a shop that adds its own bleed
//   bleed — 176x76mm with 3mm bleed and crop marks, for a commercial press
//
// Bleed exists because a guillotine drifts by a millimetre or so. Without it, a
// trim that lands 0.5mm inside the artwork leaves a white sliver along the edge of
// a dark card, which is the most obvious way a printed piece looks wrong.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';

const DIR = '/home/aswin/3d_printing/print';
const qr = readFileSync(`${DIR}/qr.svg`, 'utf8');

const base = readFileSync(`${DIR}/card.html`, 'utf8');
if (!base.includes('<!--QR-->')) throw new Error('QR placeholder missing from card.html');

const b = await chromium.launch();

async function render(html, out, { widthMm, heightMm, scale = 1 }) {
  const page = await b.newPage();
  page.on('pageerror', (e) => { throw new Error('page error: ' + e); });
  await page.setContent(html, { waitUntil: 'load' });
  // Wait for Inter specifically. Without this the first render can lay out in the
  // fallback and the type metrics shift — visible as different line breaks between
  // runs, which on a fixed-size card means text sitting where it should not.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  const loaded = await page.evaluate(() => document.fonts.check('700 12px Inter'));
  if (!loaded) console.warn(`  WARN Inter not loaded for ${out} — type will be the fallback`);

  // Inches, not mm. Passing "70mm" produced a 70.19mm MediaBox — Chromium rounds
  // the conversion upward, and a print shop reading 70.19 on a card spec'd at 70
  // will query it. Playwright's parser takes px/in/cm/mm only (pt is rejected), so
  // inches at six decimals is the most precise route to an exact point value.
  await page.pdf({
    path: `${DIR}/${out}.pdf`,
    width: `${(widthMm / 25.4).toFixed(6)}in`,
    height: `${(heightMm / 25.4).toFixed(6)}in`,
    printBackground: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
    pageRanges: '1',
  });

  await page.close();
}

// ── trim: exactly 170x70mm ────────────────────────────────────────
await render(base.replace('<!--QR-->', qr), 'card-170x70', { widthMm: 170, heightMm: 70 });
console.log('  card-170x70.pdf   170 x 70 mm  (trim size)');

// ── bleed: 176x76mm, artwork extended 3mm past the trim on every side ──
const bleedCss = `
<style>
  @page { size: 176mm 76mm; margin: 0; }
  html, body { width: 176mm; height: 76mm; }
  /* Push the content in by the bleed so the LAYOUT is identical to the trim
     version — the background extends into the bleed, the content does not move
     relative to the trim edge. */
  .left  { padding: 11.5mm 0 11mm 13mm; }
  .right { width: 61mm; padding-right: 12mm; }
  .crop { position: absolute; background: #ff6b00; }
</style>
<div class="crop" style="left:0;top:3mm;width:2mm;height:0.2mm"></div>
<div class="crop" style="left:3mm;top:0;width:0.2mm;height:2mm"></div>
<div class="crop" style="right:0;top:3mm;width:2mm;height:0.2mm"></div>
<div class="crop" style="right:3mm;top:0;width:0.2mm;height:2mm"></div>
<div class="crop" style="left:0;bottom:3mm;width:2mm;height:0.2mm"></div>
<div class="crop" style="left:3mm;bottom:0;width:0.2mm;height:2mm"></div>
<div class="crop" style="right:0;bottom:3mm;width:2mm;height:0.2mm"></div>
<div class="crop" style="right:3mm;bottom:0;width:0.2mm;height:2mm"></div>
`;
const bleedHtml = base
  .replace('<!--QR-->', qr)
  .replace('</head>', bleedCss.split('<div')[0] + '</head>')
  .replace('</body>', bleedCss.slice(bleedCss.indexOf('<div')) + '</body>');
await render(bleedHtml, 'card-170x70-bleed', { widthMm: 176, heightMm: 76 });
console.log('  card-170x70-bleed.pdf   176 x 76 mm  (3mm bleed + crop marks)');

// ── light variant ─────────────────────────────────────────────────
//
// The dark card is on-brand but floods ~120cm2 of near-black. On a home inkjet that
// is slow, expensive, prone to banding, and it cockles cheap paper. This variant
// keeps the same layout and type and inverts the ground, so there is a version that
// prints well on whatever Aswin actually has to hand — and it is the better base
// for a sticker or a rubber stamp.
const lightCss = `
<style>
  body { background: #ffffff; color: #1a1a24; }
  body::before { background: radial-gradient(circle, rgba(255,107,0,0.14) 0%, rgba(255,107,0,0) 68%); }
  .brand-name { color: #0a0a0f; }
  .headline { color: #22222e; }
  .headline em { color: #d95a00; }   /* darker orange: #ff8c38 on white is too light to read */
  .url { color: #d95a00; }
  .place { color: #6b6b80; }
  /* The tile no longer needs to exist as a shape — the page is already the quiet
     zone. Kept as padding so the 4-module margin is preserved verbatim. */
  .qr-tile { background: transparent; }
  .scan { color: #6b6b80; }
  .right::before { background: linear-gradient(180deg, rgba(255,107,0,0) 0%, rgba(255,107,0,0.4) 50%, rgba(255,107,0,0) 100%); }
</style>`;
const lightHtml = base
  .replace('<!--QR-->', qr)
  .replace('</head>', lightCss + '</head>');
await render(lightHtml, 'card-170x70-light', { widthMm: 170, heightMm: 70 });
console.log('  card-170x70-light.pdf   170 x 70 mm  (light ground, for home printing)');

// ── 300 DPI preview rasters ───────────────────────────────────────
//
// A separate pass with deviceScaleFactor on the CONTEXT. The earlier version set a
// viewport in px and screenshot at css scale, which produced a 680px-wide image —
// about 100 DPI, and useless as a print proof or as the input to the scan check
// below. CSS mm are 96 px/inch, so the factor for 300 DPI is 300/96.
const DPI = 300;
for (const [html, out, wMm, hMm] of [
  [base.replace('<!--QR-->', qr), 'card-170x70', 170, 70],
  [bleedHtml, 'card-170x70-bleed', 176, 76],
  [lightHtml, 'card-170x70-light', 170, 70],
]) {
  const ctx = await b.newContext({
    viewport: { width: Math.round(wMm * 96 / 25.4), height: Math.round(hMm * 96 / 25.4) },
    deviceScaleFactor: DPI / 96,
  });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/${out}.png` });
  await ctx.close();
  console.log(`  ${out}.png   ${Math.round(wMm * DPI / 25.4)} x ${Math.round(hMm * DPI / 25.4)} px @ ${DPI} DPI`);
}

await b.close();
