#!/usr/bin/env python3
"""Build the 170x70mm QR card.

Two decisions worth stating, because both affect whether the thing scans:

1. The QR is emitted as SVG rects, not a raster. At 170x70mm the card may be
   printed anywhere from a home inkjet to a press, and a vector QR has no
   resolution to be wrong — the modules land on exact geometry at any DPI.

2. Error correction Q (25%), not H (30%). For a 31-character URL, Q fits in
   version 3 (29x29) while H needs version 4 (33x33). At a fixed ~40mm QR that is
   1.38mm per module against 1.21mm. On a small card printed cheaply, ink spread
   blurring module edges is a more likely failure than 5% of the code being
   destroyed, so the chunkier grid is the better trade.

The QR sits on a WHITE tile even though the card is dark. Inverted (light-on-dark)
QR codes are legal in the spec but a meaningful share of phone scanners refuse
them, and a code that fails on some phones is worse than one that looks less
integrated.
"""
import qrcode, json, sys

URL = "https://3d-prints.aswincloud.com"

q = qrcode.QRCode(
    error_correction=qrcode.constants.ERROR_CORRECT_Q,
    box_size=1,
    border=0,                      # quiet zone drawn by the layout, not baked in
)
q.add_data(URL)
q.make(fit=True)
matrix = q.get_matrix()
n = len(matrix)

# One <rect> per dark module. Merging horizontal runs keeps the file small and the
# path count low enough that any RIP handles it.
rects = []
for y, row in enumerate(matrix):
    x = 0
    while x < n:
        if row[x]:
            run = 1
            while x + run < n and row[x + run]:
                run += 1
            rects.append(f'<rect x="{x}" y="{y}" width="{run}" height="1"/>')
            x += run
        else:
            x += 1

qr_svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n} {n}" '
          f'shape-rendering="crispEdges">{"".join(rects)}</svg>')

json.dump({"url": URL, "version": q.version, "n": n, "matrix": matrix},
          open("qr-matrix.json", "w"))
open("qr.svg", "w").write(qr_svg)
print(f"  QR: version {q.version}, {n}x{n} modules, {len(rects)} rects, ECC Q")
