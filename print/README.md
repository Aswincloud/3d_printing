# QR card — 70 × 170 mm (portrait)

A tall portrait card pointing at `3d-prints.aswincloud.com`. Sized for a parcel
insert, a bookmark, a table card at a stall, or a strip taped near the printer.

Rebuild everything and re-run every check:

    bash print/build.sh

## Which file to use

| File | Size | Use it for |
|---|---|---|
| `card-70x170.pdf` | 70 × 170 mm | The default. Home printing, or a shop that adds its own bleed. |
| `card-70x170-bleed.pdf` | 76 × 176 mm | Send this to a commercial press. 3 mm bleed on every side, orange crop marks at the trim. |
| `card-70x170*.png` | 827 × 2008 px | 300 DPI previews — for WhatsApp or a quick look, not for print. |

**Prefer the PDFs.** The QR and the type are vector in them, so they stay sharp at
any size. The PNGs are fixed at 300 DPI.

White ground throughout, so it prints cheaply on anything and works as the base for
a sticker. There is no dark variant: a near-black flood at this size is slow and
expensive on a home inkjet, prone to banding, and it cockles thin paper.

Printing at home: choose **Actual size** / 100%, never "Fit to page". Scaling is
what breaks a QR.

## The QR

- Encodes `https://3d-prints.aswincloud.com` — nothing else, no tracking redirect,
  so it keeps working regardless of what happens to any third-party shortener.
- Version 3, 29 × 29 modules, error correction **Q** (25%).
- 47 mm across, so **1.62 mm per module** — well above the ~0.5 mm where phone
  cameras start to struggle, with plenty of room for ink spread on cheap stock. The
  portrait format buys this: a 70 mm-wide card spends less width on text than a
  170 mm-wide one, so the code gets a third more module width.
- At least 4 modules of quiet zone on all four sides (the spec's requirement); the
  page margins give 6–8 in practice.
- Dark modules on white. Inverted codes are legal but a real share of phone scanners
  refuse them.

Q rather than H: for a 31-character URL, Q fits in version 3 (29 × 29) while H needs
version 4 (33 × 33). At a fixed 47 mm that is 1.62 mm per module against 1.42 mm. On a
small card printed cheaply, ink spread blurring module edges is a likelier failure
than 5% of the code being destroyed, so the chunkier grid wins.

## Why the verification is not a formality

A QR that does not scan looks completely fine. There is no way to eyeball it, and
the failure only shows up in someone's hand, after printing.

So `build.sh` does two independent things:

1. **`verify-qr.py`** decodes the generated matrix with `qrdecode.py` — a
   from-scratch decoder that does *not* use the encoding library — and asserts the
   payload is exactly the URL. This catches the generator being handed the wrong
   string.

2. **`verify-render.py`** finds the code in the finished 300 DPI artwork by its
   finder patterns, samples all 841 module centres, asserts every one matches the
   encoder, *and decodes the sampled grid* — the same operation a phone performs, on
   pixels read out of the delivered file. Then it checks dark/light separation and
   the quiet zone on all four edges.

Both are needed because they catch different failures. Verified by corrupting the
artwork: a 6 px blur still passes the module comparison, because sampling centres is
robust, and is caught by the contrast check. A single flipped module is caught by the
comparison. Neither alone is sufficient.

## Changing it

Text and layout live in `card.html`, in millimetres. Re-run `build.sh` afterwards —
if a change breaks the quiet zone or pushes a module off-grid, the checks will say
so rather than letting it through.

To point the code somewhere else, edit `URL` in `build-card.py`. Both verifiers read
the URL from the generated `qr-matrix.json`, so they follow automatically.
