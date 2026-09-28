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


# ------------------------------------------------------------------ typing at a pod desk (round 5)
# sit_front: PixelLab frames (raw/props6: the seated pose edited with edit_image_pixen, then animate_image "typing"),
# snapped to the analyst palette and recoloured per tier with colour maps learned from the tier sheets themselves
# (tiers are pure recolours, split at the collar). sit_back: the seated back view with the forearms brought forward
# out of sight and the elbows and head moving in turn, drawn here.
RAW6 = os.path.join(OUT, "raw", "props6")
TYPE_FRONT = [os.path.join(RAW6, f"type_front_27a8a5_{k}.png") for k in range(7)]


def collar_row(im):
    p = im.load()
    return next((y for y in range(CELL) if any(p[x, y][3] and p[x, y][:3] in (WHITE, RED) for x in range(CELL))), CELL)


def learn_maps():
    """(tier, above collar?, analyst colour) -> tier colour, by majority over every base frame."""
    votes = {}
    for n in names:
        a = base["analyst"][n]
        ap = a.load()
        cr = collar_row(a)
        for t in TIERS:
            tp = base[t][n].load()
            for y in range(CELL):
                for x in range(CELL):
                    c = ap[x, y]
                    if not c[3] or not tp[x, y][3]:
                        continue
                    key = (t, y < cr, c[:3])
                    d = votes.setdefault(key, {})
                    d[tp[x, y][:3]] = d.get(tp[x, y][:3], 0) + 1
    return {k: max(v.items(), key=lambda kv: kv[1])[0] for k, v in votes.items()}


TIER_MAP = learn_maps()
PAL = sorted({c[:3] for n in names for c in base["analyst"][n].getdata() if c[3]})


def snap(im):
    out = im.copy()
    p = out.load()
    for y in range(CELL):
        for x in range(CELL):
            c = p[x, y]
            if not c[3]:
                continue
            if c[3] < 128:
                p[x, y] = (0, 0, 0, 0)
                continue
            if c[:3] not in PAL:
                q = min(PAL, key=lambda q: (q[0] - c[0]) ** 2 * .3 + (q[1] - c[1]) ** 2 * .59 + (q[2] - c[2]) ** 2 * .11)
                p[x, y] = q + (255,)
            else:
                p[x, y] = c[:3] + (255,)
    return out


def recolor(im, t):
    if t == "analyst":
        return im
    out = im.copy()
    p = out.load()
    cr = collar_row(im)
    for y in range(CELL):
        for x in range(CELL):
            c = p[x, y]
            if c[3]:
                q = TIER_MAP.get((t, y < cr, c[:3])) or TIER_MAP.get((t, not (y < cr), c[:3]))
                if q:
                    p[x, y] = q + (255,)
    return out


FRONT_TYPE = [snap(Image.open(f).convert("RGBA")) for f in TYPE_FRONT]
KNEEL = snap(Image.open(os.path.join(RAW6, "kneel_4cbe29_0.png")).convert("RGBA"))


def bow(src):
    """The same kneeling rat bowing: everything above its waist two pixels lower."""
    bb = src.getbbox()
    if not bb:
        return src.copy()
    waist = bb[1] + (bb[3] - bb[1]) * 3 // 5
    top = src.crop((0, 0, CELL, waist))
    out = src.copy()
    out.paste(Image.new("RGBA", (CELL, waist), (0, 0, 0, 0)), (0, 0))
    out.alpha_composite(top, (0, 2))
    return out


def type_back(src, k):
    """The seated back view typing: the hanging forearm and paw go (the paws are on the keyboard, in front of the
    body), the elbow bends forward (up and right on screen), and one side then the other lifts a pixel."""
    im = src.copy()
    p = im.load()
    s = src.load()
    bb = src.getbbox()
    if not bb:
        return im
    # the arm hanging down the right side of the body, below the chair back's top edge
    chair_top = next((y for y in range(CELL) if s[(bb[0] + bb[2]) // 2, y][3] and s[(bb[0] + bb[2]) // 2, y][:3] in ((0x3E, 0x3A, 0x40), (0x26, 0x23, 0x25))), None)
    right = bb[2] - 1
    arm_x0 = right - 5
    ys = [y for y in range(CELL) if any(s[x, y][3] for x in range(arm_x0, right + 1))]
    if not ys or chair_top is None:
        return im
    elbow = chair_top + 2
    sleeve = s[right - 2, elbow - 1]
    sleeve_d = s[right - 3, elbow - 1]
    # cut the forearm below the elbow
    for y in range(elbow + 1, CELL):
        for x in range(arm_x0 + 1, right + 1):
            if x > bb[0] + (bb[2] - bb[0]) * 0.72 and p[x, y][3] and p[x, y][:3] not in ((0x3E, 0x3A, 0x40), (0x26, 0x23, 0x25)):
                p[x, y] = (0, 0, 0, 0)
    for x in range(arm_x0 + 1, right + 1):
        if p[x, elbow][3]:
            p[x, elbow + 1] = OUTLINE
    # the forearm, forward and up to the right, paw hidden beyond it
    lift = 1 if k in (1, 2) else 0
    for i in range(4):
        x = right - 1 + i
        y = elbow - 1 - i // 2 - lift
        for dy, col in ((-1, OUTLINE), (0, sleeve), (1, sleeve_d), (2, OUTLINE)):
            if 0 <= x < CELL and 0 <= y + dy < CELL:
                p[x, y + dy] = col
    if 0 <= right + 3 < CELL:
        for dy in range(-1, 3):
            p[right + 3, elbow - 2 - lift + dy] = OUTLINE
    # the other shoulder (left) twitches on the off beat: its top edge rows move up a pixel
    if k in (3, 4):
        col = bb[0] + 5
        for x in range(bb[0] + 3, bb[0] + 8):
            top = next((y for y in range(CELL) if p[x, y][3]), None)
            if top is not None and top > 30 and 0 <= top - 1:
                p[x, top - 1] = OUTLINE
                p[x, top] = p[x, top + 1]
    # the head nods on beats 2 and 5 (everything above the collar down a pixel)
    if k in (2, 5):
        cr = collar_row(src)
        head = im.crop((0, 0, CELL, cr))
        clear = Image.new("RGBA", (CELL, cr + 1), (0, 0, 0, 0))
        im.paste(clear, (0, 0))
        im.alpha_composite(head, (0, 1))
    return im


SEATED = {}
for t in TIERS:
    for k in range(4):
        se, ne = base[t][f"idle_se_{k}"], base[t][f"idle_ne_{k}"]
        SEATED.setdefault(t, {})[f"sulk_front_{k}"] = seat_frame(se, True, True)
        SEATED[t][f"sulk_back_{k}"] = seat_frame(ne, False, True)
    for k, f in enumerate(FRONT_TYPE):
        SEATED[t][f"sit_front_{k}"] = recolor(f, t)
    back0 = seat_frame(base[t]["idle_ne_0"], False, False)
    for k in range(6):
        SEATED[t][f"sit_back_{k}"] = type_back(back0, k)
    # kneeling in worship round the espresso machine: the PixelLab pose, then a bow (upper body a pixel lower)
    SEATED[t]["kneel_0"] = recolor(KNEEL, t)
    SEATED[t]["kneel_1"] = bow(SEATED[t]["kneel_0"])
for t in TIERS:
    base[t].update(SEATED[t])
all_names = names + list(SEATED["analyst"].keys())
FOOT = dict(BASE_FOOT)
for n in SEATED["analyst"]:
    FOOT[n] = 60.0  # the chair stands where the feet stood
for n in ("kneel_0", "kneel_1"):
    FOOT[n] = float(KNEEL.getbbox()[3] - 1)  # knees on the floor

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
    """Accessories at a readable size (round 5): bold 1px outlines, about twice the old size."""
    im = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    if info is None:
        return im
    p = im.load()

    def put(x, y, c):
        if 0 <= x < CELL and 0 <= y < CELL:
            p[x, y] = c

    def box(xa, ya, xb, yb, fill, edge=OUTLINE):
        for y in range(ya, yb + 1):
            for x in range(xa, xb + 1):
                put(x, y, edge if x in (xa, xb) or y in (ya, yb) else fill)

    if kind == "tie_stripes":
        return im  # drawn from the frame itself, see tie_frame
    x0, x1, y0, y1, cx = info["x0"], info["x1"], info["y0"], info["y1"], info["cx"]
    hh = y1 - y0
    crown = y0 + max(3, hh * 2 // 5)  # between the ears
    eyes = info["eyes"]
    right = (sum(x for x, _ in eyes) / len(eyes) > cx) if eyes else True
    if kind == "glasses":
        if front_back == "back" or not eyes:
            return im
        lens, glint = (0xA8, 0xE0, 0xFF, 255), (0xFF, 0xFF, 0xFF, 255)
        pts = sorted(eyes[:2])
        for ex, ey in pts:
            box(ex - 2, ey - 2, ex + 2, ey + 2, lens)
            put(ex - 1, ey - 1, glint)
            put(ex, ey, OUTLINE)  # the eye behind the lens
        if len(pts) == 2:
            (ax, ay), (bx, by) = pts
            for x in range(ax + 3, bx - 2):
                put(x, ay - 1, OUTLINE)
        # the arm back to the ear
        ex, ey = pts[0] if right else pts[-1]
        step = -1 if right else 1
        start = ex - 3 if right else ex + 3
        for i in range(4):
            put(start + step * i, ey - 1 - (i // 2), OUTLINE)
    elif kind.startswith("phones"):
        band = (0xE8, 0x3A, 0x4A, 255) if kind == "phones_red" else (0xF0, 0xF0, 0xF4, 255)
        band_d = (0xA0, 0x20, 0x30, 255) if kind == "phones_red" else (0xA8, 0xAC, 0xBC, 255)
        top = crown - 3
        # a 2px band over the crown, dropping to the cups
        for x in range(x0 + 2, x1 - 1):
            put(x, top - 1, OUTLINE)
            put(x, top, band)
            put(x, top + 1, band_d)
        cy = crown + max(2, hh // 5)
        for y in range(top, cy):
            put(x0 + 1, y, band_d)
            put(x0 + 2, y, band)
            put(x1 - 2, y, band)
            put(x1 - 1, y, band_d)
        # big cups: the far one on the back of the head, the near one on the cheek
        far_x = x0 - 1 if right else x1 - 3
        near_x = x1 - 3 if right else x0 - 1
        box(far_x, cy - 1, far_x + 4, cy + 5, band)
        for y in range(cy, cy + 5):
            put(far_x + 1, y, band_d)
        box(near_x, cy, near_x + 3, cy + 4, band_d)
    elif kind.startswith("hat"):
        style = kind.split("_")[1]
        w = max(10, (x1 - x0) * 2 // 3 + 1)
        hx0 = cx - w // 2
        hx1 = hx0 + w - 1
        if style == "bowler":
            c, d, bandc = (0x2A, 0x26, 0x2C, 255), (0x48, 0x44, 0x50, 255), (0x8A, 0x1E, 0x2C, 255)
            # the dome, the red band, the wide brim
            box(hx0 + 1, crown - 7, hx1 - 1, crown - 1, c)
            for x in range(hx0 + 2, hx1 - 1):
                put(x, crown - 2, bandc)
            put(hx0 + 3, crown - 6, d)
            put(hx0 + 4, crown - 6, d)
            box(hx0 - 2, crown - 1, hx1 + 2, crown + 1, d)
        elif style == "cap":
            c, d = (0x2F, 0x6E, 0xE0, 255), (0x1F, 0x48, 0x98, 255)
            box(hx0, crown - 6, hx1, crown, c)
            for x in range(hx0 + 1, hx1):
                put(x, crown - 1, d)
            put(cx, crown - 7, OUTLINE)
            put(cx, crown - 6, (0xF4, 0xF0, 0xE8, 255))
            if front_back != "back":
                bx0, bx1 = (hx1, hx1 + 5) if right else (hx0 - 5, hx0)
                box(bx0, crown - 1, bx1, crown + 1, d)
        elif style == "hard":
            c, d = (0xF2, 0xC2, 0x1E, 255), (0xC8, 0x92, 0x10, 255)
            box(hx0, crown - 6, hx1, crown, c)
            for y in range(crown - 5, crown):
                put(cx, y, d)
            put(hx0 + 2, crown - 5, (0xFF, 0xEE, 0x9A, 255))
            box(hx0 - 2, crown - 1, hx1 + 2, crown + 1, d)
        else:  # beanie
            c, d = (0xE0, 0x9A, 0x2A, 255), (0xB0, 0x6C, 0x18, 255)
            box(hx0, crown - 7, hx1, crown, c)
            for x in range(hx0 + 1, hx1):
                put(x, crown - 1, d)
                put(x, crown - 2, d)
                if x % 2 == 0:
                    put(x, crown - 4, d)
            box(cx - 1, crown - 10, cx + 1, crown - 8, (0xF4, 0xF0, 0xE8, 255))
    return im


PINKS = {(0xDF, 0x84, 0x93), (0xCC, 0x58, 0x73), (0xE8, 0x7A, 0x91), (0xEE, 0x94, 0xA1), (0x9D, 0x5E, 0x72)}


def briefcase_frame(src, n, k):
    """A leather briefcase in the paw nearest the camera, for walking rats: found from the frame (the lowest pink
    paw on the facing side), swinging with the walk."""
    im = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    p = im.load()
    s = src.load()
    bb = src.getbbox()
    if not bb:
        return im
    cx = (bb[0] + bb[2]) // 2
    cr = collar_row(src)
    se = "_se_" in n
    cand = [(x, y) for y in range(cr + 5, min(CELL, cr + 24)) for x in range(CELL)
            if s[x, y][3] and s[x, y][:3] in PINKS and (x >= cx - 3 if se else x >= cx - 6)]
    if cand:
        hx, hy = max(cand, key=lambda q: (q[1], q[0]))
    else:
        hx, hy = cx + 3, cr + 14
    leather, dark, clasp = (0x8A, 0x55, 0x2E, 255), (0x5A, 0x34, 0x1C, 255), (0xF2, 0xC2, 0x1E, 255)

    def put(x, y, c):
        if 0 <= x < CELL and 0 <= y < CELL:
            p[x, y] = c

    # handle in the paw, the case hanging below it
    for x in range(hx - 1, hx + 2):
        put(x, hy + 1, OUTLINE)
    put(hx - 2, hy + 2, OUTLINE)
    put(hx + 2, hy + 2, OUTLINE)
    x0c, y0c = hx - 4, hy + 2
    for y in range(y0c, y0c + 7):
        for x in range(x0c, x0c + 9):
            edge = x in (x0c, x0c + 8) or y in (y0c, y0c + 6)
            put(x, y, OUTLINE if edge else (dark if y == y0c + 1 or x == x0c + 1 else leather))
    put(hx, y0c + 2, clasp)
    put(hx + 1, y0c + 2, clasp)
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
    if n.startswith(("walk_se_", "walk_ne_")):
        accs[f"acc/briefcase/{n}"] = briefcase_frame(ref[n], n, int(n.rsplit("_", 1)[1]))

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
