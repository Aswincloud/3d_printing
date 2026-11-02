// Keychain STYLES (2026-11-02): the owner's ten designs, each made from the
// customer's name. Shared by the shop's 3D preview and the .3mf builder, so
// what the customer sees is what prints.
//
// Each style was measured from the owner's 3MF (used with each designer's
// permission): outline offsets, layer heights, ring-hole size and gap. A style
// says how to turn the name's outline into layers; build(text, font) returns
//   { parts: [{ name, slot, shape, z0, z1 }], size: { w, h } }
// where shape is in mm (kc-shapes.js), z in mm from the bed, slot 1 = base
// colour, 2 = text colour, 3 = accent (charm / inner outline).
//
// "heart" and "ribbon" put the name on a fixed body mesh (private, from the
// owner's file); their parts list holds the name only, and `body` says which.
import { union, offset, difference, solid, circle, bounds, translate, leftmostAt, rightmostAt, topAt, largest } from "./kc-shapes.js";
import { textGlyphs } from "./kc-text.js";

// The name as one shape, `height` mm tall (cap to baseline of the tallest
// glyph), left edge at x = 0, vertically centred on y = 0.
export function nameShape(text, font, height, maxWidth = Infinity) {
  const glyphs = textGlyphs(text, font).flat();
  if (!glyphs.length) return { shape: [], w: 0, h: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of glyphs) for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const s = Math.min(height / (y1 - y0), maxWidth / (x1 - x0));
  const my = (y0 + y1) / 2;
  // Glyph rings are drawn with outlines and holes in either winding; a
  // non-zero union of outlines minus holes per glyph is what the font means.
  const placed = textGlyphs(text, font).map((g) => g.map((r) => r.map(([x, y]) => [(x - x0) * s, (y - my) * s])));
  const shape = union(...placed.map(glyphShape));
  const b = bounds(shape);
  return { shape, w: b.w, h: b.h };
}

// One glyph's rings → a shape: rings inside an odd number of others are holes.
function glyphShape(rings) {
  const inside = ([x, y], ring) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const depth = rings.map((r, i) => rings.reduce((n, o, j) => n + (j !== i && inside(r[0], o) ? 1 : 0), 0));
  const outers = rings.filter((_, i) => depth[i] % 2 === 0).map((r) => [[r]]);
  const holes = rings.filter((_, i) => depth[i] % 2 === 1).map((r) => [[r]]);
  return holes.length ? difference(union(...outers), union(...holes)) : union(...outers);
}

// The y where a shape's right end is (for the shadow style's ring): the middle
// of the shape's height, where every name has letters.
const rightAtY = (shape) => { const b = bounds(shape); return (b.y0 + b.y1) / 2; };

// A thin bar along the middle of a name, from its first letter to its last:
// unioned in before outlining so the backing is ONE piece even for spaced-out
// text ("A . B"), where the outline alone would leave separate islands.
function spine(name, frac = 0.12) {
  const b = bounds(name), h = Math.max(1.2, b.h * frac);
  return [[[[b.x0 + 1, -h], [b.x1 - 1, -h], [b.x1 - 1, h], [b.x0 + 1, h]]]];
}

// A ring tab: a disc of radius `r + wall` at (cx, cy) joined to `shape`, with
// a hole of radius r. Returns { tab, hole }.
function ringTab(cx, cy, r, wall) {
  return { tab: circle(cx, cy, r + wall), hole: circle(cx, cy, r) };
}

// Bubble outline styles: name raised on an outline of the name, ring tab at the
// left end. All measured from the owner's files.
function bubble({ height, out, ringR, ringGap, baseZ, nameZ, maxW = 90, inner = null, ringAt = "left" }) {
  return (text, font) => {
    const n = nameShape(text, font, height, maxW);
    if (!n.shape.length) return null;
    const name = translate(n.shape, -n.w / 2, 0);
    const back = solid(offset(union(name, spine(name)), out));
    let cx, cy;
    if (ringAt === "top") {
      // A tab above the middle of the name (the "52" heart style).
      // Centred over the name, overlapping the outline's top so it is joined.
      // Over the highest point of the outline's middle third (script capitals
      // and ascenders vary), overlapping it by a millimetre so they join.
      const b = bounds(back);
      let best = -Infinity, bx = 0;
      for (let x = b.x0 + b.w / 3; x <= b.x1 - b.w / 3; x += 0.5) { const t = topAt(back, x); if (t > best) { best = t; bx = x; } }
      cx = bx; cy = best + ringR + out - 1;
    } else {
      cx = leftmostAt(name, 0) - ringGap - ringR; cy = 0;
    }
    const { tab, hole } = ringTab(cx, cy, ringR, out);
    const base = largest(difference(union(back, tab), hole));
    const parts = [{ name: "Outline", slot: 1, shape: base, z0: 0, z1: baseZ }];
    if (inner) {
      // A second, thinner outline in the accent colour between base and name.
      parts.push({ name: "Inner outline", slot: 3, shape: largest(difference(solid(offset(union(name, spine(name)), inner.out)), hole)), z0: baseZ, z1: inner.z1 });
      parts.push({ name: "Name", slot: 2, shape: name, z0: inner.z1, z1: nameZ });
    } else {
      parts.push({ name: "Name", slot: 2, shape: name, z0: baseZ, z1: nameZ });
    }
    const b = bounds(base);
    return { parts, size: { w: b.w, h: b.h } };
  };
}

// A five-petal flower, star or heart charm, `d` mm across, centred on (cx, cy).
function charmShape(kind, cx, cy, d) {
  const r = d / 2, ring = [];
  if (kind === "star") {
    for (let i = 0; i < 10; i++) { const a = Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r; ring.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); }
    return offset([[ring]], 0.8);
  }
  if (kind === "heart") {
    for (let i = 0; i < 64; i++) {
      const t = (i / 64) * Math.PI * 2;
      const x = 16 * Math.sin(t) ** 3, y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      ring.push([cx + (x / 34) * d, cy + (y / 34) * d + d * 0.05]);
    }
    return [[ring]];
  }
  // flower: five petals round a centre
  const petals = [];
  for (let i = 0; i < 5; i++) { const a = Math.PI / 2 + (i * 2 * Math.PI) / 5; petals.push(circle(cx + r * 0.52 * Math.cos(a), cy + r * 0.52 * Math.sin(a), r * 0.48)); }
  return union(...petals, circle(cx, cy, r * 0.4));
}

export const STYLES = {
  // The heart name keyring: the name in the recess of a fixed body.
  heart: { name: "Heart tag", body: "heart", font: "rounded", colours: 2,
    build: null },
  // Script name on a pink-style outline. Nicole: 3 mm thick, name 1 mm proud,
  // outline 2.25 mm, ring r 1.5.
  bubble: { name: "Bubble script", font: "script", colours: 2,
    build: bubble({ height: 16, out: 2.25, ringR: 1.5, ringGap: 1.2, baseZ: 2, nameZ: 3 }) },
  // LauraF: bigger, double outline (outer base, inner accent rim), ring r 2.5.
  double: { name: "Double outline", font: "script", colours: 3,
    build: bubble({ height: 24, out: 4, ringR: 2.5, ringGap: 1.0, baseZ: 1.5, nameZ: 4.5, maxW: 80, inner: { out: 2, z1: 3 } }) },
  // "52": cursive name, outline 2.75 mm, ring tab on top. 3.2 + 1.2 mm.
  topring: { name: "Script, ring on top", font: "hand", colours: 2,
    build: bubble({ height: 22, out: 2.75, ringR: 2.25, ringGap: 1, baseZ: 3.2, nameZ: 4.4, ringAt: "top" }) },
  // name+keychain (Olivia): 2 mm outline, 2 + 1 mm, ring r 2 on the left.
  classic: { name: "Classic script", font: "brush", colours: 2,
    build: bubble({ height: 24, out: 2, ringR: 2, ringGap: 2, baseZ: 2, nameZ: 3 }) },
  // namekey: chunky name on a wide wavy bubble, 3 mm base + 2 mm name.
  chunky: { name: "Chunky bubble", font: "rounded", colours: 2,
    build: bubble({ height: 16, out: 3.25, ringR: 2.5, ringGap: 1, baseZ: 3, nameZ: 5, maxW: 60 }) },
  // ParametricModelMaker: name on a bubble with a flower/star/heart charm at the
  // start. Base 2.5, charm and name to 5.
  charm: { name: "Flower charm", font: "rounded", colours: 3, charm: "flower",
    build: (text, font) => {
      const n = nameShape(text, font, 15, 75);
      if (!n.shape.length) return null;
      const name = translate(n.shape, -n.w / 2 + 8, 0);
      // The flower sits just left of the name, its petals clear of the letters.
      const charm = charmShape("flower", leftmostAt(name, 0) - 10.5, 0, 19);
      const back = solid(offset(union(name, charm, spine(union(name, charm))), 3));
      const { tab, hole } = ringTab(bounds(back).x0 + 1, 0, 1.8, 2);
      const base = largest(difference(union(back, tab), hole));
      const b = bounds(base);
      return { parts: [
        { name: "Outline", slot: 1, shape: base, z0: 0, z1: 2.5 },
        { name: "Name", slot: 2, shape: name, z0: 2.5, z1: 5 },
        { name: "Charm", slot: 3, shape: difference(charm, hole), z0: 2.5, z1: 4.5 },
      ], size: { w: b.w, h: b.h } };
    } },
  // NameKeychain: a big initial behind the name. Initial 3.5 mm, name 5 mm,
  // name outline to 2 mm.
  initial: { name: "Big initial", font: "script", colours: 2,
    build: (text, font, initialFont) => {
      const first = [...text][0];
      const big = nameShape(first.toUpperCase(), initialFont || font, 46);
      const n = nameShape(text, font, 13, 52);
      if (!big.shape.length || !n.shape.length) return null;
      const initial = translate(big.shape, -big.w / 2, 0);
      const name = translate(n.shape, -n.w / 2, -6);
      // Ring on the letter's top edge, a third of the way across, overlapping
      // the letter so the two are one piece.
      const b0 = bounds(initial);
      const rx = b0.x0 + b0.w * 0.3;
      const { tab, hole } = ringTab(rx, topAt(initial, rx) + 1.6, 1.6, 1.6);
      // One piece, as in the owner's file: the initial and the name's backing
      // joined, 3.5 mm; the name stands on it to 5 mm.
      const body = largest(difference(union(initial, solid(offset(union(name, spine(name)), 1.8)), tab), hole));
      const b = bounds(body);
      return { parts: [
        { name: "Initial", slot: 1, shape: body, z0: 0, z1: 3.5 },
        { name: "Name", slot: 2, shape: name, z0: 3.5, z1: 5 },
      ], size: { w: b.w, h: b.h } };
    } },
  // Ada (KPOP): bold name over a hard drop-shadow, ring on the right.
  // Shadow 2 mm, name 2 + 3 mm.
  shadow: { name: "Drop shadow", font: "rounded", colours: 2,
    build: (text, font) => {
      const n = nameShape(text, font, 20, 100);
      if (!n.shape.length) return null;
      const name = translate(n.shape, -n.w / 2, 0);
      // The base IS the shadow: the name's outline pushed down-right, so the
      // name (in the text colour) stands on a solid offset silhouette.
      // Letters 3+ mm apart would leave separate islands at a small offset, so
      // the silhouette is grown enough to join every letter (KPOP files are one
      // piece too), then the shadow is that silhouette pushed down-right.
      // A bar through the middle of the name joins any letters the outline
      // alone leaves apart (wide gaps in "Sophia"); the outline rounds it off.
      const sil = solid(offset(union(name, spine(name, 0.18)), 2.2));
      const back = solid(union(sil, translate(sil, 2, -2)));
      // Ring on the right end (as in the owner's KPOP file), its tab overlapping
      // the outline's real right edge at mid-height so the two are one piece.
      const cy = rightAtY(back);
      // Hole fully outside the outline (centre = edge + radius + 0.8 mm), its
      // wall overlapping the outline: one solid piece, never a thin web.
      const { tab, hole } = ringTab(rightmostAt(back, cy) + 2.2 + 0.8, cy, 2.2, 2.2);
      const base = largest(difference(union(back, tab), hole));
      const b = bounds(base);
      return { parts: [
        { name: "Shadow", slot: 1, shape: base, z0: 0, z1: 2 },
        { name: "Name", slot: 2, shape: name, z0: 2, z1: 5 },
      ], size: { w: b.w, h: b.h } };
    } },
  // Ribbon: the name on a fixed bow body.
  ribbon: { name: "Ribbon bow", body: "ribbon", font: "hand", colours: 3,
    build: null },
};
