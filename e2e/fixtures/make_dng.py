"""Writes chart.dng, ramp.dng and wide.dng: tiny synthetic DNGs (linear RGB, 16 bits) for the RAW import tests.

LinearRaw DNGs whose camera space is linear sRGB (wide.dng: linear Rec. 2020), so a RAW decoder hands back their own
colors. chart.dng (96 x 64):
a gradient with a red square, a light disc and a dark block, like chart.jpg. ramp.dng (256 x 32): a gray ramp from
black to linear 0.02, which 8 bits of sRGB hold in only about 40 steps. wide.dng (96 x 32): Rec. 2020 green at 40%
(far outside sRGB), a 40% gray, and an orange whose red is above white in sRGB (for highlight recovery). Every value
stays under 75% of white, where LibRaw would otherwise take the data's maximum for white and rescale. Standard library only:

    python3 e2e/fixtures/make_dng.py
"""
import os, struct


def srgb_to_linear(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def chart(x, y, W, H):
    r, g, b = 255 * x / (W - 1), 255 * y / (H - 1), 255 * (1 - x / (W - 1)) * 0.8
    if 6 <= x < 26 and 6 <= y < 26:
        r, g, b = 200, 40, 40
    if (x - 70) ** 2 + (y - 42) ** 2 < 12 ** 2:
        r, g, b = 240, 220, 200
    if 38 <= x < 50 and 44 <= y < 58:
        r, g, b = 40, 40, 40
    return [round(srgb_to_linear(v) * 65535) for v in (r, g, b)]

def ramp(x, y, W, H):
    return [round(0.02 * x / (W - 1) * 65535)] * 3

# XYZ (D65) to the camera space: linear sRGB, or linear Rec. 2020 for wide.dng.
SRGB = [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.2040, 1.0570]
REC2020 = [1.7166512, -0.3556708, -0.2533663, -0.6666844, 1.6164812, 0.0157685, 0.0176399, -0.0427706, 0.9421031]

def wide(x, y, W, H):
    if x < W // 3:
        return [0, round(0.4 * 65535), 0]
    if x < 2 * W // 3:
        return [round(0.4 * 65535)] * 3
    return [round(v * 65535) for v in (0.74, 0.321, 0)]

def write(name, W, H, pixel, M=SRGB):
    pixels = b''.join(struct.pack('<3H', *pixel(x, y, W, H)) for y in range(H) for x in range(W))
    # DNG's ColorMatrix1 maps XYZ to camera space.

    SHORT, LONG, RATIONAL, SRATIONAL, ASCII, BYTE = 3, 4, 5, 10, 2, 1
    entries = []  # (tag, type, count, value bytes)
    def add(tag, typ, values):
        if typ == ASCII:
            data = values.encode() + b'\0'
            entries.append((tag, typ, len(data), data))
            return
        fmt = {SHORT: 'H', LONG: 'I', BYTE: 'B'}.get(typ)
        if fmt:
            data = struct.pack('<' + fmt * len(values), *values)
        elif typ == RATIONAL:
            data = b''.join(struct.pack('<II', round(v * 10000), 10000) for v in values)
        else:
            data = b''.join(struct.pack('<ii', round(v * 10000), 10000) for v in values)
        entries.append((tag, typ, len(values), data))

    add(254, LONG, [0])                  # NewSubFileType: the main image
    add(256, LONG, [W])
    add(257, LONG, [H])
    add(258, SHORT, [16, 16, 16])        # BitsPerSample
    add(259, SHORT, [1])                 # no compression
    add(262, SHORT, [34892])             # LinearRaw
    add(271, ASCII, 'Imaginary')         # Make
    add(272, ASCII, 'Test DNG')          # Model
    add(273, LONG, [0])                  # StripOffsets, patched below
    add(274, SHORT, [1])                 # Orientation
    add(277, SHORT, [3])                 # SamplesPerPixel
    add(278, LONG, [H])                  # RowsPerStrip
    add(279, LONG, [len(pixels)])        # StripByteCounts
    add(284, SHORT, [1])                 # PlanarConfiguration
    add(50706, BYTE, [1, 4, 0, 0])       # DNGVersion
    add(50707, BYTE, [1, 1, 0, 0])       # DNGBackwardVersion
    add(50708, ASCII, 'Imaginary Test DNG')  # UniqueCameraModel
    add(50717, LONG, [65535, 65535, 65535])  # WhiteLevel
    add(50721, SRATIONAL, M)             # ColorMatrix1
    add(50728, RATIONAL, [1, 1, 1])      # AsShotNeutral
    add(50778, SHORT, [21])              # CalibrationIlluminant1: D65
    entries.sort()

    header = 8
    ifd_size = 2 + 12 * len(entries) + 4
    extra_at = header + ifd_size
    extra = b''
    records = []
    for tag, typ, count, data in entries:
        if len(data) <= 4:
            records.append((tag, typ, count, data.ljust(4, b'\0')))
        else:
            records.append((tag, typ, count, struct.pack('<I', extra_at + len(extra))))
            extra += data + (b'\0' if len(data) % 2 else b'')
    strip_at = extra_at + len(extra)
    records = [(t, ty, c, struct.pack('<I', strip_at) if t == 273 else v) for t, ty, c, v in records]
    out = b'II*\0' + struct.pack('<I', header) + struct.pack('<H', len(records))
    out += b''.join(struct.pack('<HHI', t, ty, c) + v for t, ty, c, v in records) + struct.pack('<I', 0) + extra + pixels
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), name)
    open(path, 'wb').write(out)
    print('wrote', path, len(out), 'bytes')

write('chart.dng', 96, 64, chart)
write('ramp.dng', 256, 32, ramp)
write('wide.dng', 96, 32, wide, REC2020)
