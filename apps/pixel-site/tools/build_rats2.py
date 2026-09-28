#!/usr/bin/env python3
"""Build assets/rats2.png + rats2.json: every rat look the site draws, from the tier sheets build_assets.py made.

  python3 tools/build_rats2.py

- Fur: grey (as generated), brown, white, black. A palette swap of the two fur greys (and the pink-grey between them);
  suits, ties, ears and tails keep their colours, so the tier still reads from far away. Frozen rats stay one grey.
- Seated at a pod desk: sit_front (facing the camera, from idle_se, on a chair seen from the front: the desk hides the
  legs) and sit_back (back to the camera, from idle_ne, the chair back in front of the rat). sulk_front / sulk_back
  are the same, slumped lower (stock is down).
- Accessories drawn on a separate overlay frame per base frame, found from the frame itself (head box, eyes): glasses,
  headphones (2 colours), hats (bowler, cap, beanie). They line up with every tier and fur because all looks share
  the same poses. Keys: acc/<name>/<frame>.
Frames are trimmed; anchors are per frame (feet, or where the chair stands).
"""
import json, os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
OUT = os.path.join(APP, "assets")
BUILD = os.path.join(OUT, "build")
CELL = 68
OUTLINE = (22, 24, 44, 255)
FUR, FUR_D, FUR_P = (0x74, 0x73, 0x83), (0x4E, 0x4B, 0x5C), (0x8F, 0x78, 0x8A)
WHITE, RED = (0xE1, 0xE1, 0xE4), (0xD0, 0x28, 0x3A)
TIERS = ["intern", "analyst", "associate", "vp", "partner", "frozen"]
FURS = {
    "grey": None,
    "brown": {FUR: (0x8C, 0x66, 0x48), FUR_D: (0x5E, 0x42, 0x30), FUR_P: (0xA0, 0x74, 0x66)},
    "white": {FUR: (0xDC, 0xD6, 0xCC), FUR_D: (0xA4, 0x9C, 0x96), FUR_P: (0xD8, 0xB8, 0xBC)},
    "black": {FUR: (0x44, 0x41, 0x4E), FUR_D: (0x2A, 0x28, 0x33), FUR_P: (0x5C, 0x48, 0x58)},
}

names = [k.split("/")[1] for k in json.load(open(os.path.join(OUT, "rats.json")))["frames"] if k.startswith("analyst/")]
N = len(names)


def cell(sheet, i):
    return sheet.crop(((i % 10) * CELL, (i // 10) * CELL, (i % 10) * CELL + CELL, (i // 10) * CELL + CELL))


sheets = {t: Image.open(os.path.join(BUILD, f"tier_{t}.png")).convert("RGBA") for t in TIERS}
base = {t: {n: cell(sheets[t], k) for k, n in enumerate(names)} for t in TIERS}
BASE_FOOT = {}
rats_json = json.load(open(os.path.join(OUT, "rats.json")))
for n in names:
    BASE_FOOT[n] = rats_json["frames"][f"analyst/{n}"]["anchor"]["y"] * CELL

# ------------------------------------------------------------------ seated at a pod desk


def rounded(im, x0, y0, x1, y1, fill, edge):
    p = im.load()
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            corner = (x in (x0, x1)) and (y in (y0, y1))
            if corner:
                continue
            border = x in (x0, x1) or y in (y0, y1)
            p[x, y] = OUTLINE if border else (edge if (x == x0 + 1 or y == y0 + 1) else fill)


CHAIR = (0x26, 0x23, 0x25, 255)
CHAIR_HI = (0x3E, 0x3A, 0x40, 255)
CUT, DROP = 46, 8


def seat_frame(src, front, sulk):
    """src: a standing 68x68 frame. Legs cut at the hips, dropped onto a chair."""
    drop = DROP + (3 if sulk else 0)
    body = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    body.alpha_composite(src.crop((0, 0, CELL, CUT)), (0, drop))
    out = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    if front:
        chair = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
        rounded(chair, 21, 30, 38, 51, CHAIR, CHAIR_HI)  # chair back, behind the rat (up-left of it)
        out.alpha_composite(chair)
        out.alpha_composite(body)
        # seat edge and a sliver of the base under the desk
        p = out.load()
        for x in range(26, 42):
            if not p[x, CUT + drop - 1][3]:
                p[x, CUT + drop - 1] = OUTLINE
    else:
        out.alpha_composite(body)
        chair = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
        rounded(chair, 23, 45, 35, 55, CHAIR, CHAIR_HI)  # chair back between the camera and the rat
        cp = chair.load()
        for y in range(56, 59):
            cp[29, y] = OUTLINE
        for x in range(24, 35):
            cp[x, 59] = OUTLINE if x in (24, 34) or x % 3 == 0 else CHAIR
        out.alpha_composite(chair)
    return out


SEATED = {}
for t in TIERS:
    for k in range(4):
        se, ne = base[t][f"idle_se_{k}"], base[t][f"idle_ne_{k}"]
        SEATED.setdefault(t, {})[f"sit_front_{k}"] = seat_frame(se, True, False)
        SEATED[t][f"sit_back_{k}"] = seat_frame(ne, False, False)
        SEATED[t][f"sulk_front_{k}"] = seat_frame(se, True, True)
        SEATED[t][f"sulk_back_{k}"] = seat_frame(ne, False, True)
for t in TIERS:
    base[t].update(SEATED[t])
all_names = names + list(SEATED["analyst"].keys())
FOOT = dict(BASE_FOOT)
for n in SEATED["analyst"]:
    FOOT[n] = 60.0  # the chair stands where the feet stood

# ------------------------------------------------------------------ fur


def swap(im, table):
    if not table:
        return im
    out = im.copy()
    p = out.load()
    for y in range(out.height):
        for x in range(out.width):
            c = p[x, y]
            if c[3] and c[:3] in table:
                p[x, y] = table[c[:3]] + (c[3],)
    return out


# ------------------------------------------------------------------ accessories (found per base frame)


def head_info(im):
    """Head box (fur above the collar) and eye pixels of a frame, or None."""
    p = im.load()
    collar = next((y for y in range(CELL) if any(p[x, y][3] and p[x, y][:3] in (WHITE, RED) for x in range(CELL))), None)
    top = next((y for y in range(CELL) if any(p[x, y][3] for x in range(CELL))), None)
    if top is None:
        return None
    limit = collar if collar is not None else top + 16
    fur = [(x, y) for y in range(top, limit) for x in range(CELL) if p[x, y][3] and p[x, y][:3] in (FUR, FUR_D, FUR_P)]
    if len(fur) < 20:
        return None
    xs = [x for x, _ in fur]
    ys = [y for _, y in fur]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    eyes = []
    for y in range(y0 + 2, y1):
        for x in range(x0 + 1, x1):
            c = p[x, y]
            if c[3] and c[:3] in ((0x16, 0x18, 0x2C), (0x17, 0x16, 0x18)):
                around = [p[x + dx, y + dy] for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))]
                if sum(1 for q in around if q[3] and q[:3] in (FUR, FUR_D, FUR_P, (0xDF, 0x84, 0x93), (0xCC, 0x58, 0x73))) >= 3:
                    eyes.append((x, y))
    # the head proper: the fur rows below the ears (ears are the top ~40% of the fur box)
    return {"x0": x0, "x1": x1, "y0": y0, "y1": y1, "top": top, "eyes": eyes, "cx": (x0 + x1) // 2}


def acc_frame(kind, info, front_back):
    im = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    if info is None:
        return im
    p = im.load()

    def put(x, y, c):
        if 0 <= x < CELL and 0 <= y < CELL:
            p[x, y] = c

    if kind == "tie_stripes":
        return im  # drawn from the frame itself, see tie_frame
    x0, x1, y0, y1, cx = info["x0"], info["x1"], info["y0"], info["y1"], info["cx"]
    hh = y1 - y0
    crown = y0 + max(3, hh * 2 // 5)  # between the ears
    if kind == "glasses":
        if front_back == "back":
            return im
        rim = (0xD8, 0xDE, 0xEE, 255)
        for ex, ey in info["eyes"][:2]:
            for dx in (-1, 0, 1):
                put(ex + dx, ey - 1, rim)
                put(ex + dx, ey + 1, rim)
            put(ex - 1, ey, rim)
            put(ex + 1, ey, rim)
        if len(info["eyes"]) >= 2:
            (ax, ay), (bx, by) = sorted(info["eyes"][:2])
            for x in range(ax + 2, bx - 1):
                put(x, ay, rim)
    elif kind.startswith("phones"):
        band = (0xE8, 0x3A, 0x4A, 255) if kind == "phones_red" else (0xF0, 0xF0, 0xF4, 255)
        band_d = (0xA0, 0x20, 0x30, 255) if kind == "phones_red" else (0xB0, 0xB4, 0xC0, 255)
        # band over the crown, cups low on both sides of the head
        for x in range(x0 + 3, x1 - 2):
            put(x, crown - 1, band)
        cy = crown + max(2, hh // 5)
        for sx in (x0, x1 - 1):
            for dy in range(0, 3):
                put(sx, cy + dy, band_d)
                put(sx + 1, cy + dy, band)
            put(sx, cy - 1, OUTLINE)
            put(sx + 1, cy - 1, OUTLINE)
            put(sx, cy + 3, OUTLINE)
            put(sx + 1, cy + 3, OUTLINE)
        for y in range(crown - 1, cy):
            put(x0 + 2, y, band_d)
            put(x1 - 2, y, band_d)
    elif kind.startswith("hat"):
        style = kind.split("_")[1]
        w = max(7, (x1 - x0) // 2 + 2)
        hx0 = cx - w // 2
        if style == "bowler":
            c, d = (0x2A, 0x26, 0x2C, 255), (0x44, 0x40, 0x4A, 255)
            for x in range(hx0 - 1, hx0 + w + 1):
                put(x, crown, OUTLINE)
                put(x, crown - 1, d)
            for y in range(crown - 5, crown - 1):
                for x in range(hx0 + 1, hx0 + w - 1):
                    put(x, y, c if y > crown - 5 else OUTLINE)
                put(hx0, y, OUTLINE)
                put(hx0 + w - 1, y, OUTLINE)
            put(hx0 + 2, crown - 4, d)
        elif style == "cap":
            c, d = (0x2F, 0x6E, 0xE0, 255), (0x1F, 0x48, 0x98, 255)
            for y in range(crown - 4, crown + 1):
                for x in range(hx0, hx0 + w):
                    edge = y == crown - 4 or x in (hx0, hx0 + w - 1)
                    put(x, y, OUTLINE if edge else (c if y < crown else d))
            # the brim towards where the rat looks
            eyes = info["eyes"]
            right = (sum(x for x, _ in eyes) / len(eyes) > cx) if eyes else True
            if front_back != "back":
                bx = hx0 + w if right else hx0 - 4
                for x in range(bx, bx + 4):
                    put(x, crown, d)
                    put(x, crown + 1, OUTLINE)
        elif style == "hard":
            c, d = (0xF2, 0xC2, 0x1E, 255), (0xC8, 0x92, 0x10, 255)
            for y in range(crown - 4, crown + 1):
                for x in range(hx0 - 1, hx0 + w + 1):
                    edge = y == crown - 4 or x in (hx0 - 1, hx0 + w)
                    put(x, y, OUTLINE if edge else (c if y < crown else d))
            put(cx - 1, crown - 3, (0xFF, 0xEE, 0x9A, 255))
        else:  # beanie
            c, d = (0xE0, 0x9A, 0x2A, 255), (0xB0, 0x6C, 0x18, 255)
            for y in range(crown - 5, crown + 1):
                for x in range(hx0, hx0 + w):
                    edge = x in (hx0, hx0 + w - 1) or y == crown - 5
                    put(x, y, OUTLINE if edge else (d if y >= crown - 1 else c))
            put(cx, crown - 6, (0xF4, 0xF0, 0xE8, 255))
            put(cx, crown - 7, OUTLINE)
    return im


def tie_frame(src):
    """White stripes across the tie (every other row of tie pixels): reads on red and gold ties alike."""
    im = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    p = im.load()
    s = src.load()
    rows = sorted({y for y in range(CELL) for x in range(CELL) if s[x, y][3] and s[x, y][:3] == RED})
    for n, y in enumerate(rows):
        if n % 2:
            continue
        for x in range(CELL):
            if s[x, y][3] and s[x, y][:3] == RED:
                p[x, y] = (0xF4, 0xF2, 0xEA, 255)
    return im


ACCS = ["glasses", "phones_red", "phones_white", "hat_bowler", "hat_cap", "hat_beanie", "tie_stripes", "hat_hard"]
ref = base["analyst"]
accs = {}
for n in all_names:
    info = head_info(ref[n])
    fb = "back" if ("_ne" in n or n.startswith(("sit_back", "sulk_back")) or n in ("rot_n", "rot_ne", "rot_nw")) else "front"
    for a in ACCS:
        accs[f"acc/{a}/{n}"] = tie_frame(ref[n]) if a == "tie_stripes" else acc_frame(a, info, fb)

# ------------------------------------------------------------------ pack


def trim(im, foot):
    bb = im.getbbox()
    if not bb:
        return Image.new("RGBA", (1, 1), (0, 0, 0, 0)), 0.5, 1.0
    x0, y0, x1, y1 = bb
    c = im.crop(bb)
    return c, (CELL / 2 - x0) / c.width, (foot - y0) / c.height


entries = []  # (key, image, ax, ay)
anims = {}


def anim_of(n):
    for p in ("idle_se", "idle_ne", "walk_se", "walk_ne", "sit_front", "sit_back", "sulk_front", "sulk_back"):
        if n.startswith(p + "_"):
            return p
    return n.rsplit("_", 1)[0]


for t in TIERS:
    for fur, table in FURS.items():
        if t == "frozen" and fur != "grey":
            continue
        look = t if fur == "grey" else f"{t}.{fur}"
        for n in all_names:
            im, ax, ay = trim(swap(base[t][n], table), FOOT[n])
            key = f"{look}/{n}"
            entries.append((key, im, ax, ay))
            a = anim_of(n)
            if a != "rot":
                anims.setdefault(f"{look}/{a}", []).append(key)
for key, im in accs.items():
    n = key.split("/", 2)[2]
    c, ax, ay = trim(im, FOOT[n])
    entries.append((key, c, ax, ay))

W = 2048
x = y = row = 0
pos = {}
for key, im, _, _ in sorted(entries, key=lambda e: -e[1].height):
    if x + im.width > W:
        x, y, row = 0, y + row + 1, 0
    pos[key] = (x, y)
    x += im.width + 1
    row = max(row, im.height)
H = y + row + 1
sheet = Image.new("RGBA", (W, H), (0, 0, 0, 0))
frames = {}
for key, im, ax, ay in entries:
    px, py = pos[key]
    sheet.alpha_composite(im, (px, py))
    frames[key] = {"frame": {"x": px, "y": py, "w": im.width, "h": im.height}, "anchor": {"x": round(ax, 4), "y": round(ay, 4)}}
sheet.save(os.path.join(OUT, "rats2.png"), optimize=True)
json.dump({"frames": frames, "animations": anims,
           "meta": {"app": "rat-race pixel-site tools/build_rats2.py", "image": "rats2.png", "size": {"w": W, "h": H},
                    "looks": "<tier> (grey fur) or <tier>.<fur> with fur in brown, white, black; frozen is grey only",
                    "accessories": ACCS}},
          open(os.path.join(OUT, "rats2.json"), "w"), indent=0, separators=(",", ":"))
print(f"rats2.png {W}x{H}, {len(frames)} frames, {len(anims)} animations")

# preview: every fur x a few tiers, seated front/back and accessories
PREV = os.path.join(OUT, "preview")
show = ["idle_se_0", "sit_front_0", "sit_back_0", "walk_se_2", "idle_ne_0"]
cols = []
for fur in FURS:
    for t in ("intern", "analyst", "vp", "partner"):
        cols.append((t, fur))
S = 3
img = Image.new("RGBA", (len(cols) * 40 * S, (len(show) + len(ACCS)) * 56 * S), (27, 31, 51, 255))
for ci, (t, fur) in enumerate(cols):
    look = t if fur == "grey" else f"{t}.{fur}"
    for ri, n in enumerate(show + ["idle_se_0"] * len(ACCS)):
        f = frames[f"{look}/{n}"]
        r = f["frame"]
        im = sheet.crop((r["x"], r["y"], r["x"] + r["w"], r["y"] + r["h"]))
        ox = int(20 - f["anchor"]["x"] * r["w"])
        oy = int(50 - f["anchor"]["y"] * r["h"])
        tile = Image.new("RGBA", (40, 56), (0, 0, 0, 0))
        tile.alpha_composite(im, (max(0, ox), max(0, oy)))
        if ri >= len(show):
            a = frames[f"acc/{ACCS[ri - len(show)]}/{n}"]
            ra = a["frame"]
            ai = sheet.crop((ra["x"], ra["y"], ra["x"] + ra["w"], ra["y"] + ra["h"]))
            tile.alpha_composite(ai, (max(0, int(20 - a["anchor"]["x"] * ra["w"])), max(0, int(50 - a["anchor"]["y"] * ra["h"]))))
        img.alpha_composite(tile.resize((40 * S, 56 * S), Image.NEAREST), (ci * 40 * S, ri * 56 * S))
img.save(os.path.join(PREV, "rats2_looks.png"))
