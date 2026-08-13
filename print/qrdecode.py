"""Standalone QR decoder — walks a module grid the way a scanner does.

Deliberately does not use the qrcode library, so it can be used to check that
library's output. Used twice:

  * on the encoder's matrix  — does it actually say the URL?
  * on the matrix read back out of the rendered 300 DPI artwork — did the render
    preserve it?

The second is the one that matters for a printed card. A QR can be correct as data
and still be destroyed by a resample, a smoothing filter or a half-module offset.

Three bugs on the way here, all of which produced confident garbage rather than an
obvious error. Noted at the code they belong to, because each one looked like the
grid was fine:

  1. The reserved-module map covered the three 8x8 finder corners but not row 8 and
     column 8, which carry format information beyond those corners. Twelve
     structural modules were read as data, shifting the whole stream.
  2. Format info decoded correctly throughout, which is what made 1 so convincing —
     ec and mask came out right while the payload was nonsense.
  3. Version 3-Q splits the message into TWO error-correction blocks and interleaves
     them. Mode and length live in the first two codewords, one from each block, so
     mode read as "byte" correctly and everything after it was shuffled.
"""

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

EC_BITS = {0b01: "L", 0b00: "M", 0b11: "Q", 0b10: "H"}

# (version, ec) -> (data codewords per block, number of blocks)
BLOCKS = {
    (1, "L"): (19, 1), (2, "L"): (34, 1), (3, "L"): (55, 1),
    (1, "M"): (16, 1), (2, "M"): (28, 1), (3, "M"): (44, 1),
    (1, "Q"): (13, 1), (2, "Q"): (22, 1), (3, "Q"): (17, 2),
    (4, "Q"): (24, 2), (5, "Q"): (15, 4),
    (1, "H"): (9, 1),  (2, "H"): (16, 1), (3, "H"): (13, 2),
    (4, "H"): (9, 4),
}


def reserved_map(n, version):
    """Modules that carry structure rather than data.

    Built by construction, not by inequalities. See bug 1 in the module docstring:
    row 8 and column 8 extend past the finder corners.
    """
    r = [[False] * n for _ in range(n)]

    def mark(x0, y0, w, h):
        for y in range(y0, y0 + h):
            for x in range(x0, x0 + w):
                if 0 <= x < n and 0 <= y < n:
                    r[y][x] = True

    # Finder patterns with separators: 8x8 at three corners.
    mark(0, 0, 8, 8)
    mark(n - 8, 0, 8, 8)
    mark(0, n - 8, 8, 8)

    # Timing patterns: the whole of row 6 and column 6.
    for i in range(n):
        r[6][i] = True
        r[i][6] = True

    # Alignment. Versions 2-6 have exactly one, centred at (n-7, n-7); the other
    # three grid positions would collide with the finders.
    if version >= 2:
        mark(n - 9, n - 9, 5, 5)

    # Format information, including the strips beyond the finder corners.
    for i in range(9):
        r[8][i] = True
        r[i][8] = True
    for i in range(8):
        r[8][n - 1 - i] = True
        r[n - 1 - i][8] = True

    return r


def decode(matrix, version):
    """Returns (payload, ec_level, mask_id). Raises ValueError on a grid it cannot read."""
    m = [[1 if v else 0 for v in row] for row in matrix]
    n = len(m)
    reserved = reserved_map(n, version)

    # ── format information ────────────────────────────────────────
    # 15 bits: (8,0..5), (8,7), (8,8), (7,8), then (5..0, 8).
    bits = [m[8][i] for i in range(6)]
    bits += [m[8][7], m[8][8], m[7][8]]
    bits += [m[i][8] for i in range(5, -1, -1)]
    fmt = 0
    for b in bits:
        fmt = (fmt << 1) | b
    fmt ^= 0b101010000010010                       # the spec's format-info mask
    ec = EC_BITS.get((fmt >> 13) & 0b11)
    mask_id = (fmt >> 10) & 0b111
    if ec is None or mask_id not in MASKS:
        raise ValueError(f"unreadable format info (0x{fmt:04x})")
    mask = MASKS[mask_id]

    # ── data modules, zigzag from bottom-right, unmasking ─────────
    stream = []
    col = n - 1
    upward = True
    while col > 0:
        if col == 6:                               # skip the timing column
            col -= 1
        for row in (range(n - 1, -1, -1) if upward else range(n)):
            for c in (col, col - 1):
                if reserved[row][c]:
                    continue
                v = m[row][c]
                if mask(row, c):
                    v ^= 1
                stream.append(v)
        upward = not upward
        col -= 2

    # ── de-interleave the error-correction blocks ─────────────────
    # See bug 3: without this, every other byte belongs to the other half.
    key = (version, ec)
    if key not in BLOCKS:
        raise ValueError(f"no block layout recorded for version {version}-{ec}")
    per_block, nblocks = BLOCKS[key]

    codewords = []
    for i in range(0, per_block * nblocks * 8, 8):
        byte = 0
        for b in range(8):
            byte = (byte << 1) | stream[i + b]
        codewords.append(byte)

    blocks = [[] for _ in range(nblocks)]
    for idx, cw in enumerate(codewords):
        blocks[idx % nblocks].append(cw)

    bits = []
    for blk in blocks:
        for cw in blk:
            for b in range(7, -1, -1):
                bits.append((cw >> b) & 1)

    # ── mode, length, payload ─────────────────────────────────────
    def take(k, pos):
        val = 0
        for i in range(k):
            val = (val << 1) | bits[pos + i]
        return val, pos + k

    mode, pos = take(4, 0)
    if mode != 0b0100:
        raise ValueError(f"expected byte mode (0100), got {mode:04b}")
    length, pos = take(8, pos)                     # 8-bit count for versions 1-9
    if length * 8 + pos > len(bits):
        raise ValueError(f"declared length {length} exceeds available data")
    payload = bytearray()
    for _ in range(length):
        b, pos = take(8, pos)
        payload.append(b)

    return payload.decode("utf-8", errors="replace"), ec, mask_id
