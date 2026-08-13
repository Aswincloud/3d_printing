#!/usr/bin/env python3
"""Read the QR out of the FINAL 300 DPI artwork and prove it still works.

Three assertions, in order of what they rule out:

  1. every module matches the encoder's matrix   — the render changed nothing
  2. the sampled grid decodes to the URL         — what a phone will actually do
  3. contrast and quiet zone are within spec     — it will survive being printed

qrdecode.py proves the matrix says the URL. This proves the artwork still contains
that matrix. Different failures, and the second is the one a printed card dies of:
a code correct as data, then resampled with smoothing on.

The code is located by its FINDER PATTERNS — the 1:1:3:1:1 run-length signature a
real decoder looks for — not by hunting for the white tile. Three earlier attempts
failed there, each in a way that looked like a rendering bug rather than a detection
bug:

  * longest white run on the centre row: that row passes straight THROUGH the code,
    so it measured a gap between modules and reported a 147px "tile"
  * bounding box of pure white: the wordmark is #ffffff and the logo is stroked
    #fff, so the box spanned almost the whole card
  * largest connected white blob: correct on the dark card, and completely wrong on
    the light variant, where the entire background is white

Finder detection does not care what the background is or where on the page the code
sits, which is the property the previous three lacked.
"""
import sys, json
from PIL import Image
import qrdecode

d = json.load(open("qr-matrix.json"))
expect = [[1 if v else 0 for v in row] for row in d["matrix"]]
n = d["n"]
DPI = 300
DARK = 128

PNG = sys.argv[1] if len(sys.argv) > 1 else "card-170x70.png"
im = Image.open(PNG).convert("L")
W, H = im.size
px = im.load()
print(f"  {PNG}: {W}x{H} px  ({W/DPI*25.4:.1f} x {H/DPI*25.4:.1f} mm at {DPI} DPI)")


def runs_in_row(y):
    """Run-length encode a row as (is_dark, start, length)."""
    out = []
    x = 0
    while x < W:
        dark = px[x, y] < DARK
        s = x
        while x < W and (px[x, y] < DARK) == dark:
            x += 1
        out.append((dark, s, x - s))
    return out


def finder_candidates():
    """Rows holding a dark-light-dark-light-dark run with ratios near 1:1:3:1:1."""
    hits = []
    for y in range(0, H, 2):                     # every other row is ample
        rs = runs_in_row(y)
        for i in range(len(rs) - 4):
            five = rs[i:i + 5]
            if not (five[0][0] and not five[1][0] and five[2][0]
                    and not five[3][0] and five[4][0]):
                continue
            a, b, c, dd, e = (r[2] for r in five)
            unit = (a + b + c + dd + e) / 7.0
            if unit < 3:                         # too small to be a finder at 300 DPI
                continue
            # 45% slack per element: antialiasing and ink spread both widen the dark
            # runs relative to the light ones, so exact ratios never occur.
            if (abs(a - unit) <= unit * 0.45 and abs(b - unit) <= unit * 0.45
                    and abs(c - unit * 3) <= unit * 3 * 0.45
                    and abs(dd - unit) <= unit * 0.45
                    and abs(e - unit) <= unit * 0.45):
                hits.append((five[2][1] + five[2][2] / 2.0, y, unit))
    return hits


hits = finder_candidates()
if len(hits) < 3:
    print(f"  FAIL only {len(hits)} finder candidate row(s) — no QR located")
    sys.exit(1)

# Cluster: each finder spans several scanned rows, so its candidates stack up.
clusters = []
for cx, cy, unit in hits:
    for cl in clusters:
        if abs(cl["cx"] - cx) < unit * 4 and abs(cl["cy"] - cy) < unit * 8:
            cl["xs"].append(cx); cl["ys"].append(cy); cl["us"].append(unit)
            cl["cx"] = sum(cl["xs"]) / len(cl["xs"])
            cl["cy"] = sum(cl["ys"]) / len(cl["ys"])
            break
    else:
        clusters.append({"cx": cx, "cy": cy, "xs": [cx], "ys": [cy], "us": [unit]})

# Confirm each candidate VERTICALLY through its own centre.
#
# The horizontal scan alone found 59 clusters on a 3-finder code: the QR interior
# throws up plenty of accidental 1:1:3:1:1 runs, and picking the three with the most
# candidate rows selected noise — the derived code came out 421x315 instead of
# square. A real finder is 1:1:3:1:1 on BOTH axes through its centre, which almost
# nothing in the data region is.
def ratio_ok(runs, idx_from, unit_hint=None):
    five = runs[idx_from:idx_from + 5]
    if len(five) < 5:
        return None
    if not (five[0][0] and not five[1][0] and five[2][0]
            and not five[3][0] and five[4][0]):
        return None
    a, b, c, dd, e = (r[2] for r in five)
    unit = (a + b + c + dd + e) / 7.0
    if unit < 3:
        return None
    if (abs(a - unit) <= unit * 0.45 and abs(b - unit) <= unit * 0.45
            and abs(c - unit * 3) <= unit * 3 * 0.45
            and abs(dd - unit) <= unit * 0.45
            and abs(e - unit) <= unit * 0.45):
        return five, unit
    return None


def runs_in_col(x):
    out = []
    y = 0
    while y < H:
        dark = px[x, y] < DARK
        s = y
        while y < H and (px[x, y] < DARK) == dark:
            y += 1
        out.append((dark, s, y - s))
    return out


def vertically_confirmed(cx, cy):
    """Is there a 1:1:3:1:1 column signature centred on (cx, cy)?"""
    col = runs_in_col(int(cx))
    for i in range(len(col) - 4):
        got = ratio_ok(col, i)
        if not got:
            continue
        five, unit = got
        centre = five[2][1] + five[2][2] / 2.0
        if abs(centre - cy) <= unit * 1.5:
            return unit
    return None

confirmed = []
for cl in clusters:
    u = vertically_confirmed(cl["cx"], cl["cy"])
    if u is not None:
        cl["us"].append(u)
        confirmed.append(cl)

print(f"  finders   : {len(clusters)} horizontal cluster(s), {len(confirmed)} confirmed on both axes")
if len(confirmed) < 3:
    print(f"  FAIL only {len(confirmed)} finder(s) confirmed, need 3")
    sys.exit(1)

# If more than three survive, take the triple that best forms the right isoceles
# triangle three QR finders always make.
if len(confirmed) > 3:
    import itertools
    best = None
    for tri in itertools.combinations(confirmed, 3):
        pts = [(c["cx"], c["cy"]) for c in tri]
        ds = sorted(((pts[i][0]-pts[j][0])**2 + (pts[i][1]-pts[j][1])**2) ** 0.5
                    for i, j in ((0,1),(0,2),(1,2)))
        # two equal legs and a hypotenuse of leg*sqrt(2)
        err = abs(ds[0] - ds[1]) / max(ds[1], 1) + abs(ds[2] - ds[1] * 2**0.5) / max(ds[2], 1)
        if best is None or err < best[0]:
            best = (err, tri)
    top = list(best[1])
    print(f"  selected the triple forming a right isoceles triangle (err {best[0]:.3f})")
else:
    top = confirmed

cxs = [c["cx"] for c in top]
cys = [c["cy"] for c in top]

# Module pitch from the DISTANCE BETWEEN finder centres, not from one finder's own
# 7-module width. The centres sit 3.5 modules in from each edge, so they are exactly
# (n - 7) modules apart — 22 for this version. Measuring across 22 modules instead of
# 7 cuts the error by a third, and it matters: the finder-width estimate came out
# 14.51px against a true 14.66px, which pushed the derived right-hand edge half a
# module INSIDE the code. The quiet-zone walk then started on a dark module and
# reported 0.0 modules of margin on an edge that actually has 4.3.
span_x = max(cxs) - min(cxs)
span_y = max(cys) - min(cys)
mod = max(span_x, span_y) / (n - 7)

qx0, qx1 = min(cxs) - 3.5 * mod, max(cxs) + 3.5 * mod
qy0, qy1 = min(cys) - 3.5 * mod, max(cys) + 3.5 * mod

wpx, hpx = qx1 - qx0, qy1 - qy0
print(f"  code      : {wpx:.0f}x{hpx:.0f} px  ({wpx/DPI*25.4:.2f}x{hpx/DPI*25.4:.2f} mm)")
if abs(wpx - hpx) > mod:
    print(f"  FAIL code is not square ({wpx:.0f}x{hpx:.0f}) — finder detection is off")
    sys.exit(1)

mod_mm = mod / DPI * 25.4
print(f"  module    : {mod:.2f} px = {mod_mm:.3f} mm")
if mod_mm < 0.5:
    print(f"  FAIL modules are {mod_mm:.3f} mm — too small to scan reliably")
    sys.exit(1)

# ── sample module centres ─────────────────────────────────────────
# Centres, not cell averages: averaging would smooth over exactly the edge
# softening this is meant to catch.
sampled = [[0] * n for _ in range(n)]
darks, lights, bad = [], [], []
for row in range(n):
    for col in range(n):
        sx = max(0, min(W - 1, int(qx0 + (col + 0.5) * mod)))
        sy = max(0, min(H - 1, int(qy0 + (row + 0.5) * mod)))
        v = px[sx, sy]
        got = 1 if v < DARK else 0
        sampled[row][col] = got
        (darks if expect[row][col] else lights).append(v)
        if got != expect[row][col]:
            bad.append((row, col, expect[row][col], got))

total = n * n
if bad:
    print(f"  FAIL {len(bad)} of {total} modules differ from the encoder's matrix")
    for r, c, e, g in bad[:8]:
        print(f"         ({r},{c}) expected {e}, read {g}")
    sys.exit(1)
print(f"  ✓ all {total} modules match the encoder's matrix exactly")

# ── decode what was sampled, end to end ───────────────────────────
# The same operation a phone performs, on pixels read out of the finished file
# rather than on data handed over by the generator. If this ever disagrees with the
# comparison above, distrust the comparison.
try:
    payload, ec, mask_id = qrdecode.decode(sampled, d["version"])
except ValueError as e:
    print(f"  FAIL sampled grid does not decode: {e}")
    sys.exit(1)
if payload != d["url"]:
    print(f"  FAIL sampled grid decodes to {payload!r}, not {d['url']!r}")
    sys.exit(1)
print(f"  ✓ sampled artwork decodes to {payload}  (ec={ec}, mask={mask_id})")

# ── contrast ──────────────────────────────────────────────────────
print(f"  contrast  : darks max {max(darks)}, lights min {min(lights)} (0-255)")
if max(darks) > 90 or min(lights) < 170:
    print("  FAIL insufficient separation between dark and light modules")
    sys.exit(1)
print("  ✓ dark/light separation is clean")

# ── quiet zone, all FOUR sides ────────────────────────────────────
#
# All four on purpose. The first version measured left, right and top and skipped
# the bottom — where a caption inside the tile had eaten the margin to about 1.3
# modules. The one edge with a defect was the one edge excluded from the test. The
# caption now sits outside the tile and every edge is measured.
def light_run(x, y, dx, dy, limit):
    """How far the ground stays light walking outward from the code edge.

    Skips up to 1.5 modules of dark before it starts counting. The derived box is
    always a fraction of a module out — the finder centres come from cluster
    centroids, so the measured width and height differed by 4px here — and starting
    the walk a quarter-module inside the last dark column reported 0.0 modules of
    margin on an edge that has 4.2. Skipping leading dark makes the measurement
    independent of that sub-module error instead of silently sensitive to it.
    """
    skip = int(mod * 1.5)
    while skip > 0 and 0 <= x < W and 0 <= y < H and px[int(x), int(y)] < DARK:
        x += dx
        y += dy
        skip -= 1
    steps = 0
    while steps < limit:
        if not (0 <= x < W and 0 <= y < H):
            break                                # the page edge is clear by definition
        if px[int(x), int(y)] < DARK:
            break
        steps += 1
        x += dx
        y += dy
    return steps

cx_mid, cy_mid = (qx0 + qx1) / 2, (qy0 + qy1) / 2
limit = int(mod * 8)
edges = {
    "left":   light_run(qx0, cy_mid, -1, 0, limit),
    "right":  light_run(qx1, cy_mid, 1, 0, limit),
    "top":    light_run(cx_mid, qy0, 0, -1, limit),
    "bottom": light_run(cx_mid, qy1, 0, 1, limit),
}
print("  quiet zone:")
worst = None
for name, pxs in edges.items():
    clear = pxs / mod
    print(f"    {name:<7} {pxs/DPI*25.4:5.2f} mm = {clear:.1f} modules")
    if worst is None or clear < worst[1]:
        worst = (name, clear)

if worst[1] < 3:
    print(f"  FAIL {worst[0]} quiet zone is {worst[1]:.1f} modules — under 3, scanners will struggle")
    sys.exit(1)
if worst[1] < 4:
    print(f"  WARN {worst[0]} quiet zone {worst[1]:.1f} modules; the spec asks for 4")
else:
    print("  ✓ quiet zone meets the 4-module spec on all four sides")
