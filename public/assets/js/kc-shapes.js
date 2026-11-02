// 2D shape operations for keychain styles (2026-11-02): union, offset ("grow by
// N mm"), difference, and conversion to polygons-with-holes — on Clipper2,
// vendored as a same-origin module. Shared by the browser preview and the .3mf
// builder, so the preview's outline is the printed outline.
//
// Shapes are arrays of polygons; a polygon is [outerRing, ...holeRings]; a
// ring is [[x, y], ...] in millimetres, outer counter-clockwise, holes
// clockwise. Clipper2 works on integers: millimetres are scaled by SCALE
// (1 unit = 1 micron) on the way in and back on the way out.
import { Clipper64, ClipType, FillRule, Paths64, Path64, Point64, PathType } from "../vendor/kc/clipper2.js";

const SCALE = 1000;

function toPaths(shape) {
  const out = new Paths64();
  for (const poly of shape) for (const ring of poly) {
    const p = new Path64();
    for (const [x, y] of ring) p.push(new Point64(Math.round(x * SCALE), Math.round(y * SCALE)));
    if (p.length > 2) out.push(p);
  }
  return out;
}

// Flat Clipper output → shape. (This port's executePolyTree fails, so nesting
// is done here.) Clipper returns outers counter-clockwise and holes clockwise;
// each hole goes to the smallest outer that contains it.
function fromPaths(paths) {
  const rings = Array.from(paths, (path) => dedupe(Array.from(path, (pt) => [pt.x / SCALE, pt.y / SCALE]))).filter((r) => r.length > 2 && area2(r) !== 0);
  const outers = rings.filter((r) => area2(r) > 0).map((r) => ({ r, a: area2(r), holes: [] }))
    .sort((x, y) => x.a - y.a);
  for (const h of rings.filter((r) => area2(r) < 0)) {
    const home = outers.find((o) => inside(h[0], o.r) || inside(mid(h), o.r));
    if (home) home.holes.push(h);
  }
  return outers.map((o) => [o.r, ...o.holes]);
}
// Drop repeated consecutive points (Clipper can emit them where a shape
// touches itself): a ring with a zero-length edge breaks the mesh's walls.
// …and points where the ring doubles back on itself in a straight line (a
// zero-width spike): earcut turns those into zero-area triangles whose edges
// have no partner, and the mesh is no longer closed.
function dedupe(r) {
  let out = [];
  for (const p of r) { const q = out[out.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p); }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  for (let changed = true; changed && out.length > 2;) {
    changed = false;
    const keep = [];
    for (let i = 0; i < out.length; i++) {
      const a = keep.length ? keep[keep.length - 1] : out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      const dot = Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1]);
      // On the line from its neighbours — a spike back, or a point mid-way
      // along a straight edge. earcut may skip a mid-edge point, leaving the
      // cap's edge without the wall's matching pair; either way it adds nothing.
      // (|cross| is twice the triangle's area: 1e-9 mm² is far below a micron.)
      if (Math.abs(cross) < 1e-9 * Math.max(1, Math.abs(dot))) { changed = true; continue; }
      keep.push(b);
    }
    out = keep;
  }
  return out;
}
const mid = (r) => [(r[0][0] + r[1][0]) / 2, (r[0][1] + r[1][1]) / 2];
function inside([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const area2 = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return a; };
const orient = (r, ccw) => ((area2(r) > 0) === ccw ? r : r.slice().reverse());

function boolean(type, subject, clip) {
  const c = new Clipper64();
  c.addPaths(toPaths(subject), PathType.Subject);
  if (clip) c.addPaths(toPaths(clip), PathType.Clip);
  const out = new Paths64();
  if (!c.execute(type, FillRule.NonZero, out)) throw new Error("shape operation failed");
  return fromPaths(out);
}

// Everything in any of the shapes, overlaps merged.
export const union = (...shapes) => boolean(ClipType.Union, shapes.flat());
// What is in `a` and not in `b`.
export const difference = (a, b) => boolean(ClipType.Difference, a, b);

// Grow a shape by `mm` with round corners — the outline "bubble" behind a
// name — and fill it (an outline is a solid backing). Done on a grid: exact
// Euclidean distance transform, then marching squares. Measured on a long
// script name: every contour point within 0.05 mm of the target distance,
// one clean ring, ~130 ms. (Clipper2's JS offset was 1-4 s on the same name
// and notched the result on tight curves.)
export function offset(shape, mm, res = 0.08) {
  if (!shape.length) return [];
  const b = bounds(shape), pad = mm + 3 * res;
  const x0 = b.x0 - pad, y0 = b.y0 - pad;
  const W = Math.ceil((b.w + 2 * pad) / res) + 1, H = Math.ceil((b.h + 2 * pad) / res) + 1;
  const inside = fill(shape, x0, y0, res, W, H);
  const d = distance2(inside, W, H);
  // Signed field in mm: negative within `mm` of the shape. Distances are to
  // pixel CENTRES, so half a pixel is taken off to measure to the edge.
  const field = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) field[i] = (inside[i] ? -res : Math.sqrt(d[i]) * res - res * 0.5) - mm;
  const rings = contour(field, W, H, x0, y0, res).map((r) => simplify(r, res * 0.25));
  // Rings under 0.5 mm² are grid noise, not shape. The traced rings already
  // carry their orientation (outer counter-clockwise, holes clockwise), so a
  // non-zero union puts holes back where they belong.
  return union(rings.filter((r) => Math.abs(area2(r)) / 2 > 0.5).map((r) => [r]));
}

// Pixel-centre fill of a shape, non-zero winding.
function fill(shape, x0, y0, res, W, H) {
  const inside = new Uint8Array(W * H), edges = [];
  for (const poly of shape) for (const ring of poly) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) edges.push(ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
  const hits = [];
  for (let y = 0; y < H; y++) {
    const yy = y0 + y * res; hits.length = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const ay = edges[e + 1], by = edges[e + 3];
      if ((ay > yy) !== (by > yy)) hits.push([edges[e] + ((yy - ay) / (by - ay)) * (edges[e + 2] - edges[e]), by > ay ? 1 : -1]);
    }
    hits.sort((p, q) => p[0] - q[0]);
    let wind = 0, start = 0;
    for (const [x, dir] of hits) {
      const prev = wind; wind += dir;
      if (prev === 0 && wind !== 0) start = x;
      else if (prev !== 0 && wind === 0) {
        const a = Math.max(0, Math.ceil((start - x0) / res)), e = Math.min(W - 1, Math.floor((x - x0) / res));
        for (let i = a; i <= e; i++) inside[y * W + i] = 1;
      }
    }
  }
  return inside;
}

// Squared distance (pixels) from every pixel to the nearest inside one
// (Felzenszwalb & Huttenlocher's exact transform, by columns then rows).
function distance2(inside, W, H) {
  const INF = 1e20, d = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = inside[i] ? 0 : INF;
  const n = Math.max(W, H), v = new Int32Array(n), z = new Float64Array(n + 1), f = new Float64Array(n);
  const pass = (len, at) => {
    for (let q = 0; q < len; q++) f[q] = d[at(q)];
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s;
      for (;;) { s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); if (s <= z[k] && k > 0) k--; else break; }
      if (s <= z[k]) { v[k] = q; z[k] = -INF; z[k + 1] = INF; continue; }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; d[at(q)] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  };
  for (let x = 0; x < W; x++) pass(H, (y) => y * W + x);
  for (let y = 0; y < H; y++) pass(W, (x) => y * W + x);
  return d;
}

// Marching squares on field = 0, traced into closed rings with the inside on
// their left. Each crossing is identified by the grid EDGE it lies on (not by
// its rounded coordinates), so rings join exactly; a saddle cell is split the
// way the cell's centre value says.
function contour(field, W, H, x0, y0, res) {
  // Edge ids: horizontal edge (x,y)-(x+1,y) = 2*(y*W+x); vertical (x,y)-(x,y+1) = 2*(y*W+x)+1.
  const hE = (x, y) => 2 * (y * W + x), vE = (x, y) => 2 * (y * W + x) + 1;
  const next = new Map(), where = new Map();
  const t = (a, b) => a / (a - b);
  const at = (e) => {
    if (where.has(e)) return where.get(e);
    const k = e >> 1, x = k % W, y = (k - x) / W;
    const p = (e & 1)
      ? [x0 + x * res, y0 + (y + t(field[y * W + x], field[(y + 1) * W + x])) * res]
      : [x0 + (x + t(field[y * W + x], field[y * W + x + 1])) * res, y0 + y * res];
    where.set(e, p);
    return p;
  };
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
    const a = field[y * W + x], b = field[y * W + x + 1], c = field[(y + 1) * W + x + 1], d = field[(y + 1) * W + x];
    const k = (a < 0 ? 1 : 0) | (b < 0 ? 2 : 0) | (c < 0 ? 4 : 0) | (d < 0 ? 8 : 0);
    if (k === 0 || k === 15) continue;
    const T = hE(x, y), B = hE(x, y + 1), L = vE(x, y), R = vE(x + 1, y);
    const centreIn = (a + b + c + d) / 4 < 0;
    const segs = { 1: [[L, T]], 2: [[T, R]], 3: [[L, R]], 4: [[R, B]],
      5: centreIn ? [[L, B], [R, T]] : [[L, T], [R, B]],
      6: [[T, B]], 7: [[L, B]], 8: [[B, L]], 9: [[B, T]],
      10: centreIn ? [[T, L], [B, R]] : [[T, R], [B, L]],
      11: [[B, R]], 12: [[R, L]], 13: [[R, T]], 14: [[T, L]] }[k];
    for (const [p, q] of segs) next.set(p, q);
  }
  const rings = [], used = new Set();
  for (const e0 of next.keys()) {
    if (used.has(e0)) continue;
    const ring = []; let e = e0;
    while (next.has(e) && !used.has(e)) { used.add(e); ring.push(at(e)); e = next.get(e); }
    if (ring.length > 2) rings.push(ring);
  }
  return rings;
}

// Drop points that lie within `tol` of the line through their neighbours
// (Douglas-Peucker over the closed ring).
function simplify(ring, tol) {
  if (ring.length < 8) return ring;
  const keep = new Uint8Array(ring.length);
  const dp = (i, j) => {
    let best = -1, at = -1;
    const [ax, ay] = ring[i], [bx, by] = ring[j % ring.length];
    const L = Math.hypot(bx - ax, by - ay) || 1e-12;
    for (let k = i + 1; k < j; k++) {
      const [px, py] = ring[k];
      const dd = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / L;
      if (dd > best) { best = dd; at = k; }
    }
    if (best > tol) { keep[at] = 1; dp(i, at); dp(at, j); }
  };
  const half = ring.length >> 1;
  keep[0] = keep[half] = 1;
  dp(0, half); dp(half, ring.length);
  return ring.filter((_, i) => keep[i]);
}

// Fill in every hole (the inside of an "o", the gaps between letters that an
// outline encloses): the outline is a solid backing.
export const solid = (shape) => union(shape.map((poly) => [poly[0]]));

// A circle as a shape.
export function circle(cx, cy, r, steps = 48) {
  const ring = [];
  for (let i = 0; i < steps; i++) { const a = (i / steps) * Math.PI * 2; ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return [[ring]];
}

// Bounding box of a shape.
export function bounds(shape) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of shape) for (const [x, y] of poly[0]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

export const translate = (shape, dx, dy) => shape.map((poly) => poly.map((r) => r.map(([x, y]) => [x + dx, y + dy])));
export const area = (shape) => shape.reduce((n, poly) => n + poly.reduce((m, r, i) => m + (i ? -1 : 1) * Math.abs(area2(r)) / 2, 0), 0);

// The point of `shape` furthest left on the line y = cy (for hanging a ring
// tab on a name's left end), or its left edge if the line misses it.
export function leftmostAt(shape, cy) {
  let best = Infinity;
  for (const poly of shape) for (const r of poly) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > cy) !== (yj > cy)) { const x = xi + ((cy - yi) / (yj - yi)) * (xj - xi); if (x < best) best = x; }
    }
  }
  return Number.isFinite(best) ? best : bounds(shape).x0;
}

// The top edge of `shape` on the line x = cx (for a ring above a name).
export function topAt(shape, cx) {
  let best = -Infinity;
  for (const poly of shape) for (const r of poly) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((xi > cx) !== (xj > cx)) { const y = yi + ((cx - xi) / (xj - xi)) * (yj - yi); if (y > best) best = y; }
    }
  }
  return Number.isFinite(best) ? best : bounds(shape).y1;
}

// The largest piece of a shape. A keychain's backing must be ONE piece; small
// islands (left by gaps between a charm's petals, say) would print as loose
// crumbs.
export function largest(shape) {
  if (shape.length < 2) return shape;
  let best = null, ba = -1;
  for (const poly of shape) { const a = area([poly]); if (a > ba) { ba = a; best = poly; } }
  return [best];
}

// The point of `shape` furthest right on the line y = cy.
export function rightmostAt(shape, cy) {
  let best = -Infinity;
  for (const poly of shape) for (const r of poly) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > cy) !== (yj > cy)) { const x = xi + ((cy - yi) / (yj - yi)) * (xj - xi); if (x > best) best = x; }
    }
  }
  return Number.isFinite(best) ? best : bounds(shape).x1;
}
