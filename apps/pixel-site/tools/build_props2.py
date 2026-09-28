#!/usr/bin/env python3
"""Build assets/props2.png + props2.json: everything the dense floor adds on top of world.png.

  pip install pillow
  python3 tools/build_props2.py

Three kinds of art, all in the palette of the existing sprites with the rats' 1px outline (#16182c):

1. PixelLab props (assets/raw/props2/, args and ids in assets/manifest.json): three prop sheets cut into single props,
   plus the hero coffee machine.
2. Kitbashes of PixelLab art (no generation): recolors (gold CEO desk, white server rack, blue vending machine,
   navy and green sofas), stacks (box piles, printer on a filing cabinet, plant on a filing cabinet, 2 and 3 high
   walls), a TV cut from the blank wall ticker, a half-size box.
3. Small clutter drawn here in code: boxes, paper stacks, desk printer, sticky notes, spilled coffee, cables, a wall
   whiteboard. Colours are picked from the existing sprites; recolors are snapped to that same palette.

Wall-mounted pieces (names ending _wall) are pre-skewed for a wall running down-right (anchor top-left); mirror them
for a wall running down-left.
"""
import colorsys, json, os
from collections import Counter
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
RAW = os.path.join(APP, "assets", "raw", "props2")
OUT = os.path.join(APP, "assets")
OUTLINE = "#16182c"

# (name, x, y, w, h) per sheet: the alpha bounding box of each prop (columns split on empty gaps)
SHEETS = {
    "sheet_break_bath": [("water_cooler", 13, 14, 26, 67), ("coffee_counter", 74, 27, 49, 54), ("fridge", 159, 22, 29, 59),
                         ("sink", 221, 22, 33, 59), ("vending", 292, 14, 35, 67), ("toilet", 354, 34, 30, 43)],
    "sheet_work": [("server_rack", 15, 8, 50, 75), ("copier", 97, 13, 54, 72), ("whiteboard", 180, 11, 50, 73),
                   ("filing", 258, 19, 57, 64), ("box", 344, 40, 43, 42)],
    "sheet_exec": [("sofa", 10, 33, 62, 51), ("bookshelf", 96, 7, 50, 76), ("exec_desk", 175, 23, 59, 56),
                   ("round_table", 262, 33, 51, 41), ("street_lamp", 338, 11, 37, 68)],
}


def rgba(h, a=255):
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16), a)


def lum(c):
    return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]


def crop(im):
    return im.crop(im.getbbox())


def outline(im, color=OUTLINE):
    """1px outline outside the shape (8-connected), like the rats."""
    out = Image.new("RGBA", (im.width + 2, im.height + 2), (0, 0, 0, 0))
    out.alpha_composite(im, (1, 1))
    a = out.split()[3].load()
    p = out.load()
    c = rgba(color)
    edge = []
    for y in range(out.height):
        for x in range(out.width):
            if a[x, y]:
                continue
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    xx, yy = x + dx, y + dy
                    if 0 <= xx < out.width and 0 <= yy < out.height and a[xx, yy]:
                        edge.append((x, y))
                        break
                else:
                    continue
                break
    for x, y in edge:
        p[x, y] = c
    return out


def iso_box(a, b, h, top, left, right):
    """A cuboid a cells-of-2px along i (down-right), b along j (down-left), h px tall. Returns (image, faces)."""
    W, H = 2 * a + 2 * b + 1, a + b + h + 1
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    P0, P1, P3 = (2 * b, 0), (2 * b + 2 * a, a), (0, b)
    P2 = (2 * a, a + b)
    d.polygon([P3, P2, (P2[0], P2[1] + h), (P3[0], P3[1] + h)], fill=rgba(left))
    d.polygon([P2, P1, (P1[0], P1[1] + h), (P2[0], P2[1] + h)], fill=rgba(right))
    d.polygon([P0, P1, P2, P3], fill=rgba(top))
    return im, {"P0": P0, "P1": P1, "P2": P2, "P3": P3}


def shear_right_wall(im):
    """Each column down x/2: sits on the left face of a wall running down-right (2:1)."""
    out = Image.new("RGBA", (im.width, im.height + im.width // 2 + 1), (0, 0, 0, 0))
    for x in range(im.width):
        out.paste(im.crop((x, 0, x + 1, im.height)), (x, x // 2))
    return out


def unshear_right_wall(im):
    H = im.height - im.width // 2 - 1
    out = Image.new("RGBA", (im.width, H), (0, 0, 0, 0))
    for x in range(im.width):
        out.paste(im.crop((x, x // 2, x + 1, x // 2 + H)), (x, 0))
    return out


def stack(*parts):
    """Compose (image, dx, dy) parts bottom-first on a shared canvas; dx, dy are the part's bottom-centre offset."""
    xs, ys = [], []
    for im, dx, dy in parts:
        xs += [dx - im.width / 2, dx + im.width / 2]
        ys += [dy - im.height, dy]
    x0, y0 = int(min(xs)) - 1, int(min(ys)) - 1
    out = Image.new("RGBA", (int(max(xs)) - x0 + 2, int(max(ys)) - y0 + 2), (0, 0, 0, 0))
    for im, dx, dy in parts:
        out.alpha_composite(im, (int(round(dx - im.width / 2)) - x0, int(round(dy - im.height)) - y0))
    return crop(out)


# ------------------------------------------------------------------ palette of the existing art
world = Image.open(os.path.join(OUT, "world.png")).convert("RGBA")
wf = json.load(open(os.path.join(OUT, "world.json")))["frames"]
rats = Image.open(os.path.join(OUT, "rats.png")).convert("RGBA")


def wframe(name):
    f = wf[name]["frame"]
    return world.crop((f["x"], f["y"], f["x"] + f["w"], f["y"] + f["h"]))


PALETTE = Counter()
for im in [world, rats] + [Image.open(os.path.join(RAW, f"{s}.png")).convert("RGBA") for s in SHEETS]:
    PALETTE.update(px[:3] for px in im.get_flattened_data() if px[3])
PAL = [c for c, n in PALETTE.items() if n >= 3]


def snap(c):
    return min(PAL, key=lambda p: (p[0] - c[0]) ** 2 * 3 + (p[1] - c[1]) ** 2 * 4 + (p[2] - c[2]) ** 2 * 2)


def recolor(im, fn):
    """fn(rgb) -> rgb or None (keep). Result snapped to the palette."""
    out = im.copy()
    p = out.load()
    cache = {}
    for y in range(out.height):
        for x in range(out.width):
            c = p[x, y]
            if not c[3]:
                continue
            if c[:3] not in cache:
                n = fn(c[:3])
                cache[c[:3]] = None if n is None else snap(n)
            n = cache[c[:3]]
            if n is not None:
                p[x, y] = n + (c[3],)
    return out


def hsv(c):
    return colorsys.rgb_to_hsv(c[0] / 255, c[1] / 255, c[2] / 255)


def from_hsv(h, s, v):
    r, g, b = colorsys.hsv_to_rgb(h % 1, max(0, min(1, s)), max(0, min(1, v)))
    return (int(r * 255), int(g * 255), int(b * 255))


def ramp_map(im, pick, ramp):
    """Recolor the pixels `pick` selects onto a colour ramp by luminance rank."""
    cols = sorted({px[:3] for px in im.get_flattened_data() if px[3] and pick(px[:3])}, key=lum)
    if not cols:
        return im
    lo, hi = lum(cols[0]), lum(cols[-1])
    m = {c: rgba(ramp[min(len(ramp) - 1, int((lum(c) - lo) / max(1, hi - lo) * len(ramp)))])[:3] for c in cols}
    out = im.copy()
    p = out.load()
    for y in range(out.height):
        for x in range(out.width):
            c = p[x, y]
            if c[3] and c[:3] in m:
                p[x, y] = m[c[:3]] + (c[3],)
    return out


props = {}
notes = {}

# ------------------------------------------------------------------ 1) PixelLab props
for sheet, items in SHEETS.items():
    im = Image.open(os.path.join(RAW, f"{sheet}.png")).convert("RGBA")
    for name, x, y, w, h in items:
        c = im.crop((x, y, x + w, y + h))
        assert c.getbbox() == (0, 0, w, h), (name, c.getbbox())
        props[name] = c
        notes[name] = f"PixelLab {sheet}"
coffee_path = os.path.join(RAW, "coffee_machine.png")
if os.path.exists(coffee_path):
    props["coffee_machine"] = crop(Image.open(coffee_path).convert("RGBA"))
    notes["coffee_machine"] = "PixelLab hero prop"

# ------------------------------------------------------------------ 2) kitbashes


def is_mahogany(c):
    h, s, v = hsv(c)
    return (h > 0.9 or h < 0.1) and s > 0.25 and lum(c) > 20


props["exec_desk_gold"] = ramp_map(props["exec_desk"], is_mahogany, ["#57401f", "#7a5a32", "#b98450", "#e0b12e", "#f0c43a"])
notes["exec_desk_gold"] = "recolor: mahogany to the partner gold ramp"


def is_grey(c):
    return hsv(c)[1] < 0.25 and lum(c) > 28


props["server_rack_white"] = ramp_map(props["server_rack"], is_grey, ["#6d6d7b", "#9797a5", "#b7b7c3", "#d0d2da", "#eeeef6"])
notes["server_rack_white"] = "recolor: grey rack body to the copier whites"


def hue_to(target_h, sat_min=0.35, hue_pred=None):
    def f(c):
        h, s, v = hsv(c)
        if s < sat_min or (hue_pred and not hue_pred(h)):
            return None
        return from_hsv(target_h, s, v)
    return f


props["vending_blue"] = recolor(props["vending"], hue_to(0.62, 0.4, lambda h: h > 0.9 or h < 0.06))
props["sofa_navy"] = recolor(props["sofa"], hue_to(0.63, 0.25, lambda h: 0.02 < h < 0.14))
props["sofa_green"] = recolor(props["sofa"], hue_to(0.36, 0.25, lambda h: 0.02 < h < 0.14))
for k in ("vending_blue", "sofa_navy", "sofa_green"):
    notes[k] = "recolor: hue swap, snapped to the palette"

box = props["box"]
from_half = Image.new("RGBA", ((box.width + 1) // 2, (box.height + 1) // 2), (0, 0, 0, 0))
bp, hp = box.load(), from_half.load()
for y in range(from_half.height):
    for x in range(from_half.width):
        cs = [bp[2 * x + dx, 2 * y + dy] for dx in (0, 1) for dy in (0, 1) if 2 * x + dx < box.width and 2 * y + dy < box.height]
        op = [c for c in cs if c[3] > 0]
        if len(op) >= 2:
            hp[x, y] = max(Counter(op).most_common(), key=lambda kv: (kv[1], -sum(kv[0][:3])))[0]
props["box_half"] = crop(from_half)
notes["box_half"] = "the PixelLab box at half size (2x2 majority)"

# ------------------------------------------------------------------ 3) drawn in code
BOX = ("#edc3a9", "#c39782", "#836558")
TAPE = "#f0e6c0"


def small_box(a, b, h):
    im, P = iso_box(a, b, h, *BOX)
    d = ImageDraw.Draw(im)
    # tape along the top, down the front-left face
    mid = (P["P0"][0] - b, P["P0"][1] + b / 2)
    d.line([(mid[0] + 0, mid[1]), (mid[0] + 2 * a, mid[1] + a)], fill=rgba(TAPE))
    return outline(im)


props["box_s"] = small_box(5, 4, 6)
props["box_s2"] = small_box(4, 5, 5)
props["box_long"] = small_box(8, 3, 4)
for k in ("box_s", "box_s2", "box_long"):
    notes[k] = "drawn: cardboard box, box palette"


def paper_stack(a, b, h):
    im, P = iso_box(a, b, h, "#fcfbf9", "#e3e9ed", "#c0cdd9")
    p = im.load()
    for y in range(im.height):  # page edges on the side faces
        for x in range(im.width):
            if p[x, y][3] and y > P["P2"][1] - 2 and (y - x // 2) % 2 == 0 and p[x, y][:3] != rgba("#fcfbf9")[:3]:
                p[x, y] = rgba("#adb6c9")
    return outline(im)


props["paper_stack"] = paper_stack(5, 4, 5)
props["paper_tall"] = stack((paper_stack(5, 4, 5), 0, 0), (paper_stack(4, 4, 4), 1, -8), (paper_stack(4, 3, 3), -1, -14))
for k in ("paper_stack", "paper_tall"):
    notes[k] = "drawn: paper stack, papers palette"

pr, P = iso_box(7, 5, 5, "#d0d2da", "#fafbfa", "#9797a5")
tray, _ = iso_box(3, 3, 1, "#fcfbf9", "#e3e9ed", "#c0cdd9")
pr.alpha_composite(tray, (P["P0"][0] - 5, 1))
d = ImageDraw.Draw(pr)
d.line([(P["P3"][0] + 2, P["P3"][1] + 3), (P["P2"][0] - 2, P["P2"][1] + 1)], fill=rgba("#39383f"))
pr.putpixel((P["P2"][0] + 3, P["P2"][1] - 1), rgba("#465f92"))
pr.putpixel((P["P2"][0] + 5, P["P2"][1] - 2), rgba("#62cf44"))
props["printer"] = outline(pr)
notes["printer"] = "drawn: desk printer, copier palette"

STICKY = ["#f0c43a", "#df8493", "#62cf44", "#89b7f2"]


def note(color, size=4):
    im = Image.new("RGBA", (size, size), rgba(color))
    for x in range(size):
        im.putpixel((x, size - 1), snap(tuple(int(v * 0.8) for v in rgba(color)[:3])) + (255,))
    return outline(im)


def sticky_cluster(n, seed):
    import random
    rnd = random.Random(seed)
    im = Image.new("RGBA", (26, 16), (0, 0, 0, 0))
    for k in range(n):
        im.alpha_composite(note(STICKY[(k + seed) % 4]), (rnd.randint(0, 19), rnd.randint(0, 9)))
    return crop(im)


props["sticky_wall"] = shear_right_wall(sticky_cluster(5, 1))
props["sticky_wall2"] = shear_right_wall(sticky_cluster(3, 2))
notes["sticky_wall"] = notes["sticky_wall2"] = "drawn: sticky notes, pre-skewed for a wall"
props["sticky_floor"] = note("#f0c43a", 3)
notes["sticky_floor"] = "drawn: a dropped sticky note (flat)"

wb = Image.new("RGBA", (34, 18), rgba("#a2a1af"))
d = ImageDraw.Draw(wb)
d.rectangle([1, 1, 32, 16], fill=rgba("#eeeef6"))
d.line([(3, 12), (7, 8), (11, 10), (15, 5), (19, 7), (23, 3)], fill=rgba("#465f92"))
d.line([(3, 14), (9, 14)], fill=rgba("#b3243c"))
d.line([(3, 3), (10, 3)], fill=rgba("#89b7f2"))
d.line([(3, 5), (8, 5)], fill=rgba("#89b7f2"))
d.rectangle([33, 0, 33, 17], fill=rgba("#81818f"))
wb = outline(wb)
wb.alpha_composite(note("#f0c43a", 4), (26, 9))
wb.alpha_composite(note("#df8493", 4), (22, 11))
props["whiteboard_wall"] = shear_right_wall(wb)
notes["whiteboard_wall"] = "drawn: wall whiteboard with marker charts and sticky notes"

# TV: glass and silver frame cut from the blank wall ticker, a price chart drawn on the glass
panel = unshear_right_wall(wframe("ticker_wall"))
tv = Image.new("RGBA", (34, 21), (0, 0, 0, 0))
tv.paste(panel.crop((0, 0, 30, 18)), (0, 0))
tv.paste(panel.crop((97, 0, 101, 18)), (30, 0))
tv.paste(panel.crop((0, 29, 30, 32)), (0, 18))
tv.paste(panel.crop((97, 29, 101, 32)), (30, 18))
d = ImageDraw.Draw(tv)
pts = [(4, 14), (8, 12), (11, 13), (15, 8), (18, 10), (22, 6), (25, 9), (29, 4)]
d.line(pts, fill=rgba("#62cf44"))
d.line([(4, 16), (29, 16)], fill=rgba("#2d2f2f"))
d.line([(25, 9), (27, 12), (29, 11)], fill=rgba("#d0283a"))
tv = outline(tv)
props["tv_wall"] = shear_right_wall(tv)
legs = Image.new("RGBA", (tv.width, 6), (0, 0, 0, 0))
dl = ImageDraw.Draw(legs)
for x0 in (8, tv.width - 10):
    dl.line([(x0, 0), (x0 - 2, 5)], fill=rgba("#39383f"))
    dl.line([(x0 + 1, 0), (x0 - 1, 5)], fill=rgba("#6d6d7b"))
stand = Image.new("RGBA", (tv.width, tv.height + 5), (0, 0, 0, 0))
stand.alpha_composite(legs, (0, tv.height - 1))
stand.alpha_composite(tv, (0, 0))
props["tv_stand"] = shear_right_wall(outline(crop(stand)))
notes["tv_wall"] = "kitbash: TV cut from the blank wall ticker, chart drawn in code"
notes["tv_stand"] = "kitbash: the TV on drawn legs"

sp = Image.new("RGBA", (18, 9), (0, 0, 0, 0))
d = ImageDraw.Draw(sp)
d.ellipse([0, 1, 16, 8], fill=rgba("#53413b"))
d.ellipse([1, 2, 15, 7], fill=rgba("#5c3e2b"))
d.ellipse([4, 3, 9, 5], fill=rgba("#8e5c36"))
cup = outline(Image.new("RGBA", (4, 3), rgba("#fcfbf9")))
sp.alpha_composite(cup, (12, 0))
props["spill"] = crop(sp)
notes["spill"] = "drawn: spilled coffee and a tipped cup (flat)"


def cable(points, w, h):
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.line(points, fill=rgba("#191b20"), width=2)
    d.line([(x, y - 1) for x, y in points], fill=rgba("#494a53"))
    x, y = points[-1]
    d.rectangle([x - 1, y - 2, x + 2, y + 1], fill=rgba("#52535b"))
    return crop(im)


props["cable_run"] = cable([(1, 7), (6, 4), (10, 6), (15, 3), (20, 5), (25, 3)], 28, 10)
props["cable_loop"] = cable([(2, 6), (6, 2), (12, 3), (13, 7), (8, 9), (5, 6), (10, 4), (18, 6), (22, 4)], 26, 12)
notes["cable_run"] = notes["cable_loop"] = "drawn: floor cables (flat)"

# stacks
plant = wframe("plant")
props["box_pile"] = stack((box, 0, 0), (props["box_half"], 4, -30))
props["box_pile2"] = stack((box, -10, 0), (box, 12, 5), (props["box_s"], 2, -31))
props["filing_printer"] = stack((props["filing"], 0, 0), (props["printer"], -2, -44))
props["filing_plant"] = stack((props["filing"], 0, 0), (plant, 3, -41))
props["crate_papers"] = stack((props["box_half"], 0, 0), (props["paper_stack"], 0, -13))
for k in ("box_pile", "box_pile2", "filing_printer", "filing_plant", "crate_papers"):
    notes[k] = "kitbash: stacked props"
wall = wframe("wall")
for n in (2, 3):
    im = Image.new("RGBA", (32, 32 + 16 * (n - 1)), (0, 0, 0, 0))
    for z in range(n):
        im.alpha_composite(wall, (0, 16 * (n - 1 - z)))
    props[f"wall_x{n}"] = im
    notes[f"wall_x{n}"] = f"kitbash: {n} wall blocks stacked (one sprite per wall cell)"

# ------------------------------------------------------------------ pack
ANCHOR = {"wall_x2": (16, 16 + 16), "wall_x3": (16, 16 + 32)}
order = sorted(props, key=lambda k: -props[k].height)
W, x, y, rowh, pos = 512, 0, 0, 0, {}
for k in order:
    im = props[k]
    if x + im.width > W:
        x, y, rowh = 0, y + rowh + 2, 0
    pos[k] = (x, y)
    x += im.width + 2
    rowh = max(rowh, im.height)
atlas = Image.new("RGBA", (W, y + rowh), (0, 0, 0, 0))
frames = {}
for k, (x, y) in pos.items():
    im = props[k]
    atlas.alpha_composite(im, (x, y))
    if k.endswith("_wall"):
        ax, ay = 0, 0
    else:
        ax, ay = ANCHOR.get(k, (im.width / 2, im.height))
    frames[k] = {"frame": {"x": x, "y": y, "w": im.width, "h": im.height}, "rotated": False, "trimmed": False,
                 "spriteSourceSize": {"x": 0, "y": 0, "w": im.width, "h": im.height}, "sourceSize": {"w": im.width, "h": im.height},
                 "anchor": {"x": round(ax / im.width, 4), "y": round(ay / im.height, 4)}, "source": notes.get(k, "")}
atlas.save(os.path.join(OUT, "props2.png"), optimize=True)
json.dump({"frames": frames, "meta": {"app": "rat-race pixel-site tools/build_props2.py", "image": "props2.png", "format": "RGBA8888",
                                      "size": {"w": atlas.width, "h": atlas.height}, "scale": "1",
                                      "notes": "Props anchor at the bottom centre (stand on the cell centre). *_wall pieces anchor "
                                               "top-left and are pre-skewed for a wall running down-right; mirror for down-left."}},
          open(os.path.join(OUT, "props2.json"), "w"), indent=1)
prev = Image.new("RGBA", (atlas.width + 20, atlas.height + 20), (226, 232, 238, 255))
prev.alpha_composite(atlas, (10, 10))
prev.resize((prev.width * 2, prev.height * 2), Image.NEAREST).save(os.path.join(OUT, "preview", "props2_atlas_2x.png"))
print("props2 atlas", atlas.size, len(frames), "props")
