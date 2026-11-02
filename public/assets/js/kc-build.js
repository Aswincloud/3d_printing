// Builds a print-ready Bambu Studio project (.3mf) for a custom name keychain
// (2026-11-02). Runs in the OWNER'S BROWSER (the dashboard's Download button,
// public/assets/js/admin.js) and in the tests — not in the Worker: the shop is
// on Cloudflare's free plan (10 ms of CPU per request) and a build takes
// 50-300 ms. The Worker only hands the owner the inputs (src/kc3mf.js).
//
// The file: the keychain body (private, fetched owner-only), the customer's
// name as its own solid part laid out by kc-text.js (the same layout as the
// shop's preview), each part on its AMS slot in the customer's colours, the
// printer set to the A1 from a template built by scripts/build-kc-template.py.
import polygonClipping from "../vendor/kc/polygon-clipping.js";
import earcut from "../vendor/kc/earcut.js";
import { layoutText, area2, TEXT_Z0, TEXT_Z1 } from "./kc-text.js";

// Copies per plate, and the most plates one file holds. Six 120 x 32 mm
// keychains fit the A1's 256 mm bed in a column with room to spare.
export const PER_PLATE = 6;
export const MAX_PLATES = 4;
const BED = 256, PITCH = 40;
// Bambu Studio lays plates out in a grid, each plate 1.2 bed-widths from the
// last (seen in a Studio-saved project: plate 2's object at x = 128 + 307.2).
const PLATE_STRIDE = BED * 1.2;
const BODY_HALF_HEIGHT = 2.6; // the body mesh is centred on z = 0

// ── geometry ──────────────────────────────────────────────────────

// The name as a closed, outward-facing triangle mesh in body coordinates.
// Overlapping script letters are merged first, so the mesh has no internal
// faces for the slicer to trip over.
export function textMesh(text, font) {
  const { polygons } = layoutText(text, font);
  if (!polygons.length) return { v: [], t: [] };
  const merged = polygonClipping.union(...polygons.map((p) => [p]));
  const v = [], t = [];
  for (const poly of merged) {
    // polygon-clipping repeats each ring's first point at its end.
    const rings = poly.map((r) => r.slice(0, -1)).filter((r) => r.length > 2);
    if (!rings.length) continue;
    // Outer ring counter-clockwise, holes clockwise: the side walls below rely on it.
    rings.forEach((r, i) => { if ((area2(r) > 0) !== (i === 0)) r.reverse(); });
    const flat = [], holes = [];
    for (const r of rings) {
      if (flat.length) holes.push(flat.length / 2);
      for (const [x, y] of r) flat.push(x, y);
    }
    const n = flat.length / 2, base = v.length / 3;
    // Vertex k of the polygon: bottom at base + 2k, top at base + 2k + 1.
    for (let k = 0; k < n; k++) v.push(flat[2 * k], flat[2 * k + 1], TEXT_Z0, flat[2 * k], flat[2 * k + 1], TEXT_Z1);
    const tri = earcut(flat, holes);
    for (let i = 0; i < tri.length; i += 3) {
      let [a, b, c] = [tri[i], tri[i + 1], tri[i + 2]];
      const ccw = (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) - (flat[2 * c] - flat[2 * a]) * (flat[2 * b + 1] - flat[2 * a + 1]) > 0;
      if (!ccw) [b, c] = [c, b];
      t.push(base + 2 * a + 1, base + 2 * b + 1, base + 2 * c + 1); // top, facing up
      t.push(base + 2 * a, base + 2 * c, base + 2 * b);             // bottom, facing down
    }
    // Side walls, ring by ring: edge a→b with the solid on its left.
    let start = 0;
    for (const r of rings) {
      for (let k = 0; k < r.length; k++) {
        const a = start + k, b = start + (k + 1) % r.length;
        t.push(base + 2 * a, base + 2 * b, base + 2 * b + 1);
        t.push(base + 2 * a, base + 2 * b + 1, base + 2 * a + 1);
      }
      start += r.length;
    }
  }
  return { v, t };
}

// ── project files ─────────────────────────────────────────────────

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Full float precision: the body has distinct vertices closer than 1e-4 mm,
// and rounding them together would tear its surface.
const num = (x) => String(Math.fround(x));

function meshXml(id, m) {
  const out = [`  <object id="${id}" type="model">\n   <mesh>\n    <vertices>\n`];
  for (let i = 0; i < m.v.length; i += 3) out.push(`     <vertex x="${num(m.v[i])}" y="${num(m.v[i + 1])}" z="${num(m.v[i + 2])}"/>\n`);
  out.push("    </vertices>\n    <triangles>\n");
  for (let i = 0; i < m.t.length; i += 3) out.push(`     <triangle v1="${m.t[i]}" v2="${m.t[i + 1]}" v3="${m.t[i + 2]}"/>\n`);
  out.push("    </triangles>\n   </mesh>\n  </object>\n");
  return out.join("");
}

const NS = `xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"`;
const uuid = (a, b) => `${a.toString(16).padStart(8, "0")}-${b.toString(16).padStart(4, "0")}-4000-8000-000000000000`;

// Where copy i (0-based) of n sits: a column of up to PER_PLATE per plate,
// centred on the bed; plates in Bambu's grid (cols = ceil(sqrt(plates))).
export function placement(i, n) {
  const plates = Math.ceil(n / PER_PLATE);
  const plate = Math.floor(i / PER_PLATE), slot = i % PER_PLATE;
  const onPlate = Math.min(PER_PLATE, n - plate * PER_PLATE);
  const cols = Math.ceil(Math.sqrt(plates));
  const px = (plate % cols) * PLATE_STRIDE, py = -Math.floor(plate / cols) * PLATE_STRIDE;
  return { plate, x: px + BED / 2, y: py + BED / 2 + (slot - (onPlate - 1) / 2) * PITCH };
}

// Build the project for `copies` of one design. Returns the files of the 3MF
// as [name, string] pairs; zip() packs them.
// `colours`: the filament hex for each slot — [base] or [base, text].
export function projectFiles({ design, label, copies, body, text, template, colours }) {
  const two = design.ink !== design.base;
  const nFil = two ? 2 : 1;
  const textSlot = two ? 2 : 1;
  // Callers split larger lines with fileParts(); more here is a bug, not a clamp.
  if (!(copies >= 1 && copies <= PER_PLATE * MAX_PLATES)) throw new Error(`copies must be 1..${PER_PLATE * MAX_PLATES}, got ${copies}`);
  const n = copies;
  const plates = Math.ceil(n / PER_PLATE);

  // Mesh objects: 1 = body, 2 = text. Every copy is a component pair pointing at them.
  const objectModel = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n`
    + meshXml(1, body) + meshXml(2, text) + ` </resources>\n <build/>\n</model>\n`;

  const resources = [], items = [], cfgObjects = [], instances = Array.from({ length: plates }, () => []);
  for (let i = 0; i < n; i++) {
    const id = 3 + i;
    const at = placement(i, n);
    resources.push(`  <object id="${id}" p:UUID="${uuid(id, 1)}" type="model">\n   <components>\n`
      + `    <component p:path="/3D/Objects/object_1.model" objectid="1" p:UUID="${uuid(id, 2)}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n`
      + `    <component p:path="/3D/Objects/object_1.model" objectid="2" p:UUID="${uuid(id, 3)}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n`
      + `   </components>\n  </object>\n`);
    items.push(`  <item objectid="${id}" p:UUID="${uuid(id, 4)}" transform="1 0 0 0 1 0 0 0 1 ${num(at.x)} ${num(at.y)} ${BODY_HALF_HEIGHT}" printable="1"/>\n`);
    const name = n > 1 ? `${label} (${i + 1})` : label;
    cfgObjects.push(`  <object id="${id}">\n    <metadata key="name" value="${xml(name)}"/>\n    <metadata key="extruder" value="1"/>\n`
      + `    <part id="1" subtype="normal_part">\n      <metadata key="name" value="Keychain body"/>\n      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n      <metadata key="extruder" value="1"/>\n    </part>\n`
      + `    <part id="2" subtype="normal_part">\n      <metadata key="name" value="${xml(`Text: ${design.text}`)}"/>\n      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n      <metadata key="extruder" value="${textSlot}"/>\n    </part>\n  </object>\n`);
    instances[at.plate].push(`    <model_instance>\n      <metadata key="object_id" value="${id}"/>\n      <metadata key="instance_id" value="0"/>\n      <metadata key="identify_id" value="${100 + i}"/>\n    </model_instance>\n`);
  }

  const mainModel = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}>\n`
    + ` <metadata name="Application">BambuStudio-02.08.02.61</metadata>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n`
    + ` <metadata name="Title">${xml(label)}</metadata>\n <resources>\n${resources.join("")} </resources>\n`
    + ` <build p:UUID="${uuid(1, 9)}">\n${items.join("")} </build>\n</model>\n`;

  const plateXml = instances.map((list, p) => `  <plate>\n    <metadata key="plater_id" value="${p + 1}"/>\n    <metadata key="plater_name" value=""/>\n    <metadata key="locked" value="false"/>\n`
    + `    <metadata key="filament_map_mode" value="Auto For Flush"/>\n    <metadata key="filament_maps" value="${Array(nFil).fill(1).join(" ")}"/>\n${list.join("")}  </plate>\n`).join("");
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${cfgObjects.join("")}${plateXml}  <assemble>\n  </assemble>\n</config>\n`;

  const projectSettings = JSON.stringify(projectConfig(template, colours.slice(0, nFil), plates), null, 4);

  return [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n <Default Extension="png" ContentType="image/png"/>\n <Default Extension="gcode" ContentType="text/x.gcode"/>\n</Types>\n`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n`],
    ["3D/3dmodel.model", mainModel],
    ["3D/_rels/3dmodel.model.rels", `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n`],
    ["3D/Objects/object_1.model", objectModel],
    ["Metadata/model_settings.config", modelSettings],
    ["Metadata/project_settings.config", projectSettings],
    ["Metadata/slice_info.config", `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n    <header_item key="X-BBL-Client-Version" value="02.08.02.61"/>\n  </header>\n</config>\n`],
  ];
}

// The template holds ONE value for each per-filament key; repeat it per slot.
export function projectConfig(template, colours, plates) {
  const s = structuredClone(template.settings);
  const n = colours.length;
  for (const k of template.per_filament) if (Array.isArray(s[k])) s[k] = Array(n).fill(s[k][0]);
  s.filament_colour = colours.map((c) => c.toUpperCase());
  s.filament_self_index = colours.map((_, i) => String(i + 1));
  s.filament_map = Array(n).fill("1");
  s.filament_nozzle_map = Array(n).fill("1");
  s.filament_volume_map = Array(n).fill("0");
  // One entry for the process, one per filament, one for the printer.
  s.different_settings_to_system = Array(n + 2).fill("");
  s.inherits_group = Array(n + 2).fill("");
  s.flush_volumes_matrix = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) s.flush_volumes_matrix.push(i === j ? "0" : "280");
  s.wipe_tower_x = Array(plates).fill("15");
  s.wipe_tower_y = Array(plates).fill("220");
  s.enable_prime_tower = n > 1 ? "1" : "0";
  return s;
}

// ── zip ───────────────────────────────────────────────────────────

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

async function deflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// A plain zip (deflate, no zip64): every file here is far under 4 GB.
export async function zip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const raw = typeof content === "string" ? enc.encode(content) : content;
    const data = await deflate(raw);
    const nameB = enc.encode(name);
    const crc = crc32(raw);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 8, true); local.setUint16(10, 0, true); local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, raw.length, true);
    local.setUint16(26, nameB.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameB, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 8, true); cen.setUint16(12, 0, true); cen.setUint16(14, 0x21, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, raw.length, true);
    cen.setUint16(28, nameB.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cenSize = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)]).arrayBuffer().then((b) => new Uint8Array(b));
}

// Most copies one file holds; a larger order line is split across files.
export const PER_FILE = PER_PLATE * MAX_PLATES;

// How an order line of `qty` splits into files: [copies in file 1, file 2, ...].
export function fileParts(qty) {
  const n = Math.max(1, Math.floor(Number(qty) || 1)), parts = [];
  for (let left = n; left > 0; left -= PER_FILE) parts.push(Math.min(PER_FILE, left));
  return parts;
}

// The file name the owner sees: receipt, text, colours and how many keychains
// are IN THIS FILE; "part 2 of 3" when the line was split. File-system safe.
export function fileName(receipt, design, n, part = 1, parts = 1) {
  const safe = (s) => String(s).replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const colours = design.ink !== design.base ? `${design.base}-${design.ink}` : design.base;
  return `${safe(receipt)}-${safe(design.text) || "name"}-${colours}${n > 1 ? `-x${n}` : ""}${parts > 1 ? `-part${part}of${parts}` : ""}.3mf`;
}


// ── the whole thing ───────────────────────────────────────────────

// job: what GET /api/admin/orders/<id>/print/<pos> returns —
//   { receipt, design, qty, colours, font, body, template }, with font a
//   typeface JSON object. Returns [{ name, bytes }], one per file of the line.
export async function buildPrintFiles(job) {
  const text = textMesh(job.design.text, job.font);
  if (!text.t.length) throw new Error("the text produced no geometry");
  const parts = fileParts(job.qty);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const label = `${job.receipt} ${job.design.text}`;
    const bytes = await zip(projectFiles({ design: job.design, label, copies: parts[i], body: job.body, text, template: job.template, colours: job.colours }));
    out.push({ name: fileName(job.receipt, job.design, parts[i], i + 1, parts.length), bytes });
  }
  return out;
}
