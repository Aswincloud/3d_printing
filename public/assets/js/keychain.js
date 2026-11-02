// /keychain — design a custom name keychain with a live 3D preview (2026-11-02).
//
// The heart name keyring (120 x 32 mm) with the name standing in its recess,
// rebuilt as you type. The name is laid out by kc-text.js — the SAME code that
// builds the print file (src/kc3mf.js) — so the preview shows what prints.
// The plate here is drawn to the printed body's measurements; the body mesh
// itself is never sent to the browser.
//
// Everything here is the customer's choice and is DISPLAY ONLY: the cart line
// is the design's id, and the server decodes, validates and prices it
// (src/keychain.js). The colour and font lists below must match that file.
import * as THREE from '/assets/vendor/three/three.module.min.js';
import { OrbitControls } from '/assets/vendor/three/OrbitControls.js';
import { layoutText, PANEL, TEXT_Z0, TEXT_Z1 } from '/assets/js/kc-text.js';
import { STYLES as SHAPES } from '/assets/js/kc-styles.js';
import { RIBBON } from '/assets/js/kc-build.js';

const COLOURS = {
  white: ['White', '#f4f4f2'], black: ['Black', '#1b1b1f'], brown: ['Choco brown', '#5a3a22'],
  gold: ['Gold', '#c9a227'], orange: ['Orange', '#ff7a1a'], blue: ['Blue', '#1f5fd1'],
  red: ['Red', '#d62828'], green: ['Green', '#2f9e44'], pink: ['Pink', '#f06fae'], skin: ['Skin', '#e8b996'],
};
const FONTS = {
  script: ['Script', 'kc-script.json'], brush: ['Brush', 'kc-brush.json'],
  hand: ['Handwritten', 'kc-hand.json'], rounded: ['Rounded', 'kc-rounded.json'],
};
// Must match STYLES in src/keychain.js. `accent`: a third colour part.
const STYLE_LIST = {
  heart: ['Heart tag', false], bubble: ['Bubble script', false], double: ['Double outline', true],
  topring: ['Script, ring on top', false], classic: ['Classic script', false], chunky: ['Chunky bubble', false],
  charm: ['Flower charm', true], initial: ['Big initial', false], shadow: ['Drop shadow', false], ribbon: ['Ribbon bow', true],
};
const ACCENT_LABEL = { double: 'Inner outline colour', charm: 'Flower colour', ribbon: 'Bow colour' };
// The ribbon bow's silhouette for the PREVIEW only (2D, simplified to 0.35 mm,
// from the owner's file): the printable bow mesh is private and never sent here.
const RIBBON_OUTLINE = {"base":[[[[-11.6,-20.68],[-11.7,-19.16],[-10.1,-12.83],[-8.89,-4.43],[-6.16,3.3],[-10.74,1.84],[-15.5,1.3],[-18.05,1.47],[-20.37,2.83],[-22.87,6.16],[-24.25,10.67],[-23.99,15.35],[-22.27,19.14],[-21.06,20.5],[-19.4,21.32],[-13.73,21.62],[-9.95,20.51],[-2.84,16.26],[-2.83,19.2],[-0.89,21.01],[1.49,21.31],[3.17,20.49],[4.18,18.92],[4.23,17.05],[14.03,24.36],[17.83,24.98],[21.11,23.95],[23.19,21.74],[24.23,18.82],[24.08,12.99],[22.85,8.33],[19.46,4.54],[15.54,3.43],[11.6,3.47],[13.7,-1.18],[14.36,-6.69],[15.57,-10.68],[17.55,-13.99],[21.4,-17.68],[21.41,-19.42],[19.74,-20.55],[17.68,-20.94],[17.87,-23.8],[16.66,-24.91],[13.96,-24.47],[11.58,-21.97],[7.83,-15.24],[5.41,-2.49],[4.07,1.16],[1.9,4.66],[-0.72,-8.19],[-1.4,-20.71],[-2.43,-21.58],[-3.94,-21.32],[-6.25,-17.67],[-9.37,-21.24],[-10.69,-21.39]],[[-1.45,17.74],[-0.83,16.24],[0.67,15.62],[2.16,16.24],[2.78,17.74],[2.16,19.23],[0.67,19.85],[-0.83,19.23]]]],"top":[[[[-17.95,3.45],[-20.82,6.41],[-22.36,10.88],[-21.96,15.52],[-19.51,19.24],[-15.79,19.86],[-11.34,19.07],[-1.06,12.69],[0.74,13.82],[2.81,13.27],[9.01,18.57],[14.76,22.6],[17.15,23.1],[19.68,22.6],[21.57,20.74],[22.34,18.6],[22.09,12.56],[20.64,8.31],[18.54,6.22],[15.86,5.4],[7.78,5.89],[11.56,-0.67],[12.48,-7.01],[13.83,-11.46],[16.04,-15.15],[19.49,-18.56],[15.94,-19.08],[15.97,-23.09],[14.78,-22.73],[12.03,-19.35],[9.45,-13.99],[7.85,-4.41],[6.33,0.72],[4.51,4.26],[1.09,8.86],[-2.47,-6.98],[-3.09,-19.36],[-5.88,-14.8],[-9.44,-18.24],[-6.46,-2.62],[-2.26,6.93],[-11.14,3.7]],[[-10.23,13.32],[-14.04,14.37],[-17.72,14.06],[-19.13,12.81],[-19.29,10.99],[-17.54,8.98],[-14.71,8.23],[-4.86,9.83]],[[11.11,15.77],[7.69,12.39],[5.24,8.45],[9.21,8.82],[13.99,10.27],[18.12,12.65],[19.11,14.43],[18.76,16.22],[16.78,17.59],[13.78,17.16]]]]};
const MAX_TEXT = 12;
const PRICE_ONE = 19900, PRICE_TWO = 29900;
const TEXT_RE = /^[A-Za-z0-9 &.\-'!]+$/u;   // must match src/keychain.js
const CART_KEY = 'ap_cart';

const state = { text: 'Aswin', font: 'script', base: 'white', ink: 'pink', accent: 'gold', style: 'heart', twoTone: true };
const $ = (id) => document.getElementById(id);
const rupees = (p) => '₹' + (p / 100).toLocaleString('en-IN');
const clean = (s) => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();

// ── the design id: MUST equal designId() in src/keychain.js ───────
// A heart design keeps the original four fields; other styles add two.
function designId(d) {
  const json = JSON.stringify(d.style === 'heart' ? [d.text, d.font, d.base, d.ink] : [d.text, d.font, d.base, d.ink, d.style, d.accent]);
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'kc~' + b64;
}
const valid = () => {
  const t = clean(state.text);
  return t && [...t].length <= MAX_TEXT && TEXT_RE.test(t);
};
const hasAccent = () => STYLE_LIST[state.style][1];
const design = () => ({ text: clean(state.text), font: state.font, base: state.base, ink: state.twoTone ? state.ink : state.base,
  style: state.style, accent: hasAccent() && state.twoTone ? state.accent : state.base });

// ── 3D scene ──────────────────────────────────────────────────────
const host = $('kcCanvas');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
host.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 1000);
camera.position.set(0, -55, 150);
scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(60, -40, 120); scene.add(key);
const rim = new THREE.DirectionalLight(0xffd9a8, 0.6); rim.position.set(-80, 60, -40); scene.add(rim);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.enablePan = false;
// Not a full turn: seen edge-on, a flat keychain shows nothing of its name.
// It rocks gently either side of facing the viewer instead (see frame()).
controls.autoRotate = false;
const rock = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let touched = false;
controls.addEventListener('start', () => { touched = true; });
const group = new THREE.Group(); scene.add(group);
// For the browser test: how many meshes the preview is drawing.
window.__kcParts = () => group.children.length;

// Far enough that the whole 120 mm plate (radius ~64 mm as it turns) fits the
// canvas at any rotation, whatever the canvas's shape.
function fitDistance() {
  const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  return (lastSize * 0.6) / (half * Math.min(1, camera.aspect));
}
let fitted = false, lastSize = 120;
function fit() {
  const d = fitDistance();
  controls.minDistance = d * 0.6; controls.maxDistance = d * 1.8;
  if (!fitted) { camera.position.setLength(d); fitted = true; }
}
function size() {
  const w = host.clientWidth, h = host.clientHeight || 280;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  fitted = false; fit();
}
new ResizeObserver(size).observe(host);

const fonts = {};
function loadFont(k) {
  if (!fonts[k]) fonts[k] = fetch('/assets/fonts3d/' + FONTS[k][1]).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .catch((e) => { delete fonts[k]; throw e; });
  return fonts[k];
}

// ── the plate, to the printed body's measurements (mm, centred on 0) ──
// 120 x 32 x 5.2, corner radius 6; keyring hole r 3 at x -54; a heart recess
// and the name recess (PANEL), both 2 mm deep.
const W = 120, H = 32, R = 6, DEPTH = 2;
function roundRect(path, x0, y0, x1, y1, r) {
  path.moveTo(x0 + r, y0); path.lineTo(x1 - r, y0); path.absarc(x1 - r, y0 + r, r, -Math.PI / 2, 0);
  path.lineTo(x1, y1 - r); path.absarc(x1 - r, y1 - r, r, 0, Math.PI / 2);
  path.lineTo(x0 + r, y1); path.absarc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI);
  path.lineTo(x0, y0 + r); path.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5);
  return path;
}
function heartPath(path, cx, cy, s) {
  // A plain heart, point down, ~20 mm across at s = 1.
  path.moveTo(cx, cy - 10 * s);
  path.bezierCurveTo(cx - 6 * s, cy - 4 * s, cx - 11 * s, cy + 1 * s, cx - 10 * s, cy + 5 * s);
  path.bezierCurveTo(cx - 9 * s, cy + 10.5 * s, cx - 2 * s, cy + 11 * s, cx, cy + 6 * s);
  path.bezierCurveTo(cx + 2 * s, cy + 11 * s, cx + 9 * s, cy + 10.5 * s, cx + 10 * s, cy + 5 * s);
  path.bezierCurveTo(cx + 11 * s, cy + 1 * s, cx + 6 * s, cy - 4 * s, cx, cy - 10 * s);
  return path;
}
const holePath = () => { const p = new THREE.Path(); p.absarc(-54, 0, 3, 0, Math.PI * 2, true); return p; };
function plateGeometries() {
  // Floor: the full outline with the keyring hole, z -2.6 .. 0.6.
  const floor = roundRect(new THREE.Shape(), -W / 2, -H / 2, W / 2, H / 2, R);
  floor.holes.push(holePath());
  const g1 = new THREE.ExtrudeGeometry(floor, { depth: 5.2 - DEPTH, bevelEnabled: false, curveSegments: 16 });
  g1.translate(0, 0, -2.6);
  // Rim: the outline minus the hole, the heart and the name panel, z 0.6 .. 2.6.
  const rim = roundRect(new THREE.Shape(), -W / 2, -H / 2, W / 2, H / 2, R);
  rim.holes.push(holePath(), heartPath(new THREE.Path(), -38, 0, 1),
    roundRect(new THREE.Path(), PANEL.x0, PANEL.y0, PANEL.x1, PANEL.y1, 2.5));
  const g2 = new THREE.ExtrudeGeometry(rim, { depth: DEPTH, bevelEnabled: false, curveSegments: 16 });
  g2.translate(0, 0, 2.6 - DEPTH);
  return [g1, g2];
}

function textGeometry(text, font) {
  const shapes = layoutText(text, font).polygons.map(([outer, ...holes]) => {
    const s = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const h of holes) s.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
    return s;
  });
  const g = new THREE.ExtrudeGeometry(shapes, { depth: TEXT_Z1 - TEXT_Z0, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, TEXT_Z0);
  return g;
}

// A shape (kc-shapes.js polygons) → a three.js extrusion between z0 and z1.
function shapeGeometry(shape, z0, z1) {
  const shapes = shape.map(([outer, ...holes]) => {
    const sh = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const h of holes) sh.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
    return sh;
  });
  const g = new THREE.ExtrudeGeometry(shapes, { depth: z1 - z0, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, z0);
  return g;
}

// The parts to draw for a design: [{ geometry, slot }], plus its size in mm.
// Name styles use kc-styles.js — the code that builds the printed file. The
// heart and ribbon draw their bodies from measurements/silhouettes instead
// of the private meshes.
let initialFont = null;
async function previewParts(d, font) {
  if (d.style === 'heart') {
    const out = plateGeometries().map((g) => ({ geometry: g, slot: 1 }));
    if (d.text) out.push({ geometry: textGeometry(d.text, font), slot: 2 });
    return { parts: out, w: 120, h: 32, lift: 0 };
  }
  if (d.style === 'ribbon') {
    const out = [
      { geometry: shapeGeometry(RIBBON_OUTLINE.base, 0, 0.84), slot: 1 },
      { geometry: shapeGeometry(RIBBON_OUTLINE.top, 0.85, 1.69), slot: 3 },
    ];
    if (d.text) out.push({ geometry: shapeGeometry(layoutText(d.text, font, RIBBON).polygons, RIBBON.z0, RIBBON.z1), slot: 2 });
    return { parts: out, w: 50, h: 50, lift: 0.84 };
  }
  if (!d.text) return { parts: [], w: 100, h: 30, lift: 0 };
  if (d.style === 'initial' && !initialFont) initialFont = await loadFont('rounded');
  const built = SHAPES[d.style].build(d.text, font, initialFont);
  if (!built) return { parts: [], w: 100, h: 30, lift: 0 };
  // Centre the keychain on the turntable.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, top = 0;
  for (const p of built.parts) {
    top = Math.max(top, p.z1);
    for (const poly of p.shape) for (const [x, y] of poly[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const parts = built.parts.map((p) => {
    const g = shapeGeometry(p.shape, p.z0, p.z1); g.translate(-cx, -cy, 0); return { geometry: g, slot: p.slot };
  });
  return { parts, w: x1 - x0, h: y1 - y0, lift: top / 2 };
}

let building = 0, debounce = 0;
function rebuild() {
  // Name styles take 50-300 ms to shape; wait for a pause in typing.
  clearTimeout(debounce);
  debounce = setTimeout(rebuildNow, state.style === 'heart' ? 0 : 180);
}
async function rebuildNow() {
  const my = ++building;
  const d = design();
  const font = await loadFont(d.font).catch(() => null);
  if (my !== building || !font) return;
  let built;
  try { built = await previewParts(d, font); } catch (e) { console.error(e); return; }
  if (my !== building) return;
  while (group.children.length) { const m = group.children.pop(); m.geometry.dispose(); m.material.dispose(); }
  const mat = (hex) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.55, metalness: hex === COLOURS.gold[1] ? 0.45 : 0.05 });
  const hex = [COLOURS[d.base][1], COLOURS[d.ink][1], COLOURS[d.accent][1]];
  for (const p of built.parts) group.add(new THREE.Mesh(p.geometry, mat(hex[p.slot - 1])));
  group.position.set(0, 0, -built.lift);
  lastSize = Math.max(built.w, built.h * 1.6, 40);
  fitted = false; fit();
}

function frame(t) {
  requestAnimationFrame(frame);
  // Rock ±25° about the vertical until the customer drags it themselves.
  if (rock && !touched) group.rotation.z = Math.sin((t || 0) / 1400) * 0.42;
  controls.update(); renderer.render(scene, camera);
}

// ── controls ──────────────────────────────────────────────────────
// Built ONCE; refresh() only updates aria-pressed. Rebuilding on every refresh
// removed the focused button, so a keyboard user lost their place after each pick.
function swatches(id, pick) {
  const box = $(id); box.replaceChildren();
  for (const [k, [name, hex]] of Object.entries(COLOURS)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'kc-swatch'; b.style.setProperty('--sw', hex);
    b.dataset.colour = k;
    b.setAttribute('aria-label', name); b.title = name;
    b.addEventListener('click', () => { pick(k); refresh(); });
    box.append(b);
  }
}
const markSwatches = (id, current) => { for (const b of $(id).children) b.setAttribute('aria-pressed', String(b.dataset.colour === current)); };
function fontButtons() {
  const box = $('kcFonts'); box.replaceChildren();
  for (const [k, [name]] of Object.entries(FONTS)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'kc-font'; b.textContent = name; b.dataset.font = k;
    b.setAttribute('aria-pressed', String(k === state.font));
    b.addEventListener('click', () => { state.font = k; refresh(); });
    box.append(b);
  }
}

function styleButtons() {
  const box = $('kcStyles'); box.replaceChildren();
  for (const [k, [name]] of Object.entries(STYLE_LIST)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'kc-style'; b.dataset.style = k;
    const img = document.createElement('img');
    img.src = '/assets/images/keychain-styles/' + k + '.webp'; img.alt = ''; img.loading = 'lazy'; img.width = 96; img.height = 72;
    const label = document.createElement('span'); label.textContent = name;
    b.append(img, label);
    b.addEventListener('click', () => {
      state.style = k;
      // Each style opens in the font it was designed with.
      state.font = DEFAULT_FONT[k] || state.font;
      refresh();
    });
    box.append(b);
  }
}
// The font each style was designed with (src/keychain.js STYLES / kc-styles.js).
const DEFAULT_FONT = { heart: 'rounded', bubble: 'script', double: 'script', topring: 'hand', classic: 'brush',
  chunky: 'rounded', charm: 'rounded', initial: 'script', shadow: 'rounded', ribbon: 'hand' };

function refresh() {
  for (const b of $('kcStyles').children) b.setAttribute('aria-pressed', String(b.dataset.style === state.style));
  for (const b of $('kcFonts').children) b.setAttribute('aria-pressed', String(b.dataset.font === state.font));
  markSwatches('kcBase', state.base);
  markSwatches('kcInk', state.ink);
  markSwatches('kcAccent', state.accent);
  $('kcInkRow').hidden = !state.twoTone;
  $('kcAccentRow').hidden = !(state.twoTone && hasAccent());
  $('kcAccentLabel').textContent = ACCENT_LABEL[state.style] || 'Accent colour';
  const d = design(), two = d.ink !== d.base || d.accent !== d.base;
  $('kcPrice').textContent = rupees(two ? PRICE_TWO : PRICE_ONE);
  $('kcPriceNote').textContent = !two ? 'One colour' : (d.ink !== d.base && d.accent !== d.base && d.ink !== d.accent) ? 'Three colours' : 'Two colours';
  const cols = [];
  if (!two) cols.push(COLOURS[d.base][0] + ', one colour');
  else {
    cols.push(COLOURS[d.base][0] + ' base');
    if (d.ink !== d.base) cols.push(COLOURS[d.ink][0] + ' text');
    if (d.accent !== d.base) cols.push(COLOURS[d.accent][0] + ' ' + (d.style === 'charm' ? 'flower' : d.style === 'ribbon' ? 'bow' : 'outline'));
  }
  $('kcSummary').textContent = '"' + (d.text || '') + '"' + (d.style === 'heart' ? '' : ' · ' + STYLE_LIST[d.style][0]) + ' · ' + FONTS[d.font][0] + ' font · ' + cols.join(', ');
  const ok = valid();
  $('kcAdd').disabled = !ok; $('kcBuy').disabled = !ok;
  const n = [...clean(state.text)].length;
  $('kcCount').textContent = n + ' / ' + MAX_TEXT;
  $('kcError').textContent = !clean(state.text) ? 'Type the name or text you want.'
    : n > MAX_TEXT ? 'Up to ' + MAX_TEXT + ' characters.'
    : !TEXT_RE.test(clean(state.text)) ? 'Letters, numbers, spaces and & . - \' ! only.' : '';
  rebuild();
}

function addToCart() {
  if (!valid()) return null;
  const id = designId(design());
  let cart = [];
  try { cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); if (!Array.isArray(cart)) cart = []; } catch { cart = []; }
  const line = cart.find((it) => it && it.id === id);
  if (line) line.qty = Math.min(100, (parseInt(line.qty, 10) || 0) + 1); else cart.push({ id, qty: 1 });
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* private mode: the buy-now path still works */ }
  window.apTrack?.('cart_add', {});
  return id;
}

$('kcText').value = state.text;
$('kcTwoTone').checked = state.twoTone; // the starting example is two-colour
$('kcText').maxLength = MAX_TEXT + 4;
$('kcText').addEventListener('input', (e) => { state.text = e.target.value; refresh(); });
$('kcTwoTone').addEventListener('change', (e) => { state.twoTone = e.target.checked; if (state.twoTone && state.ink === state.base) state.ink = state.base === 'white' ? 'black' : 'white'; refresh(); });
$('kcAdd').addEventListener('click', () => {
  if (!addToCart()) return;
  const msg = $('kcAdded'); msg.hidden = false;
  clearTimeout(msg._t); msg._t = setTimeout(() => { msg.hidden = true; }, 4000);
});
// Buy now checks out THIS keychain only, through the same hand-off a product
// page's Buy now uses (takeBuyNowHandoff in main.js) — not the whole cart.
$('kcBuy').addEventListener('click', () => {
  if (!valid()) return;
  const id = designId(design());
  try { sessionStorage.setItem('ap_buynow', JSON.stringify([{ id, qty: 1 }])); } catch { /* falls back to the cart */ addToCart(); }
  location.href = '/#checkout';
});

styleButtons();
fontButtons();
swatches('kcBase', (k) => { state.base = k; });
swatches('kcInk', (k) => { state.ink = k; });
swatches('kcAccent', (k) => { state.accent = k; });
size(); refresh(); frame();
