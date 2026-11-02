// Custom keychain designs (2026-11-02): the customer types a name, picks a font,
// a base colour and an optional text colour, and sees a 3D preview (/keychain).
//
// Each DESIGN is its own cart line. The cart, the account cart and the order
// code all key lines on a product id, so a design is carried AS the id:
//
//     kc~<base64url(JSON [text, font, base, textColour])>
//
// The same design always yields the same id (two "ASWIN, red" add up; "ASWIN"
// and "PRIYA" stay two lines), and every existing path that keys on product id
// treats it as an ordinary line without knowing anything about keychains.
//
// The id is untrusted input. parseDesign() accepts only text of the allowed
// characters and length and only fonts and colours from the fixed lists below;
// anything else is refused, never coerced. Nothing in a design can set a price:
// priceCart() takes the price from the keychain product row and the RULE here
// (two colours cost more), never from the id.

export const KC_PREFIX = "kc~";
export const KEYCHAIN_SLUG = "custom-name-keychain";
export const MAX_TEXT = 12;

// The owner's filaments (2026-11-02). Names are what the order shows; hex is for
// the preview only.
export const COLOURS = {
  white: { name: "White", hex: "#f4f4f2" },
  black: { name: "Black", hex: "#1b1b1f" },
  brown: { name: "Choco brown", hex: "#5a3a22" },
  gold: { name: "Gold", hex: "#c9a227" },
  orange: { name: "Orange", hex: "#ff7a1a" },
  blue: { name: "Blue", hex: "#1f5fd1" },
  red: { name: "Red", hex: "#d62828" },
  green: { name: "Green", hex: "#2f9e44" },
  pink: { name: "Pink", hex: "#f06fae" },
  skin: { name: "Skin", hex: "#e8b996" },
};

// Fonts (2026-11-02), built by scripts/build-kc-fonts.py into /assets/fonts3d/.
// The SAME file draws the browser preview and the printed 3MF (src/kc3mf.js).
// The first is the default.
export const FONTS = {
  script: { name: "Script", file: "kc-script.json" },   // Pacifico
  brush: { name: "Brush", file: "kc-brush.json" },      // Damion
  hand: { name: "Handwritten", file: "kc-hand.json" },  // Satisfy
  rounded: { name: "Rounded", file: "kc-rounded.json" }, // Fredoka
};

// The two prices (owner, 2026-11-02): one colour, or text in a second colour.
export const PRICE_ONE_PAISE = 19900;
export const PRICE_TWO_PAISE = 29900;

// Letters, digits, space and a few safe symbols — what prints cleanly at
// keychain size, cannot carry markup, and EVERY font in /assets/fonts3d has a
// glyph for (a missing one previews as "?"; ♥ was dropped for that reason).
// test/keychain.mjs checks this list against the font files.
export const TEXT_RE = /^[A-Za-z0-9 &.\-'!]+$/u;

export function cleanText(s) {
  return String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

// The keychain styles (2026-11-02), the owner's designs: public/assets/js/
// kc-styles.js turns each into printable parts; this list is what the shop
// ACCEPTS. `accent`: the style has a third part (inner outline, charm, bow top)
// with its own colour. The first is the default and the style of every design
// made before styles existed.
export const STYLES = {
  heart: { name: "Heart tag", accent: false },
  bubble: { name: "Bubble script", accent: false },
  double: { name: "Double outline", accent: true },
  topring: { name: "Script, ring on top", accent: false },
  classic: { name: "Classic script", accent: false },
  chunky: { name: "Chunky bubble", accent: false },
  charm: { name: "Flower charm", accent: true },
  initial: { name: "Big initial", accent: false },
  shadow: { name: "Drop shadow", accent: false },
  ribbon: { name: "Ribbon bow", accent: true },
};

// { text, font, base, ink, style, accent } → validated, or null.
// ink equal to base (or empty) means one colour; accent defaults to the base
// and is kept only for styles that have an accent part.
export function validDesign(d) {
  if (!d || typeof d !== "object") return null;
  const text = cleanText(d.text);
  if (!text || [...text].length > MAX_TEXT || !TEXT_RE.test(text)) return null;
  if (!Object.hasOwn(FONTS, d.font)) return null;
  if (!Object.hasOwn(COLOURS, d.base)) return null;
  const ink = d.ink || d.base;
  if (!Object.hasOwn(COLOURS, ink)) return null;
  const style = d.style || "heart";
  if (!Object.hasOwn(STYLES, style)) return null;
  const accent = STYLES[style].accent ? (d.accent || d.base) : d.base;
  if (!Object.hasOwn(COLOURS, accent)) return null;
  return { text, font: d.font, base: d.base, ink, style, accent };
}

const b64url = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

// A heart design keeps the original four-field id, so carts and orders from
// before styles existed still match; every other style adds [style, accent].
export function designId(d) {
  const v = validDesign(d);
  if (!v) return null;
  const fields = v.style === "heart" ? [v.text, v.font, v.base, v.ink] : [v.text, v.font, v.base, v.ink, v.style, v.accent];
  return KC_PREFIX + b64url(JSON.stringify(fields));
}

export const isDesignId = (id) => typeof id === "string" && id.startsWith(KC_PREFIX);

// The id → a validated design, or null. Strict: it must round-trip to exactly
// the same id, so two spellings of one design cannot become two lines, and a
// hand-crafted id with extra fields is refused.
export function parseDesign(id) {
  if (!isDesignId(id) || id.length > 200) return null;
  let arr;
  try { arr = JSON.parse(unb64url(id.slice(KC_PREFIX.length))); } catch { return null; }
  if (!Array.isArray(arr) || (arr.length !== 4 && arr.length !== 6)) return null;
  const v = validDesign({ text: arr[0], font: arr[1], base: arr[2], ink: arr[3], style: arr[4], accent: arr[5] });
  if (!v || designId(v) !== id) return null;
  return v;
}

// More than one colour (text, or an accent part, differs from the base).
export const twoColour = (v) => v.ink !== v.base || v.accent !== v.base;
// One colour ₹199; any multi-colour design ₹299 — including three colours
// (owner to confirm a three-colour price; 2026-11-02).
export const designPrice = (v) => (twoColour(v) ? PRICE_TWO_PAISE : PRICE_ONE_PAISE);

// What the owner reads on the order, the dashboard and the email.
export function designSummary(v) {
  const parts = [];
  if (!twoColour(v)) parts.push(`${COLOURS[v.base].name}, one colour`);
  else {
    parts.push(`${COLOURS[v.base].name} base`);
    if (v.ink !== v.base) parts.push(`${COLOURS[v.ink].name} text`);
    if (v.accent !== v.base) parts.push(`${COLOURS[v.accent].name} ${v.style === "charm" ? "flower" : v.style === "ribbon" ? "bow" : "outline"}`);
  }
  const style = v.style === "heart" ? "" : ` · ${STYLES[v.style].name}`;
  return `"${v.text}"${style} · ${FONTS[v.font].name} font · ${parts.join(", ")}`;
}
