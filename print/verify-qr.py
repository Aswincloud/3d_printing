#!/usr/bin/env python3
"""Independently decode the generated QR and assert it says the URL.

Not a formality. The library could be handed the wrong string, the layout could
scale or crop the modules, or a PDF pipeline could resample them. So this walks
the module grid the way a scanner does — locate format info, undo the mask, read
the data codewords in the zigzag order, parse mode and length, and rebuild the
payload byte by byte. If that string is not the URL, nothing else about the card
matters.

Deliberately does NOT use the qrcode library to check the qrcode library.
"""
import json, sys

d = json.load(open("qr-matrix.json"))
m = [[1 if v else 0 for v in row] for row in d["matrix"]]
n = d["n"]

def reserved_map(n, version):
    """Modules that carry structure, not data.

    Built by construction rather than by inequalities. The first version tested
    only the three 8x8 corners plus the timing lines and got the format-info
    strips wrong — row 8 and column 8 extend past the corners, so twelve
    structural modules were read as data. That shifted the whole bitstream and
    produced plausible-looking garbage, which is the dangerous kind of wrong: the
    format bits still decoded correctly, so it looked like the grid was fine.
    """
    r = [[False] * n for _ in range(n)]

    def mark(x0, y0, w, h):
        for y in range(y0, y0 + h):
            for x in range(x0, x0 + w):
                if 0 <= x < n and 0 <= y < n:
                    r[y][x] = True

    # Finder patterns with their separators: 8x8 at three corners.
    mark(0, 0, 8, 8); mark(n - 8, 0, 8, 8); mark(0, n - 8, 8, 8)

    # Timing patterns: full row 6 and column 6.
    for i in range(n):
        r[6][i] = True
        r[i][6] = True

    # Alignment pattern. Versions 2-6 have exactly one, centred at (n-7, n-7);
    # the other three grid positions would collide with the finders.
    if version >= 2:
        mark(n - 9, n - 9, 5, 5)

    # Format information — the part the first attempt missed. Column 8 down the
    # left, row 8 across the top, plus the mirrored strips beside the other two
    # finders, and the always-dark module.
    for i in range(9):
        r[8][i] = True
        r[i][8] = True
    for i in range(8):
        r[8][n - 1 - i] = True
        r[n - 1 - i][8] = True

    return r

RESERVED = reserved_map(n, d["version"])

def is_function_module(x, y):
    return RESERVED[y][x]

# ── format information ────────────────────────────────────────────
# 15 bits, twice. Read copy 1: (8,0..5),(8,7),(8,8),(7,8),(5..0,8)
bits = []
for i in range(6):        bits.append(m[8][i])
bits.append(m[8][7]); bits.append(m[8][8]); bits.append(m[7][8])
for i in range(5, -1, -1): bits.append(m[i][8])
fmt = 0
for b in bits: fmt = (fmt << 1) | b
fmt ^= 0b101010000010010                      # spec mask for format info
ec_bits = (fmt >> 13) & 0b11
mask_id = (fmt >> 10) & 0b111
EC = {0b01: "L", 0b00: "M", 0b11: "Q", 0b10: "H"}
print(f"  format info: ec={EC.get(ec_bits,'?')} mask={mask_id}")

MASKS = {
    0: lambda i, j: (i + j) % 2 == 0,
    1: lambda i, j: i % 2 == 0,
    2: lambda i, j: j % 3 == 0,
    3: lambda i, j: (i + j) % 3 == 0,
    4: lambda i, j: (i // 2 + j // 3) % 2 == 0,
    5: lambda i, j: (i * j) % 2 + (i * j) % 3 == 0,
    6: lambda i, j: ((i * j) % 2 + (i * j) % 3) % 2 == 0,
    7: lambda i, j: ((i + j) % 2 + (i * j) % 3) % 2 == 0,
}
mask = MASKS[mask_id]

# ── read data modules in zigzag, unmasking as we go ───────────────
bitstream = []
col = n - 1
upward = True
while col > 0:
    if col == 6:            # skip the vertical timing column
        col -= 1
    rows = range(n - 1, -1, -1) if upward else range(n)
    for row in rows:
        for c in (col, col - 1):
            if is_function_module(c, row):
                continue
            v = m[row][c]
            if mask(row, c):
                v ^= 1
            bitstream.append(v)
    upward = not upward
    col -= 2

# ── de-interleave the codewords ───────────────────────────────────
#
# The step the first two attempts missed. Version 3-Q splits the message into TWO
# error-correction blocks of 17 data codewords each, and the encoder interleaves
# them on the way out: b1[0], b2[0], b1[1], b2[1], ... So reading the bitstream
# straight through yields every other byte of two different halves.
#
# This is why the earlier failures looked so convincing: mode and length sit in
# the first two codewords, which are b1[0] and b2[0], so the mode bits happened to
# be right while everything after was shuffled.
#
# (version, ec) -> (data codewords per block, number of blocks)
BLOCKS = {
    (1, "Q"): (13, 1), (2, "Q"): (22, 1), (3, "Q"): (17, 2),
    (4, "Q"): (24, 2), (5, "Q"): (15, 4),
    (1, "M"): (16, 1), (2, "M"): (28, 1), (3, "M"): (44, 1),
}
ec_name = EC.get(ec_bits)
key = (d["version"], ec_name)
if key not in BLOCKS:
    print(f"  FAIL no block layout recorded for version {d['version']}-{ec_name}")
    sys.exit(1)
per_block, nblocks = BLOCKS[key]

codewords = []
for i in range(0, (per_block * nblocks) * 8, 8):
    byte = 0
    for b in range(8):
        byte = (byte << 1) | bitstream[i + b]
    codewords.append(byte)

blocks = [[] for _ in range(nblocks)]
for idx, cw in enumerate(codewords):
    blocks[idx % nblocks].append(cw)
data = [cw for blk in blocks for cw in blk]

# Back to a bit list, now in true message order.
bitstream = []
for cw in data:
    for b in range(7, -1, -1):
        bitstream.append((cw >> b) & 1)
print(f"  layout: {nblocks} block(s) x {per_block} data codewords, de-interleaved")

def take(bits_list, k, pos):
    val = 0
    for i in range(k):
        val = (val << 1) | bits_list[pos + i]
    return val, pos + k

pos = 0
mode, pos = take(bitstream, 4, pos)
if mode != 0b0100:
    print(f"  FAIL expected byte mode (0100), got {mode:04b}")
    sys.exit(1)
length, pos = take(bitstream, 8, pos)          # 8-bit count for versions 1-9
payload = bytearray()
for _ in range(length):
    b, pos = take(bitstream, 8, pos)
    payload.append(b)

decoded = payload.decode("utf-8", errors="replace")
print(f"  mode=byte length={length}")
print(f"  decoded: {decoded!r}")

if decoded != d["url"]:
    print(f"  FAIL decoded payload does not match {d['url']!r}")
    sys.exit(1)
print("  ✓ the QR decodes to exactly the intended URL")
