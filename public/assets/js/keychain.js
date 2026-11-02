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

const COLOURS = {
  white: ['White', '#f4f4f2'], black: ['Black', '#1b1b1f'], brown: ['Choco brown', '#5a3a22'],
  gold: ['Gold', '#c9a227'], orange: ['Orange', '#ff7a1a'], blue: ['Blue', '#1f5fd1'],
  red: ['Red', '#d62828'], green: ['Green', '#2f9e44'], pink: ['Pink', '#f06fae'], skin: ['Skin', '#e8b996'],
};
const FONTS = {
  script: ['Script', 'kc-script.json'], brush: ['Brush', 'kc-brush.json'],
  hand: ['Handwritten', 'kc-hand.json'], rounded: ['Rounded', 'kc-rounded.json'],
};
const MAX_TEXT = 12;
const PRICE_ONE = 19900, PRICE_TWO = 29900;
const TEXT_RE = /^[A-Za-z0-9 &.\-'!]+$/u;   // must match src/keychain.js
const CART_KEY = 'ap_cart';

const state = { text: 'Aswin', font: 'script', base: 'white', ink: 'pink', twoTone: true };
const $ = (id) => document.getElementById(id);
const rupees = (p) => '₹' + (p / 100).toLocaleString('en-IN');
const clean = (s) => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();

// ── the design id: MUST equal designId() in src/keychain.js ───────
function designId(d) {
  const json = JSON.stringify([d.text, d.font, d.base, d.ink]);
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'kc~' + b64;
}
const valid = () => {
  const t = clean(state.text);
  return t && [...t].length <= MAX_TEXT && TEXT_RE.test(t);
};
const design = () => ({ text: clean(state.text), font: state.font, base: state.base, ink: state.twoTone ? state.ink : state.base });

// ── 3D scene ──────────────────────────────────────────────────────
const host = $('kcCanvas');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
host.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 1000);
camera.position.set(0, -70, 150);
scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(60, -40, 120); scene.add(key);
const rim = new THREE.DirectionalLight(0xffd9a8, 0.6); rim.position.set(-80, 60, -40); scene.add(rim);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.enablePan = false;
controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
controls.autoRotateSpeed = 1.6;
const group = new THREE.Group(); scene.add(group);
// For the browser test: how many meshes the preview is drawing.
window.__kcParts = () => group.children.length;

// Far enough that the whole 120 mm plate (radius ~64 mm as it turns) fits the
// canvas at any rotation, whatever the canvas's shape.
function fitDistance() {
  const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  return 72 / (half * Math.min(1, camera.aspect));
}
let fitted = false;
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

let building = 0;
async function rebuild() {
  const my = ++building;
  const d = design();
  const font = await loadFont(d.font).catch(() => null);
  if (my !== building || !font) return;
  while (group.children.length) { const m = group.children.pop(); m.geometry.dispose(); m.material.dispose(); }
  const mat = (hex) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.55, metalness: hex === COLOURS.gold[1] ? 0.45 : 0.05 });
  for (const g of plateGeometries()) group.add(new THREE.Mesh(g, mat(COLOURS[d.base][1])));
  if (d.text) group.add(new THREE.Mesh(textGeometry(d.text, font), mat(COLOURS[d.ink][1])));
  fit();
}

function frame() { requestAnimationFrame(frame); controls.update(); renderer.render(scene, camera); }

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

function refresh() {
  for (const b of $('kcFonts').children) b.setAttribute('aria-pressed', String(b.dataset.font === state.font));
  markSwatches('kcBase', state.base);
  markSwatches('kcInk', state.ink);
  $('kcInkRow').hidden = !state.twoTone;
  const d = design(), two = d.ink !== d.base;
  $('kcPrice').textContent = rupees(two ? PRICE_TWO : PRICE_ONE);
  $('kcPriceNote').textContent = two ? 'Two colours' : 'One colour';
  $('kcSummary').textContent = '"' + (d.text || '') + '" · ' + FONTS[d.font][0] + ' font · ' +
    (two ? COLOURS[d.base][0] + ' base, ' + COLOURS[d.ink][0] + ' text' : COLOURS[d.base][0] + ', one colour');
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

fontButtons();
swatches('kcBase', (k) => { state.base = k; });
swatches('kcInk', (k) => { state.ink = k; });
size(); refresh(); frame();
