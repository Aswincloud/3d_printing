// Cross-engine geometry check for the hero strip.
//
// WHY THIS EXISTS. The hero cards were sized by asking the engine "how wide is
// this picture at this height" — card width:auto, image width:auto height:100%.
// Chromium answered from the aspect ratio and produced a 221x295 card. WebKit
// took the max-content contribution from the image's natural 1200px width, hit
// the max-width, and produced 335x295: a 3:4 portrait cover-cropped top and
// bottom. Every screenshot and measurement taken during that work was Chromium,
// so it shipped, and the report came from a real iPhone.
//
// WHAT IT ASSERTS, and deliberately not more:
//
//   1. The engines AGREE. This is the real check. It encodes no opinion about
//      what the design should be, so it keeps working when the design changes —
//      it only fails when two browsers disagree about it, which is the bug class
//      that got through.
//
//   2. No card crops more than CROP_LIMIT of its photo. A floor against the
//      original complaint (35% of a dinosaur) coming back in BOTH engines at
//      once, which agreement alone would not catch.
//
//   3. The page does not scroll sideways. The strip scrolls; the document must
//      not.
//
// Runs against the static files, not the Worker: this is CSS geometry, so it
// needs no D1, no secrets and no wrangler.

import { chromium, webkit } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const WIDTHS = [360, 390, 480, 768];
const CROP_LIMIT = 0.25;      // no card may hide more than 25% of its photo
const TOLERANCE = 1.5;        // px; sub-pixel layout differs harmlessly

let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// A browser that will not start is a check that is not running. Locally that is
// worth tolerating with a loud warning — WebKit needs GTK and GStreamer libraries
// a dev box may not have. In CI it is not: an engine silently dropping out is how
// this bug reached a phone in the first place, so CI=true makes it fatal.
const REQUIRE_ALL = process.env.CI === 'true';
const skipped = new Set();

async function launch(engine, name) {
  try {
    return await engine.launch();
  } catch (e) {
    const msg = String(e.message).split('\n')[0];
    if (REQUIRE_ALL) {
      console.error(`\n  ${name} could not start, and CI requires it: ${msg}`);
      process.exit(1);
    }
    if (!skipped.has(name)) {
      console.warn(`\n  !! ${name} could not start — SKIPPING it. ${msg}`);
      console.warn('     This run therefore proves nothing about cross-engine agreement.');
      skipped.add(name);
    }
    return null;
  }
}

async function measure(engine, width, name) {
  const b = await launch(engine, name);
  if (!b) return null;
  const p = await b.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: 2 });
  await p.goto(BASE + '/index.html', { waitUntil: 'load' });
  // Static markup, so the images are the only thing to wait for.
  await p.waitForTimeout(500);
  const out = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.hero-shot')].map((a) => {
      const img = a.querySelector('img');
      const r = a.getBoundingClientRect();
      const scale = Math.max(r.width / img.naturalWidth, r.height / img.naturalHeight);
      return {
        src: img.getAttribute('src').replace(/^.*\//, ''),
        w: +r.width.toFixed(1),
        h: +r.height.toFixed(1),
        // Fraction of the photo actually visible through object-fit: cover.
        shown: (r.width / (img.naturalWidth * scale)) * (r.height / (img.naturalHeight * scale)),
      };
    });
    const d = document.documentElement;
    const strip = document.querySelector('.hero-visual');
    return {
      cards,
      hScroll: d.scrollWidth > d.clientWidth + 1,
      // "No horizontal scroll" has to mean the strip too, not just the page. It
      // used to be a carousel that scrolled INSIDE a page that did not — which is
      // precisely the thing that was unwanted, and a page-level check would have
      // called it fine.
      stripScrolls: strip ? strip.scrollWidth > strip.clientWidth + 1 : false,
    };
  });
  await b.close();
  return out;
}

for (const width of WIDTHS) {
  console.log(`\n${width}px`);
  const c = await measure(chromium, width, 'chromium');
  const w = await measure(webkit, width, 'webkit');

  for (const [eng, m] of [['chromium', c], ['webkit', w]]) {
    if (!m) continue;
    ok(`${eng} does not scroll the page sideways`, !m.hScroll);
    ok(`${eng} — the hero strip itself does not scroll sideways`, !m.stripScrolls);
    for (const card of m.cards) {
      ok(`${card.src} — ${eng} shows at least ${(1 - CROP_LIMIT) * 100}% of the photo`,
         card.shown >= 1 - CROP_LIMIT,
         `${Math.round(card.shown * 100)}% shown at ${card.w}x${card.h}`);
    }
  }

  if (!c || !w) continue;

  ok('same number of cards in both engines',
     c.cards.length === w.cards.length, `${c.cards.length} vs ${w.cards.length}`);

  for (let i = 0; i < Math.min(c.cards.length, w.cards.length); i++) {
    const a = c.cards[i], b2 = w.cards[i];
    const dw = Math.abs(a.w - b2.w), dh = Math.abs(a.h - b2.h);
    ok(`${a.src} — engines agree on size`,
       dw <= TOLERANCE && dh <= TOLERANCE,
       `chromium ${a.w}x${a.h}, webkit ${b2.w}x${b2.h}`);
  }
}

if (skipped.size) {
  console.warn(`\n  !! ${[...skipped].join(', ')} did not run. Cross-engine agreement was NOT checked.`);
}
console.log(fail ? `\n  ${fail} failed` : '\n  hero geometry OK');
process.exit(fail ? 1 : 0);
