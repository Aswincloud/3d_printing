// Render the 70x155mm portrait QR card to print-ready PDF and a 300 DPI preview.
//
// PDF via Chromium's print path rather than a screenshot, so the QR and the type
// stay vector — the card can be scaled or printed at any DPI without the code
// softening. The PNG is a preview only.
//
// Two PDFs:
//   trim  — exactly 70x155mm, for home printing or a shop that adds its own bleed
//   bleed — 76x176mm with 3mm bleed and crop marks, for a commercial press
//
// Bleed exists because a guillotine drifts by a millimetre or so. On a white card a
// slightly-inside trim leaves no visible sliver, which is precisely why the bleed
// version also carries crop marks: they are the cut guide, and they work regardless
// of ground colour.
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const DIR = '/home/aswin/3d_printing/print';
const qr = readFileSync(`${DIR}/qr.svg`, 'utf8');
const base = readFileSync(`${DIR}/card.html`, 'utf8');
if (!base.includes('<!--QR-->')) throw new Error('QR placeholder missing from card.html');

const W_MM = 70, H_MM = 155, BLEED = 3;

const b = await chromium.launch();

async function pdf(html, out, widthMm, heightMm) {
  const page = await b.newPage();
  page.on('pageerror', (e) => { throw new Error('page error: ' + e); });
  await page.setContent(html, { waitUntil: 'load' });
  // Wait for Inter. Without this the first render can lay out in the fallback and
  // the metrics shift — different line breaks between runs, which on a fixed-size
  // card means text landing where it should not.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  if (!(await page.evaluate(() => document.fonts.check('700 12px Inter')))) {
    console.warn(`  WARN Inter not loaded for ${out} — type will be the fallback`);
  }

  // preferCSSPageSize, NOT width/height.
  //
  // This is the bug Aswin spotted. Passing width/height while the CSS also declares
  // `@page { size: 70mm 155mm }` makes Chromium lay out for one box and print to
  // another: the content came out scaled to about 84% and pushed into the top-left
  // corner, 5.6mm left of centre. The screenshot path was unaffected, which is why
  // every check passed — I was verifying the PNG and shipping the PDF.
  //
  // Deferring to the CSS page size fixes the offset and the size rounding at once:
  // the MediaBox lands on exactly 70 x 155mm instead of the 70.19mm Chromium
  // produced when converting a passed dimension.
  await page.pdf({
    path: `${DIR}/${out}.pdf`,
    preferCSSPageSize: true,
    printBackground: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
    pageRanges: '1',
  });
  await page.close();
}

// ── trim ──────────────────────────────────────────────────────────
const trimHtml = base.replace('<!--QR-->', qr);
await pdf(trimHtml, 'card-70x155', W_MM, H_MM);
console.log(`  card-70x155.pdf         ${W_MM} x ${H_MM} mm  (trim size)`);

// ── bleed ─────────────────────────────────────────────────────────
// Content pushed in by the bleed so the layout is IDENTICAL relative to the trim
// edge: the background extends into the bleed, the content does not move.
const bw = W_MM + BLEED * 2, bh = H_MM + BLEED * 2;
const bleedHead = `
<style>
  @page { size: ${bw}mm ${bh}mm; margin: 0; }
  html, body { width: ${bw}mm; height: ${bh}mm; }
  body { padding: 0 ${8 + BLEED}mm; }
  .top { top: ${11 + BLEED}mm; left: ${8 + BLEED}mm; right: ${8 + BLEED}mm; }
  .below, .foot { left: ${8 + BLEED}mm; right: ${8 + BLEED}mm; }
  .foot { bottom: ${11 + BLEED}mm; }
  .crop { position: absolute; background: #ff6b00; }
</style>`;
const marks = [
  `left:0;top:${BLEED}mm;width:2mm;height:0.2mm`,
  `left:${BLEED}mm;top:0;width:0.2mm;height:2mm`,
  `right:0;top:${BLEED}mm;width:2mm;height:0.2mm`,
  `right:${BLEED}mm;top:0;width:0.2mm;height:2mm`,
  `left:0;bottom:${BLEED}mm;width:2mm;height:0.2mm`,
  `left:${BLEED}mm;bottom:0;width:0.2mm;height:2mm`,
  `right:0;bottom:${BLEED}mm;width:2mm;height:0.2mm`,
  `right:${BLEED}mm;bottom:0;width:0.2mm;height:2mm`,
].map((s) => `<div class="crop" style="${s}"></div>`).join('');

const bleedHtml = base
  .replace('<!--QR-->', qr)
  .replace('</head>', bleedHead + '</head>')
  .replace('</body>', marks + '</body>');
await pdf(bleedHtml, 'card-70x155-bleed', bw, bh);
console.log(`  card-70x155-bleed.pdf   ${bw} x ${bh} mm  (${BLEED}mm bleed + crop marks)`);

// ── 300 DPI preview rasters ───────────────────────────────────────
// deviceScaleFactor on the CONTEXT, which is the only way to get a true 300 DPI
// bitmap. An earlier version set a viewport in px and screenshot at css scale,
// producing about 100 DPI — useless as a proof and useless as input to the scan
// check. CSS mm are 96 px/inch, so the factor for 300 DPI is 300/96.
const DPI = 300;
for (const [html, out, wMm, hMm] of [
  [trimHtml, 'card-70x155', W_MM, H_MM],
  [bleedHtml, 'card-70x155-bleed', bw, bh],
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
