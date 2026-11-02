// Flat (2D, top-down) drawings of every keychain style, for the /keychain
// gallery: each card redraws with the customer's own name as they type. Built
// from the SAME shapes as the 3D preview and the print file (kc-styles.js), so
// a card is a true picture of what will print. Drawn as SVG paths.
import { STYLES } from "./kc-styles.js";
import { layoutText, PANEL } from "./kc-text.js";
import { RIBBON } from "./kc-build.js";

// The ribbon bow's silhouette, for previews only (2D, simplified to 0.35 mm,
// from the owner's file): the printable bow mesh is private and never sent here.
export const RIBBON_OUTLINE = {"base":[[[[-11.6,-20.68],[-11.7,-19.16],[-10.1,-12.83],[-8.89,-4.43],[-6.16,3.3],[-10.74,1.84],[-15.5,1.3],[-18.05,1.47],[-20.37,2.83],[-22.87,6.16],[-24.25,10.67],[-23.99,15.35],[-22.27,19.14],[-21.06,20.5],[-19.4,21.32],[-13.73,21.62],[-9.95,20.51],[-2.84,16.26],[-2.83,19.2],[-0.89,21.01],[1.49,21.31],[3.17,20.49],[4.18,18.92],[4.23,17.05],[14.03,24.36],[17.83,24.98],[21.11,23.95],[23.19,21.74],[24.23,18.82],[24.08,12.99],[22.85,8.33],[19.46,4.54],[15.54,3.43],[11.6,3.47],[13.7,-1.18],[14.36,-6.69],[15.57,-10.68],[17.55,-13.99],[21.4,-17.68],[21.41,-19.42],[19.74,-20.55],[17.68,-20.94],[17.87,-23.8],[16.66,-24.91],[13.96,-24.47],[11.58,-21.97],[7.83,-15.24],[5.41,-2.49],[4.07,1.16],[1.9,4.66],[-0.72,-8.19],[-1.4,-20.71],[-2.43,-21.58],[-3.94,-21.32],[-6.25,-17.67],[-9.37,-21.24],[-10.69,-21.39]],[[-1.45,17.74],[-0.83,16.24],[0.67,15.62],[2.16,16.24],[2.78,17.74],[2.16,19.23],[0.67,19.85],[-0.83,19.23]]]],"top":[[[[-17.95,3.45],[-20.82,6.41],[-22.36,10.88],[-21.96,15.52],[-19.51,19.24],[-15.79,19.86],[-11.34,19.07],[-1.06,12.69],[0.74,13.82],[2.81,13.27],[9.01,18.57],[14.76,22.6],[17.15,23.1],[19.68,22.6],[21.57,20.74],[22.34,18.6],[22.09,12.56],[20.64,8.31],[18.54,6.22],[15.86,5.4],[7.78,5.89],[11.56,-0.67],[12.48,-7.01],[13.83,-11.46],[16.04,-15.15],[19.49,-18.56],[15.94,-19.08],[15.97,-23.09],[14.78,-22.73],[12.03,-19.35],[9.45,-13.99],[7.85,-4.41],[6.33,0.72],[4.51,4.26],[1.09,8.86],[-2.47,-6.98],[-3.09,-19.36],[-5.88,-14.8],[-9.44,-18.24],[-6.46,-2.62],[-2.26,6.93],[-11.14,3.7]],[[-10.23,13.32],[-14.04,14.37],[-17.72,14.06],[-19.13,12.81],[-19.29,10.99],[-17.54,8.98],[-14.71,8.23],[-4.86,9.83]],[[11.11,15.77],[7.69,12.39],[5.24,8.45],[9.21,8.82],[13.99,10.27],[18.12,12.65],[19.11,14.43],[18.76,16.22],[16.78,17.59],[13.78,17.16]]]]};

// The heart tag's plate, to the printed body's measurements (mm).
function roundRect(x0, y0, x1, y1, r) {
  const p = [];
  for (const [cx, cy, a0] of [[x1 - r, y0 + r, -90], [x1 - r, y1 - r, 0], [x0 + r, y1 - r, 90], [x0 + r, y0 + r, 180]])
    for (let i = 0; i <= 6; i++) { const a = ((a0 + (i * 90) / 6) * Math.PI) / 180; p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return p;
}
const circleRing = (cx, cy, r, n = 28) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy - r * Math.sin((i / n) * 2 * Math.PI)]);
function heartRing(cx, cy, s) {
  return Array.from({ length: 40 }, (_, i) => {
    const t = (i / 40) * 2 * Math.PI;
    return [cx + 16 * Math.sin(t) ** 3 * 0.62 * s, cy + (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * 0.62 * s + 1];
  });
}

// A design's layers, bottom first: [{ shape, slot, recess? }]; slot 1 base,
// 2 text, 3 accent. `recess` marks a sunken area drawn a shade darker.
export function flatLayers(style, text, font, initialFont) {
  if (style === "heart") {
    const layers = [
      { shape: [[roundRect(-60, -16, 60, 16, 6), circleRing(-54, 0, 3)]], slot: 1 },
      { shape: [[roundRect(PANEL.x0, PANEL.y0, PANEL.x1, PANEL.y1, 2.5)]], slot: 1, recess: true },
      { shape: [[heartRing(-38, 0, 1)]], slot: 1, recess: true },
    ];
    if (text) layers.push({ shape: layoutText(text, font).polygons, slot: 2 });
    return layers;
  }
  if (style === "ribbon") {
    const layers = [{ shape: RIBBON_OUTLINE.base, slot: 1 }, { shape: RIBBON_OUTLINE.top, slot: 3 }];
    if (text) layers.push({ shape: layoutText(text, font, RIBBON).polygons, slot: 2 });
    return layers;
  }
  if (!text) return [];
  const built = STYLES[style].build(text, font, initialFont);
  if (!built) return [];
  return built.parts.slice().sort((a, b) => a.z1 - b.z1).map((p) => ({ shape: p.shape, slot: p.slot }));
}

// Layers → an SVG string (y flipped: SVG's y runs down). `hex` per slot.
// The ink outline is drawn under each layer so neighbouring colours read apart.
export function layersSvg(layers, hex, { pad = 3, ink = "#1E1B33" } = {}) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const L of layers) for (const poly of L.shape) for (const [x, y] of poly[0]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (!Number.isFinite(x0)) return "";
  const f = (v) => Math.round(v * 100) / 100;
  const d = (shape) => shape.map((poly) => poly.map((r) => "M" + r.map(([x, y]) => `${f(x)} ${f(-y)}`).join("L") + "Z").join("")).join("");
  const paths = layers.map((L) => {
    const fill = L.recess ? shade(hex[0]) : hex[L.slot - 1];
    return `<path d="${d(L.shape)}" fill="${fill}" fill-rule="evenodd" stroke="${ink}" stroke-width="0.7" stroke-linejoin="round"/>`;
  }).join("");
  const w = x1 - x0 + pad * 2, h = y1 - y0 + pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(x0 - pad)} ${f(-y1 - pad)} ${f(w)} ${f(h)}" aria-hidden="true" focusable="false">${paths}</svg>`;
}

function shade(h) {
  const n = parseInt(h.slice(1), 16), k = 0.84;
  return "#" + [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v * k).toString(16).padStart(2, "0")).join("");
}
