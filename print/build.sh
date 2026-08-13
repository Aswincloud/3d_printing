#!/usr/bin/env bash
# Build and verify the QR card end to end.
#
#   bash print/build.sh
#
# Fails if any check fails, so a broken card cannot be handed to a printer.
#
# The checks run on the PDF, rasterised — not on the PNG. That distinction is the
# whole point of this script's shape. Chromium's screenshot path and its print path
# are different code, and the print one applies shrink-to-fit: a background wash whose
# layout box overflowed the page by 13mm silently scaled the entire card to 84% and
# anchored it top-left. The PNG was pixel perfect. The PDF, which is what gets
# printed, was visibly wrong. Every check passed because every check looked at the PNG.
set -uo pipefail
cd "$(dirname "$0")"
rc=0
E2E=/home/aswin/.cache/3dprints-e2e     # where playwright is installed

W_MM=70;      H_MM=155
BLEED_W=76;   BLEED_H=161

echo "── generate the code ──"
python3 build-card.py || rc=1

echo "── decode it independently (does it say the URL?) ──"
python3 verify-qr.py || rc=1

echo "── no page overflow (the cause of the shrink-to-fit) ──"
cp overflow.mjs "$E2E/" && (cd "$E2E" && node overflow.mjs) || rc=1

echo "── render ──"
cp render.mjs "$E2E/" && (cd "$E2E" && node render.mjs) || rc=1

echo "── rasterise the PDFs and check THEM ──"
command -v pdftoppm >/dev/null || { echo "  pdftoppm missing — cannot verify the PDF"; exit 1; }
for spec in "card-70x155 $W_MM $H_MM" "card-70x155-bleed $BLEED_W $BLEED_H"; do
  set -- $spec
  f=$1; w=$2; h=$3
  pdftoppm -r 300 -png -singlefile "$f.pdf" "/tmp/raster-$f" 2>/dev/null
  echo "  ── $f ──"
  python3 verify-layout.py "/tmp/raster-$f.png" "$w" "$h" 2>&1 | sed 's/^/  /' || rc=1
  python3 verify-render.py "/tmp/raster-$f.png" 2>&1 | sed 's/^/  /' || rc=1
done

echo
if [ $rc -eq 0 ]; then
  echo "  ✓ built and verified from the PDFs"
else
  echo "  ✗ something failed — do not send these to print"
fi
exit $rc
