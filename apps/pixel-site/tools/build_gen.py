#!/usr/bin/env python3
"""Build assets/gen.png + gen.json: art drawn here in code (no PixelLab generations).

  python3 tools/build_gen.py

- Floor tiles, 32x16 diamonds with 4 variants each: carpet, wood planks (both directions), small bath tiles, kitchen
  checker, raised server floor, concrete, marble, corridor vinyl, asphalt, sidewalk pavers, driveway, dirt lot and a
  blueprint grid. Neutral ones are tinted per room at runtime.
- Thin cutaway walls: one face per cell edge, low (10 px, with a light cut top) or tall (48 px, for the building's back
  walls and the panels things hang on), both wall directions; tall back walls get night windows.
- desk_back: the oak desk turned round (monitor back towards the camera) for rats that face the camera.
- Floor decals: rugs, worn spots, hazard tape, dust.
Frames load with the 'world:' prefix (src/gfx/atlas.ts).
"""
import json, os, random
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
OUT = os.path.join(APP, "assets")
OUTLINE = (22, 24, 44, 255)


def hexc(h, a=255):
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16), a)


def clamp(v):
    return max(0, min(255, int(round(v))))


def shade(c, k):
    return (clamp(c[0] * k), clamp(c[1] * k), clamp(c[2] * k), c[3] if len(c) > 3 else 255)


def add(c, d):
    return (clamp(c[0] + d), clamp(c[1] + d), clamp(c[2] + d), c[3] if len(c) > 3 else 255)


def mix(a, b, t):
    return tuple(clamp(a[k] + (b[k] - a[k]) * t) for k in range(3)) + (255,)


# ------------------------------------------------------------------ floor diamonds

TW, TH = 32, 16


def in_diamond(x, y):
    """Row widths 2, 6, ... 30, 30, ... 2: tiles at (+-16, +-8) cover the plane exactly once."""
    r = y if y < 8 else 15 - y
    half = 2 * r + 1
    return 16 - half <= x < 16 + half


def uv(x, y):
    """Continuous (i, j) fraction of the cell at pixel (x, y): both in [0, 1)."""
    dx = x + 0.5 - 16
    dy = y + 0.5
    return (dx / 16 + dy / 8) / 2, (dy / 8 - dx / 16) / 2


def tile(fn, seed):
    rnd = random.Random(seed)
    im = Image.new("RGBA", (TW, TH), (0, 0, 0, 0))
    p = im.load()
    state = fn.__defaults__ and {}
    ctx = {"rnd": rnd}
    if hasattr(fn, "prep"):
        fn.prep(ctx)
    for y in range(TH):
        for x in range(TW):
            if in_diamond(x, y):
                u, v = uv(x, y)
                p[x, y] = fn(u, v, x, y, ctx)
    return im


def carpet(u, v, x, y, ctx):
    r = ctx["rnd"]
    base = (190, 190, 196)
    d = r.gauss(0, 5)
    if r.random() < 0.07:
        d += r.choice([-16, 14])
    return add(base + (255,), d)


def vinyl(u, v, x, y, ctx):
    r = ctx["rnd"]
    base = (222, 226, 232)
    d = r.gauss(0, 2.5)
    if r.random() < 0.035:
        d -= 22
    return add(base + (255,), d)


def plank_fn(axis):
    woods = [hexc("#c48a52"), hexc("#b27a45"), hexc("#d29b60"), hexc("#bb814b"), hexc("#a8713f")]

    def prep(ctx):
        r = ctx["rnd"]
        ctx["planks"] = [(r.choice(woods), r.random(), r.random() < 0.5) for _ in range(4)]

    def f(u, v, x, y, ctx):
        r = ctx["rnd"]
        a, b = (u, v) if axis == "i" else (v, u)
        k = min(3, int(b * 4))
        color, seam, has_seam = ctx["planks"][k]
        fb = b * 4 - k
        if fb < 0.2:
            return shade(color, 0.62)
        if has_seam and abs(a - seam) < 0.035:
            return shade(color, 0.7)
        c = add(color, r.gauss(0, 3))
        if r.random() < 0.05:
            c = shade(c, 0.88)
        return c

    f.prep = prep
    return f


def bath(u, v, x, y, ctx):
    r = ctx["rnd"]
    fu, fv = (u * 2) % 1, (v * 2) % 1
    if fu < 0.11 or fv < 0.11:
        return (170, 180, 188, 255)
    return add((236, 242, 246, 255), r.gauss(0, 2))


def checker(u, v, x, y, ctx):
    r = ctx["rnd"]
    k = (int(u * 2) + int(v * 2)) % 2
    c = (226, 219, 204, 255) if k == 0 else (96, 92, 104, 255)
    return add(c, r.gauss(0, 2))


def raised(u, v, x, y, ctx):
    r = ctx["rnd"]
    if u < 0.07 or v < 0.07:
        return (88, 94, 110, 255)
    if u > 0.93 or v > 0.93:
        return (170, 176, 190, 255)
    c = (138, 144, 158, 255)
    if (int(u * 8) + int(v * 8)) % 2 == 0 and 0.2 < u < 0.8 and 0.2 < v < 0.8 and (x + y) % 3 == 0:
        c = (104, 110, 124, 255)
    return add(c, r.gauss(0, 1.5))


def concrete(u, v, x, y, ctx):
    r = ctx["rnd"]
    base = (170, 168, 162)
    d = r.gauss(0, 5)
    if r.random() < 0.04:
        d -= 20
    stain = ctx.setdefault("stain", (r.random(), r.random(), r.random() < 0.4))
    if stain[2] and (u - stain[0]) ** 2 + (v - stain[1]) ** 2 < 0.03:
        d -= 12
    return add(base + (255,), d)


def marble(u, v, x, y, ctx):
    r = ctx["rnd"]
    veins = ctx.setdefault("veins", [(r.random(), r.uniform(-0.8, 0.8)) for _ in range(2)])
    c = add((236, 232, 224, 255), r.gauss(0, 2))
    for c0, slope in veins:
        if abs(v - (c0 + slope * (u - 0.5))) < 0.022:
            c = (190, 188, 196, 255)
    if u < 0.03 or v < 0.03:
        c = shade(c, 0.9)
    return c


def asphalt(u, v, x, y, ctx):
    r = ctx["rnd"]
    d = r.gauss(0, 4)
    if r.random() < 0.05:
        d += 14
    return add((58, 62, 78, 255), d)


def sidewalk(u, v, x, y, ctx):
    r = ctx["rnd"]
    fu, fv = (u * 2) % 1, (v * 2) % 1
    if fu < 0.07 or fv < 0.07:
        return (92, 98, 116, 255)
    return add((142, 148, 164, 255), r.gauss(0, 3))


def driveway(u, v, x, y, ctx):
    r = ctx["rnd"]
    if u < 0.04:
        return (112, 112, 118, 255)
    d = r.gauss(0, 4)
    if r.random() < 0.03:
        d -= 16
    return add((158, 156, 152, 255), d)


def lot(u, v, x, y, ctx):
    r = ctx["rnd"]
    d = r.gauss(0, 4)
    if r.random() < 0.08:
        d += r.choice([12, 18, -8])
    return add((50, 52, 66, 255), d)


def blueprint(u, v, x, y, ctx):
    if u < 0.06 or v < 0.06:
        return (104, 150, 230, 255)
    fu, fv = (u * 4) % 1, (v * 4) % 1
    if fu < 0.12 or fv < 0.12:
        return (48, 82, 150, 255)
    return (30, 58, 118, 255)


def grass(u, v, x, y, ctx):
    r = ctx["rnd"]
    d = r.gauss(0, 6)
    if r.random() < 0.1:
        d += 16
    return add((58, 104, 62, 255), d)


def dirt(u, v, x, y, ctx):
    r = ctx["rnd"]
    d = r.gauss(0, 6)
    if r.random() < 0.08:
        d += r.choice([14, -12])
    return add((112, 92, 70, 255), d)


FLOORS = {
    "carpet": carpet, "vinyl": vinyl, "wood_i": plank_fn("i"), "wood_j": plank_fn("j"), "bath": bath, "checker": checker,
    "raised": raised, "concrete": concrete, "marble": marble, "asphalt": asphalt, "sidewalk": sidewalk,
    "driveway": driveway, "lot": lot, "blueprint": blueprint, "grass": grass, "dirt": dirt,
}

# ------------------------------------------------------------------ walls


def wall_face(axis, H, kind):
    """One face on a cell edge. axis 'i': the +j edge (face looks down-left), 'j': the +i edge (looks down-right).
    Anchor: the cell's top vertex. Returns (image, anchor x, anchor y) in pixels."""
    T = 2  # slab thickness in screen px (back along -j or -i)
    Wd = 16 + T + 1
    Hd = H + 8 + T + 2
    im = Image.new("RGBA", (Wd, Hd), (0, 0, 0, 0))
    p = im.load()
    # frame coords: the edge runs from L = (0, top + 8) to B = (16, top + 16), where top = the cell top vertex row
    top = H + T - 7
    ax, ay = 16, top
    face_hi = hexc("#dfe7f0") if axis == "i" else hexc("#b7c3d2")
    face_lo = hexc("#c3cedb") if axis == "i" else hexc("#9eabbd")
    base = hexc("#646c84") if axis == "i" else hexc("#555c73")
    cap = hexc("#f4f7fb")
    for cx in range(16):
        yb = top + 8 + cx // 2 + (1 if cx % 2 else 0) // 2
        for k in range(H):
            y = yb - k
            if kind == "header" and k < H - 14:
                continue  # a rolled-up garage door: only the drum and header show, the opening stays clear
            if kind == "header":
                c = hexc("#e9e4d8") if (H - k) % 3 else hexc("#b9b2a2")
                if k == H - 14:
                    c = hexc("#7c7466")
                p[cx, y] = c
                continue
            if kind == "window" and H > 20 and 4 <= k <= H - 6:
                # night windows: dark glass, mullions, a few city lights far away
                mull = cx % 8 == 0 or (k - 4) % 14 == 0
                rnd = random.Random(cx * 131 + k * 7 + (0 if axis == "i" else 999))
                if mull:
                    c = hexc("#58627e") if axis == "i" else hexc("#4a526c")
                else:
                    c = mix(hexc("#16203c"), hexc("#26345a"), k / H)
                    if rnd.random() < 0.035:
                        c = rnd.choice([hexc("#ffd27a"), hexc("#9fd3ff"), hexc("#ff9f6a")])
            elif k < 2:
                c = base
            else:
                c = mix(face_lo, face_hi, min(1, k / max(1, H - 1)))
                if kind == "panel" and H > 20 and k in (H // 2, H // 2 + 1) and cx % 16 == 7:
                    c = shade(c, 0.9)
            p[cx, y] = c
        # the cut top: a light band the thickness of the slab, outlined above
        for t in range(T):
            p[cx, yb - H - t] = cap if t == 0 else shade(cap, 0.93)
        p[cx, yb - H - T] = OUTLINE
    # the far end of the slab (where the run starts): a thin dark edge
    for k in range(H + T if kind != "header" else 0):
        y = top + 8 - k
        if 0 <= y < Hd and p[0, y][3]:
            p[0, y] = shade(p[0, y], 0.8)
    if axis == "j":
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
        ax = Wd - ax
    return im, ax, ay


# ------------------------------------------------------------------ desk turned round

world = Image.open(os.path.join(OUT, "world.png")).convert("RGBA")
wf = json.load(open(os.path.join(OUT, "world.json")))["frames"]


def wframe(name):
    f = wf[name]["frame"]
    return world.crop((f["x"], f["y"], f["x"] + f["w"], f["y"] + f["h"]))


def desk_back():
    """desk_oak has its monitor on the far (-i) edge facing +i. Turned round: the monitor stands on the near (+i)
    edge and shows its back, the keyboard moves to the far side. Same frame and footprint, so it places the same."""
    src = wframe("desk_oak")
    im = src.copy()
    p = im.load()
    s = src.load()
    wood = hexc("#d29b60")
    wood_dk = hexc("#b27a45")
    # 1. clear the monitor, the keyboard and the mug: everything above the tabletop that is not wood
    top_poly = [(8, 34), (24, 43), (56, 24), (40, 15)]
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).polygon(top_poly, fill=255)
    m = mask.load()
    for y in range(im.height):
        for x in range(im.width):
            c = s[x, y]
            if not c[3]:
                continue
            woodish = c[0] > c[2] + 40 and c[0] > 120
            if m[x, y] and not woodish:
                p[x, y] = wood if (x + y) % 5 else wood_dk
            elif not m[x, y] and y < 30 and not woodish:
                p[x, y] = (0, 0, 0, 0)
    # outline the cleared top edge
    d = ImageDraw.Draw(im)
    d.line([(40, 15), (8, 31)], fill=OUTLINE)
    d.line([(40, 15), (56, 23)], fill=OUTLINE)
    # 2. keyboard + mouse on the far side (a small light slab near the -i edge)
    kb = [(22, 28), (26, 30), (40, 23), (36, 21)]
    d.polygon(kb, fill=hexc("#d8dce6"))
    d.line([(22, 28), (36, 21)], fill=hexc("#9aa0b0"))
    p[44, 22] = hexc("#d8dce6")
    # 3. monitor back on the near (+i) edge: a dark slab rising from the edge, with a stand
    base_l = (26, 38)
    base_r = (46, 28)
    h = 15
    back = [(base_l[0], base_l[1] - 3), (base_r[0], base_r[1] - 3), (base_r[0], base_r[1] - 3 - h), (base_l[0], base_l[1] - 3 - h)]
    d.polygon(back, fill=hexc("#3b3f52"))
    # lighter rim and a logo dot
    d.line([back[3], back[2]], fill=hexc("#6d7389"))
    d.line([back[0], back[3]], fill=hexc("#555a70"))
    mx, my = (base_l[0] + base_r[0]) // 2, (base_l[1] + base_r[1]) // 2 - 3 - h // 2
    p[mx, my] = hexc("#9aa3bd")
    p[mx + 1, my] = hexc("#9aa3bd")
    # stand
    d.line([(mx, my + h // 2), (mx, my + h // 2 + 3)], fill=hexc("#2b2e3e"))
    d.polygon([(mx - 3, my + h // 2 + 4), (mx + 3, my + h // 2 + 1), (mx + 5, my + h // 2 + 2), (mx - 1, my + h // 2 + 5)], fill=hexc("#2b2e3e"))
    # outline of the monitor back
    d.line([back[3], back[2]], fill=OUTLINE)
    d.line([back[0], back[3]], fill=OUTLINE)
    d.line([back[1], back[2]], fill=OUTLINE)
    return im


# ------------------------------------------------------------------ decals


def parallelogram(a, b, fill_fn, border=None):
    """Flat iso rectangle a cells along i by b along j. Anchor: centre."""
    W, H = 16 * (a + b), 8 * (a + b)
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    p = im.load()
    for y in range(H):
        for x in range(W):
            X = x + 0.5 - 16 * b
            Y = y + 0.5
            i = (X / 16 + Y / 8) / 2
            j = (Y / 8 - X / 16) / 2
            if 0 <= i < a and 0 <= j < b:
                c = fill_fn(i / a, j / b, i, j)
                if c:
                    p[x, y] = c
    return im


def rug(a, b, outer, inner, accent, pattern, seed):
    rnd = random.Random(seed)

    def f(fu, fv, i, j):
        e = min(i, j, a - i, b - j)
        if e < 0.12:
            return shade(outer, 0.8)
        if e < 0.3:
            return outer
        if e < 0.38:
            return accent
        if pattern == "diamond" and abs((i - a / 2)) / a + abs((j - b / 2)) / b < 0.22:
            return accent
        if pattern == "stripes" and int((i + j) * 3) % 2 == 0:
            return shade(inner, 0.9)
        return add(inner, rnd.gauss(0, 2))

    return parallelogram(a, b, f)


def worn(seed):
    rnd = random.Random(seed)
    cx, cy = rnd.uniform(0.35, 0.65), rnd.uniform(0.35, 0.65)

    def f(fu, fv, i, j):
        d = ((fu - cx) / 0.45) ** 2 + ((fv - cy) / 0.45) ** 2
        if d > 1:
            return None
        a = int(46 * (1 - d) * (0.6 + 0.4 * rnd.random()))
        return (20, 20, 30, a) if a > 4 else None

    return parallelogram(2, 2, f)


def road_mark(kind, axis):
    """Flat road paint on one cell: lane dash, zebra stripes, a parking bay line. axis: the way the road runs."""
    im = Image.new("RGBA", (TW, TH), (0, 0, 0, 0))
    p = im.load()
    white = (236, 236, 228, 210)
    for y in range(TH):
        for x in range(TW):
            if not in_diamond(x, y):
                continue
            u, v = uv(x, y)
            along, across = (u, v) if axis == "i" else (v, u)
            if kind == "lane" and 0.46 < across < 0.54 and 0.1 < along < 0.6:
                p[x, y] = (240, 210, 90, 220)
            elif kind == "zebra" and 0.15 < across < 0.85 and int(along * 5) % 2 == 0:
                p[x, y] = white
            elif kind == "pline" and across < 0.07 and along < 0.9:
                p[x, y] = white
    return im


def tape(axis):
    """Hazard tape along one cell edge (flat): axis 'i' runs down-right, 'j' down-left."""
    im = Image.new("RGBA", (17, 12), (0, 0, 0, 0))
    p = im.load()
    for cx in range(17):
        y = 1 + cx // 2 if axis == "i" else 1 + (16 - cx) // 2
        c = hexc("#ffd23c") if (cx // 3) % 2 == 0 else hexc("#2a2a33")
        p[cx, y] = c
        p[cx, y + 1] = shade(c, 0.8)
    return im


# ------------------------------------------------------------------ pack

frames = {}  # name -> (image, anchor x px, anchor y px)
for name, fn in FLOORS.items():
    for k in range(4):
        frames[f"fl_{name}_{k}"] = (tile(fn, f"{name}:{k}"), 16, 0)
for axis in ("i", "j"):
    for H, tag in ((10, "low"), (48, "tall")):
        for kind in ("plain", "window", "panel", "header") if tag == "tall" else ("plain",):
            im, ax, ay = wall_face(axis, H, kind)
            frames[f"wf_{axis}_{tag}{'' if kind == 'plain' else '_' + kind}"] = (im, ax, ay)
db = desk_back()
frames["desk_back"] = (db, 32, 64)
rugs = [
    ("rug_red", 3, 2, hexc("#8e2433"), hexc("#b8384a"), hexc("#e8c46a"), "diamond"),
    ("rug_blue", 3, 2, hexc("#24386e"), hexc("#3d5aa0"), hexc("#b9c8ee"), "stripes"),
    ("rug_green", 2, 2, hexc("#2f5e3c"), hexc("#4f8a58"), hexc("#d8e4b0"), "plain"),
    ("rug_sand", 3, 3, hexc("#8a6a44"), hexc("#c7a574"), hexc("#f1dfb4"), "diamond"),
    ("rug_purple", 2, 3, hexc("#4b2d6e"), hexc("#6d48a0"), hexc("#e0c8ff"), "stripes"),
]
for name, a, b, o, i_, acc, pat in rugs:
    im = rug(a, b, o, i_, acc, pat, name)
    frames[name] = (im, im.width // 2, im.height // 2)
for k in range(3):
    im = worn(k)
    frames[f"worn_{k}"] = (im, im.width // 2, im.height // 2)
for axis in ("i", "j"):
    for kind in ("lane", "zebra", "pline"):
        frames[f"{kind}_{axis}"] = (road_mark(kind, axis), 16, 0)
for axis in ("i", "j"):
    frames[f"tape_{axis}"] = (tape(axis), 8 if axis == "i" else 8, 5)


def pack(items, width=512):
    x = y = row = 0
    pos = {}
    for name, (im, _, _) in sorted(items.items(), key=lambda kv: -kv[1][0].height):
        if x + im.width > width:
            x, y, row = 0, y + row + 1, 0
        pos[name] = (x, y)
        x += im.width + 1
        row = max(row, im.height)
    return pos, y + row + 1


pos, height = pack(frames)
sheet = Image.new("RGBA", (512, height), (0, 0, 0, 0))
meta = {}
for name, (im, ax, ay) in frames.items():
    x, y = pos[name]
    sheet.alpha_composite(im, (x, y))
    meta[name] = {"frame": {"x": x, "y": y, "w": im.width, "h": im.height}, "anchor": {"x": round(ax / im.width, 4), "y": round(ay / im.height, 4)}}
sheet.save(os.path.join(OUT, "gen.png"))
json.dump({"frames": meta, "meta": {"app": "rat-race pixel-site tools/build_gen.py", "image": "gen.png", "size": {"w": 512, "h": height}}},
          open(os.path.join(OUT, "gen.json"), "w"), indent=1)
print(f"gen.png 512x{height}, {len(frames)} frames")
