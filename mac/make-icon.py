#!/usr/bin/env python3
"""Draw the Blazing Games icon, then build the .icns from it.

NO FONT FILES. blazing-ps5/tools/make-icons.py learned this the hard way and
the note is worth repeating: PIL answers a missing font by silently falling
back to a 6px bitmap, so the build exits 0 and the icon is illegible. Every
shape below is a circle, a rectangle or a rounded rectangle.

The mark is a d-pad and two buttons on the Blazing red, because this one app
stands in for eight separate console browsers and the icon has to read as
"games" at 32px in the Dock.

Colours are DESIGN-V2 §2.5 tokens and nothing else:
    bg      #0A0A0B
    accent  #FF3D47
    textHi  #FFFFFF
"""
import os
import subprocess
import sys
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
BG = (10, 10, 11, 255)
ACCENT = (255, 61, 71, 255)
WHITE = (255, 255, 255, 255)

S = 1024


def draw(size):
    """A GAMEPAD SILHOUETTE, and the first attempt was thrown away.

    Version 1 was a d-pad, three dots and a horizontal accent bar. Rendered at
    512 and looked at, it read as a FACE - two eyes, a nose and a mouth - not
    as a controller. That is exactly the failure a "the code says it draws a
    gamepad" check never catches, which is why the icon is rendered and looked
    at before it ships.

    This version draws the body of a pad, so the outline itself carries the
    meaning and the details sit inside it.
    """
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # The plate. macOS Big Sur+ icons are a rounded square inset from the
    # canvas; 100px of padding at 1024 is the shape Apple's own grid uses.
    pad = 100
    d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=225, fill=BG)

    cx, cy = S // 2, S // 2 + 6

    # THE PAD BODY. A wide rounded rectangle with two grips implied by the two
    # circles that overlap its bottom corners. Drawn in the accent at full
    # strength, because at 32px in the Dock this outline is the only thing
    # that survives and it has to be the thing that says "games".
    bw, bh = 520, 250
    d.rounded_rectangle([cx - bw // 2, cy - bh // 2, cx + bw // 2, cy + bh // 2],
                        radius=110, fill=ACCENT)
    gr = 140
    d.ellipse([cx - bw // 2 - 20, cy + bh // 2 - gr, cx - bw // 2 - 20 + 2 * gr, cy + bh // 2 + gr],
              fill=ACCENT)
    d.ellipse([cx + bw // 2 + 20 - 2 * gr, cy + bh // 2 - gr, cx + bw // 2 + 20, cy + bh // 2 + gr],
              fill=ACCENT)

    # The d-pad, knocked OUT of the body in the page black rather than painted
    # white on top. A knockout cannot drift out of register with the shape it
    # sits in, and it keeps the icon to two colours.
    arm, thick = 132, 44
    lx, ly = cx - 150, cy
    d.rounded_rectangle([lx - thick // 2, ly - arm // 2, lx + thick // 2, ly + arm // 2],
                        radius=14, fill=BG)
    d.rounded_rectangle([lx - arm // 2, ly - thick // 2, lx + arm // 2, ly + thick // 2],
                        radius=14, fill=BG)

    # Four face buttons in a diamond, right. Four is the count that reads as a
    # controller; three read as dots on a face in version 1.
    r, off = 32, 68
    bx, by = cx + 150, cy
    for dx, dy in ((0, -off), (0, off), (-off, 0), (off, 0)):
        d.ellipse([bx + dx - r, by + dy - r, bx + dx + r, by + dy + r], fill=BG)

    return img.resize((size, size), Image.LANCZOS)


def main():
    out = os.path.join(HERE, "BlazingGames.iconset")
    os.makedirs(out, exist_ok=True)
    # The exact set iconutil demands. A missing pair makes it fail with a
    # message that names neither the size nor the file.
    for size in (16, 32, 128, 256, 512):
        draw(size).save(os.path.join(out, f"icon_{size}x{size}.png"))
        draw(size * 2).save(os.path.join(out, f"icon_{size}x{size}@2x.png"))
    icns = os.path.join(HERE, "BlazingGames.icns")
    subprocess.run(["iconutil", "-c", "icns", out, "-o", icns], check=True)
    # A 1024 PNG as well, so the same mark can be reused for the PS5 tile.
    draw(512).save(os.path.join(HERE, "BlazingGames-512.png"))
    print(f"wrote {icns} ({os.path.getsize(icns)} bytes)")
    print(f"wrote {os.path.join(HERE, 'BlazingGames-512.png')}")


if __name__ == "__main__":
    sys.exit(main())
