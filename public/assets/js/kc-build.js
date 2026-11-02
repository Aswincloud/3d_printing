// Builds a print-ready Bambu Studio project (.3mf) for a custom name keychain
// (2026-11-02). Runs in the OWNER'S BROWSER (the dashboard's Download button,
// public/assets/js/admin.js) and in the tests — not in the Worker: the shop is
// on Cloudflare's free plan (10 ms of CPU per request) and a build takes
// 50-500 ms. The Worker only hands the owner the inputs (src/kc3mf.js).
//
// A keychain is a list of PARTS, each a closed mesh on one AMS slot, z from 0
// at the bed. The parts come from the style (kc-styles.js): either shapes made
// from the customer's name, extruded between two heights, or a fixed body mesh
// (private, from the owner's file) with the name laid on it.
import earcut from "../vendor/kc/earcut.js";
import { layoutText, TEXT_Z0, TEXT_Z1, PANEL } from "./kc-text.js";
import { STYLES } from "./kc-styles.js";
import { union } from "./kc-shapes.js";

// Copies per plate, and the most plates one file holds.
export const PER_PLATE = 6;
export const MAX_PLATES = 4;
const BED = 256, GAP = 6;
// Bambu Studio lays plates out in a grid, each plate 1.2 bed-widths from the
// last (seen in a Studio-saved project: plate 2's object at x = 128 + 307.2).
const PLATE_STRIDE = BED * 1.2;

// ── geometry ──────────────────────────────────────────────────────

const area2 = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return a; };

// A shape (kc-shapes.js: polygons of [outer, ...holes]) extruded from z0 to z1
// as one closed, outward-facing triangle mesh.
export function extrude(shape, z0, z1) {
  const v = [], t = [];
  for (const poly of shape) {
    const rings = poly.filter((r) => r.length > 2).map((r) => r.slice());
    if (!rings.length) continue;
    // Outer counter-clockwise, holes clockwise: the side walls rely on it.
    rings.forEach((r, i) => { if ((area2(r) > 0) !== (i === 0)) r.reverse(); });
    const flat = [], holes = [];
    for (const r of rings) {
      if (flat.length) holes.push(flat.length / 2);
      for (const [x, y] of r) flat.push(x, y);
    }
    const n = flat.length / 2, base = v.length / 3;
    // Vertex k of the polygon: bottom at base + 2k, top at base + 2k + 1.
    for (let k = 0; k < n; k++) v.push(flat[2 * k], flat[2 * k + 1], z0, flat[2 * k], flat[2 * k + 1], z1);
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

// The heart body's name: laid out in its recess (kc-text.js), merged. The heart
// body mesh is centred on z = 0, 5.2 mm thick; the name stands from the recess
// floor to just proud of the top, so both are lifted by 2.6 mm to the bed.
const HEART_LIFT = 2.6;
// The ribbon body (lifted to the bed when it was extracted) carries the name
// across its wings, on top of its upper layer.
export const RIBBON = { x0: -19, x1: 20.8, y0: 7, y1: 15.7, z0: 1.69, z1: 2.4, height: 8.2 };

export function textMesh(text, font) {
  const { polygons } = layoutText(text, font);
  if (!polygons.length) return { v: [], t: [] };
  return extrude(union(...polygons.map((p) => [p])), TEXT_Z0, TEXT_Z1);
}

const lift = (m, dz) => ({ v: m.v.map((x, i) => (i % 3 === 2 ? x + dz : x)), t: m.t });

// A design → its parts: [{ name, slot, mesh }], all z >= 0, plus its footprint.
// `bodies`: { heart, ribbon } meshes for the body styles (private files).
export function designParts(design, font, bodies, initialFont) {
  const st = STYLES[design.style || "heart"];
  if (!st) throw new Error(`unknown style ${design.style}`);
  if (st.body === "heart") {
    const body = bodies?.heart;
    if (!body) throw new Error("the heart body is missing");
    const text = textMesh(design.text, font);
    return { parts: [
      { name: "Keychain body", slot: 1, mesh: lift(body, HEART_LIFT) },
      { name: `Text: ${design.text}`, slot: 2, mesh: lift(text, HEART_LIFT) },
    ], size: { w: 120, h: 32 } };
  }
  if (st.body === "ribbon") {
    const body = bodies?.ribbon;
    if (!body) throw new Error("the ribbon body is missing");
    const { polygons } = layoutText(design.text, font, RIBBON);
    const name = extrude(union(...polygons.map((p) => [p])), RIBBON.z0, RIBBON.z1);
    return { parts: [
      ...body.parts.map((p) => ({ name: p.name, slot: p.slot, mesh: { v: p.v, t: p.t } })),
      { name: `Text: ${design.text}`, slot: 2, mesh: name },
    ], size: { w: 49, h: 50 } };
  }
  const built = st.build(design.text, font, initialFont);
  if (!built) throw new Error("the text produced no shape");
  return { parts: built.parts.map((p) => ({ name: p.name === "Name" ? `Text: ${design.text}` : p.name, slot: p.slot, mesh: extrude(p.shape, p.z0, p.z1) })), size: built.size };
}

// ── project files ─────────────────────────────────────────────────

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Full float precision: the heart body has distinct vertices closer than
// 1e-4 mm, and rounding them together would tear its surface.
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

// How many of a size fit one plate, packed in rows (each copy's footprint
// plus a GAP), and where copy i of n sits. Plates follow Bambu's grid.
export function layout(n, size) {
  const cw = size.w + GAP, ch = size.h + GAP;
  const cols = Math.max(1, Math.floor((BED - 10) / cw)), rows = Math.max(1, Math.floor((BED - 10) / ch));
  const per = Math.min(PER_PLATE, cols * rows);
  const plates = Math.ceil(n / per), gridCols = Math.ceil(Math.sqrt(plates));
  const at = [];
  for (let i = 0; i < n; i++) {
    const plate = Math.floor(i / per), k = i % per, onPlate = Math.min(per, n - plate * per);
    const used = Math.min(cols, onPlate), usedRows = Math.ceil(onPlate / cols);
    const c = k % cols, r = Math.floor(k / cols);
    const px = (plate % gridCols) * PLATE_STRIDE, py = -Math.floor(plate / gridCols) * PLATE_STRIDE;
    at.push({ plate, x: px + BED / 2 + (c - (used - 1) / 2) * cw, y: py + BED / 2 - (r - (usedRows - 1) / 2) * ch });
  }
  return { at, plates, per };
}
// The heart's column layout, kept for its tests: 6 per plate, 40 mm apart.
export const placement = (i, n) => layout(n, { w: 120, h: 34 }).at[i];

// Build the project for `copies` of one design. Returns the files of the 3MF
// as [name, string] pairs; zip() packs them. `colours`: hex per slot used.
export function projectFiles({ parts, size, label, copies, template, colours }) {
  if (!(copies >= 1 && copies <= PER_PLATE * MAX_PLATES)) throw new Error(`copies must be 1..${PER_PLATE * MAX_PLATES}, got ${copies}`);
  const n = copies;
  const { at, plates } = layout(n, size);
  const slots = Math.max(...parts.map((p) => p.slot));
  if (colours.length < slots) throw new Error(`the design uses ${slots} colours, ${colours.length} given`);

  // One mesh object per part, ids 1..k; every copy is a component group.
  const objectModel = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n`
    + parts.map((p, i) => meshXml(i + 1, p.mesh)).join("") + ` </resources>\n <build/>\n</model>\n`;

  const resources = [], items = [], cfgObjects = [], instances = Array.from({ length: plates }, () => []);
  const first = parts.length + 1;
  for (let i = 0; i < n; i++) {
    const id = first + i;
    resources.push(`  <object id="${id}" p:UUID="${uuid(id, 1)}" type="model">\n   <components>\n`
      + parts.map((_, k) => `    <component p:path="/3D/Objects/object_1.model" objectid="${k + 1}" p:UUID="${uuid(id, 2 + k)}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n`).join("")
      + `   </components>\n  </object>\n`);
    items.push(`  <item objectid="${id}" p:UUID="${uuid(id, 1000)}" transform="1 0 0 0 1 0 0 0 1 ${num(at[i].x)} ${num(at[i].y)} 0" printable="1"/>\n`);
    const name = n > 1 ? `${label} (${i + 1})` : label;
    cfgObjects.push(`  <object id="${id}">\n    <metadata key="name" value="${xml(name)}"/>\n    <metadata key="extruder" value="1"/>\n`
      + parts.map((p, k) => `    <part id="${k + 1}" subtype="normal_part">\n      <metadata key="name" value="${xml(p.name)}"/>\n      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n      <metadata key="extruder" value="${p.slot}"/>\n    </part>\n`).join("")
      + `  </object>\n`);
    instances[at[i].plate].push(`    <model_instance>\n      <metadata key="object_id" value="${id}"/>\n      <metadata key="instance_id" value="0"/>\n      <metadata key="identify_id" value="${100 + i}"/>\n    </model_instance>\n`);
  }

  const mainModel = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}>\n`
    + ` <metadata name="Application">BambuStudio-02.08.02.61</metadata>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n`
    + ` <metadata name="Title">${xml(label)}</metadata>\n <resources>\n${resources.join("")} </resources>\n`
    + ` <build p:UUID="${uuid(1, 9)}">\n${items.join("")} </build>\n</model>\n`;

  const used = colours.slice(0, slots);
  const plateXml = instances.map((list, p) => `  <plate>\n    <metadata key="plater_id" value="${p + 1}"/>\n    <metadata key="plater_name" value=""/>\n    <metadata key="locked" value="false"/>\n`
    + `    <metadata key="filament_map_mode" value="Auto For Flush"/>\n    <metadata key="filament_maps" value="${Array(used.length).fill(1).join(" ")}"/>\n${list.join("")}  </plate>\n`).join("");
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${cfgObjects.join("")}${plateXml}  <assemble>\n  </assemble>\n</config>\n`;

  const projectSettings = JSON.stringify(projectConfig(template, used, plates), null, 4);

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
  // Distinct colours in slot order (base, text, accent), and the style for all
  // but the original heart, so file names from before styles stay the same.
  const colours = [...new Set([design.base, design.ink, design.accent || design.base])].join("-");
  const style = design.style && design.style !== "heart" ? `-${design.style}` : "";
  return `${safe(receipt)}-${safe(design.text) || "name"}${style}-${colours}${n > 1 ? `-x${n}` : ""}${parts > 1 ? `-part${part}of${parts}` : ""}.3mf`;
}


// Parts on slots 1..3 with `hex` per slot → parts renumbered so each distinct
// colour has one slot, and that slot list.
export function mergeSlots(parts, hex) {
  const colours = [], slotOf = new Map();
  const ordered = [...new Set([1, ...parts.map((p) => p.slot)])];
  for (const s of ordered) {
    const c = String(hex[s - 1] || hex[0]).toLowerCase();
    if (!slotOf.has(c)) { colours.push(c); slotOf.set(c, colours.length); }
  }
  return { parts: parts.map((p) => ({ ...p, slot: slotOf.get(String(hex[p.slot - 1] || hex[0]).toLowerCase()) })), colours };
}

// ── the whole thing ───────────────────────────────────────────────

// job: what GET /api/admin/orders/<id>/print/<pos> returns —
//   { receipt, design, qty, colours, font, bodies, template }, with font (and
//   initialFont for the big-initial style) a typeface JSON object, colours the
//   hex for slots 1..3. Returns [{ name, bytes }], one per file of the line.
export async function buildPrintFiles(job) {
  const built = designParts(job.design, job.font, job.bodies, job.initialFont);
  // Parts in the same colour share one filament slot: a one-colour design
  // prints from one spool with no prime tower. Slots are numbered in order of
  // first use (base first).
  const { parts, colours } = mergeSlots(built.parts, job.colours);
  const size = built.size;
  const fileCount = fileParts(job.qty);
  const out = [];
  for (let i = 0; i < fileCount.length; i++) {
    const label = `${job.receipt} ${job.design.text}`;
    const bytes = await zip(projectFiles({ parts, size, label, copies: fileCount[i], template: job.template, colours }));
    out.push({ name: fileName(job.receipt, job.design, fileCount[i], i + 1, fileCount.length), bytes });
  }
  return out;
}
