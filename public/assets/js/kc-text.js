// Keychain text outline and layout (2026-11-02), SHARED by the browser preview
// (public/assets/js/keychain.js) and the printable 3MF (src/kc3mf.js), so the
// name the customer sees is the name that prints: same glyphs, same size, same
// place in the recess.
//
// Fonts are the kc-*.json files built by scripts/build-kc-fonts.py (three.js
// typeface format, overlaps already merged per glyph). Contours are closed
// implicitly; "m" starts one, "l" a line, "q x y cx cy" a quadratic curve
// (end point first, then the control point — the order three.js reads).
//
// No imports: the Worker bundles this file and the browser loads it as is.

// The recessed name panel of the heart keyring body, in the body's own
// millimetres (measured from the model: x -20.5..56.5, y -13.5..13.5).
export const PANEL = { x0: -20.5, x1: 56.5, y0: -13.5, y1: 13.5 };
// Clear space kept between the letters and the recess wall.
export const MARGIN = 2.5;
// The tallest the text block may be. Without a cap, "AB" would fill the
// whole recess height in letters taller than they are legible.
export const MAX_HEIGHT = 15;
// Letters stand from the recess floor (z 0.6) to just proud of the top face
// (z 2.6), as in the original design.
export const TEXT_Z0 = 0.58, TEXT_Z1 = 2.8;

const STEPS = 6; // segments per curve

// Glyph outlines of `text` in font units, laid out on one line.
// Returns one array of rings per glyph (a ring is an array of [x, y]).
export function textGlyphs(text, font) {
  const glyphs = [];
  let pen = 0;
  for (const ch of String(text)) {
    const g = font.glyphs[ch] || font.glyphs["?"];
    if (!g) continue;
    const rings = [];
    const o = String(g.o || "").trim().split(/\s+/);
    let ring = null, x = 0, y = 0;
    for (let i = 0; i < o.length;) {
      const c = o[i++];
      if (c === "m") {
        if (ring && ring.length > 2) rings.push(ring);
        x = +o[i++] + pen; y = +o[i++];
        ring = [[x, y]];
      } else if (c === "l") {
        x = +o[i++] + pen; y = +o[i++];
        ring.push([x, y]);
      } else if (c === "q") {
        const ex = +o[i++] + pen, ey = +o[i++], cx = +o[i++] + pen, cy = +o[i++];
        for (let s = 1; s <= STEPS; s++) {
          const t = s / STEPS, u = 1 - t;
          ring.push([u * u * x + 2 * u * t * cx + t * t * ex, u * u * y + 2 * u * t * cy + t * t * ey]);
        }
        x = ex; y = ey;
      } else if (c === "b") {
        const ex = +o[i++] + pen, ey = +o[i++], c1x = +o[i++] + pen, c1y = +o[i++], c2x = +o[i++] + pen, c2y = +o[i++];
        for (let s = 1; s <= STEPS; s++) {
          const t = s / STEPS, u = 1 - t;
          ring.push([u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex,
                     u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey]);
        }
        x = ex; y = ey;
      } else {
        break; // unknown command: stop this glyph rather than misdraw it
      }
    }
    if (ring && ring.length > 2) rings.push(ring);
    pen += Number(g.ha) || 0;
    const kept = rings.map(clean).filter((r) => r.length > 2);
    if (kept.length) glyphs.push(kept);
  }
  return glyphs;
}

// Drop repeated points and a closing point equal to the first.
function clean(r) {
  const out = [];
  for (const p of r) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-6 || Math.abs(q[1] - p[1]) > 1e-6) out.push(p);
  }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < 1e-6 && Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-6) out.pop();
  return out;
}

// Text → polygons in millimetres, scaled to fit the panel and centred in it.
// Returns { polygons, width, height }: one polygon per filled region of each
// glyph, as [outerRing, ...holeRings]. Letters of a script font overlap their
// neighbours; the 3MF writer unions them, the preview just draws them.
// `area` (optional): { x0, x1, y0, y1, height?, margin? } to fit into instead
// of the heart's name panel — the ribbon bow's wings, say.
export function layoutText(text, font, area = null) {
  const glyphs = textGlyphs(text, font);
  const all = glyphs.flat();
  if (!all.length) return { polygons: [], width: 0, height: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of all) for (const [x, y] of r) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const w = x1 - x0, h = y1 - y0;
  const P = area || PANEL, m = area ? (area.margin ?? 0) : MARGIN;
  const maxW = P.x1 - P.x0 - 2 * m;
  const maxH = Math.min(P.y1 - P.y0 - 2 * m, area ? (area.height ?? Infinity) : MAX_HEIGHT);
  const scale = Math.min(maxW / w, maxH / h);
  const cx = (P.x0 + P.x1) / 2, cy = (P.y0 + P.y1) / 2;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const place = (r) => r.map(([x, y]) => [cx + (x - mx) * scale, cy + (y - my) * scale]);
  const polygons = glyphs.flatMap((g) => nest(g.map(place)));
  return { polygons, width: w * scale, height: h * scale };
}

// One glyph's rings → polygons. A ring inside an odd number of the glyph's
// other rings is a hole (the inside of an "o"); otherwise it is an outline.
// Each hole goes to the smallest outline around it. Orientation is then set:
// outlines counter-clockwise, holes clockwise.
function nest(rings) {
  const depth = rings.map((r, i) => rings.reduce((n, o, j) => n + (j !== i && inside(r[0], o) ? 1 : 0), 0));
  const outers = rings.map((r, i) => ({ r, i })).filter(({ i }) => depth[i] % 2 === 0)
    .map(({ r, i }) => ({ ring: area2(r) < 0 ? r.slice().reverse() : r, i, holes: [] }));
  rings.forEach((r, i) => {
    if (depth[i] % 2 === 0) return;
    const home = outers.filter((o) => inside(r[0], rings[o.i]))
      .sort((a, b) => Math.abs(area2(rings[a.i])) - Math.abs(area2(rings[b.i])))[0];
    if (home) home.holes.push(area2(r) > 0 ? r.slice().reverse() : r);
  });
  return outers.map((o) => [o.ring, ...o.holes]);
}

function inside([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// Twice the signed area: positive = counter-clockwise (y up).
export function area2(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * r[i][1]) - (r[i][0] * r[j][1]);
  return a;
}
