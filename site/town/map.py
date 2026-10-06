"""Draw the town as one inline SVG at build time, so it paints before any script runs.

The town sits on a 14 by 14 isometric grid. P() turns grid coordinates and a
height in pixels into screen coordinates; every building is built from boxes,
roofs, cylinders and domes, and drawn back to front.

Anything a season or the night can change carries a class (gr, rd, lot, snow1,
snow2, tc1, tc2, ts, pond, win), so town.css can repaint the town without
touching the drawing. Windows are drawn twice: once in the building, and once
in a "lights" layer that town.css switches on at night.
"""
import math

OX, OY = 510, 286
HW, HH = 32, 16            # half tile width and height: a 2:1 isometric grid
K = math.sqrt(2)
INK = "#1F2A44"
_lights = []               # window polygons of the building being drawn


def P(gx, gy, z=0.0):
    return (OX + (gx - gy) * HW, OY + (gx + gy) * HH - z)


def _pts(ps):
    return " ".join("%.1f,%.1f" % p for p in ps)


def poly(ps, fill, cls=None):
    if cls == "win":
        _lights.append('<polygon points="%s"/>' % _pts(ps))
    c = ' class="%s"' % cls if cls else ""
    return '<polygon points="%s" fill="%s"%s/>' % (_pts(ps), fill, c)


def mix(a, b, t):
    a, b = a.lstrip("#"), b.lstrip("#")
    c = [round(int(a[i:i + 2], 16) * (1 - t) + int(b[i:i + 2], 16) * t) for i in (0, 2, 4)]
    return "#%02X%02X%02X" % tuple(c)


def tone(base):
    """Top, left and right face colors for one wall color, lit from the upper left."""
    return mix(base, "#FFFFFF", 0.4), base, mix(base, INK, 0.17)


def box(gx, gy, w, d, h, colors, z=0.0, cls=("snow1", None, None)):
    top, left, right = colors
    a, b, c = P(gx, gy + d, z), P(gx + w, gy + d, z), P(gx + w, gy, z)
    a2, b2, c2, d2 = P(gx, gy + d, z + h), P(gx + w, gy + d, z + h), P(gx + w, gy, z + h), P(gx, gy, z + h)
    return poly([a, b, b2, a2], left, cls[1]) + poly([b, c, c2, b2], right, cls[2]) + poly([d2, c2, b2, a2], top, cls[0])


def band_y(x0, x1, y, z0, z1, fill, cls=None):
    """A flat band painted on a wall that faces +y."""
    return poly([P(x0, y, z0), P(x1, y, z0), P(x1, y, z1), P(x0, y, z1)], fill, cls)


def band_x(y0, y1, x, z0, z1, fill, cls=None):
    """A flat band painted on a wall that faces +x."""
    return poly([P(x, y0, z0), P(x, y1, z0), P(x, y1, z1), P(x, y0, z1)], fill, cls)


def gable_y(gx, gy, w, d, z, rh, colors):
    """Pitched roof with its ridge along y, so the gable end faces the viewer's left."""
    top, left, right = colors
    m = gx + w / 2
    s = poly([P(gx, gy, z), P(gx, gy + d, z), P(m, gy + d, z + rh), P(m, gy, z + rh)], top, "snow1")
    s += poly([P(gx + w, gy, z), P(gx + w, gy + d, z), P(m, gy + d, z + rh), P(m, gy, z + rh)], right, "snow2")
    s += poly([P(gx, gy + d, z), P(gx + w, gy + d, z), P(m, gy + d, z + rh)], left)
    return s


def pyramid(gx, gy, w, d, z, rh, left, right):
    apex = P(gx + w / 2, gy + d / 2, z + rh)
    return (poly([P(gx, gy + d, z), P(gx + w, gy + d, z), apex], left, "snow1")
            + poly([P(gx + w, gy + d, z), P(gx + w, gy, z), apex], right, "snow2"))


def ell(gx, gy, r, z=0.0):
    x, y = P(gx, gy, z)
    return x, y, r * HW * K, r * HH * K


def cylinder(gx, gy, r, h, body, top, shade, z=0.0):
    x, yb, rx, ry = ell(gx, gy, r, z)
    yt = yb - h
    s = '<path d="M%.1f,%.1f L%.1f,%.1f A%.1f,%.1f 0 0 0 %.1f,%.1f L%.1f,%.1f Z" fill="%s"/>' % (
        x - rx, yt, x - rx, yb, rx, ry, x + rx, yb, x + rx, yt, body)
    s += '<path d="M%.1f,%.1f L%.1f,%.1f A%.1f,%.1f 0 0 0 %.1f,%.1f L%.1f,%.1f Z" fill="%s"/>' % (
        x, yt + ry, x, yb + ry, rx, ry, x + rx, yb, x + rx, yt, shade)
    s += '<ellipse cx="%.1f" cy="%.1f" rx="%.1f" ry="%.1f" fill="%s" class="snow1"/>' % (x, yt, rx, ry, top)
    return s


def dome(gx, gy, r, z, fill, tall=0.9):
    x, y, rx, ry = ell(gx, gy, r, z)
    return '<path d="M%.1f,%.1f A%.1f,%.1f 0 0 1 %.1f,%.1f A%.1f,%.1f 0 0 1 %.1f,%.1f Z" fill="%s"/>' % (
        x - rx, y, rx, rx * tall, x + rx, y, rx, ry, x - rx, y, fill)


def puff(x, y, r, k, o=0.92):
    return '<circle class="puff" style="--k:%d" cx="%.1f" cy="%.1f" r="%.1f" fill="#FFFFFF" opacity="%.2f"/>' % (k, x, y, r, o)


def line(a, b, stroke=INK, w=2.0):
    return '<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.1f" stroke-linecap="round"/>' % (
        a[0], a[1], b[0], b[1], stroke, w)


def rect(x, y, w, h, fill, rx=0, extra=""):
    return '<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%.1f" fill="%s"%s/>' % (x, y, w, h, rx, fill, extra)


def tree(gx, gy, n, s=1.0):
    x, y = P(gx, gy)
    v = n % 3
    return ('<g class="tree">'
            + '<ellipse class="ts" cx="%.1f" cy="%.1f" rx="%.1f" ry="%.1f" fill="#7DBE63"/>' % (x + 3, y + 2, 12 * s, 6 * s)
            + rect(x - 2 * s, y - 15 * s, 4 * s, 15 * s, "#8A5A3C")
            + '<circle class="tc1 v%d" cx="%.1f" cy="%.1f" r="%.1f" fill="#4E9A3C"/>' % (v, x, y - 22 * s, 11 * s)
            + '<circle class="tc2 v%d" cx="%.1f" cy="%.1f" r="%.1f" fill="#6FC25A"/>' % (v, x - 3.5 * s, y - 26 * s, 6 * s)
            + '</g>')


# ---------------------------------------------------------------- buildings
# Each returns (svg, sign anchor in screen space). Footprints never overlap,
# so sorting by the front corner (gx + w + gy + d) draws them back to front.

def observatory():
    s = box(1.2, 1.2, 2.2, 2.2, 20, tone("#DDE4F2"))
    s += cylinder(2.3, 2.3, 0.8, 22, "#F2F5FB", "#FFFFFF", "#D3DAE8", z=20)
    s += dome(2.3, 2.3, 0.8, 42, "#5468D8")
    x, y, rx, ry = ell(2.3, 2.3, 0.8, 42)
    slit = [(x - 5, y - rx * 0.9 + 6), (x + 5, y - rx * 0.9 + 6), (x + 5, y + ry - 2), (x - 5, y + ry - 2)]
    s += poly(slit, "#2E3B8F", "win")
    s += '<rect x="%.1f" y="%.1f" width="34" height="8" rx="3" fill="#2E3B8F" transform="rotate(-32 %.1f %.1f)"/>' % (
        x - 2, y - 40, x, y - 36)
    return s, (x, y - rx * 0.9 - 8)


def library():
    s = box(4.4, 1.2, 2.4, 2.0, 30, tone("#E6E0FF"))
    for i in range(5):
        x0 = 4.62 + i * 0.47
        s += band_y(x0, x0 + 0.14, 3.2, 0, 30, "#FFFFFF")
    for i in range(4):
        x0 = 4.82 + i * 0.47
        s += band_y(x0, x0 + 0.2, 3.2, 8, 20, "#C9C0F2", "win")
    s += gable_y(4.3, 1.1, 2.6, 2.25, 30, 18, tone("#5468D8"))
    s += box(4.3, 3.2, 2.6, 0.35, 5, tone("#C9D2E3"))
    x, y = P(5.6, 2.2, 48)
    return s, (x, y - 10)


def control_tower():
    s = box(1.65, 4.95, 0.7, 0.7, 64, tone("#3FB8A6"))
    s += box(1.35, 4.65, 1.3, 1.3, 16, ("#2C8F80", "#BDEBFF", "#93D6F0"), z=64, cls=("snow1", "win", "win"))
    s += band_y(1.35, 2.65, 5.95, 69, 71, "#2C8F80") + band_x(4.65, 5.95, 2.65, 69, 71, "#26806F")
    s += box(1.3, 4.6, 1.4, 1.4, 4, tone("#2C8F80"), z=80)
    a = P(2.0, 5.3, 84)
    s += line(a, (a[0], a[1] - 24)) + '<circle class="blink" cx="%.1f" cy="%.1f" r="4" fill="#FF4F6B"/>' % (a[0], a[1] - 26)
    return s, (a[0], a[1] - 34)


def gym():
    s = box(3.9, 4.4, 2.6, 2.0, 24, tone("#FF7A59"))
    s += band_y(4.85, 5.65, 6.4, 0, 15, "#C9583C")
    for x0 in (4.15, 5.95):
        s += band_y(x0, x0 + 0.4, 6.4, 13, 19, "#FFE1D6", "win")
    x, y = P(5.2, 5.4, 24)
    s += line((x - 22, y - 2), (x - 22, y - 22), INK, 2) + line((x + 22, y - 2), (x + 22, y - 22), INK, 2)
    s += rect(x - 38, y - 52, 76, 32, "#FFFFFF", 7, ' stroke="%s" stroke-width="2"' % INK)
    s += ('<g class="lift">' + rect(x - 17, y - 38.5, 34, 5, INK, 2) + rect(x - 23, y - 45, 7, 18, "#FF7A59", 2)
          + rect(x + 16, y - 45, 7, 18, "#FF7A59", 2) + '</g>')
    return s, (x, y - 58)


def factory():
    s = cylinder(8.45, 0.75, 0.24, 74, "#B8574A", "#7E3A31", "#9C4A3F")
    cx, cy, _, _ = ell(8.45, 0.75, 0.24, 74)
    s += '<g class="smoke">' + puff(cx + 6, cy - 12, 9, 0) + puff(cx + 16, cy - 24, 12, 1, 0.85) + puff(cx + 30, cy - 34, 14, 2, 0.75) + '</g>'
    s += box(8.8, 1.2, 3.4, 2.2, 22, tone("#FFB199"))
    s += band_y(9.1, 9.7, 3.4, 0, 13, "#C9583C") + band_y(10.4, 11.9, 3.4, 9, 15, "#FFE1D6", "win")
    seg = 3.4 / 3
    for i in range(3):
        x0, x1 = 8.8 + i * seg, 8.8 + (i + 1) * seg
        s += poly([P(x0, 1.2, 22), P(x1, 1.2, 38), P(x1, 3.4, 38), P(x0, 3.4, 22)], "#E3E8F1", "snow1")
        s += poly([P(x1, 1.2, 22), P(x1, 3.4, 22), P(x1, 3.4, 38), P(x1, 1.2, 38)], "#93D6F0", "win")
        s += poly([P(x0, 3.4, 22), P(x1, 3.4, 22), P(x1, 3.4, 38)], "#FFB199")
    x, y = P(10.5, 2.3, 38)
    return s, (x, y - 14)


def power_station():
    x, yb, rxb, ryb = ell(13.0, 1.9, 0.75)
    _, _, rxt, ryt = ell(13.0, 1.9, 0.48)
    yt, ym, rw = yb - 58, yb - 36, rxt * 0.9
    s = '<path d="M%.1f,%.1f Q%.1f,%.1f %.1f,%.1f L%.1f,%.1f Q%.1f,%.1f %.1f,%.1f A%.1f,%.1f 0 0 1 %.1f,%.1f Z" fill="#E4E9F2"/>' % (
        x - rxb, yb, x - rw, ym, x - rxt, yt, x + rxt, yt, x + rw, ym, x + rxb, yb, rxb, ryb, x - rxb, yb)
    s += '<path d="M%.1f,%.1f L%.1f,%.1f Q%.1f,%.1f %.1f,%.1f A%.1f,%.1f 0 0 1 %.1f,%.1f Z" fill="#C8D0DE"/>' % (
        x, yt + ryt, x + rxt, yt, x + rw, ym, x + rxb, yb, rxb, ryb, x, yb + ryb)
    s += '<ellipse cx="%.1f" cy="%.1f" rx="%.1f" ry="%.1f" fill="#7D889C"/>' % (x, yt, rxt, ryt)
    s += '<g class="smoke">' + puff(x - 8, yt - 12, 13, 0) + puff(x + 10, yt - 20, 15, 1, 0.85) + puff(x - 2, yt - 34, 12, 2, 0.75) + '</g>'
    s += box(12.25, 3.0, 1.5, 0.8, 14, tone("#FFC93C"))
    bx, by = P(13.0, 3.8, 7)
    s += '<polygon points="%.1f,%.1f %.1f,%.1f %.1f,%.1f %.1f,%.1f %.1f,%.1f %.1f,%.1f" fill="%s"/>' % (
        bx + 1, by - 7, bx - 5, by + 1, bx - 1, by + 1, bx - 3, by + 7, bx + 4, by - 1, bx, by - 1, INK)
    return s, (x, yt - 46)


def newsroom():
    s = box(8.8, 4.4, 2.4, 2.0, 34, tone("#FF6FA3"))
    for z0 in (8, 20):
        for x0 in (9.05, 9.75, 10.45):
            s += band_y(x0, x0 + 0.45, 6.4, z0, z0 + 7, "#FFE0EC", "win")
        for y0 in (4.65, 5.4):
            s += band_x(y0, y0 + 0.5, 11.2, z0, z0 + 7, "#F2B8CF", "win")
    a = P(9.3, 4.8, 34)
    s += line(a, (a[0], a[1] - 30)) + line((a[0] - 6, a[1] - 22), (a[0] + 6, a[1] - 22))
    d = P(10.5, 5.2, 34)
    s += line(d, (d[0], d[1] - 10), INK, 2.5)
    s += ('<g class="dish" style="transform-origin:%.1fpx %.1fpx">' % (d[0], d[1] - 16)
          + '<ellipse cx="%.1f" cy="%.1f" rx="15" ry="8" fill="#FFFFFF" stroke="%s" stroke-width="1.5" transform="rotate(-28 %.1f %.1f)"/>' % (
              d[0], d[1] - 16, INK, d[0], d[1] - 16)
          + '<circle cx="%.1f" cy="%.1f" r="2.5" fill="%s"/></g>' % (d[0], d[1] - 16, INK))
    x, y = P(10.0, 5.4, 34)
    return s, (x, y - 30)


def race_track():
    s = poly([P(11.4, 4.0), P(13.85, 4.0), P(13.85, 6.95), P(11.4, 6.95)], "#93CF74", "lot")
    x, y, rx, ry = ell(12.6, 5.45, 1.05)
    s += '<ellipse cx="%.1f" cy="%.1f" rx="%.1f" ry="%.1f" fill="#5B6478"/>' % (x, y, rx, ry)
    _, _, ix, iy = ell(12.6, 5.45, 0.7)
    s += '<ellipse class="lot" cx="%.1f" cy="%.1f" rx="%.1f" ry="%.1f" fill="#A8DB8A"/>' % (x, y, ix, iy)
    mx, my = (rx + ix) / 2, (ry + iy) / 2
    s += '<ellipse cx="%.1f" cy="%.1f" rx="%.1f" ry="%.1f" fill="none" stroke="#FFFFFF" stroke-width="1.2" stroke-dasharray="5 5"/>' % (
        x, y, mx, my)
    s += rect(x - 2, y + iy, 4, ry - iy, "#FFFFFF")
    lap = "M%.1f,%.1f a%.1f,%.1f 0 1,0 %.1f,0 a%.1f,%.1f 0 1,0 %.1f,0" % (x - mx, y, mx, my, 2 * mx, mx, my, -2 * mx)
    s += ('<g class="racer"><rect x="-7" y="-3.5" width="14" height="7" rx="2.5" fill="#FF4F6B"/>'
          '<rect x="1" y="-2.5" width="4" height="5" rx="1" fill="#FFFFFF"/>'
          '<animateMotion dur="6s" repeatCount="indefinite" rotate="auto" path="%s"/></g>' % lap)
    s += box(11.55, 6.55, 1.6, 0.35, 10, tone("#3FB8A6"))
    f = P(13.55, 4.3)
    s += line(f, (f[0], f[1] - 38))
    s += '<g class="flag" style="transform-origin:%.1fpx %.1fpx">' % (f[0], f[1] - 33)
    for i in range(4):
        for j in range(2):
            s += rect(f[0] + i * 4.5, f[1] - 38 + j * 5, 4.5, 5, INK if (i + j) % 2 == 0 else "#FFFFFF")
    s += '</g>'
    return s, (x, y - ry - 26)


def town_hall():
    s = box(1.2, 8.9, 2.6, 2.0, 28, tone("#FFC93C"))
    s += band_y(2.15, 2.85, 10.9, 0, 14, "#C9932A")
    for x0 in (1.45, 3.15):
        s += band_y(x0, x0 + 0.4, 10.9, 12, 20, "#FFF1C2", "win")
    s += box(2.05, 9.45, 0.9, 0.9, 30, tone("#FFD666"), z=28)
    s += pyramid(2.0, 9.4, 1.0, 1.0, 58, 18, "#E0603F", "#B94C31")
    c = P(2.5, 10.35, 46)
    s += '<circle cx="%.1f" cy="%.1f" r="7" fill="#FFFFFF" stroke="%s" stroke-width="1.5"/>' % (c[0] - 7, c[1] + 4, INK)
    s += line((c[0] - 7, c[1] + 4), (c[0] - 7, c[1] - 1), INK, 1.5)
    s += '<g class="hand" style="transform-origin:%.1fpx %.1fpx">' % (c[0] - 7, c[1] + 4) + line((c[0] - 7, c[1] + 4), (c[0] - 3, c[1] + 5), INK, 1.5) + '</g>'
    a = P(2.5, 9.9, 76)
    s += line(a, (a[0], a[1] - 18)) + '<polygon class="flag" style="transform-origin:%.1fpx %.1fpx" points="%.1f,%.1f %.1f,%.1f %.1f,%.1f" fill="#FF4F6B"/>' % (
        a[0], a[1] - 14, a[0], a[1] - 18, a[0] + 14, a[1] - 14, a[0], a[1] - 10)
    return s, (a[0], a[1] - 28)


def train_yard():
    s = poly([P(4.3, 8.8), P(6.8, 8.8), P(6.8, 12.8), P(4.3, 12.8)], "#D9CFC0")
    y = 8.9
    while y < 13.9:
        s += poly([P(5.1, y), P(5.82, y), P(5.82, y + 0.09), P(5.1, y + 0.09)], "#9B8268")
        y += 0.3
    for x0 in (5.2, 5.66):
        s += poly([P(x0, 8.85), P(x0 + 0.06, 8.85), P(x0 + 0.06, 13.95), P(x0, 13.95)], "#5E5145")
    s += box(4.45, 9.0, 0.55, 2.4, 6, tone("#C9D2E3"))
    s += '<g class="train">'
    for i, c in enumerate(("#5468D8", "#FFC93C", "#FF7A59")):
        s += box(5.18, 9.25 + i * 1.12, 0.55, 1.0, 15, tone(c), z=1)
        s += band_x(9.45 + i * 1.12, 10.05 + i * 1.12, 5.73, 8, 13, "#FFFFFF", "win")
    s += box(5.24, 9.3, 0.43, 0.42, 9, tone("#2E3B8F"), z=16)
    s += '</g>'
    x, y = P(5.45, 10.4, 30)
    return s, (x, y - 8)


def travel_agency():
    s = box(9.1, 9.0, 1.4, 1.3, 30, tone("#7FD3C7"))
    s += band_y(9.6, 10.0, 10.3, 0, 13, "#3E9E91") + band_x(9.25, 9.95, 10.5, 12, 22, "#D7F3EE", "win")
    n = 5
    for i in range(n):
        x0, x1 = 9.1 + i * 1.4 / n, 9.1 + (i + 1) * 1.4 / n
        s += poly([P(x0, 10.3, 24), P(x1, 10.3, 24), P(x1, 10.62, 17), P(x0, 10.62, 17)], "#FF7A59" if i % 2 == 0 else "#FFFFFF")
    g = P(10.25, 9.3, 30)
    s += line(g, (g[0], g[1] - 20))
    s += '<g class="globe" style="transform-origin:%.1fpx %.1fpx">' % (g[0], g[1] - 31)
    s += '<circle cx="%.1f" cy="%.1f" r="11" fill="#5468D8"/>' % (g[0], g[1] - 31)
    s += '<ellipse cx="%.1f" cy="%.1f" rx="5" ry="11" fill="none" stroke="#FFFFFF" stroke-width="1.3"/>' % (g[0], g[1] - 31)
    s += line((g[0] - 11, g[1] - 31), (g[0] + 11, g[1] - 31), "#FFFFFF", 1.3) + '</g>'
    x, y = P(9.8, 9.65, 30)
    return s, (x - 16, y - 12)


def toolshed():
    s = box(11.8, 9.0, 1.4, 1.2, 16, tone("#C98B5B"))
    s += band_y(12.25, 12.75, 10.2, 0, 11, "#7A4A30")
    s += gable_y(11.75, 8.95, 1.5, 1.32, 16, 12, tone("#8C5A3C"))
    x, y = P(12.5, 9.6, 28)
    return s, (x, y - 10)


def university():
    s = box(1.2, 11.7, 2.8, 1.9, 30, tone("#D8E0F2"))
    for i in range(5):
        x0 = 1.6 + i * 0.44
        s += band_y(x0, x0 + 0.2, 13.6, 10, 22, "#B8C4E0", "win")
    for i in range(6):
        x0 = 1.42 + i * 0.44
        s += band_y(x0, x0 + 0.13, 13.6, 0, 30, "#FFFFFF")
    s += box(1.15, 11.65, 2.9, 2.0, 4, tone("#AEB9D3"), z=30)
    s += cylinder(2.6, 12.65, 0.55, 12, "#F2F5FB", "#FFFFFF", "#D3DAE8", z=34)
    s += dome(2.6, 12.65, 0.55, 46, "#FFC93C")
    x, y, rx, _ = ell(2.6, 12.65, 0.55, 46)
    s += line((x, y - rx * 0.9), (x, y - rx * 0.9 - 14))
    return s, (x, y - rx * 0.9 - 22)


def post_office():
    s = box(8.9, 11.7, 2.2, 1.7, 24, tone("#F25F5C"))
    s += band_y(9.75, 10.3, 13.4, 0, 13, "#B23F3C") + band_x(12.0, 12.9, 11.1, 10, 18, "#FFD1CF", "win")
    e = P(9.35, 13.4, 18)
    s += rect(e[0] - 2, e[1] - 4, 22, 14, "#FFFFFF", 2)
    s += '<polyline points="%.1f,%.1f %.1f,%.1f %.1f,%.1f" fill="none" stroke="%s" stroke-width="1.3"/>' % (
        e[0] - 2, e[1] - 4, e[0] + 9, e[1] + 4, e[0] + 20, e[1] - 4, INK)
    s += box(11.4, 13.0, 0.3, 0.3, 12, tone("#5468D8"))
    x, y = P(10.0, 12.55, 24)
    return s, (x, y - 10)


BUILDINGS = [
    # id, sign name, drawing, footprint front corner for draw order
    ("observatory", "Observatory", observatory, 6.8),
    ("library", "Library", library, 10.45),
    ("tower", "Control tower", control_tower, 8.7),
    ("gym", "Gym", gym, 12.9),
    ("factory", "Factory", factory, 15.6),
    ("power", "Power station", power_station, 17.55),
    ("newsroom", "Newsroom", newsroom, 17.6),
    ("track", "Race track", race_track, 20.8),
    ("hall", "Town hall", town_hall, 14.7),
    ("yard", "Train yard", train_yard, 19.6),
    ("travel", "Travel agency", travel_agency, 20.8),
    ("shed", "Toolshed", toolshed, 23.4),
    ("school", "University", university, 17.6),
    ("post", "Post office", post_office, 25.0),
]

TREES = [(0.55, 0.6), (3.75, 0.55), (6.6, 0.55), (0.55, 4.0), (3.55, 3.85), (0.6, 6.6), (3.3, 6.75),
         (6.75, 6.7), (8.4, 6.75), (11.0, 6.85), (0.6, 8.6), (4.05, 10.6), (0.6, 11.2), (0.6, 13.5),
         (4.6, 13.4), (6.6, 13.4), (8.45, 11.2), (11.4, 11.0), (13.4, 10.9), (13.5, 13.3), (12.0, 13.6),
         (11.5, 12.4), (13.6, 8.5), (13.6, 6.9)]

# cars: lane position, size along x and y, color, and how far they drive in grid units
CARS = [("c1", 7.55, 0.05, 0.3, 0.5, "#FF4F6B"), ("c2", 7.15, 13.45, 0.3, 0.5, "#5468D8"),
        ("c3", 0.05, 7.55, 0.5, 0.3, "#FFC93C"), ("c4", 13.45, 7.15, 0.5, 0.3, "#3FB8A6")]


def ground():
    s = '<g class="ground">'
    s += poly([P(0, 14), P(14, 14), P(14, 14, -20), P(0, 14, -20)], "#B98A5E")
    s += poly([P(14, 0), P(14, 14), P(14, 14, -20), P(14, 0, -20)], "#9C7049")
    s += poly([P(0, 0), P(14, 0), P(14, 14), P(0, 14)], "#A8DB8A", "gr")
    s += poly([P(7, 0), P(8, 0), P(8, 14), P(7, 14)], "#F3D98F", "rd")
    s += poly([P(0, 7), P(14, 7), P(14, 8), P(0, 8)], "#F3D98F", "rd")
    for i in range(14):
        if i != 7:
            s += poly([P(7.46, i + 0.3), P(7.54, i + 0.3), P(7.54, i + 0.7), P(7.46, i + 0.7)], "#FFFFFF")
            s += poly([P(i + 0.3, 7.46), P(i + 0.7, 7.46), P(i + 0.7, 7.54), P(i + 0.3, 7.54)], "#FFFFFF")
    x, y, rx, ry = ell(12.7, 12.2, 0.6)
    s += '<ellipse class="pond" cx="%.1f" cy="%.1f" rx="%.1f" ry="%.1f" fill="#7CC4F2"/>' % (x, y, rx, ry)
    s += '<ellipse class="pond-hi" cx="%.1f" cy="%.1f" rx="%.1f" ry="%.1f" fill="#A9DBFA"/>' % (x - 6, y - 3, rx * 0.4, ry * 0.3)
    return s + "</g>"


def cars():
    s = '<g class="cars">'
    for cid, gx, gy, w, d, c in CARS:
        s += '<g class="car %s">' % cid + box(gx, gy, w, d, 7, tone(c), z=0.5)
        hx, hy = P(gx + w / 2, gy + d, 4) if d > w else P(gx + w, gy + d / 2, 4)
        s += '<circle class="hl" cx="%.1f" cy="%.1f" r="2.2" fill="#FFF6C8"/></g>' % (hx, hy)
    return s + "</g>"


def sky():
    s = '<g class="sun"><g class="rays">'
    for i in range(10):
        a = math.radians(i * 36)
        s += line((900 + 38 * math.cos(a), 262 + 38 * math.sin(a)), (900 + 48 * math.cos(a), 262 + 48 * math.sin(a)), "#FFD166", 4)
    s += '</g><circle cx="900" cy="262" r="30" fill="#FFD166"/></g>'
    s += '<g class="night-sky"><circle cx="900" cy="262" r="26" fill="#F4F1DE"/><circle cx="890" cy="254" r="5" fill="#E1DCC4"/><circle cx="909" cy="272" r="3.5" fill="#E1DCC4"/>'
    for sx, sy, r in ((70, 240, 1.6), (140, 300, 1.2), (220, 250, 1.8), (300, 330, 1.3), (380, 236, 1.5), (110, 420, 1.2), (250, 385, 1.4),
                      (600, 250, 1.3), (680, 300, 1.6), (760, 236, 1.2), (840, 330, 1.5), (960, 330, 1.3),
                      (90, 600, 1.4), (200, 700, 1.2), (60, 730, 1.6), (900, 640, 1.3), (800, 720, 1.5), (960, 700, 1.2)):
        s += '<circle class="star" cx="%d" cy="%d" r="%.1f" fill="#FFFFFF"/>' % (sx, sy, r)
    s += '</g>'
    for n, (cx, cy, sc) in enumerate(((700, 250, 1.0), (820, 300, 0.8), (110, 640, 0.9), (250, 270, 0.7))):
        # each cloud crosses the whole sky; the negative delay starts it where it is drawn
        a, b, dur = -(cx + 120), 1100 - cx, 80 + n * 14
        s += '<g class="drift" style="--a:%dpx;--b:%dpx;--dur:%ds;--del:%.1fs">' % (a, b, dur, -dur * (-a) / (b - a))
        s += ('<g transform="translate(%d %d) scale(%.2f)"><ellipse cx="0" cy="0" rx="36" ry="13" fill="#FFFFFF"/>'
              '<ellipse cx="16" cy="-8" rx="22" ry="13" fill="#FFFFFF"/><ellipse cx="-14" cy="-5" rx="16" ry="10" fill="#FFFFFF"/></g></g>') % (cx, cy, sc)
    s += '<g class="birds"><g class="flap">'
    for bx, by in ((0, 0), (16, 7), (-15, 9)):
        s += '<path d="M%d,%d q5,-6 10,0 q5,-6 10,0" fill="none" stroke="%s" stroke-width="1.8" stroke-linecap="round"/>' % (bx, by, INK)
    s += '</g></g>'
    return s


def sign(bid, name, anchor):
    x, y = anchor
    w = len(name) * 7.6 + 22
    return ('<g class="sign" data-b="%s" aria-hidden="true">' % bid
            + rect(x - w / 2, y - 26, w, 24, "#FFFFFF", 9, ' stroke="%s" stroke-width="1.5"' % INK)
            + '<polygon points="%.1f,%.1f %.1f,%.1f %.1f,%.1f" fill="%s"/>' % (x - 5, y - 2.5, x + 5, y - 2.5, x, y + 4, INK)
            + '<text x="%.1f" y="%.1f" text-anchor="middle">%s</text></g>' % (x, y - 9.5, name))


def render(labels):
    """labels maps building id to the aria label the page wants for that building."""
    items = [(depth, "b", (bid, name, fn)) for bid, name, fn, depth in BUILDINGS]
    items += [(gx + gy + 0.3, "t", (gx, gy)) for gx, gy in TREES]
    items.sort(key=lambda it: it[0])
    out, signs, n, t = [], [], 0, 0
    for _, kind, data in items:
        if kind == "t":
            out.append(tree(*data, n=t))
            t += 1
            continue
        bid, name, fn = data
        del _lights[:]
        svg, anchor = fn()
        lights = '<g class="lights" fill="#FFD86B">%s</g>' % "".join(_lights) if _lights else ""
        out.append('<g class="b" data-b="%s" tabindex="0" role="button" aria-label="%s" style="--i:%d"><g class="b__in">%s</g>%s</g>'
                   % (bid, labels.get(bid, name), n, svg, lights))
        signs.append(sign(bid, name, anchor))
        n += 1
    return ('<svg class="map" id="map" viewBox="32 200 956 570" role="group" aria-label="A small town. Each building holds some of my work." aria-describedby="mapHelp">'
            + '<g class="sky">' + sky() + '</g>' + ground() + cars() + "".join(out) + '<g class="signs">' + "".join(signs) + "</g></svg>")


if __name__ == "__main__":
    import sys
    sys.stdout.write(render({}))
