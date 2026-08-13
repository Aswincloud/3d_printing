#!/usr/bin/env python3
"""Assert the layout of a rasterised PDF: page size, centring, and code size.

    python3 verify-layout.py <raster.png> <width_mm> <height_mm>

Exists because of a bug that every other check missed. The QR checks ran on the
PNG from Chromium's screenshot path, while the deliverable is the PDF from its
print path. Those are different code paths, and the print one applies
shrink-to-fit: a background wash whose layout box overflowed the page by 13mm made
Chromium scale the entire card to 84% and anchor it top-left. The PNG was pixel
perfect, the PDF was visibly wrong, and nothing caught it because nothing looked at
the PDF.

So this runs on the PDF, rasterised. It checks the things shrink-to-fit breaks:

  * page size — the trim must be the size it claims
  * the code's measured width — the tell for any global scaling
  * horizontal centring of every ink band
  * top and bottom margins
"""
import sys
from PIL import Image

if len(sys.argv) < 4:
    print("  usage: verify-layout.py <raster.png> <width_mm> <height_mm>")
    sys.exit(2)

PNG = sys.argv[1]
WANT_W, WANT_H = float(sys.argv[2]), float(sys.argv[3])
CODE_MM = 47.0          # the QR's designed width
DPI = 300
INK = 240               # anything below this counts as ink on white paper

im = Image.open(PNG).convert("L")
W, H = im.size
px = im.load()
mm = lambda p: p / DPI * 25.4
got_w, got_h = mm(W), mm(H)
print(f"  {PNG}")
print(f"  page      {got_w:.2f} x {got_h:.2f} mm  (want {WANT_W} x {WANT_H})")

fail = 0

# Chromium rounds the page box to whole points, so 1pt (0.35mm) of slack is expected
# and not worth failing over. Anything larger means the size was not honoured.
if abs(got_w - WANT_W) > 0.4 or abs(got_h - WANT_H) > 0.4:
    print(f"  FAIL page size is off by more than a point")
    fail += 1

# ── ink rows, to find the content bands ───────────────────────────
rows = []
for y in range(H):
    x0, x1 = None, None
    for x in range(W):
        if px[x, y] < INK:
            if x0 is None:
                x0 = x
            x1 = x
    rows.append((x0, x1))

inked = [y for y, (a, _) in enumerate(rows) if a is not None]
if not inked:
    print("  FAIL no ink on the page at all")
    sys.exit(1)

top_margin, bottom_margin = mm(inked[0]), mm(H - 1 - inked[-1])
print(f"  margins   top {top_margin:.2f}mm, bottom {bottom_margin:.2f}mm")

# ── group contiguous inked rows into bands ────────────────────────
bands, start = [], None
for y in range(H):
    has = rows[y][0] is not None
    if has and start is None:
        start = y
    elif not has and start is not None:
        if y - start > int(DPI * 0.02):          # ignore specks under ~0.5mm tall
            bands.append((start, y - 1))
        start = None
if start is not None:
    bands.append((start, H - 1))

print(f"  bands     {len(bands)}")
worst = 0.0
widest = 0.0
for (a, b) in bands:
    x0 = min(rows[y][0] for y in range(a, b + 1))
    x1 = max(rows[y][1] for y in range(a, b + 1))
    centre = (x0 + x1) / 2
    off = mm(centre - W / 2)
    wide = mm(x1 - x0 + 1)
    widest = max(widest, wide)
    tall = mm(b - a + 1)
    flag = ""
    if abs(off) > 0.4:
        flag = "  << OFF CENTRE"
        fail += 1
    worst = max(worst, abs(off))
    print(f"    y {mm(a):6.1f}..{mm(b):6.1f}mm  width {wide:6.2f}mm  offset {off:+.2f}mm{flag}")

print(f"  worst horizontal offset {worst:.2f}mm")

# ── the scaling tell ──────────────────────────────────────────────
# The QR is the widest square band. If the page was scaled, this shrinks with it —
# it read 39.6mm instead of 47mm when shrink-to-fit was active.
code_band = None
for (a, b) in bands:
    x0 = min(rows[y][0] for y in range(a, b + 1))
    x1 = max(rows[y][1] for y in range(a, b + 1))
    w_, h_ = mm(x1 - x0 + 1), mm(b - a + 1)
    if abs(w_ - h_) < 1.0 and w_ > 20:
        code_band = (w_, h_)
        break
if code_band is None:
    print("  FAIL could not find a square band to identify the QR")
    fail += 1
else:
    w_, h_ = code_band
    print(f"  code      {w_:.2f} x {h_:.2f} mm  (want {CODE_MM})")
    if abs(w_ - CODE_MM) > 0.5:
        print(f"  FAIL code is {w_:.2f}mm, not {CODE_MM}mm — the page has been scaled")
        fail += 1

print(f"\n  {'FAIL — ' + str(fail) + ' problem(s)' if fail else 'layout OK'}")
sys.exit(1 if fail else 0)
