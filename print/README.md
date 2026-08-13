# QR card — 70 × 155 mm (portrait)

A tall portrait card pointing at `3d-prints.aswincloud.com`. Sized for a parcel
insert, a bookmark, a table card at a stall, or a strip taped near the printer.

Rebuild everything and re-run every check:

    bash print/build.sh

## Which file to use

| File | Size | Use it for |
|---|---|---|
| `card-70x155.pdf` | 70 × 155 mm | The default. Home printing, or a shop that adds its own bleed. |
| `card-70x155-bleed.pdf` | 76 × 161 mm | Send this to a commercial press. 3 mm bleed on every side, orange crop marks at the trim. |
| `card-70x155*.png` | 827 × 1831 px | 300 DPI previews — for WhatsApp or a quick look, not for print. |

**Prefer the PDFs.** The QR and the type are vector in them, so they stay sharp at
any size. The PNGs are fixed at 300 DPI.

White ground throughout, so it prints cheaply on anything and works as the base for
a sticker. There is no dark variant: a near-black flood at this size is slow and
expensive on a home inkjet, prone to banding, and it cockles thin paper.

Printing at home: choose **Actual size** / 100%, never "Fit to page". Scaling is
what breaks a QR.

## Layout

The code is anchored to 50% of the card height, so it is dead centre by definition
rather than as an outcome of row arithmetic — measured at 77.5 mm on a 155 mm card,
0.0 mm off. The brand block and the footer are pinned to the top and bottom edges
with equal 11 mm margins, so changing the height only changes how much white sits
between the three groups.

An earlier version centred the code with `margin: auto`, which centres in the
*leftover* space. With 44 mm of copy above and a 10 mm footer below, that put the
code 11.9 mm low.

**155 mm is close to the floor for this content** — the gap between the caption and
the footer is down to 4.4 mm. Dropping the "Order online · Shipped India-wide" line
would allow roughly 148 mm; going shorter than that means either a smaller code or
less copy.

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

3. **`verify-layout.py`** checks page size, horizontal centring of every ink band,
   the margins, and the code's measured width — that last one being the tell for any
   global scaling.

4. **`overflow.mjs`** asserts, in print media, that the body's scrollable width does
   not exceed its client width.

All of them run on the **PDF, rasterised with `pdftoppm`** — not on the PNG.

That last point was a real bug, not a precaution. Chromium's screenshot path and its
print path are different code, and the print one applies shrink-to-fit. A background
wash whose layout box overflowed the page by 13 mm made Chromium scale the entire card
to 84% and anchor it top-left. The PNG was pixel perfect; the PDF, which is the thing
that gets printed, was visibly wrong — and every check passed, because every check was
looking at the PNG.

Verified by corrupting things deliberately: a 6 px blur still passes the module
comparison (sampling centres is robust) and is caught by the contrast check; a single
flipped module is caught by the comparison; and reintroducing the overflowing wash is
caught three ways — the overflow check names the cause, and the layout check reports
both the −5.5 mm shift and a 39.62 mm code where 47 mm was expected.

## Changing it

Text and layout live in `card.html`, in millimetres. Re-run `build.sh` afterwards —
if a change breaks the quiet zone or pushes a module off-grid, the checks will say
so rather than letting it through.

To point the code somewhere else, edit `URL` in `build-card.py`. Both verifiers read
the URL from the generated `qr-matrix.json`, so they follow automatically.
