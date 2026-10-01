#!/usr/bin/env python3
"""Look-test frames for the ?film demo: the hook and the 3 ending options, 1920x1080.

Every frame is composed at a small base resolution and scaled up by a whole number with nearest-neighbour, so every
pixel (art, light, text) sits on one grid. Lighting is banded (a few flat steps), never a smooth gradient.

  python3 tools/film_looktest.py            -> assets/film/looktest/{hook,end_pile,end_tower,end_vault}.png
"""
import colorsys, json, math, os, random

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FILM = os.path.join(ROOT, "assets", "film")
RAW = os.path.join(FILM, "raw")
OUT = os.path.join(FILM, "looktest")
W, H = 1920, 1080

INK = (22, 24, 44)
CREAM = (255, 244, 214)
GOLD = (242, 193, 78)
GOLD_HI = (255, 232, 150)
GOLD_LO = (160, 104, 34)

G = {
    'A': '.###.#...##...#######...##...##...#', 'B': '####.#...##...#####.#...##...#####.',
    'C': '.###.#...##....#....#....#...#.###.', 'D': '####.#...##...##...##...##...#####.',
    'E': '######....#....####.#....#....#####', 'F': '######....#....####.#....#....#....',
    'H': '#...##...##...#######...##...##...#', 'I': '.###...#....#....#....#....#...###.',
    'L': '#....#....#....#....#....#....#####', 'N': '#...###..##.#.##..###...##...##...#',
    'O': '.###.#...##...##...##...##...#.###.', 'R': '####.#...##...#####.#.#..#..#.#...#',
    'S': '.####.....#.....###.....#....#####.', 'T': '#####..#....#....#....#....#....#..',
    'U': '#...##...##...##...##...##...#.###.',
    'V': '#...##...##...##...##...#.#.#...#..', 'W': '#...##...##...##.#.##.#.##.#.#.#.#.',
    'Y': '#...##...#.#.#...#....#....#....#..', ' ': '...................................',
}


def glyph_mask(s, scale=1):
    """Bold 5x7 font (every stroke 2 px wide), 1 px padding. Returns an L image at base pixels * scale."""
    adv = 7
    m = Image.new('L', (len(s) * adv + 1, 9), 0)
    p = m.load()
    for i, ch in enumerate(s):
        g = G[ch.upper()]
        for k in range(35):
            if g[k] == '#':
                x, y = 1 + i * adv + k % 5, 1 + k // 5
                p[x, y] = 255
                p[x + 1, y] = 255
    return m.resize((m.width * scale, m.height * scale), Image.NEAREST)


def dilate(mask, r=1):
    a = np.array(mask) > 0
    out = a.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out |= np.roll(np.roll(a, dy, 0), dx, 1)
    return Image.fromarray((out * 255).astype(np.uint8))


def text(s, scale, fill=CREAM, outline=INK, shadow=1):
    """Flat title text: fill, 1 px outline, drop shadow."""
    m = glyph_mask(s, scale)
    pad = 2 + shadow
    big = Image.new('L', (m.width + pad * 2, m.height + pad * 2), 0)
    big.paste(m, (pad, pad))
    ol = dilate(big, 1)
    img = Image.new('RGBA', big.size, (0, 0, 0, 0))
    if shadow:
        sh = Image.new('L', big.size, 0)
        sh.paste(ol, (0, shadow))
        img.paste(Image.new('RGBA', big.size, INK + (255,)), (0, 0), sh)
    img.paste(Image.new('RGBA', big.size, outline + (255,)), (0, 0), ol)
    img.paste(Image.new('RGBA', big.size, fill + (255,)), (0, 0), big)
    return img


def gold_letters(s, scale, depth):
    """Chunky gold block letters: highlight top rows, gold face, dark gold extrusion, ink outline."""
    m = glyph_mask(s, scale)
    Wd, Hd = m.width + 4, m.height + depth + 4
    face = Image.new('L', (Wd, Hd), 0)
    face.paste(m, (2, 2))
    ext = Image.new('L', (Wd, Hd), 0)
    for d in range(1, depth + 1):
        ext.paste(m, (2, 2 + d), m)
    solid = Image.fromarray(np.maximum(np.array(face), np.array(ext)))
    ol = dilate(solid, 1)
    img = Image.new('RGBA', (Wd, Hd), (0, 0, 0, 0))
    img.paste(Image.new('RGBA', img.size, INK + (255,)), (0, 0), ol)
    img.paste(Image.new('RGBA', img.size, GOLD_LO + (255,)), (0, 0), ext)
    img.paste(Image.new('RGBA', img.size, GOLD + (255,)), (0, 0), face)
    fa = np.array(face) > 0
    hi = fa & ~np.roll(fa, scale, 0)  # top edge of every stroke
    hi_img = Image.fromarray((hi * 255).astype(np.uint8))
    img.paste(Image.new('RGBA', img.size, GOLD_HI + (255,)), (0, 0), hi_img)
    return img


def load(rel):
    return Image.open(os.path.join(RAW, rel)).convert('RGBA')


def key_bg(im, tol=14):
    """Remove a flat backdrop by flood fill from the border."""
    a = np.array(im).astype(int)
    h, w = a.shape[:2]
    bg = a[0, 0, :3]
    near = (np.abs(a[:, :, :3] - bg).max(2) <= tol)
    seen = np.zeros((h, w), bool)
    stack = [(y, x) for x in range(w) for y in (0, h - 1)] + [(y, x) for y in range(h) for x in (0, w - 1)]
    while stack:
        y, x = stack.pop()
        if y < 0 or x < 0 or y >= h or x >= w or seen[y, x] or not near[y, x]:
            continue
        seen[y, x] = True
        stack += [(y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)]
    a[seen, 3] = 0
    return Image.fromarray(a.astype(np.uint8))


def recolor_suit(im, hue_deg, sat_mul=1.0, val_mul=1.0):
    """Move the navy suit to another tier colour (hue of blue pixels only)."""
    a = np.array(im).astype(float) / 255
    out = a.copy()
    h, w = a.shape[:2]
    for y in range(h):
        for x in range(w):
            r, g, b, al = a[y, x]
            if al == 0:
                continue
            hh, ss, vv = colorsys.rgb_to_hsv(r, g, b)
            if 0.55 < hh < 0.72 and ss > 0.35:
                nr, ng, nb = colorsys.hsv_to_rgb(hue_deg / 360, min(1, ss * sat_mul), min(1, vv * val_mul))
                out[y, x, :3] = (nr, ng, nb)
    return Image.fromarray((out * 255).astype(np.uint8))


def tint_fur(im, rgb, amount):
    """Tint the low-saturation fur toward rgb (brown, cream or dark rats)."""
    a = np.array(im).astype(float)
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
    fur = (a[:, :, 3] > 0) & (mx - mn < 22) & (mx > 60)
    lum = (r + g + b) / 3 / 150
    for i, c in enumerate(rgb):
        a[:, :, i] = np.where(fur, a[:, :, i] * (1 - amount) + np.clip(c * lum, 0, 255) * amount, a[:, :, i])
    return Image.fromarray(a.astype(np.uint8))


def grade(img, mul):
    a = np.array(img).astype(float)
    a[:, :, :3] *= np.array(mul)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def light(img, sources, bands=5):
    """Banded lights: each source adds colour * step(falloff). sources: (x, y, radius, (r,g,b), strength)."""
    a = np.array(img).astype(float)
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    add = np.zeros((h, w, 3))
    for x, y, rad, col, k in sources:
        d = np.sqrt((xx - x) ** 2 + ((yy - y) * 1.6) ** 2) / rad
        f = np.clip(1 - d, 0, 1)
        f = np.ceil(f * bands) / bands * (f > 0)
        add += f[:, :, None] * np.array(col)[None, None, :] / 255 * k
    lit = a[:, :, :3] * (1 + add) + add * 18
    a[:, :, :3] = np.clip(lit, 0, 255)
    return Image.fromarray(a.astype(np.uint8))


def vignette(img, strength=0.55, bands=4):
    a = np.array(img).astype(float)
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2)
    f = np.clip((d - 0.65) / 0.75, 0, 1)
    f = np.ceil(f * bands) / bands
    a[:, :, :3] *= (1 - strength * f)[:, :, None]
    return Image.fromarray(a.astype(np.uint8))


def sky(w, h, top=(8, 10, 28), bottom=(34, 30, 70), bands=10, stars=160, seed=1):
    img = Image.new('RGBA', (w, h))
    d = ImageDraw.Draw(img)
    for i in range(bands):
        t = i / (bands - 1)
        c = tuple(int(top[k] + (bottom[k] - top[k]) * t) for k in range(3))
        d.rectangle((0, int(h * i / bands), w, int(h * (i + 1) / bands)), fill=c + (255,))
    rnd = random.Random(seed)
    for _ in range(stars):
        x, y = rnd.randrange(w), rnd.randrange(int(h * 0.7))
        c = rnd.choice([(200, 210, 255), (255, 240, 200), (150, 160, 210)])
        d.point((x, y), fill=c + (255,))
        if rnd.random() < 0.08:
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                d.point((x + dx, y + dy), fill=tuple(v // 2 for v in c) + (255,))
    return img


def atlas_sprite(atlas, key):
    d = json.load(open(os.path.join(ROOT, 'assets', atlas + '.json')))['frames']
    k = key if key in d else next(n for n in d if n.startswith(key))
    f = d[k]['frame']
    im = Image.open(os.path.join(ROOT, 'assets', atlas + '.png')).convert('RGBA')
    c = im.crop((f['x'], f['y'], f['x'] + f['w'], f['y'] + f['h']))
    return c.crop(c.getbbox())


def skyline(base, y_floor, darkness, seed, n=9, lit=True):
    """A row of existing city towers as a darkened far layer."""
    rnd = random.Random(seed)
    keys = [('props3', 'glass_tower'), ('props3', 'deco_tower'), ('props3', 'apartment_tower'), ('props3', 'glass_tower')]
    x = -40
    while x < base.width + 40:
        a, k = rnd.choice(keys)
        s = atlas_sprite(a, k)
        if rnd.random() < 0.5:
            s = s.transpose(Image.FLIP_LEFT_RIGHT)
        s = grade(s, (darkness * 0.8, darkness * 0.85, darkness * 1.25))
        base.alpha_composite(s, (x, y_floor - s.height + rnd.randint(0, 40)))
        x += int(s.width * rnd.uniform(0.55, 0.85))


def puffs(base, pts, seed, col=(170, 190, 185), alpha=150):
    rnd = random.Random(seed)
    layer = Image.new('RGBA', base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for (x, y, r) in pts:
        d.ellipse((x - r, y - r, x + r, y + r), fill=col + (alpha,))
        d.ellipse((x - r + 2, y - r + 1, x + r - 3, y + r - 4), fill=tuple(min(255, c + 30) for c in col) + (alpha,))
    base.alpha_composite(layer)


def sparkle(d, x, y, c=GOLD_HI):
    d.point((x, y), fill=c + (255,))
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        d.point((x + dx, y + dy), fill=GOLD + (255,))


def coin(r=5):
    s = r * 2 + 3
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse((0, 0, s - 1, s - 1), fill=INK + (255,))
    d.ellipse((1, 1, s - 2, s - 2), fill=GOLD_LO + (255,))
    d.ellipse((1, 1, s - 3, s - 3), fill=GOLD + (255,))
    d.ellipse((3, 3, s - 5, s - 5), outline=GOLD_LO + (255,))
    d.point((4, 3), fill=GOLD_HI + (255,))
    d.point((3, 4), fill=GOLD_HI + (255,))
    return im


def up(base, scale):
    return base.resize((base.width * scale, base.height * scale), Image.NEAREST).convert('RGB')


def put(base, im, cx, y_bottom=None, y_top=None):
    x = int(cx - im.width / 2)
    y = int(y_bottom - im.height) if y_bottom is not None else int(y_top)
    base.alpha_composite(im, (x, y))


# ---------------------------------------------------------------- 1. HOOK: coin in, rat out
def asphalt(w, h, seed=2):
    rnd = random.Random(seed)
    a = np.zeros((h, w, 4), np.uint8)
    a[:, :] = (34, 36, 48, 255)
    tones = [(28, 30, 41), (42, 44, 57), (50, 52, 66), (24, 25, 34)]
    for _ in range(w * h // 5):
        x, y = rnd.randrange(w), rnd.randrange(h)
        a[y, x, :3] = rnd.choice(tones)
    img = Image.fromarray(a)
    d = ImageDraw.Draw(img)
    for _ in range(6):  # hairline cracks
        x, y = rnd.randrange(w), rnd.randrange(h)
        for _ in range(rnd.randint(6, 14)):
            nx, ny = x + rnd.choice((-2, -1, 1, 2)), y + rnd.choice((-1, 0, 1))
            d.line((x, y, nx, ny), fill=(18, 19, 27, 255))
            x, y = nx, ny
    return img


def hook():
    S = 8
    bw, bh = W // S, H // S  # 240 x 135
    base = asphalt(bw, bh)
    # sidewalk above the curb line y = curb0 - x/2, iso slabs, with a lit curb face
    curb0 = 44
    walk = load('street_sidewalk.png')
    side = Image.new('RGBA', base.size, (0, 0, 0, 0))
    for i in range(-12, 12):
        for j in range(-12, 12):
            x, y = 160 + (i - j) * 32 - 32, -60 + (i + j) * 16 - 22
            if -64 < x < bw and -64 < y < bh:
                side.alpha_composite(walk, (x, y))
    sm = np.array(side)
    yy, xx = np.mgrid[0:bh, 0:bw]
    sm[yy > curb0 - xx / 2 - 5, 3] = 0
    base.alpha_composite(Image.fromarray(sm))
    d = ImageDraw.Draw(base)
    for x in range(bw):
        y = int(curb0 - x / 2)
        d.line((x, y - 5, x, y - 5), fill=(170, 170, 180, 255))
        d.line((x, y - 4, x, y), fill=(92, 94, 108, 255))
        d.point((x, y + 1), fill=(14, 15, 22, 255))
    base = grade(base, (0.62, 0.66, 0.92))

    hole = load('manhole_hole2.png')
    hx, hy = 80, 50
    # opening measured on the sprite: outer rim (9..71, 4..60), inner opening a rim's width in
    cx, cy = hx + 40, hy + 31
    rx, ry = 23, 20
    ha = np.array(hole).astype(int)
    yy, xx = np.mgrid[0:ha.shape[0], 0:ha.shape[1]]
    inner = ((xx + hx - cx) / rx) ** 2 + ((yy + hy - cy) / ry) ** 2 < 1
    lid = load('manhole_lid2.png')
    lid = lid.crop(lid.getbbox())
    lx, ly = 178, 4
    sh = Image.new('RGBA', base.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse((lx - 16, 104, lx + 30, 116), fill=(0, 0, 0, 90))
    base.alpha_composite(sh)
    base.alpha_composite(hole, (hx, hy))
    base = light(base, [(cx, cy, 55, (70, 255, 150), 0.5), (20, 0, 130, (255, 196, 120), 0.7)])

    # steam, behind the rat
    puffs(base, [(cx - 22, cy - 14, 5), (cx - 27, cy - 24, 4), (cx + 21, cy - 18, 6), (cx + 26, cy - 30, 4),
                 (cx - 12, cy - 40, 3), (cx + 14, cy - 48, 3)], 3, col=(126, 170, 156), alpha=130)

    rat = grade(load('hero2_burst/5.png'), (0.92, 0.95, 1.05))
    rb = rat.getbbox()
    waist = rb[1] + int((rb[3] - rb[1]) * 0.6)
    front = cy + ry - 1
    rx0, ry0 = int(cx - 64), int(front - waist)
    ra = np.array(rat)

    def arc(gx):
        u = (gx - cx) / (rx + 1)
        return cy + ry * math.sqrt(max(0, 1 - u * u)) if abs(u) < 1 else cy

    for y in range(128):
        for x in range(128):
            if ra[y, x, 3] and ry0 + y > arc(rx0 + x) - 1:
                ra[y, x, 3] = 0
    ratimg = Image.fromarray(ra)
    # green uplight on the rat's lower half
    rl = np.array(ratimg).astype(float)
    for y in range(128):
        k = max(0, (y - (waist - 40)) / 40)
        rl[y, :, 1] = np.minimum(255, rl[y, :, 1] * (1 + 0.14 * k))
        rl[y, :, 0] *= (1 - 0.05 * k)
    base.alpha_composite(Image.fromarray(rl.astype(np.uint8)), (rx0, ry0))
    hr = np.array(hole)
    for y in range(hr.shape[0]):
        for x in range(hr.shape[1]):
            if hy + y < arc(hx + x) - 1 or inner[y, x]:
                hr[y, x, 3] = 0
    rim = light(Image.fromarray(hr), [(cx - hx, cy - hy, 80, (70, 255, 150), 0.6)])
    base.alpha_composite(rim, (hx, hy))

    puffs(base, [(cx - 30, cy + 4, 4), (cx + 31, cy + 2, 5)], 5, col=(126, 170, 156), alpha=110)
    d = ImageDraw.Draw(base)
    for k, (ax, ay) in enumerate([(-16, 30), (-10, 38), (-4, 44)]):
        d.line((lx + ax, ly + ay, lx + ax + 8, ly + ay - 11), fill=(210, 220, 240, 120 - k * 30))
    base.alpha_composite(lid, (lx, ly))
    for (x, y) in [(int(cx) - 30, int(cy) - 34), (int(cx) + 30, int(cy) - 44), (int(cx) - 18, int(cy) - 60),
                   (int(cx) + 40, int(cy) - 14), (int(cx) - 42, int(cy) - 8)]:
        sparkle(d, x, y)
    base = vignette(base, 0.4)
    t = text('EVERY FEE HIRES A RAT', 1)
    put(base, t, bw // 2, y_top=bh - t.height - 3)
    return up(base, S)


# ---------------------------------------------------------------- pile rats (hero recolours)
TIERS = [(None, 1, 1), (32, 0.55, 0.75), (140, 0.8, 0.8), (352, 1.1, 1.1), (230, 0.3, 0.35)]
FURS = [None, ((150, 110, 80), 0.55), ((235, 230, 220), 0.5), ((70, 70, 80), 0.55)]


def pile_rat(frame, rnd):
    im = load(frame)
    hue, sm, vm = rnd.choice(TIERS)
    if hue is not None:
        im = recolor_suit(im, hue, sm, vm)
    fur = rnd.choice(FURS)
    if fur:
        im = tint_fur(im, *fur)
    if rnd.random() < 0.5:
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    return im.crop(im.getbbox())


# ---------------------------------------------------------------- 2. THE PILE
def end_pile():
    S = 3
    bw, bh = W // S, H // S  # 640 x 360
    base = sky(bw, bh, seed=4)
    skyline(base, bh - 30, 0.28, 7)
    rnd = random.Random(11)
    lying = [f'hero2_tumble/{i}.png' for i in (5, 6, 7, 8)]
    standing = ['hero2_rot/Idle/rotations/' + n + '.png' for n in ('south', 'south-east', 'south-west')]
    logo = gold_letters('WALL STREET RATS', 5, 7)
    top = 138
    bottom = top + logo.height
    d = ImageDraw.Draw(base)
    glow = light(Image.new('RGBA', base.size, (0, 0, 0, 0)), [])
    base = light(base, [(bw // 2, bottom - 20, 300, (255, 200, 110), 0.5)])
    put(base, logo, bw // 2, y_top=top)
    # rats on the letters, the hero in the middle straightening its tie
    for x in (bw // 2 - 190, bw // 2 + 200):
        put(base, pile_rat(rnd.choice(standing), rnd), x, y_bottom=top + 6)
    hero = load('hero2_tie/6.png')
    put(base, hero.crop(hero.getbbox()), bw // 2, y_bottom=top + 6)
    # the pile, stacked up into the letters
    placed = []
    for (yb, n, half) in [(bottom + 42, 9, 280), (bottom + 76, 11, 305), (bottom + 110, 12, 330), (bottom + 146, 13, 350)]:
        for k in range(n):
            x = bw // 2 - half + (2 * half) * (k + 0.5) / n + rnd.randint(-8, 8)
            placed.append((yb + rnd.randint(-5, 5), x))
    for yb, x in sorted(placed):
        put(base, pile_rat(rnd.choice(lying), rnd), x, y_bottom=yb)
    # still raining rats, and the loop: a coin flips off the pile
    d = ImageDraw.Draw(base)
    for (x, y, fr) in [(64, 58, 'hero2_tumble/4.png'), (586, 30, 'hero2_tumble/3.png')]:
        for k in range(3):
            d.line((x - 8 + k * 8, y - 22, x - 8 + k * 8, y - 6), fill=(190, 200, 235, 110))
        put(base, pile_rat(fr, rnd), x, y_top=y)
    base.alpha_composite(coin(5), (bw // 2 + 262, bottom + 4))
    for (x, y) in [(bw // 2 - 150, top - 50), (bw // 2 + 160, top - 60), (bw // 2 + 60, top - 96)]:
        sparkle(d, x, y)
    base = vignette(base, 0.45)
    t = text('EVERY FEE HIRES A RAT', 3)
    put(base, t, bw // 2, y_top=10)
    return up(base, S)


# ---------------------------------------------------------------- 3. THE TOWER
def end_tower():
    S = 2
    bw, bh = W // S, H // S  # 960 x 540
    base = sky(bw, bh, top=(6, 8, 24), bottom=(40, 32, 76), seed=9, stars=260)
    d = ImageDraw.Draw(base)
    # searchlights from the roof
    beams = Image.new('RGBA', base.size, (0, 0, 0, 0))
    bd = ImageDraw.Draw(beams)
    tx = bw // 2
    for ang, a in ((-0.55, 36), (0.42, 30)):
        x1 = tx + math.tan(ang) * 400
        bd.polygon([(tx - 6, 190), (tx + 6, 190), (x1 + 60, -300), (x1 - 60, -300)], fill=(255, 230, 170, a + 14))
    base.alpha_composite(beams)
    skyline(base, bh + 60, 0.22, 3)
    skyline(base, bh + 140, 0.4, 5)
    tower = key_bg(load('tower_top.png'), 10)
    tower = tower.crop(tower.getbbox())
    ta = np.array(tower)
    ta[:72, :, 3] = 0  # the generated billboard and its legs; our sign stands there instead
    tower = Image.fromarray(ta)
    tt = 120
    put(base, tower, tx, y_top=tt)
    # rooftop sign: steel frame, lit gold letters
    l1, l2 = gold_letters('WALL STREET', 4, 5), gold_letters('RATS', 6, 7)
    sw = l1.width + 30
    top = tt + 72 - l1.height - l2.height - 26
    shf = Image.new('RGBA', base.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shf)
    for lx, rx_ in ((tx - sw // 2 + 16, tx - 34), (tx + sw // 2 - 16, tx + 34), (tx, tx)):
        sd.polygon([(lx - 3, tt + 66), (lx + 3, tt + 66), (rx_ + 3, tt + 84), (rx_ - 3, tt + 84)], fill=(40, 44, 70, 255), outline=INK + (255,))
    sd.rectangle((tx - sw // 2 + 8, top + 18, tx + sw // 2 - 8, tt + 70), outline=(52, 58, 92, 255))
    for xx in range(tx - sw // 2 + 8, tx + sw // 2 - 8, 14):
        sd.line((xx, top + 18, xx + 14, tt + 70), fill=(52, 58, 92, 255))
        sd.line((xx + 14, top + 18, xx, tt + 70), fill=(52, 58, 92, 255))
    base.alpha_composite(shf)
    put(base, l1, tx, y_top=top)
    put(base, l2, tx, y_top=top + l1.height + 2)
    # the loop: a coin falling off the roof
    c = coin(4)
    base.alpha_composite(c, (tx + 150, tt + 150))
    for k in range(3):
        d.line((tx + 155, tt + 120 + k * 8, tx + 155, tt + 126 + k * 8), fill=(255, 220, 140, 90 - k * 25))
    base = light(base, [(tx, top + 40, 200, (255, 205, 120), 0.8), (tx, tt + 60, 150, (255, 200, 130), 0.35)])
    base = vignette(base, 0.5)
    t = text('EVERY FEE HIRES A RAT', 4)
    put(base, t, bw // 2, y_top=bh - t.height - 16)
    return up(base, S)


# ---------------------------------------------------------------- 4. THE VAULT
def end_vault():
    S = 2
    bw, bh = W // S, H // S  # 960 x 540
    base = sky(bw, bh, top=(8, 8, 22), bottom=(52, 38, 56), seed=13, stars=200)
    rays = Image.new('RGBA', base.size, (0, 0, 0, 0))
    rd = ImageDraw.Draw(rays)
    cx, cy = bw // 2, 250
    for k in range(12):
        a0 = -math.pi + k * math.pi / 11
        rd.polygon([(cx, cy), (cx + math.cos(a0) * 900, cy + math.sin(a0) * 900),
                    (cx + math.cos(a0 + 0.07) * 900, cy + math.sin(a0 + 0.07) * 900)], fill=(255, 210, 120, 22))
    base.alpha_composite(rays)
    skyline(base, bh + 40, 0.25, 21)
    # plaza
    d = ImageDraw.Draw(base)
    d.rectangle((0, bh - 70, bw, bh), fill=(20, 18, 34, 255))
    vault = key_bg(load('vault_cathedral_v2.png'), 10)
    vault = vault.crop(vault.getbbox())
    vt = bh - 52 - vault.height
    put(base, vault, cx, y_top=vt)
    vx = cx - vault.width // 2
    # a crane lifting cash onto the roof
    crane = atlas_sprite('props3', 'crane')
    base.alpha_composite(crane, (vx + vault.width - 40, bh - 52 - crane.height))
    cash = atlas_sprite('props3', 'cash_pile')
    base.alpha_composite(cash, (vx + vault.width + 60, bh - 52 - crane.height + 60))
    # rats at work: on the roofs, on the steps, carrying bills in
    rnd = random.Random(5)
    bill = atlas_sprite('props3', 'bill')
    tiers = ['analyst', 'associate', 'vp', 'intern', 'partner']
    spots = [(vx + 130, vt + 150), (vx + 170, vt + 132), (vx + 250, vt + 150), (vx + 290, vt + 170), (vx + 90, vt + 205),
             (vx + 205, vt + 95), (vx + 330, vt + 205), (vx + 60, vt + 250), (cx - 60, bh - 46), (cx + 20, bh - 40),
             (cx + 110, bh - 50), (cx - 150, bh - 44), (cx + 190, bh - 42), (cx - 230, bh - 48)]
    for (x, y) in spots:
        anim = rnd.choice(['walk_se', 'walk_ne', 'idle_se', 'cheer', 'walk_se'])
        r = atlas_sprite('rats', f'{rnd.choice(tiers)}/{anim}')
        if rnd.random() < 0.5:
            r = r.transpose(Image.FLIP_LEFT_RIGHT)
        put(base, r, x, y_bottom=y)
        if anim.startswith('walk') and rnd.random() < 0.6:
            base.alpha_composite(bill, (x - 9, y - r.height - 14))
    # bills flying in from the street
    for k in range(10):
        t = k / 9
        x = int(80 + t * (cx - 120))
        y = int(bh - 90 - math.sin(t * math.pi) * 180)
        base.alpha_composite(bill, (x, y))
    for k in range(8):
        t = k / 7
        base.alpha_composite(bill, (int(bw - 90 - t * (bw / 2 - 140)), int(bh - 110 - math.sin(t * math.pi) * 150)))
    # the loop: a coin rolling off the pile into the street
    base.alpha_composite(coin(4), (cx + 260, bh - 34))
    base = light(base, [(cx, vt + 220, 330, (255, 200, 110), 0.7), (cx, bh - 40, 260, (255, 190, 100), 0.4)])
    base = vignette(base, 0.45)
    logo = gold_letters('WALL STREET RATS', 5, 6)
    put(base, logo, bw // 2, y_top=8)
    t = text('EVERY FEE HIRES A RAT', 4)
    put(base, t, bw // 2, y_top=bh - t.height - 10)
    return up(base, S)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for name, fn in (('hook', hook), ('end_pile', end_pile), ('end_tower', end_tower), ('end_vault', end_vault)):
        fn().save(os.path.join(OUT, f'{name}.png'))
        print('wrote', name)
