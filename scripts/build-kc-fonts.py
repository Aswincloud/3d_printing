#!/usr/bin/env python3
"""Build the keychain fonts: TTF (Google Fonts, OFL) -> three.js typeface JSON.

Run with fontTools + skia-pathops installed:
    python3 scripts/build-kc-fonts.py <dir with the .ttf files>

Writes public/assets/fonts3d/kc-<key>.json. Only the characters the designer
accepts (TEXT_RE in src/keychain.js) are kept, so the files stay small, and
every glyph's overlapping contours are merged first: a glyph drawn as two
overlapping strokes would otherwise triangulate into holes and slivers, and
the same JSON drives BOTH the browser preview and the printed 3MF.

The output uses the typeface.json command language three.js's FontLoader
reads: "m x y", "l x y", "q x y cx cy" (end point first, then control point).
"""
import json, sys, os
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib.removeOverlaps import removeOverlaps
from fontTools.pens.basePen import decomposeQuadraticSegment

CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 &.-'!"
# key: (file, variable-axis location, display name)
# Chosen (2026-11-02) among Google Fonts with NO Reserved Font Name: this
# script converts and subsets the font, and under the OFL a modified font may
# not carry a reserved name. Pacifico, Damion and Fredoka are OFL 1.1 without
# one; Satisfy is Apache 2.0. Licences sit beside the output in fonts3d/.
FONTS = {
    "script":  ("Pacifico-Regular.ttf", None, "Pacifico"),
    "brush":   ("Damion-Regular.ttf", None, "Damion"),
    "hand":    ("Satisfy-Regular.ttf", None, "Satisfy"),
    "rounded": ("Fredoka[wdth,wght].ttf", {"wght": 600, "wdth": 100}, "Fredoka SemiBold"),
}

def fmt(v):
    return str(round(v, 1)).removesuffix(".0")

def convert(path, loc):
    f = TTFont(path)
    if loc:
        f = instantiateVariableFont(f, loc)
    removeOverlaps(f)
    gs = f.getGlyphSet()
    cmap = f.getBestCmap()
    upm = f["head"].unitsPerEm
    glyphs = {}
    for ch in CHARS:
        name = cmap[ord(ch)]
        pen = DecomposingRecordingPen(gs)
        gs[name].draw(pen)
        out = []
        cur = None
        for op, pts in pen.value:
            if op == "moveTo":
                cur = pts[0]; out += ["m", fmt(cur[0]), fmt(cur[1])]
            elif op == "lineTo":
                cur = pts[0]; out += ["l", fmt(cur[0]), fmt(cur[1])]
            elif op == "qCurveTo":
                if pts[-1] is None:
                    raise SystemExit(f"{path}: {ch!r} has an on-curve-less contour")
                for c, e in decomposeQuadraticSegment(pts):
                    out += ["q", fmt(e[0]), fmt(e[1]), fmt(c[0]), fmt(c[1])]
                cur = pts[-1]
            elif op == "curveTo":
                raise SystemExit(f"{path}: cubic outlines are not supported")
            elif op in ("closePath", "endPath"):
                pass
        glyphs[ch] = {"ha": gs[name].width, "o": " ".join(out)}
    hhea = f["hhea"]
    return {"glyphs": glyphs, "resolution": upm, "ascender": hhea.ascent,
            "descender": hhea.descent, "underlinePosition": 0, "underlineThickness": 0,
            "boundingBox": {"xMin": 0, "yMin": hhea.descent, "xMax": upm, "yMax": hhea.ascent},
            "familyName": f["name"].getDebugName(1), "cssFontWeight": "normal", "cssFontStyle": "normal"}

if __name__ == "__main__":
    src = sys.argv[1]
    dest = os.path.join(os.path.dirname(__file__), "..", "public", "assets", "fonts3d")
    for key, (file, loc, label) in FONTS.items():
        data = convert(os.path.join(src, file), loc)
        p = os.path.join(dest, f"kc-{key}.json")
        with open(p, "w") as fh:
            json.dump(data, fh, separators=(",", ":"), ensure_ascii=True)
        print(key, label, os.path.getsize(p), "bytes")
