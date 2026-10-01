"""Render the Provider Usage CRT logo using only the Python standard library.

Run from any directory: python tools/logo_generator.py
The hand-drawn pixel font, ordered texture and lighting are deterministic.
"""

import math
from pathlib import Path
import struct
import zlib


WIDTH, HEIGHT = 512, 384
FONT = {
    "A": "01110/10001/10001/11111/10001/10001/10001",
    "B": "11110/10001/10001/11110/10001/10001/11110",
    "C": "01111/10000/10000/10000/10000/10000/01111",
    "D": "11110/10001/10001/10001/10001/10001/11110",
    "E": "11111/10000/10000/11110/10000/10000/11111",
    "G": "01111/10000/10000/10111/10001/10001/01111",
    "I": "111/010/010/010/010/010/111",
    "L": "10000/10000/10000/10000/10000/10000/11111",
    "O": "01110/10001/10001/10001/10001/10001/01110",
    "P": "11110/10001/10001/11110/10000/10000/10000",
    "R": "11110/10001/10001/11110/10100/10010/10001",
    "S": "01111/10000/10000/01110/00001/00001/11110",
    "U": "10001/10001/10001/10001/10001/10001/01110",
    "V": "10001/10001/10001/10001/10001/01010/00100",
    "0": "01110/10001/10011/10101/11001/10001/01110",
    "4": "00010/00110/01010/10010/11111/00010/00010",
    ".": "0/0/0/0/0/1/1",
    ":": "0/1/1/0/1/1/0",
    "-": "000/000/000/111/000/000/000",
    ">": "100/010/001/000/001/010/100",
    "\\": "10000/10000/01000/00100/00010/00001/00001",
    " ": "000/000/000/000/000/000/000",
    "a": "00000/00000/01110/00001/01111/10001/01111",
    "e": "00000/00000/01110/10001/11111/10000/01110",
    "g": "00000/01111/10001/10001/01111/00001/01110",
    "i": "010/000/110/010/010/010/111",
    "l": "110/010/010/010/010/010/111",
    "s": "00000/00000/01111/10000/01110/00001/11110",
    "u": "00000/00000/10001/10001/10001/10011/01101",
    "v": "00000/00000/10001/10001/10001/01010/00100",
}


def write_png(width, height, rgba_rows):
    """Encode RGBA rows as a minimal PNG, returning its bytes."""
    rows = list(rgba_rows)
    if len(rows) != height or any(len(row) != width * 4 for row in rows):
        raise ValueError("Expected height rows of width * 4 RGBA bytes")

    def chunk(kind, payload):
        return (struct.pack(">I", len(payload)) + kind + payload
                + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(b"\0" + bytes(r) for r in rows), 9))
            + chunk(b"IEND", b""))


class Canvas:
    def __init__(self):
        self.rows = [bytearray(WIDTH * 4) for _ in range(HEIGHT)]

    def pixel(self, x, y, color):
        if not (0 <= x < WIDTH and 0 <= y < HEIGHT):
            return
        src = (*color, 255) if len(color) == 3 else color
        row, offset = self.rows[y], x * 4
        alpha = src[3] / 255
        dest_alpha = row[offset + 3] / 255
        out_alpha = alpha + dest_alpha * (1 - alpha)
        if out_alpha:
            for i in range(3):
                row[offset + i] = round((src[i] * alpha + row[offset + i]
                                        * dest_alpha * (1 - alpha)) / out_alpha)
            row[offset + 3] = round(out_alpha * 255)

    def box(self, x0, y0, x1, y1, color, radius=0):
        for y in range(y0, y1):
            for x in range(x0, x1):
                dx = max(x0 + radius - x - 0.5, 0, x + 0.5 - (x1 - radius))
                dy = max(y0 + radius - y - 0.5, 0, y + 0.5 - (y1 - radius))
                if dx * dx + dy * dy <= radius * radius:
                    self.pixel(x, y, color(x, y) if callable(color) else color)

    def polygon(self, points, color):
        for y in range(min(p[1] for p in points), max(p[1] for p in points)):
            crossings = []
            for (xa, ya), (xb, yb) in zip(points, points[1:] + points[:1]):
                if min(ya, yb) <= y + 0.5 < max(ya, yb):
                    crossings.append(xa + (y + 0.5 - ya) * (xb - xa) / (yb - ya))
            crossings.sort()
            for left, right in zip(crossings[::2], crossings[1::2]):
                for x in range(math.ceil(left), math.ceil(right)):
                    self.pixel(x, y, color(x, y) if callable(color) else color)


def material(base, strength=35):
    """Upper-left light plus tiny molded-plastic grain, with no random state."""
    def shade(x, y):
        grain = ((x * 73 + y * 137 + x * y * 19) % 11 - 5) * 0.55
        light = strength * (0.65 - x / WIDTH * 0.65 - y / HEIGHT * 0.55)
        return tuple(max(0, min(255, round(c + light + grain))) for c in base)
    return shade


def text_width(text, scale=1, spacing=1):
    return sum((len(FONT[c].split('/')[0]) + spacing) * scale
               for c in text) - spacing * scale


def lettering(canvas, text, x, y, scale, color, spacing=1):
    for char in text:
        glyph = FONT[char].split('/')
        for row, line in enumerate(glyph):
            for col, bit in enumerate(line):
                if bit == '1':
                    canvas.box(x + col * scale, y + row * scale,
                               x + (col + 1) * scale, y + (row + 1) * scale, color)
        x += (len(glyph[0]) + spacing) * scale


def glow(canvas, cx, cy, rx, ry, rgb, opacity):
    for y in range(max(0, int(cy - ry * 3)), min(HEIGHT, int(cy + ry * 3))):
        for x in range(max(0, int(cx - rx * 3)), min(WIDTH, int(cx + rx * 3))):
            falloff = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2
            alpha = round(opacity * math.exp(-falloff * 1.6))
            if alpha:
                canvas.pixel(x, y, (*rgb, alpha))


def render():
    c = Canvas()
    # Soft transparent contact shadows. All solid edges remain crisp pixels.
    glow(c, 268, 328, 120, 17, (26, 25, 28), 66)
    glow(c, 258, 355, 135, 10, (26, 25, 28), 78)

    # Pedestal, its recessed neck and wide stepped foot.
    c.box(221, 256, 296, 307, material((112, 105, 87)), 5)
    c.box(228, 262, 282, 305, material((190, 182, 158)), 3)
    c.box(230, 268, 236, 299, (226, 220, 196))
    c.polygon([(214, 296), (296, 296), (325, 315), (190, 315)], material((203, 195, 172)))
    c.box(190, 314, 325, 323, material((133, 125, 106)), 3)
    c.box(199, 307, 315, 310, (227, 220, 197))

    # Thick shell, right-hand depth, inset face and four bevel bands.
    c.box(88, 25, 425, 278, material((94, 87, 73)), 17)
    c.box(89, 23, 417, 271, material((176, 166, 141)), 15)
    c.box(90, 23, 410, 264, material((239, 230, 204)), 14)
    c.box(95, 28, 407, 262, material((211, 202, 176)), 12)
    c.box(101, 34, 400, 256, material((226, 217, 190)), 9)
    c.box(104, 36, 394, 39, (249, 243, 223))
    c.box(102, 42, 105, 247, (242, 235, 212))
    c.box(398, 44, 401, 249, (151, 140, 115))
    c.box(111, 254, 394, 257, (158, 147, 122))
    # Ventilation slots on the visible right side.
    for y in range(68, 202, 9):
        c.box(413, y, 419, y + 3, (87, 80, 66))
        c.box(413, y + 3, 419, y + 4, (191, 181, 155))

    # Sculpted dark bezel around the curved phosphor glass.
    c.box(112, 47, 389, 214, (251, 242, 211), 12)
    c.box(111, 46, 388, 211, material((105, 101, 85), 18), 12)
    c.box(115, 50, 385, 209, material((46, 52, 43), 17), 10)
    c.box(121, 57, 380, 204, (13, 24, 19), 10)

    def glass(x, y):
        radial = max(0, 1 - ((x - 250) / 148) ** 2 - ((y - 128) / 91) ** 2)
        grain = (x * 31 + y * 17 + x * y) % 5
        scan = 0.8 if y % 3 == 0 else 1.0
        return (int(6 + radial * 5), int((19 + radial * 21 + grain) * scan),
                int(13 + radial * 13))

    c.box(125, 61, 376, 200, glass, 9)
    c.box(135, 63, 365, 65, (53, 74, 57))
    c.box(127, 72, 129, 178, (33, 57, 43))
    c.box(139, 67, 198, 69, (68, 86, 62, 65))
    c.box(132, 72, 158, 74, (68, 86, 62, 45))

    # Bloom behind each pixel of the large block wordmark.
    word_x = 250 - text_width('USAGE', 7) // 2
    mask = Canvas()
    lettering(mask, 'USAGE', word_x, 94, 7, (255, 255, 255))
    for y in range(84, 153):
        for x in range(word_x - 5, word_x + text_width('USAGE', 7) + 5):
            nearby = 0
            for dx, dy in ((-4, 0), (4, 0), (0, -4), (0, 4), (0, 0)):
                if mask.rows[y + dy][(x + dx) * 4 + 3]:
                    nearby += 1
            if nearby:
                c.pixel(x, y, (46, 235, 102, nearby * 9))

    def phosphor(x, y):
        center = max(0, 1 - abs(y - 118) / 36)
        horizontal = max(0.65, 1 - abs(x - 250) / 290)
        scan = 0.76 if y % 3 == 0 else 1
        return (round((71 + 52 * center) * scan),
                round((174 + 79 * center) * horizontal * scan),
                round((80 + 64 * center) * scan))

    lettering(c, 'USAGE', word_x, 94, 7, phosphor)
    c.box(148, 155, 352, 156, (56, 116, 69))
    prompt = 'C:\\> usage --live'
    lettering(c, prompt, 250 - text_width(prompt) // 2, 169, 1, (116, 208, 133))
    c.box(304, 178, 310, 180, (141, 244, 156))
    for x in range(144, 359, 6):
        c.box(x, 188, x + 3, 189, (41, 74, 49))

    # Engraved name plate, floppy drive, eject button and glowing power LED.
    c.box(115, 224, 260, 244, (162, 152, 128), 2)
    c.box(116, 225, 260, 244, material((207, 198, 170)), 2)
    label = 'PROVIDER-USAGE'
    lettering(c, label, 123, 232, 1, (240, 229, 197))
    lettering(c, label, 123, 231, 1, (95, 93, 74))
    lettering(c, 'v0.4.0', 215, 231, 1, (111, 105, 84))
    c.box(277, 225, 358, 231, (129, 119, 96), 1)
    c.box(279, 226, 356, 229, (41, 42, 35))
    c.box(278, 231, 358, 232, (245, 236, 206))
    c.box(344, 237, 356, 243, (146, 137, 111), 1)
    c.box(345, 237, 355, 241, (236, 224, 192), 1)
    glow(c, 375, 238, 8, 7, (255, 46, 17), 65)
    c.box(370, 233, 380, 243, (92, 74, 56), 3)
    c.box(372, 235, 378, 241, (209, 45, 29), 2)
    c.box(373, 235, 376, 237, (255, 143, 94))
    for x, y in ((107, 245), (392, 245)):
        c.box(x, y, x + 4, y + 4, (161, 150, 123))
        c.box(x + 1, y + 1, x + 3, y + 2, (92, 88, 70))

    # Keyboard cable and low-profile chamfered keyboard body.
    c.box(339, 281, 343, 307, (95, 91, 76), 2)
    c.box(340, 279, 360, 283, (95, 91, 76), 2)
    c.box(357, 262, 361, 281, (95, 91, 76), 2)
    c.polygon([(84, 303), (423, 303), (447, 346), (62, 346)], (89, 85, 73))
    c.polygon([(85, 302), (422, 302), (445, 341), (65, 341)], material((222, 213, 185)))
    c.polygon([(65, 341), (445, 341), (445, 351), (65, 351)], material((153, 143, 118)))
    c.box(72, 341, 439, 344, (238, 226, 197))
    c.box(77, 350, 434, 353, (97, 91, 78), 2)
    c.polygon([(94, 307), (411, 307), (425, 335), (80, 335)], (117, 111, 92))

    def key(x, y, w, h, dark=False, legend=True):
        base = (152, 151, 131) if dark else (213, 206, 183)
        c.box(x, y, x + w, y + h, (77, 77, 65), 1)
        c.box(x, y, x + w - 1, y + h - 2, material(base, 19), 1)
        c.box(x + 1, y, x + w - 2, y + 1, (235, 230, 205) if not dark else (189, 187, 163))
        if legend:
            c.box(x + 3, y + 2, x + 5, y + 3, (99, 104, 88))

    for row in range(3):
        for col in range(18):
            key(94 - row * 3 + col * 18, 309 + row * 8, 15, 7,
                dark=(col == 0 or col >= 14))
    for x in (87, 107, 127):
        key(x, 333, 17, 7, dark=True)
    key(148, 333, 159, 7, legend=False)
    for x in (312, 332, 352, 372, 392, 412):
        key(x, 333, 17, 7, dark=True)
    return c.rows


def main():
    output = Path(__file__).resolve().parents[1] / 'media' / 'logo.png'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(write_png(WIDTH, HEIGHT, render()))
    print(f'Wrote {output} ({WIDTH}x{HEIGHT} RGBA, {output.stat().st_size:,} bytes)')


if __name__ == '__main__':
    main()
