#!/usr/bin/env python3
"""Generate the Orbit icon set (original artwork: a centre dot with a small satellite on a thin
elliptical ring). Produces:
  icons/orbit.svg                      vector source (accent on warm off-black)
  icons/icon-{16,32,48,128}.png        colour toolbar/store icons
  icons/mono-dark-{16,32,48,128}.png   monochrome, light glyph for dark toolbars
  icons/mono-light-{16,32,48,128}.png  monochrome, dark glyph for light toolbars
Requires Pillow (pip install pillow). Run from the extension root: python3 scripts/make-icons.py
"""
import math
import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required: pip install pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")
os.makedirs(OUT, exist_ok=True)

ACCENT = (255, 106, 31, 255)        # tangerine, matches ORBIT.ACCENTS.tangerine
INK = (23, 20, 15, 255)             # warm off-black
PAPER = (242, 235, 224, 255)        # warm paper
SIZES = (16, 32, 48, 128)
SS = 8                              # supersampling factor for crisp anti-aliasing


def draw_mark(size, fg, bg=None):
    """Render the mark at `size` px. Geometry is defined on a 64-unit grid."""
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = S / 64.0  # one grid unit
    if bg is not None:
        r = 14 * u
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=bg)

    cx = cy = 32 * u
    # Thin elliptical ring, tilted -28 degrees. PIL has no rotated-ellipse primitive, so the ring is
    # built from two rotated polygons: the outer edge filled with the glyph colour, the inner edge
    # filled with the background (or fully transparent) to punch the hole. ImageDraw replaces pixels
    # rather than blending, which is exactly what we want here.
    rx, ry = 26 * u, 10.5 * u
    tilt = math.radians(-28)
    width = 2.6 * u if size >= 32 else 3.4 * u

    def ellipse_pts(ax, ay):
        pts = []
        for i in range(720):
            a = math.radians(i / 2.0)
            x, y = ax * math.cos(a), ay * math.sin(a)
            pts.append((cx + x * math.cos(tilt) - y * math.sin(tilt), cy + x * math.sin(tilt) + y * math.cos(tilt)))
        return pts

    hole = bg if bg is not None else (0, 0, 0, 0)
    d.polygon(ellipse_pts(rx + width / 2, ry + width / 2), fill=fg)
    d.polygon(ellipse_pts(rx - width / 2, ry - width / 2), fill=hole)

    # Centre dot
    cr = 9 * u if size >= 32 else 10 * u
    d.ellipse([cx - cr, cy - cr, cx + cr, cy + cr], fill=fg)

    # Satellite on the ring (at parametric angle 205 degrees), with a thin halo gap so it reads
    # as sitting *on* the ring rather than merging with it.
    a = math.radians(205)
    x, y = rx * math.cos(a), ry * math.sin(a)
    sx = cx + (x * math.cos(tilt) - y * math.sin(tilt))
    sy = cy + (x * math.sin(tilt) + y * math.cos(tilt))
    sr = 4.6 * u if size >= 32 else 5.4 * u
    d.ellipse([sx - sr - 1.6 * u, sy - sr - 1.6 * u, sx + sr + 1.6 * u, sy + sr + 1.6 * u], fill=hole)
    d.ellipse([sx - sr, sy - sr, sx + sr, sy + sr], fill=fg)

    return img.resize((size, size), Image.LANCZOS)


def write_svg():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="128" height="128">
  <!-- Orbit mark: centre dot + satellite on a thin elliptical ring. Original artwork. -->
  <rect width="64" height="64" rx="14" fill="#17140f"/>
  <g transform="rotate(-28 32 32)">
    <ellipse cx="32" cy="32" rx="26" ry="10.5" fill="none" stroke="#ff6a1f" stroke-width="2.6"/>
    <circle cx="8.43" cy="27.56" r="6.2" fill="#17140f"/>
    <circle cx="8.43" cy="27.56" r="4.6" fill="#ff6a1f"/>
  </g>
  <circle cx="32" cy="32" r="9" fill="#ff6a1f"/>
</svg>
"""
    with open(os.path.join(OUT, "orbit.svg"), "w", encoding="utf-8") as f:
        f.write(svg)


def main():
    write_svg()
    for s in SIZES:
        draw_mark(s, ACCENT, bg=INK).save(os.path.join(OUT, f"icon-{s}.png"))
        draw_mark(s, PAPER, bg=None).save(os.path.join(OUT, f"mono-dark-{s}.png"))
        draw_mark(s, INK, bg=None).save(os.path.join(OUT, f"mono-light-{s}.png"))
    print("wrote", sorted(os.listdir(OUT)))


if __name__ == "__main__":
    main()
