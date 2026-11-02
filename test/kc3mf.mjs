// Print-ready keychain .3mf (src/kc3mf.js): the text mesh is a closed solid in
// the recess, the project is set up for the A1 with the customer's colours on
// the right slots, the zip is valid, and an order's file reaches the owner —
// by email and by the dashboard download — only for the owner.
//
// The real body mesh and A1 template are private (R2, not this repo), so these
// tests use a stand-in body box and a minimal template with the same shape.
// The real files were checked by slicing with Bambu Studio 2.08 (see the PR).
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { textMesh, projectFiles, projectConfig, zip, buildPrintFiles, fileName, fileParts, placement, designParts, mergeSlots, layout, extrude, PER_PLATE, MAX_PLATES, PER_FILE } from "../public/assets/js/kc-build.js";
import { STYLES as SHAPES } from "../public/assets/js/kc-styles.js";
import { printJob, BODY_KEY, RIBBON_KEY, TEMPLATE_KEY } from "../src/kc3mf.js";
import { layoutText, PANEL, MARGIN, TEXT_Z0, TEXT_Z1 } from "../public/assets/js/kc-text.js";
import { designId, parseDesign, validDesign, FONTS, COLOURS, STYLES } from "../src/keychain.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);
const font = (k) => JSON.parse(readFileSync(new URL(`../public/assets/fonts3d/${FONTS[k].file}`, import.meta.url), "utf8"));

// Every directed edge appears once, and its reverse once: closed and consistently wound.
function closed(m) {
  const e = new Map();
  for (let i = 0; i < m.t.length; i += 3) {
    const [a, b, c] = [m.t[i], m.t[i + 1], m.t[i + 2]];
    for (const [x, y] of [[a, b], [b, c], [c, a]]) e.set(`${x},${y}`, (e.get(`${x},${y}`) || 0) + 1);
  }
  for (const [k, n] of e) { const [x, y] = k.split(","); if (n !== 1 || e.get(`${y},${x}`) !== 1) return false; }
  return true;
}
// Signed volume (divergence theorem): positive = normals face outward.
function volume(m) {
  let v = 0;
  for (let i = 0; i < m.t.length; i += 3) {
    const p = [m.t[i], m.t[i + 1], m.t[i + 2]].map((k) => m.v.slice(3 * k, 3 * k + 3));
    v += (p[0][0] * (p[1][1] * p[2][2] - p[1][2] * p[2][1]) - p[0][1] * (p[1][0] * p[2][2] - p[1][2] * p[2][0]) + p[0][2] * (p[1][0] * p[2][1] - p[1][1] * p[2][0])) / 6;
  }
  return v;
}

function boxMesh(x0, y0, z0, x1, y1, z1) {
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { v, t };
}
// A stand-in body: a 120 x 32 x 5.2 box centred on 0 (the real one is private).
const BODY = (() => {
  const x = 60, y = 16, z = 2.6;
  const v = [-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z];
  const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { v, t };
})();
const TEMPLATE = {
  settings: { printer_model: "Bambu Lab A1", printer_settings_id: "Bambu Lab A1 0.4 nozzle", printable_area: ["0x0", "256x0", "256x256", "0x256"],
    filament_colour: ["#000000"], filament_settings_id: ["Bambu PLA Basic @BBL A1"], nozzle_temperature: ["220"], layer_height: "0.2" },
  per_filament: ["filament_colour", "filament_settings_id", "nozzle_temperature"],
};

// Unzip (stored or deflate) — enough to read our own output back.
function unzip(bytes) {
  const b = Buffer.from(bytes), out = {};
  const end = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = b.readUInt16LE(end + 10);
  let p = b.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nlen = b.readUInt16LE(p + 28),
      xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
    const name = b.toString("utf8", p + 46, p + 46 + nlen);
    const lnlen = b.readUInt16LE(off + 26), lxlen = b.readUInt16LE(off + 28);
    const data = b.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    out[name] = (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

const bucket = (extra = {}) => {
  const files = { [BODY_KEY]: BODY, [TEMPLATE_KEY]: TEMPLATE, ...extra };
  return { get: async (k) => (files[k] ? { json: async () => structuredClone(files[k]) } : null) };
};
const assets = { fetch: async (req) => { try { return new Response(readFileSync(new URL(`../public${new URL(req.url).pathname}`, import.meta.url))); } catch { return new Response("", { status: 404 }); } } };

section("the name, laid out in the recess");
for (const k of Object.keys(FONTS)) {
  for (const text of ["A", "Aswin", "Eilidh-Rose!", "WWWWWWWWWWWW", "il.i", "Mo & Jo's"]) {
    const { polygons, width, height } = layoutText(text, font(k));
    const pts = polygons.flat(2);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const inPanel = Math.min(...xs) >= PANEL.x0 + MARGIN - 1e-6 && Math.max(...xs) <= PANEL.x1 - MARGIN + 1e-6
      && Math.min(...ys) >= PANEL.y0 + MARGIN - 1e-6 && Math.max(...ys) <= PANEL.y1 - MARGIN + 1e-6;
    ok(`${k} "${text}": inside the recess with a ${MARGIN} mm margin`, polygons.length > 0 && inPanel, `${width.toFixed(1)}x${height.toFixed(1)}`);
  }
}

section("the text mesh is a closed solid between the recess floor and just above the top");
for (const k of Object.keys(FONTS)) {
  for (const text of ["Aswin", "Eilidh-Rose!", "B8 & Q0"]) {
    const m = textMesh(text, font(k));
    const zs = m.v.filter((_, i) => i % 3 === 2);
    ok(`${k} "${text}": closed and consistently wound`, m.t.length > 0 && closed(m));
    ok(`${k} "${text}": faces point outward (positive volume)`, volume(m) > 0, volume(m).toFixed(1));
    ok(`${k} "${text}": spans z ${TEXT_Z0}..${TEXT_Z1}`, Math.min(...zs) === TEXT_Z0 && Math.max(...zs) === TEXT_Z1);
  }
}
{
  // Script letters overlap their neighbours. They must be merged into one
  // outline: overlapping solids in one part make the slicer print the overlap
  // twice (or trip its mesh repair). Merged, the volume is LESS than the sum of
  // the letters' own areas x height.
  const area = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(a) / 2; };
  const { polygons } = layoutText("Aswin", font("script"));
  const summed = polygons.reduce((n, [outer, ...holes]) => n + area(outer) - holes.reduce((h, r) => h + area(r), 0), 0) * (TEXT_Z1 - TEXT_Z0);
  const vol = volume(textMesh("Aswin", font("script")));
  ok("overlapping script letters are merged into one solid", vol < summed - 1, `mesh ${vol.toFixed(1)} vs letters ${summed.toFixed(1)}`);
}
{
  // Holes stay holes: an "O" has less material than its outline would.
  const o = textMesh("O", font("rounded"));
  const { polygons } = layoutText("O", font("rounded"));
  ok("a letter with a hole keeps the hole", polygons.some((p) => p.length > 1) && closed(o));
}

section("the project");
{
  // The heart, with the stand-in body (the real one is private).
  const parts = (d) => mergeSlots(designParts(d, font(d.font), { heart: BODY }).parts, [COLOURS[d.base].hex, COLOURS[d.ink].hex, COLOURS[d.accent].hex]);
  const one = parseDesign(designId({ text: "Aswin", font: "script", base: "white" }));
  const two = parseDesign(designId({ text: "Aswin", font: "script", base: "white", ink: "pink" }));
  const files = (d, copies = 1) => { const p = parts(d); return Object.fromEntries(projectFiles({ parts: p.parts, size: { w: 120, h: 32 }, label: "AP-1 Aswin", copies, template: TEMPLATE, colours: p.colours })); };

  const f1 = files(one), f2 = files(two);
  const cfg1 = JSON.parse(f1["Metadata/project_settings.config"]), cfg2 = JSON.parse(f2["Metadata/project_settings.config"]);
  ok("one colour → one filament slot, in the base colour", JSON.stringify(cfg1.filament_colour) === '["#F4F4F2"]', cfg1.filament_colour);
  ok("two colours → two slots: base, then text", JSON.stringify(cfg2.filament_colour) === '["#F4F4F2","#F06FAE"]', cfg2.filament_colour);
  ok("per-filament settings repeat for each slot", cfg2.nozzle_temperature.length === 2 && cfg2.filament_settings_id.length === 2);
  ok("printer is the A1 with its 256 mm bed", cfg2.printer_model === "Bambu Lab A1" && cfg2.printable_area[2] === "256x256");
  ok("prime tower only when there is a colour change", cfg1.enable_prime_tower === "0" && cfg2.enable_prime_tower === "1");
  const ms2 = f2["Metadata/model_settings.config"], ms1 = f1["Metadata/model_settings.config"];
  ok("two colours: the text part prints on slot 2", /Text: Aswin"\/>\s*<metadata key="matrix"[^>]*\/>\s*<metadata key="extruder" value="2"/.test(ms2));
  ok("one colour: the text part prints on slot 1", /Text: Aswin"\/>\s*<metadata key="matrix"[^>]*\/>\s*<metadata key="extruder" value="1"/.test(ms1));
  ok("the body prints on slot 1", /Keychain body"\/>\s*<metadata key="matrix"[^>]*\/>\s*<metadata key="extruder" value="1"/.test(ms2));
  ok("the object file holds body and text", (f2["3D/Objects/object_1.model"].match(/<object id=/g) || []).length === 2);

  // Copies: qty 3 → three on one plate; qty 8 → two plates (6 + 2).
  const f3 = files(one, 3), f8 = files(one, 8);
  ok("qty 3 → 3 keychains", (f3["3D/3dmodel.model"].match(/<item /g) || []).length === 3);
  ok("qty 8 → 8 keychains on 2 plates", (f8["3D/3dmodel.model"].match(/<item /g) || []).length === 8 && (f8["Metadata/model_settings.config"].match(/<plate>/g) || []).length === 2);
  ok(`${PER_FILE} copies fit one file`, (files(one, PER_FILE)["3D/3dmodel.model"].match(/<item /g) || []).length === PER_FILE);
  let threw = false;
  try { files(one, PER_FILE + 1); } catch { threw = true; }
  ok(`more than ${PER_FILE} in one file is refused, never silently cut`, threw);
  ok("a line splits into files of at most PER_FILE, losing none", [1, 24, 25, 30, 48, 49, 100].every((q) => {
    const p = fileParts(q); return p.reduce((a, b) => a + b, 0) === q && p.every((n) => n >= 1 && n <= PER_FILE);
  }), JSON.stringify(fileParts(30)));
  // Every copy's footprint is on its plate's bed and clear of the others — for
  // the heart (120 x 32) and for a small and a tall style.
  ok("a single keychain sits in the middle of the bed", JSON.stringify(placement(0, 1)) === '{"plate":0,"x":128,"y":128}', JSON.stringify(placement(0, 1)));
  for (const size of [{ w: 120, h: 32 }, { w: 50, h: 50 }, { w: 115, h: 21 }, { w: 56, h: 51 }]) {
    for (const n of [1, 3, 6, 7, 24]) {
      const { at } = layout(n, size);
      const STRIDE = 256 * 1.2;
      const cols = Math.ceil(Math.sqrt(Math.max(...at.map((p) => p.plate)) + 1));
      const onBed = at.every((p) => {
        const lx = p.x - (p.plate % cols) * STRIDE, ly = p.y + Math.floor(p.plate / cols) * STRIDE;
        return lx - size.w / 2 >= 0 && lx + size.w / 2 <= 256 && ly - size.h / 2 >= 0 && ly + size.h / 2 <= 256;
      });
      const apart = at.every((p, i) => at.every((q, j) => i === j || p.plate !== q.plate || Math.abs(p.y - q.y) >= size.h + 4 || Math.abs(p.x - q.x) >= size.w + 4));
      ok(`${size.w}x${size.h}, ${n} copies: all on the bed, none touching`, onBed && apart);
    }
  }
  // Customer text is escaped in the XML.
  const sneaky = validDesign({ text: `A&B`, font: "script", base: "white" });
  const ps = parts(sneaky);
  const xs = Object.fromEntries(projectFiles({ parts: ps.parts.map((p) => ({ ...p, name: p.name.replace("A&B", `A"&<b>`) })), size: { w: 120, h: 32 }, label: `AP-1 A"&<b>`, copies: 1, template: TEMPLATE, colours: ps.colours }));
  ok("text in the XML is escaped", !xs["Metadata/model_settings.config"].includes(`A"&<b>`) && xs["Metadata/model_settings.config"].includes("A&quot;&amp;&lt;b&gt;"));
  ok("the template is not modified by a project", TEMPLATE.settings.filament_colour.length === 1 && projectConfig(TEMPLATE, ["#111111", "#222222"], 1) && TEMPLATE.settings.nozzle_temperature.length === 1);
}

section("every style: closed parts, stacked in order, one-piece base, colours on the right slots");
{
  const RIBBON_BODY = { parts: [
    { name: "Bow base", slot: 1, ...boxMesh(-24, -25, 0, 24, 25, 0.84) },
    { name: "Bow top", slot: 3, ...boxMesh(-22, -23, 0.85, 22, 23, 1.69) },
  ] };
  for (const style of Object.keys(STYLES)) {
    for (const text of ["Sophia", "Eilidh-Rose!", "Jo", "WWWWWWWWWWWW"]) {
      const f = SHAPES[style]?.font || "rounded";
      const d = validDesign({ text, font: f, base: "white", ink: "pink", style, accent: "gold" });
      let built, err = "";
      try { built = designParts(d, font(f), { heart: BODY, ribbon: RIBBON_BODY }, font("rounded")); } catch (e) { err = e.message; }
      ok(`${style} "${text}": builds`, Boolean(built), err);
      if (!built) continue;
      const bad = built.parts.filter((p) => !(p.mesh.t.length && closed(p.mesh) && volume(p.mesh) > 0)).map((p) => p.name);
      ok(`${style} "${text}": every part closed and outward-facing`, bad.length === 0, bad.join(","));
      const zs = built.parts.flatMap((p) => p.mesh.v.filter((_, i) => i % 3 === 2));
      ok(`${style} "${text}": sits on the bed`, Math.abs(Math.min(...zs)) < 1e-6, Math.min(...zs));
      const name = built.parts.find((p) => p.name.startsWith("Text:"));
      const nz = name.mesh.v.filter((_, i) => i % 3 === 2);
      ok(`${style} "${text}": the name is the top of the keychain`, Math.max(...nz) >= Math.max(...zs) - 1e-6);
      ok(`${style} "${text}": fits one plate`, built.size.w <= 246 && built.size.h <= 246, JSON.stringify(built.size));
      // Name styles' base is ONE piece: a loose crumb would print and fall off.
      if (!SHAPES[style].body) {
        const shp = SHAPES[style].build(text, font(f), font("rounded"));
        ok(`${style} "${text}": base is one piece`, shp.parts[0].shape.length === 1, shp.parts[0].shape.length);
        // …with a ring hole in it.
        ok(`${style} "${text}": base has a ring hole`, shp.parts[0].shape[0].length >= 2);
      }
    }
    // Slots: a part's slot follows its colour, and same colours share one.
    const d3 = validDesign({ text: "Ana", font: "rounded", base: "white", ink: "pink", style, accent: "gold" });
    const b3 = designParts(d3, font("rounded"), { heart: BODY, ribbon: RIBBON_BODY }, font("rounded"));
    const m3 = mergeSlots(b3.parts, [COLOURS.white.hex, COLOURS.pink.hex, COLOURS.gold.hex]);
    const want = STYLES[style].accent ? 3 : 2;
    ok(`${style}: ${want} colours → ${want} slots`, m3.colours.length === want, m3.colours.join());
    const textPart = m3.parts.find((p) => p.name.startsWith("Text:"));
    ok(`${style}: the name prints in the text colour`, m3.colours[textPart.slot - 1] === COLOURS.pink.hex);
    const m1 = mergeSlots(b3.parts, [COLOURS.red.hex, COLOURS.red.hex, COLOURS.red.hex]);
    ok(`${style}: one colour → one slot`, m1.colours.length === 1 && m1.parts.every((p) => p.slot === 1));
  }
}

section("the zip");
{
  const bytes = await zip([["a.txt", "hello"], ["dir/b.txt", "x".repeat(5000)]]);
  const back = unzip(bytes);
  ok("round-trips", back["a.txt"] === "hello" && back["dir/b.txt"] === "x".repeat(5000));
  ok("starts with a zip header", bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4);
}

section("an order line → its .3mf files (what the dashboard builds)");
{
  const d = parseDesign(designId({ text: "Priya", font: "rounded", base: "blue", ink: "gold" }));
  const job = (qty) => ({ receipt: "AP-abc123", design: d, qty, colours: [COLOURS.blue.hex, COLOURS.gold.hex, COLOURS.blue.hex], font: font("rounded"), bodies: { heart: BODY }, template: TEMPLATE });
  const [one] = await buildPrintFiles(job(2));
  const f = unzip(one.bytes);
  ok("contains a Bambu project", ["3D/3dmodel.model", "3D/Objects/object_1.model", "Metadata/model_settings.config", "Metadata/project_settings.config", "[Content_Types].xml", "_rels/.rels"].every((k) => k in f), Object.keys(f).join(","));
  ok("…in the customer's colours", JSON.parse(f["Metadata/project_settings.config"]).filament_colour.join() === "#1F5FD1,#C9A227", JSON.parse(f["Metadata/project_settings.config"]).filament_colour.join());
  ok("…named for receipt, text, colours, quantity", one.name === "AP-abc123-Priya-blue-gold-x2.3mf", one.name);
  ok("file name of a one-colour single", fileName("AP-abc123", { ...d, ink: "blue" }, 1) === "AP-abc123-Priya-blue.3mf");
  ok("file name strips anything odd", fileName("AP-1", { ...d, text: "Mo & Jo's" }, 1) === "AP-1-Mo-Jo-s-blue-gold.3mf");
  const big = await buildPrintFiles(job(30));
  ok("qty 30 → two files, 24 + 6, every keychain accounted for", big.map((x) => x.name).join() === "AP-abc123-Priya-blue-gold-x24-part1of2.3mf,AP-abc123-Priya-blue-gold-x6-part2of2.3mf", big.map((x) => x.name).join());
  ok("…the second really holds 6", (unzip(big[1].bytes)["3D/3dmodel.model"].match(/<item /g) || []).length === 6);
}

section("the Worker hands the owner the inputs, and nothing else");
{
  const kc = designId({ text: "Aswin", font: "script", base: "white", ink: "pink" });
  const rows = { "11111111-1111-4111-8111-111111111111:0": { receipt: "AP-7", design_id: kc, qty: 3 },
                 "11111111-1111-4111-8111-111111111111:1": { receipt: "AP-7", design_id: "", qty: 1 },
                 "11111111-1111-4111-8111-111111111111:2": { receipt: "AP-7", design_id: "kc~forged", qty: 1 } };
  const DB = { prepare: () => ({ bind: (id, pos) => ({ first: async () => rows[`${id}:${pos}`] || null }) }) };
  const raw = { [BODY_KEY]: JSON.stringify(BODY), [TEMPLATE_KEY]: JSON.stringify(TEMPLATE) };
  const UPLOADS = { get: async (k) => (raw[k] ? { text: async () => raw[k] } : null) };
  const env = { DB, UPLOADS };
  const r = await printJob(env, "11111111-1111-4111-8111-111111111111", 0);
  const job = await r.json();
  ok("a keychain line → its job", r.status === 200 && job.receipt === "AP-7" && job.qty === 3 && job.design.text === "Aswin");
  ok("…with the colours (base, text, accent) and font for the design", job.colours.join() === "#f4f4f2,#f06fae,#f4f4f2" && job.font === "/assets/fonts3d/kc-script.json", JSON.stringify([job.colours, job.font]));
  ok("…and the private body and template, unchanged", JSON.stringify(job.bodies.heart) === JSON.stringify(BODY) && JSON.stringify(job.template) === JSON.stringify(TEMPLATE));
  ok("…never cached", r.headers.get("cache-control") === "private, no-store");
  ok("a non-keychain line → 404", (await printJob(env, "11111111-1111-4111-8111-111111111111", 1)).status === 404);
  ok("a forged design → 404", (await printJob(env, "11111111-1111-4111-8111-111111111111", 2)).status === 404);
  ok("an unknown line → 404", (await printJob(env, "11111111-1111-4111-8111-111111111111", 9)).status === 404);
  ok("missing model files → 500, not a broken job", (await printJob({ DB, UPLOADS: { get: async () => null } }, "11111111-1111-4111-8111-111111111111", 0)).status === 500);
  // A name style needs no body: none is read or sent.
  rows["11111111-1111-4111-8111-111111111111:3"] = { receipt: "AP-7", design_id: designId({ text: "Aswin", font: "script", base: "white", ink: "pink", style: "bubble" }), qty: 1 };
  const reads = [];
  const env2 = { DB, UPLOADS: { get: async (k) => { reads.push(k); return raw[k] ? { text: async () => raw[k] } : null; } } };
  const j2 = await (await printJob(env2, "11111111-1111-4111-8111-111111111111", 3)).json();
  ok("a name style's job carries no body, and reads only the template", JSON.stringify(j2.bodies) === "{}" && JSON.stringify(reads) === JSON.stringify([TEMPLATE_KEY]), JSON.stringify(reads));
  // The ribbon reads ITS body, not the heart's.
  rows["11111111-1111-4111-8111-111111111111:4"] = { receipt: "AP-7", design_id: designId({ text: "Ann", font: "hand", base: "white", style: "ribbon", accent: "pink" }), qty: 1 };
  raw[RIBBON_KEY] = JSON.stringify({ parts: [] });
  reads.length = 0;
  const j3 = await (await printJob(env2, "11111111-1111-4111-8111-111111111111", 4)).json();
  ok("the ribbon's job carries the ribbon body", "ribbon" in j3.bodies && !("heart" in j3.bodies) && reads.includes(RIBBON_KEY) && !reads.includes(BODY_KEY));
  ok("…and the bow colour as the third", j3.colours[2] === COLOURS.pink.hex);
  delete raw[RIBBON_KEY];
  ok("a missing ribbon body → 500", (await printJob(env2, "11111111-1111-4111-8111-111111111111", 4)).status === 500);
  // And the inputs it returns build a real file — the browser's whole job.
  const files = await buildPrintFiles({ ...job, font: font("script"), initialFont: font("rounded") });
  ok("the job builds into a .3mf", files.length === 1 && files[0].name === "AP-7-Aswin-white-pink-x3.3mf" && unzip(files[0].bytes)["3D/3dmodel.model"].includes("<item "));

  // Owner-only: the route sits under the /api/admin/ gate.
  const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const gate = src.indexOf('if (p.startsWith("/api/admin/")) {');
  const route = src.indexOf("printJob(env, printFile[1]");
  ok("the print-job route is below the owner gate", gate > 0 && route > gate);
  // The Worker never builds the file: it imports none of the geometry.
  const worker = readFileSync(new URL("../src/kc3mf.js", import.meta.url), "utf8");
  ok("the Worker does no geometry (free-plan CPU)", !/^import .*(kc-build|polygon|earcut)/m.test(worker) && !/\bzip\(/.test(worker));
}

section("every name style's base is one piece with a ring hole — awkward names, every font");
{
  // Spaced-out text, single letters, punctuation only: the cases where an
  // outline alone falls apart into islands (and the ring with them).
  const NAMES = ["i i i", "A . B", "W", "I", "x-y", "- -", "1 2 3 4 5 6", "!!!!", "'", ".", "Ty", "mmmmmmmmmmmm", "Sophia"];
  const fails = [];
  for (const [style, st] of Object.entries(SHAPES)) {
    if (!st.build) continue;
    for (const f of Object.keys(FONTS)) for (const t of NAMES) {
      const r = st.build(t, font(f), font("rounded"));
      const b = r?.parts[0].shape;
      if (!b || b.length !== 1 || b[0].length < 2) fails.push(`${style}/${f}/${JSON.stringify(t)}:${b ? b.length + "p" + (b[0]?.length || 0) + "r" : "null"}`);
    }
  }
  ok("one piece with a ring hole, every style x font x awkward name", fails.length === 0, fails.slice(0, 6).join(" "));
}
{
  // A lone script W: its outline used to come back in 4 pieces (saddle cells
  // in the contour joined the wrong way). One piece, growing with the radius.
  const { offset, area, translate } = await import("../public/assets/js/kc-shapes.js");
  const { nameShape } = await import("../public/assets/js/kc-styles.js");
  const w = nameShape("W", font("script"), 20, 100).shape;
  const sizes = [0.5, 1, 2.2, 3].map((r) => offset(w, r));
  ok("a script W's outline is one piece at every radius", sizes.every((o) => o.length === 1), sizes.map((o) => o.length).join());
  ok("…and grows with the radius", sizes.every((o, i) => !i || area(o) > area(sizes[i - 1])), sizes.map((o) => area(o).toFixed(0)).join());
}

{
  // The big initial moves the name 6 mm below centre; the spine must follow it,
  // or "a b" under the initial is two islands joined only by luck.
  const { bounds } = await import("../public/assets/js/kc-shapes.js");
  const src = readFileSync(new URL("../public/assets/js/kc-styles.js", import.meta.url), "utf8");
  const spineSrc = src.slice(src.indexOf("function spine("), src.indexOf("\n}\n", src.indexOf("function spine(")) + 2);
  const spine = new Function("bounds", `${spineSrc}; return spine;`)(bounds);
  const name = [[[[0, -12], [4, -12], [4, 0], [0, 0]]], [[[10, -12], [14, -12], [14, 0], [10, 0]]]];
  const bar = spine(name)[0][0], ys = bar.map((p) => p[1]);
  ok("the spine is centred on a moved name, not on y = 0", Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 + 6) < 1e-9, JSON.stringify(ys));
}

section("the vendored geometry libraries are browser-safe");
{
  // A page element with id="process" is a global in browsers (index.html has
  // one); a library testing `typeof process` would mistake it for Node's.
  for (const f of ["clipper2.js", "earcut.js"]) {
    const src = readFileSync(new URL(`../public/assets/vendor/kc/${f}`, import.meta.url), "utf8");
    ok(`${f}: no process.env lookups`, !/typeof process|process\.env\.[A-Z]/.test(src));
    ok(`${f}: no imports from outside this site`, !/^import .* from ["'](?!\.)/m.test(src));
  }
}

section("the private files stay private");
{
  const { execSync } = await import("node:child_process");
  const tracked = execSync("git ls-files", { cwd: new URL("..", import.meta.url) }).toString();
  ok("no body mesh or template in the repo", !/heart-body|ribbon-body|a1-template|\.3mf$/m.test(tracked));
  const page = readFileSync(new URL("../public/assets/js/keychain.js", import.meta.url), "utf8");
  ok("the preview never loads a body mesh", !/heart-body|ribbon-body|private\//.test(page));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
