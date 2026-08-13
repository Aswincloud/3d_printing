#!/usr/bin/env bash
# Build and verify the QR card end to end.
#
#   bash print/build.sh
#
# Fails if any check fails, so a broken QR cannot be handed to a printer. The
# checks are the point of this script: a card whose code does not scan is worth
# nothing, and that is not visible by looking at it.
set -uo pipefail
cd "$(dirname "$0")"
rc=0

echo "── generate the code ──"
python3 build-card.py || rc=1

echo "── decode it independently (does it say the URL?) ──"
python3 verify-qr.py || rc=1

echo "── render to PDF + 300 DPI PNG ──"
# Playwright lives in the e2e cache, not this repo, so the renderer runs from there.
E2E=/home/aswin/.cache/3dprints-e2e
cp render.mjs "$E2E/" && (cd "$E2E" && node render.mjs) || rc=1

echo "── read the code back out of each rendered file ──"
for f in card-70x170 card-70x170-bleed; do
  echo "  $f:"
  python3 verify-render.py "$f.png" 2>&1 | sed 's/^/  /' || rc=1
done

echo
if [ $rc -eq 0 ]; then
  echo "  ✓ all files built and verified"
else
  echo "  ✗ something failed — do not send these to print"
fi
exit $rc
