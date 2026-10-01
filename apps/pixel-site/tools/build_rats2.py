#!/usr/bin/env python3
"""Build assets/rats2.png + rats2.json: every look the site draws (Wall Street Inu Shibas; keys keep the rat names).

  python3 tools/build_shiba.py && python3 tools/build_rats2.py

- Works from assets/build/shiba_base.png (the 55 base frames in the base palette, made by build_shiba.py). Every
  look is an exact recolour of the same frames: the tier recolours suit and tie (shiba_common.look_frame), the fur
  coat recolours the fur (shiba_common.coat_swap). Coat keys keep the rat names the site picks from the avatar
  seed: grey = golden tan (as generated), brown = red, black = black and tan, white = cream. Frozen is grey only.
- Seated at a pod desk: sit_front (facing the camera: PixelLab edit_image_pixen of the seated pose, then a 7 frame
  animate_image typing loop, raw/shiba/type_front), sit_back (back to the camera, from idle_ne, the chair back in
  front, forearms forward with elbows and head moving, drawn here). sulk_front / sulk_back: the idle frames cut at
  the hips and set lower on a chair (stock is down). kneel: PixelLab pose (raw/shiba/kneel) and a bow.
- Accessories drawn on a separate overlay frame per base frame from head keypoints (ear base, head span, eyes):
  found on one reference frame per pose group, then followed through the group by template matching, so hats sit
  between the ears and glasses on the eyes in every frame. Keys: acc/<name>/<frame>.
Frames are trimmed; anchors are per frame (feet, or where the chair stands).
"""
import json, os, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
OUT = os.path.join(APP, "assets")
BUILD = os.path.join(OUT, "build")
RAW = os.path.join(OUT, "raw", "shiba")
sys.path.insert(0, HERE)
from shiba_common import (CELL, CHAIR_PAL, OUTLINE as OUTLINE3, SEAM, SHIRT, TIE, TIER_NAMES, coat_swap, collar_row,  # noqa: E402
                          fur_role, look_frame, snap)

OUTLINE = OUTLINE3 + (255,)
TIERS = TIER_NAMES
FURS = ["grey", "brown", "white", "black"]

names = [k.split("/")[1] for k in json.load(open(os.path.join(OUT, "rats.json")))["frames"] if k.startswith("analyst/")]
N = len(names)
rats_json = json.load(open(os.path.join(OUT, "rats.json")))
BASE_FOOT = {n: rats_json["frames"][f"analyst/{n}"]["anchor"]["y"] * CELL for n in names}
sheet = Image.open(os.path.join(BUILD, "shiba_base.png")).convert("RGBA")
base = {n: sheet.crop(((k % 10) * CELL, (k // 10) * CELL, (k % 10) * CELL + CELL, (k // 10) * CELL + CELL)) for k, n in enumerate(names)}

# ------------------------------------------------------------------ seated at a pod desk


def rounded(im, x0, y0, x1, y1, fill, edge):
    p = im.load()
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if (x in (x0, x1)) and (y in (y0, y1)):
                continue
            border = x in (x0, x1) or y in (y0, y1)
            p[x, y] = OUTLINE if border else (edge if (x == x0 + 1 or y == y0 + 1) else fill)


CHAIR = (0x26, 0x23, 0x25, 255)
CHAIR_HI = (0x3E, 0x3A, 0x40, 255)
CUT, DROP, SULK = 46, 8, 3


def seat_frame(src, front, sulk):
    """src: a standing 68x68 frame. Legs cut at the hips, dropped onto a chair."""
    drop = DROP + (SULK if sulk else 0)
    body = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    body.alpha_composite(src.crop((0, 0, CELL, CUT)), (0, drop))
    out = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    if front:
        chair = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
        rounded(chair, 21, 30, 38, 51, CHAIR, CHAIR_HI)  # chair back, behind the Shiba (up-left of it)
        out.alpha_composite(chair)
        out.alpha_composite(body)
        p = out.load()
        for x in range(26, 42):
            if not p[x, CUT + drop - 1][3]:
                p[x, CUT + drop - 1] = OUTLINE
    else:
        out.alpha_composite(body)
        chair = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
        rounded(chair, 23, 45, 35, 55, CHAIR, CHAIR_HI)  # chair back between the camera and the Shiba
        cp = chair.load()
        for y in range(56, 59):
            cp[29, y] = OUTLINE
        for x in range(24, 35):
            cp[x, 59] = OUTLINE if x in (24, 34) or x % 3 == 0 else CHAIR
        out.alpha_composite(chair)
    return out


CHAIR_COLS = {CHAIR[:3], CHAIR_HI[:3]}


def type_back(src, k):
    """The seated back view typing: the hanging forearm goes (the paws are on the keyboard, in front of the body), the
    elbow bends forward (up and right on screen), one side then the other lifts a pixel, the head nods."""
    im = src.copy()
    p = im.load()
    s = src.load()
    bb = src.getbbox()
    if not bb:
        return im
    mid = (bb[0] + bb[2]) // 2
    chair_top = next((y for y in range(CELL) if s[mid, y][3] and s[mid, y][:3] in CHAIR_COLS), None)
    right = bb[2] - 1
    arm_x0 = right - 5
    if chair_top is None:
        return im
    elbow = chair_top + 2
    sleeve = s[right - 2, elbow - 1]
    sleeve_d = s[right - 3, elbow - 1]
    if not sleeve[3]:
        sleeve = (0x4E, 0x56, 0x68, 255)
    if not sleeve_d[3]:
        sleeve_d = (0x2E, 0x31, 0x42, 255)
    for y in range(elbow + 1, CELL):
        for x in range(arm_x0 + 1, right + 1):
            if x > bb[0] + (bb[2] - bb[0]) * 0.72 and p[x, y][3] and p[x, y][:3] not in CHAIR_COLS:
                p[x, y] = (0, 0, 0, 0)
    for x in range(arm_x0 + 1, right + 1):
        if p[x, elbow][3]:
            p[x, elbow + 1] = OUTLINE
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
    if k in (3, 4):
        for x in range(bb[0] + 3, bb[0] + 8):
            top = next((y for y in range(CELL) if p[x, y][3]), None)
            if top is not None and top > 30:
                p[x, top - 1] = OUTLINE
                p[x, top] = p[x, top + 1]
    if k in (2, 5):  # the head nods (everything above the collar down a pixel)
        cr = collar_row(src)
        head = im.crop((0, 0, CELL, cr))
        im.paste(Image.new("RGBA", (CELL, cr + 1), (0, 0, 0, 0)), (0, 0))
        im.alpha_composite(head, (0, 1))
    return im


def bow(src):
    """The same kneeling Shiba bowing: everything above its waist two pixels lower."""
    bb = src.getbbox()
    if not bb:
        return src.copy()
    waist = bb[1] + (bb[3] - bb[1]) * 3 // 5
    top = src.crop((0, 0, CELL, waist))
    out = src.copy()
    out.paste(Image.new("RGBA", (CELL, waist), (0, 0, 0, 0)), (0, 0))
    out.alpha_composite(top, (0, 2))
    return out


FRONT_TYPE = [snap(Image.open(os.path.join(RAW, "type_front", f"{k}.png"))) for k in range(7)]
KNEEL = snap(Image.open(os.path.join(RAW, "kneel", "0.png")))

SEATED = {}
for k in range(4):
    SEATED[f"sulk_front_{k}"] = seat_frame(base[f"idle_se_{k}"], True, True)
    SEATED[f"sulk_back_{k}"] = seat_frame(base[f"idle_ne_{k}"], False, True)
for k, f in enumerate(FRONT_TYPE):
    SEATED[f"sit_front_{k}"] = f
back0 = seat_frame(base["idle_ne_0"], False, False)
for k in range(6):
    SEATED[f"sit_back_{k}"] = type_back(back0, k)
SEATED["kneel_0"] = KNEEL
SEATED["kneel_1"] = bow(KNEEL)
base.update(SEATED)
all_names = names + list(SEATED.keys())
FOOT = dict(BASE_FOOT)
for n in SEATED:
    FOOT[n] = 60.0  # the chair stands where the feet stood
for n in ("kneel_0", "kneel_1"):
    FOOT[n] = float(KNEEL.getbbox()[3] - 1)  # knees on the floor

# ------------------------------------------------------------------ head keypoints


def is_head(c):
    return c[3] and c[:3] != OUTLINE3 and c[:3] not in CHAIR_PAL and c[:3] not in (SHIRT, TIE)


def head_keys(im):
    """Ear tips, ear base (crown: where a hat brim sits), head span and eyes of a clean standing frame."""
    p = im.load()
    cr = collar_row(im)
    rows = {}
    for y in range(cr):
        xs = [x for x in range(CELL) if is_head(p[x, y])]
        if xs:
            rows[y] = xs
    if not rows:
        return None
    y0 = min(rows)
    maxw = max(len(v) for v in rows.values())
    crown = next(y for y in sorted(rows) if len(rows[y]) >= 0.7 * maxw)
    span = [x for y in range(crown, min(cr, crown + 4)) for x in rows.get(y, [])]
    hx0, hx1 = min(span), max(span)
    cands = set()
    for y in range(crown + 2, cr - 1):
        for x in range(1, CELL - 1):
            if p[x, y][3] and p[x, y][:3] not in CHAIR_PAL and sum(p[x, y][:3]) < 200:  # dark: eye or nose
                if sum(1 for dx in (-1, 0, 1) for dy in (-1, 0, 1) if (dx or dy) and is_head(p[x + dx, y + dy])) >= 5:
                    cands.add((x, y))
    clusters = []
    while cands:
        st = [cands.pop()]
        cl = []
        while st:
            q = st.pop()
            cl.append(q)
            for d in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
                r = (q[0] + d[0], q[1] + d[1])
                if r in cands:
                    cands.remove(r)
                    st.append(r)
        clusters.append(cl)
    cent = [(sum(x for x, _ in c) / len(c), sum(y for _, y in c) / len(c)) for c in clusters]
    return {"y0": y0, "crown": crown, "x0": hx0, "x1": hx1, "cx": (hx0 + hx1) / 2, "cr": cr, "eyes": cent}


def head_mask(im, keys):
    p = im.load()
    return [(x, y, p[x, y][:3]) for y in range(keys["y0"], keys["cr"]) for x in range(CELL) if is_head(p[x, y])]


def match(mask, im, rx, ry):
    """Offset (dx, dy) of the reference head in im, by least colour difference."""
    p = im.load()
    best, bo = None, (0, 0)
    for dy in range(-ry, ry + 1):
        for dx in range(-rx, rx + 1):
            cost = 0
            for x, y, c in mask:
                X, Y = x + dx, y + dy
                if not (0 <= X < CELL and 0 <= Y < CELL):
                    cost += 600
                    continue
                q = p[X, Y]
                cost += 600 if not q[3] else abs(q[0] - c[0]) + abs(q[1] - c[1]) + abs(q[2] - c[2])
                if best is not None and cost >= best:
                    break
            if best is None or cost < best:
                best, bo = cost, (dx, dy)
    return bo


def shifted(keys, dx, dy):
    k = dict(keys)
    for a in ("y0", "crown", "cr"):
        k[a] = keys[a] + dy
    for a in ("x0", "x1", "cx"):
        k[a] = keys[a] + dx
    k["eyes"] = [(x + dx, y + dy) for x, y in keys["eyes"]]
    return k


KEYS = {}
GROUPS = [("idle_se_0", ("idle_se_", "walk_se_"), 4, 6), ("idle_ne_0", ("idle_ne_", "walk_ne_"), 4, 6),
          ("cheer_0", ("cheer_",), 9, 14), ("type_0", ("type_", "slump_"), 6, 10), ("sit_front_0", ("sit_front_",), 4, 6),
          ("kneel_0", ("kneel_",), 2, 4)]
# The eyes of each reference pose, read off the frames by hand (the 2/3 downscale leaves the face too small for a
# reliable automatic find: nose, mouth and brows are the same dark). Followed through each group by the matching.
EYES = {"idle_se_0": [(36, 25)], "cheer_0": [(35, 24)], "type_0": [(28, 23)], "sit_front_0": [(36, 33)],
        "rot_s": [(31, 23), (36, 23)], "rot_se": [(35, 24)], "rot_e": [(37, 23)], "rot_sw": [(30, 24)], "rot_w": [(26, 23)]}
for ref, prefixes, rx, ry in GROUPS:
    rk = head_keys(base[ref])
    rk["eyes"] = EYES.get(ref, [])
    mask = head_mask(base[ref], rk)
    for n in all_names:
        if n.startswith(prefixes):
            KEYS[n] = shifted(rk, *match(mask, base[n], rx, ry))
for n in all_names:
    if n.startswith("rot_"):
        KEYS[n] = head_keys(base[n])
        KEYS[n]["eyes"] = EYES.get(n, [])
for k in range(4):
    KEYS[f"sulk_front_{k}"] = shifted(KEYS[f"idle_se_{k}"], 0, DROP + SULK)
    KEYS[f"sulk_back_{k}"] = shifted(KEYS[f"idle_ne_{k}"], 0, DROP + SULK)
for k in range(6):
    KEYS[f"sit_back_{k}"] = shifted(KEYS["idle_ne_0"], 0, DROP + (1 if k in (2, 5) else 0))
missing = [n for n in all_names if n not in KEYS]
assert not missing, missing
json.dump(KEYS, open(os.path.join(BUILD, "shiba_head_keys.json"), "w"), indent=0)

# ------------------------------------------------------------------ accessories


def facing(n):
    if n in ("rot_n", "rot_ne", "rot_nw") or "_ne" in n or n.startswith(("sit_back", "sulk_back")):
        return "back"
    if n == "rot_s":
        return "front"
    if n in ("rot_sw", "rot_w"):
        return "left"
    return "right"


def acc_frame(kind, keys, face):
    im = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    if keys is None:
        return im
    p = im.load()

    def put(x, y, c):
        x, y = int(round(x)), int(round(y))
        if 0 <= x < CELL and 0 <= y < CELL:
            p[x, y] = c

    def box(xa, ya, xb, yb, fill, edge=OUTLINE):
        xa, ya, xb, yb = (int(round(v)) for v in (xa, ya, xb, yb))
        for y in range(ya, yb + 1):
            for x in range(xa, xb + 1):
                put(x, y, edge if x in (xa, xb) or y in (ya, yb) else fill)

    x0, x1, crown, cx = keys["x0"], keys["x1"], keys["crown"], int(round(keys["cx"]))
    hw = x1 - x0
    right = face != "left"
    eyes = sorted(keys["eyes"])
    if kind == "glasses":
        if face == "back" or not eyes:
            return im
        if not eyes:
            return im
        lens, glint = (0xA8, 0xE0, 0xFF, 255), (0xFF, 0xFF, 0xFF, 255)
        pts = [(int(round(x)), int(round(y))) for x, y in eyes[:2]]
        for ex, ey in pts:
            box(ex - 2, ey - 2, ex + 1, ey + 1, lens)
            put(ex - 1, ey - 1, glint)
            put(ex, ey, OUTLINE)
        if len(pts) == 2:
            (ax, ay), (bx, by) = pts
            for x in range(ax + 2, bx - 1):
                put(x, ay - 1, OUTLINE)
        ex, ey = pts[0] if right else pts[-1]
        step = -1 if right else 1
        start = ex - 3 if right else ex + 2
        for i in range(3):
            put(start + step * i, ey - 1 - (i // 2), OUTLINE)
    elif kind.startswith("phones"):
        band = (0xE8, 0x3A, 0x4A, 255) if kind == "phones_red" else (0xF0, 0xF0, 0xF4, 255)
        band_d = (0xA0, 0x20, 0x30, 255) if kind == "phones_red" else (0xA8, 0xAC, 0xBC, 255)
        # an arched band over the head between the ears (the ears stand up through it), down to the cups
        top = crown - 1
        for x in range(x0 + 2, x1 - 1):
            put(x, top - 1, OUTLINE)
            put(x, top, band)
            put(x, top + 1, band_d)
        cy = crown + max(4, (keys["cr"] - crown) // 2)
        for sx, dx in ((x0, 1), (x1, -1)):
            put(sx + dx, top, OUTLINE)
            put(sx + dx, top + 1, band)
            for y in range(top + 2, cy):
                put(sx - dx, y, OUTLINE)
                put(sx, y, band)
        if face in ("front", "back"):
            box(x0 - 2, cy - 1, x0 + 1, cy + 4, band)
            box(x1 - 1, cy - 1, x1 + 2, cy + 4, band)
            for y in range(cy, cy + 4):
                put(x0 - 1, y, band_d)
                put(x1 + 1, y, band_d)
        else:  # the cup over the ear on the back half of the head
            back_x = x0 + 1 if right else x1 - 1
            box(back_x - 2, cy - 1, back_x + 2, cy + 4, band)
            for y in range(cy, cy + 4):
                put(back_x - 1, y, band_d)
    elif kind.startswith("hat"):
        style = kind.split("_")[1]
        w = max(10, int(hw * 0.85) + 1)   # wide enough to sit down over the ear bases
        hx0 = cx - w // 2
        hx1 = hx0 + w - 1

        def dome(xa, ya, xb, yb, fill):
            box(xa, ya, xb, yb, fill)
            for cxp in (xa, xb):  # rounded top corners
                put(cxp, ya, (0, 0, 0, 0))
                put(cxp + (1 if cxp == xa else -1), ya, OUTLINE)
                put(cxp, ya + 1, OUTLINE)

        if style == "bowler":
            c, d, bandc = (0x2A, 0x26, 0x2C, 255), (0x48, 0x44, 0x50, 255), (0x8A, 0x1E, 0x2C, 255)
            dome(hx0 + 1, crown - 6, hx1 - 1, crown, c)
            for x in range(hx0 + 2, hx1 - 1):
                put(x, crown - 1, bandc)
            put(hx0 + 3, crown - 4, d)
            put(hx0 + 3, crown - 3, d)
            box(hx0 - 2, crown, hx1 + 2, crown + 2, d)
        elif style == "cap":
            c, d = (0x2F, 0x6E, 0xE0, 255), (0x1F, 0x48, 0x98, 255)
            dome(hx0, crown - 5, hx1, crown + 1, c)
            for x in range(hx0 + 1, hx1):
                put(x, crown, d)
            put(cx, crown - 5, (0xF4, 0xF0, 0xE8, 255))
            if face == "front":
                box(hx0 + 1, crown, hx1 - 1, crown + 2, d)
            elif face != "back":
                bx0, bx1 = (hx1 - 1, hx1 + 4) if right else (hx0 - 4, hx0 + 1)
                box(bx0, crown - 1, bx1, crown + 1, d)
        elif style == "hard":
            c, d = (0xF2, 0xC2, 0x1E, 255), (0xC8, 0x92, 0x10, 255)
            dome(hx0, crown - 5, hx1, crown + 1, c)
            for y in range(crown - 4, crown + 1):
                put(cx, y, d)
            put(hx0 + 2, crown - 3, (0xFF, 0xEE, 0x9A, 255))
            box(hx0 - 2, crown, hx1 + 2, crown + 2, d)
        else:  # beanie: a rounded knit cap (teal, so it never reads as fur or a cardboard box), ribbed cuff, pompom
            c, d, hi = (0x2A, 0x9D, 0x8F, 255), (0x1A, 0x6E, 0x64, 255), (0x5C, 0xC8, 0xB8, 255)
            rows = [(crown - 6, 3), (crown - 5, 1), (crown - 4, 0), (crown - 3, 0), (crown - 2, 0), (crown - 1, 0), (crown, 0), (crown + 1, 0)]
            for k, (y, inset) in enumerate(rows):
                xa, xb = hx0 + inset, hx1 - inset
                for x in range(xa, xb + 1):
                    edge = x in (xa, xb) or k == 0 or k == len(rows) - 1
                    put(x, y, OUTLINE if edge else (d if y >= crown - 1 and x % 2 == 0 else c))
                if k == 1:
                    for x in range(xa + 1, xb):
                        put(x, y - 1, OUTLINE)
            put(hx0 + 2, crown - 4, hi)
            put(hx0 + 3, crown - 4, hi)
            box(cx - 1, crown - 9, cx + 1, crown - 6, (0xF4, 0xF0, 0xE8, 255))
            put(cx, crown - 7, (0xF4, 0xF0, 0xE8, 255))
    return im


def briefcase_frame(src, n):
    """A leather briefcase in the paw nearest the camera, for walking Shibas: the lowest fur pixel on the facing side
    below the collar (the paw at the end of the sleeve), swinging with the walk."""
    im = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    p = im.load()
    s = src.load()
    bb = src.getbbox()
    if not bb:
        return im
    cr = collar_row(src)
    body = [x for y in range(cr, cr + 12) for x in range(CELL) if s[x, y][3] and s[x, y][:3] != OUTLINE3 and fur_role(s[x, y][:3]) is None]
    cx = (min(body) + max(body)) // 2 if body else (bb[0] + bb[2]) // 2
    se = "_se_" in n
    # paws: clusters of fur below the sleeves (stray brown pixels on the shoes are too small to count)
    pts = {(x, y) for y in range(cr + 8, min(CELL, cr + 21)) for x in range(CELL)
           if s[x, y][3] and fur_role(s[x, y][:3]) == "fur" and x >= cx - 8}
    clusters = []
    while pts:
        st, cl = [pts.pop()], []
        while st:
            q = st.pop()
            cl.append(q)
            for d in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                r = (q[0] + d[0], q[1] + d[1])
                if r in pts:
                    pts.remove(r)
                    st.append(r)
        if len(cl) >= 4:
            clusters.append(cl)
    if clusters:
        # always the same hand through the walk: the near-side paw (left on screen walking se, right walking ne)
        pick = (min if se else max)(clusters, key=lambda cl: sum(x for x, _ in cl) / len(cl))
        hy = max(y for _, y in pick)
        hx = round(sum(x for x, y in pick if y == hy) / sum(1 for _, y in pick if y == hy))
    else:
        hx, hy = cx + 3, cr + 14
    leather, dark, clasp = (0x8A, 0x55, 0x2E, 255), (0x5A, 0x34, 0x1C, 255), (0xF2, 0xC2, 0x1E, 255)

    def put(x, y, c):
        if 0 <= x < CELL and 0 <= y < CELL:
            p[x, y] = c

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
    rows = sorted({y for y in range(CELL) for x in range(CELL) if s[x, y][3] and s[x, y][:3] == TIE})
    for k, y in enumerate(rows):
        if k % 2:
            continue
        for x in range(CELL):
            if s[x, y][3] and s[x, y][:3] == TIE:
                p[x, y] = (0xF4, 0xF2, 0xEA, 255)
    return im


ACCS = ["glasses", "phones_red", "phones_white", "hat_bowler", "hat_cap", "hat_beanie", "tie_stripes", "hat_hard"]
accs = {}
for n in all_names:
    if n.startswith("kneel_"):  # the kneelers round the espresso machine never wear accessories
        KEYS[n] = None
    for a in ACCS:
        accs[f"acc/{a}/{n}"] = tie_frame(base[n]) if a == "tie_stripes" else acc_frame(a, KEYS[n], facing(n))
    if n.startswith(("walk_se_", "walk_ne_")):
        accs[f"acc/briefcase/{n}"] = briefcase_frame(base[n], n)

# ------------------------------------------------------------------ pack


def trim(im, foot):
    bb = im.getbbox()
    if not bb:
        return Image.new("RGBA", (1, 1), (0, 0, 0, 0)), 0.5, 1.0
    x0, y0, x1, y1 = bb
    c = im.crop(bb)
    return c, (CELL / 2 - x0) / c.width, (foot - y0) / c.height


def anim_of(n):
    for p in ("idle_se", "idle_ne", "walk_se", "walk_ne", "sit_front", "sit_back", "sulk_front", "sulk_back"):
        if n.startswith(p + "_"):
            return p
    return n.rsplit("_", 1)[0]


entries, anims = [], {}
tier_frames = {t: {n: look_frame(base[n], t) for n in all_names} for t in TIERS}
for t in TIERS:
    for fur in FURS:
        if t == "frozen" and fur != "grey":
            continue
        look = t if fur == "grey" else f"{t}.{fur}"
        for n in all_names:
            im, ax, ay = trim(coat_swap(tier_frames[t][n], fur), FOOT[n])
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
out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
frames = {}
for key, im, ax, ay in entries:
    px, py = pos[key]
    out.alpha_composite(im, (px, py))
    frames[key] = {"frame": {"x": px, "y": py, "w": im.width, "h": im.height}, "anchor": {"x": round(ax, 4), "y": round(ay, 4)}}
out.save(os.path.join(OUT, "rats2.png"), optimize=True)
json.dump({"frames": frames, "animations": anims,
           "meta": {"app": "wall-street-inu pixel-site tools/build_rats2.py", "image": "rats2.png", "size": {"w": W, "h": H},
                    "looks": "<tier> (golden tan coat) or <tier>.<coat> with brown = red, white = cream, black = black "
                             "and tan; frozen has one coat",
                    "accessories": ACCS}},
          open(os.path.join(OUT, "rats2.json"), "w"), indent=0, separators=(",", ":"))
print(f"rats2.png {W}x{H}, {len(frames)} frames, {len(anims)} animations")

# ------------------------------------------------------------------ preview: coats x tiers, seated, accessories
PREV = os.path.join(OUT, "preview")
show = ["idle_se_0", "walk_se_2", "sit_front_0", "sit_back_0", "sulk_front_0", "idle_ne_0", "cheer_4", "kneel_0"]
acc_rows = [(a, "idle_se_0") for a in ACCS] + [("briefcase", "walk_se_2")] + [(a, "idle_ne_1") for a in ("phones_red", "hat_bowler", "hat_cap")] \
    + [(a, "sit_front_3") for a in ("glasses", "hat_beanie")] + [(a, "cheer_5") for a in ("hat_hard", "glasses")]
cols = [(t, fur) for fur in FURS for t in ("intern", "analyst", "vp", "partner")] + [("associate", "grey"), ("frozen", "grey")]
S = 3
img = Image.new("RGBA", (len(cols) * 40 * S, (len(show) + len(acc_rows)) * 56 * S), (27, 31, 51, 255))


def paste(tile, key):
    f = frames[key]
    r = f["frame"]
    im = out.crop((r["x"], r["y"], r["x"] + r["w"], r["y"] + r["h"]))
    tile.alpha_composite(im, (max(0, int(round(20 - f["anchor"]["x"] * r["w"]))), max(0, int(round(52 - f["anchor"]["y"] * r["h"])))))


for ci, (t, fur) in enumerate(cols):
    look = t if fur == "grey" else f"{t}.{fur}"
    rows = [(None, n) for n in show] + acc_rows
    for ri, (a, n) in enumerate(rows):
        tile = Image.new("RGBA", (40, 56), (0, 0, 0, 0))
        paste(tile, f"{look}/{n}")
        if a and t != "frozen":
            paste(tile, f"acc/{a}/{n}")
        img.alpha_composite(tile.resize((40 * S, 56 * S), Image.NEAREST), (ci * 40 * S, ri * 56 * S))
img.save(os.path.join(PREV, "rats2_looks.png"))
print("preview written")
