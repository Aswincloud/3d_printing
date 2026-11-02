#!/usr/bin/env python3
"""Build the Bambu Studio A1 project-settings template for keychain 3MFs.

    python3 scripts/build-kc-template.py <a GUI-exported A1 3MF's
        Metadata/project_settings.config> <BambuStudio resources/profiles/BBL> <out.json>

Bambu Studio's CLI cannot export a correct A1 project on its own (it writes a
200x200 generic bed), so the template starts from a project the GUI saved for
an A1 and then takes every value it can from Bambu's OWN system profiles
(machine "Bambu Lab A1 0.4 nozzle", process "0.20mm Standard @BBL A1",
filament "Bambu PLA Basic @BBL A1"), so no one's personal tweaks ride along.

Output: { settings, per_filament: [keys] }. Every per-filament key holds ONE
value; src/kc3mf.js repeats it once per filament slot.
"""
import json, sys, glob

src, profiles, out = sys.argv[1:4]
base = json.load(open(src))
n = len(base["filament_colour"])

idx = {}
for sub in ("machine", "process", "filament"):
    for f in glob.glob(f"{profiles}/{sub}/**/*.json", recursive=True):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        if "name" in d:
            idx[(sub, d["name"])] = d

def resolve(sub, name):
    d = idx[(sub, name)]
    out = dict(resolve(sub, d["inherits"])) if d.get("inherits") else {}
    out.update(d)
    return out

SKIP = {"name", "inherits", "from", "instantiation", "setting_id", "type", "filament_id",
        "compatible_printers", "compatible_printers_condition", "compatible_prints",
        "compatible_prints_condition", "description", "renamed_from", "version"}
machine = resolve("machine", "Bambu Lab A1 0.4 nozzle")
process = resolve("process", "0.20mm Standard @BBL A1")
fil = resolve("filament", "Bambu PLA Basic @BBL A1")

per = sorted(k for k, v in base.items() if isinstance(v, list) and len(v) == n and k != "wipe_tower_x" and k != "wipe_tower_y")
settings = {}
for k, v in base.items():
    settings[k] = [v[0]] if k in per else v
for prof in (machine, process):
    for k, v in prof.items():
        if k in SKIP or k not in settings or k in per:
            continue
        settings[k] = v
for k, v in fil.items():
    if k in SKIP or k not in settings:
        continue
    settings[k] = [v[0]] if (k in per and isinstance(v, list)) else v

settings.update({
    "printer_settings_id": "Bambu Lab A1 0.4 nozzle",
    "print_settings_id": "0.20mm Standard @BBL A1",
    "filament_settings_id": ["Bambu PLA Basic @BBL A1"],
    "filament_ids": [fil.get("filament_id", "GFA00")],
    "curr_bed_type": "Textured PEI Plate",
    "wipe_tower_x": ["15"], "wipe_tower_y": ["220"],
})
for k in ("filament_settings_id", "filament_ids"):
    if k not in per:
        per.append(k)
assert settings["printable_area"] == ["0x0", "256x0", "256x256", "0x256"], settings["printable_area"]
assert settings["printer_model"] == "Bambu Lab A1"
json.dump({"settings": settings, "per_filament": sorted(per)}, open(out, "w"), separators=(",", ":"))
print("keys", len(settings), "per-filament", len(per), "bed", settings["printable_area"], "layer", settings["layer_height"])
