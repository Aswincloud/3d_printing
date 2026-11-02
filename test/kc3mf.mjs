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
import { textMesh, projectFiles, projectConfig, zip, keychain3mf, fileName, fileParts, placement, printFilesFor, downloadPrintFile, BODY_KEY, TEMPLATE_KEY, PER_PLATE, MAX_PLATES, PER_FILE } from "../src/kc3mf.js";
import { layoutText, PANEL, MARGIN, TEXT_Z0, TEXT_Z1 } from "../public/assets/js/kc-text.js";
import { designId, parseDesign, FONTS } from "../src/keychain.js";

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
  const one = parseDesign(designId({ text: "Aswin", font: "script", base: "white" }));
  const two = parseDesign(designId({ text: "Aswin", font: "script", base: "white", ink: "pink" }));
  const text = textMesh("Aswin", font("script"));
  const files = (d, copies = 1) => Object.fromEntries(projectFiles({ design: d, label: "AP-1 Aswin", copies, body: BODY, text, template: TEMPLATE }));

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
  ok("the main model points at the meshes", f2["3D/3dmodel.model"].includes('p:path="/3D/Objects/object_1.model" objectid="1"') && f2["3D/3dmodel.model"].includes('objectid="2"'));
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
  // Every copy's 120 x 32 footprint is on its plate's bed and clear of the others.
  ok("a single keychain sits in the middle of the bed", JSON.stringify(placement(0, 1)) === '{"plate":0,"x":128,"y":128}', JSON.stringify(placement(0, 1)));
  ok("the last plate's copies are centred too (7 → 1 alone on plate 2)", placement(6, 7).y === 128 && placement(6, 7).plate === 1, JSON.stringify(placement(6, 7)));
  for (const n of [1, 3, 6, 7, 24]) {
    const at = Array.from({ length: n }, (_, i) => placement(i, n));
    const STRIDE = 256 * 1.2;
    const cols = Math.ceil(Math.sqrt(Math.ceil(n / PER_PLATE)));
    const onBed = at.every((p) => {
      const lx = p.x - (p.plate % cols) * STRIDE, ly = p.y + Math.floor(p.plate / cols) * STRIDE;
      return lx - 60 >= 0 && lx + 60 <= 256 && ly - 16 >= 0 && ly + 16 <= 256;
    });
    const apart = at.every((p, i) => at.every((q, j) => i === j || p.plate !== q.plate || Math.abs(p.y - q.y) >= 32 + 4 || Math.abs(p.x - q.x) >= 120 + 4));
    ok(`${n} copies: all on the bed, none touching`, onBed && apart);
  }
  // Customer text is escaped in the XML.
  const sneaky = { text: `A"&<b>`, font: "script", base: "white", ink: "white" };
  const xs = Object.fromEntries(projectFiles({ design: sneaky, label: `AP-1 A"&<b>`, copies: 1, body: BODY, text, template: TEMPLATE }));
  ok("text in the XML is escaped", !xs["Metadata/model_settings.config"].includes(`A"&<b>`) && xs["Metadata/model_settings.config"].includes("A&quot;&amp;&lt;b&gt;"));
  ok("the template is not modified by a project", TEMPLATE.settings.filament_colour.length === 1 && projectConfig(TEMPLATE, ["#111111", "#222222"], 1) && TEMPLATE.settings.nozzle_temperature.length === 1);
}

section("the zip");
{
  const bytes = await zip([["a.txt", "hello"], ["dir/b.txt", "x".repeat(5000)]]);
  const back = unzip(bytes);
  ok("round-trips", back["a.txt"] === "hello" && back["dir/b.txt"] === "x".repeat(5000));
  ok("starts with a zip header", bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4);
}

section("one design → the .3mf");
{
  const env = { UPLOADS: bucket(), ASSETS: assets };
  const d = parseDesign(designId({ text: "Priya", font: "rounded", base: "blue", ink: "gold" }));
  const bytes = await keychain3mf(env, { design: d, receipt: "AP-abc123", copies: 2 });
  const f = unzip(bytes);
  ok("contains a Bambu project", ["3D/3dmodel.model", "3D/Objects/object_1.model", "Metadata/model_settings.config", "Metadata/project_settings.config", "[Content_Types].xml", "_rels/.rels"].every((k) => k in f), Object.keys(f).join(","));
  ok("…in the customer's colours", JSON.parse(f["Metadata/project_settings.config"]).filament_colour.join() === "#1F5FD1,#C9A227");
  ok("file name says receipt, text, colours, quantity", fileName("AP-abc123", d, 2) === "AP-abc123-Priya-blue-gold-x2.3mf");
  ok("file name of a one-colour single", fileName("AP-abc123", { ...d, ink: "blue" }, 1) === "AP-abc123-Priya-blue.3mf");
  ok("file name strips anything odd", fileName("AP-1", { ...d, text: "Mo & Jo's" }, 1) === "AP-1-Mo-Jo-s-blue-gold.3mf");
  let threw = "";
  try { await keychain3mf({ UPLOADS: { get: async () => null }, ASSETS: assets }, { design: d, receipt: "AP-1" }); } catch (e) { threw = e.message; }
  ok("a missing private body is an error, not a broken file", /missing private\/keychain\/heart-body\.json/.test(threw), threw);
}

section("an order's print files (the owner email)");
{
  const env = { UPLOADS: bucket(), ASSETS: assets };
  const kc = designId({ text: "Aswin", font: "script", base: "white", ink: "pink" });
  const r = await printFilesFor(env, { receipt: "AP-9" }, [
    { name: "Murugan Box", qty: 1, design_id: "" },
    { name: "Custom Name Keychain", qty: 2, design_id: kc },
  ]);
  ok("one attachment for the one keychain line", r.attachments.length === 1 && r.failed === 0);
  ok("…named for the order and design", r.attachments[0]?.filename === "AP-9-Aswin-white-pink-x2.3mf", r.attachments[0]?.filename);
  ok("…as base64 of a zip", Buffer.from(r.attachments[0]?.content || "", "base64").subarray(0, 2).toString() === "PK");
  const big = await printFilesFor(env, { receipt: "AP-9" }, [{ qty: 30, design_id: kc }]);
  ok("qty 30 → two files, 24 + 6, every keychain accounted for", big.attachments.map((a) => a.filename).join() === "AP-9-Aswin-white-pink-x24-part1of2.3mf,AP-9-Aswin-white-pink-x6-part2of2.3mf", big.attachments.map((a) => a.filename).join());
  const bad = await printFilesFor(env, { receipt: "AP-9" }, [{ qty: 1, design_id: "kc~nonsense" }]);
  ok("an unparseable design is counted as failed, not thrown", bad.attachments.length === 0 && bad.failed === 1);
  const broken = await printFilesFor({ UPLOADS: { get: async () => null }, ASSETS: assets }, { receipt: "AP-9" }, [{ qty: 1, design_id: kc }]);
  ok("a missing body is counted as failed, not thrown", broken.attachments.length === 0 && broken.failed === 1);
}

section("the dashboard download");
{
  const kc = designId({ text: "Aswin", font: "script", base: "white", ink: "pink" });
  const rows = { "11111111-1111-4111-8111-111111111111:0": { receipt: "AP-7", design_id: kc, qty: 1 },
                 "11111111-1111-4111-8111-111111111111:1": { receipt: "AP-7", design_id: "", qty: 1 } };
  const DB = { prepare: () => ({ bind: (id, pos) => ({ first: async () => rows[`${id}:${pos}`] || null }) }) };
  const env = { DB, UPLOADS: bucket(), ASSETS: assets };
  const r = await downloadPrintFile(env, "11111111-1111-4111-8111-111111111111", 0);
  ok("a keychain line downloads", r.status === 200 && /attachment; filename="AP-7-Aswin-white-pink\.3mf"/.test(r.headers.get("content-disposition")));
  ok("…never cached", r.headers.get("cache-control") === "private, no-store");
  ok("a non-keychain line → 404", (await downloadPrintFile(env, "11111111-1111-4111-8111-111111111111", 1)).status === 404);
  ok("an unknown line → 404", (await downloadPrintFile(env, "11111111-1111-4111-8111-111111111111", 9)).status === 404);
  rows["11111111-1111-4111-8111-111111111111:2"] = { receipt: "AP-7", design_id: kc, qty: 30 };
  const p2 = await downloadPrintFile(env, "11111111-1111-4111-8111-111111111111", 2, 2);
  ok("part 2 of a 30-line downloads the remaining 6", p2.status === 200 && /AP-7-Aswin-white-pink-x6-part2of2\.3mf/.test(p2.headers.get("content-disposition")), p2.headers.get("content-disposition"));
  ok("a part past the end → 404", (await downloadPrintFile(env, "11111111-1111-4111-8111-111111111111", 2, 3)).status === 404);
  ok("part 0 → 404", (await downloadPrintFile(env, "11111111-1111-4111-8111-111111111111", 2, 0)).status === 404);

  // Owner-only: the route sits under the /api/admin/ gate.
  const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const gate = src.indexOf('if (p.startsWith("/api/admin/")) {');
  const route = src.indexOf("downloadPrintFile(env, printFile[1]");
  ok("the download route is below the owner gate", gate > 0 && route > gate);
}

section("the private files stay private");
{
  const { execSync } = await import("node:child_process");
  const tracked = execSync("git ls-files", { cwd: new URL("..", import.meta.url) }).toString();
  ok("no body mesh or template in the repo", !/heart-body|a1-template|\.3mf$/m.test(tracked));
  const page = readFileSync(new URL("../public/assets/js/keychain.js", import.meta.url), "utf8");
  ok("the preview never loads the body mesh", !/heart-body|private\//.test(page));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
