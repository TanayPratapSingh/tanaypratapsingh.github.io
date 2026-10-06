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


BUILDINGS = [
    # id, sign name, drawing, footprint front corner for draw order
    ("observatory", "Observatory", observatory, 6.8),
    ("library", "Library", library, 10.45),
    ("tower", "Control tower", control_tower, 8.7),
]

TREES = []

# cars: lane position, size along x and y, color, and how far they drive in grid units
CARS = []


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
    return ""


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
    return ('<svg class="map" id="map" viewBox="0 0 980 770" role="group" aria-label="A small town. Each building holds some of my work.">'
            + '<g class="sky">' + sky() + '</g>' + ground() + cars() + "".join(out) + '<g class="signs">' + "".join(signs) + "</g></svg>")


if __name__ == "__main__":
    import sys
    sys.stdout.write(render({}))
