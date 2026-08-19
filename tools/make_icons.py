#!/usr/bin/env python3
"""Erzeugt das PWA-Icon (App: 'Kescher' - schnelle Ticket-/Screenshot-Erfassung).
Motiv: amberfarbene Screenshot-Rahmenecken (Capture-Frame) + Notiz-Zeilen auf
warmem Fast-Schwarz. Rein mit PIL, ohne externe SVG-Renderer."""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT, exist_ok=True)

SS = 4  # Supersampling fuer knackige Kanten

# Türkis-Grund, cremefarbene Rahmen (Variablennamen aus Historie beibehalten)
BG_TOP = (34, 201, 182)      # helles Türkis
BG_BOT = (10, 122, 113)      # tiefes Türkis
AMBER = (251, 247, 238)      # Rahmen-Ecken (creme)
AMBER_HI = (255, 255, 255)   # oberste Notiz-Zeile (weiss)
INK = (240, 233, 214)        # gedämpfte Notiz-Zeilen (creme)


def vgrad(size, top, bot):
    img = Image.new("RGB", (1, size), 0)
    for y in range(size):
        t = y / (size - 1)
        img.putpixel((0, y), tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    return img.resize((size, size))


def radial_glow(size, color, cx, cy, radius, max_alpha):
    glow = Image.new("L", (size, size), 0)
    px = glow.load()
    for y in range(size):
        for x in range(size):
            d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            t = max(0.0, 1.0 - d / radius)
            px[x, y] = int(max_alpha * (t ** 2))
    layer = Image.new("RGB", (size, size), color)
    return layer, glow


def draw_mark(size, safe, rounded):
    s = size * SS
    base = vgrad(s, BG_TOP, BG_BOT).convert("RGBA")
    # Amber-Glow hinter dem Zentrum
    gl_layer, gl_mask = radial_glow(s, AMBER, s * 0.5, s * 0.46, s * 0.6, 46)
    base = Image.composite(gl_layer.convert("RGBA"), base, gl_mask)

    layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    m = s * safe            # Rand des sicheren Bereichs
    fx0, fy0, fx1, fy1 = m, m, s - m, s - m
    arm = (fx1 - fx0) * 0.30
    thick = s * 0.052
    r = thick * 0.5

    for (cx, cy, dx, dy) in [(fx0, fy0, 1, 1), (fx1, fy0, -1, 1),
                             (fx0, fy1, 1, -1), (fx1, fy1, -1, -1)]:
        # horizontaler Arm
        d.rounded_rectangle([min(cx, cx + dx * arm), cy - thick / 2,
                             max(cx, cx + dx * arm), cy + thick / 2], radius=r, fill=AMBER)
        # vertikaler Arm
        d.rounded_rectangle([cx - thick / 2, min(cy, cy + dy * arm),
                             cx + thick / 2, max(cy, cy + dy * arm)], radius=r, fill=AMBER)

    # Notiz-Zeilen in der Mitte (eine hell = Titel, zwei gedaempft)
    cxw = (fx0 + fx1) / 2
    line_w = (fx1 - fx0) * 0.42
    lh = s * 0.030
    gap = s * 0.052
    cy0 = s * 0.5 - gap
    specs = [(0.0, AMBER_HI, 0.62), (1.0, INK, 0.85), (2.0, INK, 0.62)]
    for i, col, wf in specs:
        y = cy0 + gap * i
        w = line_w * wf
        a = 255 if i == 0 else 150
        col_a = col + (a,)
        d.rounded_rectangle([cxw - w / 2, y - lh / 2, cxw - w / 2 + w, y + lh / 2],
                            radius=lh / 2, fill=col_a)

    base = Image.alpha_composite(base, layer)

    if rounded:
        # abgerundete Maske (macOS-Dock-Style)
        mask = Image.new("L", (s, s), 0)
        md = ImageDraw.Draw(mask)
        md.rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 0.225, fill=255)
        out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        out.paste(base, (0, 0), mask)
        base = out

    return base.resize((size, size), Image.LANCZOS)


# Standard-Icon (abgerundet), Inhalt naeher am Rand
draw_mark(512, safe=0.20, rounded=True).save(os.path.join(OUT, "icon-512.png"))
# Maskable: voller Hintergrund, Inhalt im sicheren Bereich (mehr Padding), nicht vorab gerundet
draw_mark(512, safe=0.28, rounded=False).save(os.path.join(OUT, "icon-maskable-512.png"))
print("icons/icon-512.png + icons/icon-maskable-512.png geschrieben")
