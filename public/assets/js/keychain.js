// /keychain — design a custom name keychain with a live 3D preview (2026-11-02).
//
// A rounded plate with a keyring hole and the name raised on it, rebuilt as you
// type. Everything here is the customer's choice and is DISPLAY ONLY: the cart
// line is the design's id, and the server decodes, validates and prices it
// (src/keychain.js). The colour and font lists below must match that file.
import * as THREE from '/assets/vendor/three/three.module.min.js';
import { FontLoader } from '/assets/vendor/three/FontLoader.js';
import { TextGeometry } from '/assets/vendor/three/TextGeometry.js';
import { OrbitControls } from '/assets/vendor/three/OrbitControls.js';

const COLOURS = {
  white: ['White', '#f4f4f2'], black: ['Black', '#1b1b1f'], brown: ['Choco brown', '#5a3a22'],
  gold: ['Gold', '#c9a227'], orange: ['Orange', '#ff7a1a'], blue: ['Blue', '#1f5fd1'],
  red: ['Red', '#d62828'], green: ['Green', '#2f9e44'], pink: ['Pink', '#f06fae'], skin: ['Skin', '#e8b996'],
};
const FONTS = {
  bold: ['Bold', 'helvetiker_bold.typeface.json'], classic: ['Classic', 'optimer_bold.typeface.json'],
  serif: ['Serif', 'droid_serif_bold.typeface.json'], rounded: ['Rounded', 'gentilis_bold.typeface.json'],
};
const MAX_TEXT = 12;
const PRICE_ONE = 19900, PRICE_TWO = 29900;
const TEXT_RE = /^[A-Za-z0-9 &.\-'!♥]+$/u;
const CART_KEY = 'ap_cart';

const state = { text: 'ASWIN', font: 'bold', base: 'orange', ink: 'orange', twoTone: false };
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
camera.position.set(0, -40, 150);
scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(60, -40, 120); scene.add(key);
const rim = new THREE.DirectionalLight(0xffd9a8, 0.6); rim.position.set(-80, 60, -40); scene.add(rim);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.enablePan = false; controls.minDistance = 80; controls.maxDistance = 260;
controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
controls.autoRotateSpeed = 1.6;
const group = new THREE.Group(); scene.add(group);

function size() {
  const w = host.clientWidth, h = host.clientHeight || 280;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(size).observe(host);

const fonts = {};
const loader = new FontLoader();
function loadFont(k) {
  if (fonts[k]) return Promise.resolve(fonts[k]);
  return new Promise((res, rej) => loader.load('/assets/fonts3d/' + FONTS[k][1], (f) => { fonts[k] = f; res(f); }, undefined, rej));
}

// A rounded-rectangle plate with a keyring hole on the left, sized to the text.
function plateShape(w, h, r, holeR, holeX) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  const hole = new THREE.Path(); hole.absarc(holeX, 0, holeR, 0, Math.PI * 2, true); s.holes.push(hole);
  return s;
}

let building = 0;
async function rebuild() {
  const my = ++building;
  const d = design();
  const font = await loadFont(d.font).catch(() => null);
  if (my !== building || !font) return;
  while (group.children.length) { const m = group.children.pop(); m.geometry.dispose(); m.material.dispose(); }
  const text = d.text || ' ';
  const tg = new TextGeometry(text, { font, size: 12, depth: 2.2, curveSegments: 6, bevelEnabled: true, bevelThickness: 0.35, bevelSize: 0.3, bevelSegments: 2 });
  tg.computeBoundingBox();
  const bb = tg.boundingBox, tw = bb.max.x - bb.min.x, th = bb.max.y - bb.min.y;
  const pad = 7, holeSpace = 13;
  const w = tw + pad * 2 + holeSpace, h = Math.max(th + pad * 2, 26);
  const plate = new THREE.ExtrudeGeometry(plateShape(w, h, 6, 3.4, -w / 2 + 7.5), { depth: 4, bevelEnabled: true, bevelThickness: 0.6, bevelSize: 0.6, bevelSegments: 2, curveSegments: 18 });
  const mat = (hex) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.55, metalness: hex === COLOURS.gold[1] ? 0.45 : 0.05 });
  const plateMesh = new THREE.Mesh(plate, mat(COLOURS[d.base][1]));
  const textMesh = new THREE.Mesh(tg, mat(COLOURS[d.ink][1]));
  // Text centred in the space right of the hole, sitting on the plate's top face.
  textMesh.position.set(-bb.min.x - tw / 2 + holeSpace / 2, -bb.min.y - th / 2, 4.6);
  group.add(plateMesh, textMesh);
  group.position.set(0, 0, -2.3);
  // Fit the camera to the plate's width.
  const dist = Math.min(240, Math.max(95, w * 1.55));
  controls.minDistance = dist * 0.6; camera.position.setLength(dist);
}

function frame() { requestAnimationFrame(frame); controls.update(); renderer.render(scene, camera); }

// ── controls ──────────────────────────────────────────────────────
function swatches(id, pick, current) {
  const box = $(id); box.replaceChildren();
  for (const [k, [name, hex]] of Object.entries(COLOURS)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'kc-swatch'; b.style.setProperty('--sw', hex);
    b.setAttribute('aria-label', name); b.title = name;
    b.setAttribute('aria-pressed', String(k === current()));
    b.addEventListener('click', () => { pick(k); refresh(); });
    box.append(b);
  }
}
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
  swatches('kcBase', (k) => { state.base = k; }, () => state.base);
  swatches('kcInk', (k) => { state.ink = k; }, () => state.ink);
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
    : !TEXT_RE.test(clean(state.text)) ? 'Letters, numbers, spaces and & . - \' ! ♥ only.' : '';
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
$('kcText').maxLength = MAX_TEXT + 4;
$('kcText').addEventListener('input', (e) => { state.text = e.target.value; refresh(); });
$('kcTwoTone').addEventListener('change', (e) => { state.twoTone = e.target.checked; if (state.twoTone && state.ink === state.base) state.ink = state.base === 'white' ? 'black' : 'white'; refresh(); });
$('kcAdd').addEventListener('click', () => {
  if (!addToCart()) return;
  const msg = $('kcAdded'); msg.hidden = false;
  clearTimeout(msg._t); msg._t = setTimeout(() => { msg.hidden = true; }, 4000);
});
$('kcBuy').addEventListener('click', () => { if (addToCart()) location.href = '/#checkout'; });

fontButtons();
size(); refresh(); frame();
