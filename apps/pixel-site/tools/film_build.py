#!/usr/bin/env python3
"""Bake the ?film textures: lit, night-graded set plates and sprite frames at base resolution (free, no gens).

  python3 tools/film_build.py   ->  assets/film/built/*.png + assets/film/built/meta.json

The film (src/film/) scales every texture up by a whole number with nearest-neighbour, so a base pixel is always a
square block on screen. Plates are baked larger than the frame so the camera can move over them.
"""
import json, os, random, sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import film_looktest as L  # noqa: E402  (shared helpers: sky, skyline, lighting, recolours, gold letters)

ROOT = os.path.dirname(HERE)
RAW = os.path.join(ROOT, 'assets', 'film', 'raw')
OUT = os.path.join(ROOT, 'assets', 'film', 'built')
META = {}


def save(name, im):
    im.save(os.path.join(OUT, f'{name}.png'))


MISSING = []


def load(rel):
    path = os.path.join(RAW, rel)
    if not os.path.exists(path):  # a gen still running: a placeholder keeps the film building
        MISSING.append(rel)
        return Image.new('RGBA', (8, 8), (255, 0, 255, 255))
    return Image.open(path).convert('RGBA')


def frames(prefix, rels):
    for i, r in enumerate(rels):
        save(f'{prefix}_{i}', load(r))
    META[prefix] = len(rels)


def banded_glow(size=96, bands=5):
    """White radial light in flat steps; the film tints it and adds it."""
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    a = np.zeros((size, size, 4), np.uint8)
    yy, xx = np.mgrid[0:size, 0:size]
    d = np.sqrt((xx - size / 2 + 0.5) ** 2 + (yy - size / 2 + 0.5) ** 2) / (size / 2)
    f = np.clip(1 - d, 0, 1)
    f = np.ceil(f * bands) / bands * (f > 0)
    a[:, :, :3] = 255
    a[:, :, 3] = (f * 150).astype(np.uint8)
    return Image.fromarray(a)


# ---------------------------------------------------------------- street (hook, suit up, the loop tail)
def street():
    W, H = 520, 460
    base = L.asphalt(W, H, seed=2)
    walk = load('street_sidewalk.png')
    curb0 = 275  # curb line y = curb0 - x/2
    side = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    for i in range(-20, 20):
        for j in range(-20, 20):
            x, y = 260 + (i - j) * 32 - 32, -60 + (i + j) * 16 - 22
            if -64 < x < W and -64 < y < H:
                side.alpha_composite(walk, (x, y))
    sm = np.array(side)
    yy, xx = np.mgrid[0:H, 0:W]
    sm[yy > curb0 - xx / 2 - 5, 3] = 0
    base.alpha_composite(Image.fromarray(sm))
    d = ImageDraw.Draw(base)
    for x in range(W):
        y = int(curb0 - x / 2)
        if y - 5 >= 0:
            d.point((x, y - 5), fill=(170, 170, 180, 255))
        d.line((x, max(0, y - 4), x, max(0, y)), fill=(92, 94, 108, 255))
        d.point((x, y + 1), fill=(14, 15, 22, 255))
    # lane dashes parallel to the curb, clear of the manhole
    for k in range(-2, 14):
        x0 = k * 44
        y0 = 480 - x0 / 2
        d.polygon([(x0, y0), (x0 + 24, y0 - 12), (x0 + 24, y0 - 10), (x0, y0 + 2)], fill=(206, 196, 160, 255))
    base = L.grade(base, (0.62, 0.66, 0.92))
    hx, hy = 220, 230  # manhole sprite top-left on the plate
    base = L.light(base, [(hx + 40, hy + 31, 60, (70, 255, 150), 0.35), (150, 140, 190, (255, 196, 120), 0.8)])
    base = L.vignette(base, 0.25)
    save('street_plate', base)
    META['street'] = {'w': W, 'h': H, 'hole': [hx, hy], 'holeCentre': [hx + 40, hy + 31], 'holeR': [23, 20]}

    hole = load('manhole_hole2.png')
    save('hole', hole)
    cx, cy, rx, ry = 40, 31, 23, 20
    hr = np.array(hole)
    front = hr.copy()
    for y in range(hr.shape[0]):
        for x in range(hr.shape[1]):
            u = (x - cx) / (rx + 1)
            arc = cy + ry * np.sqrt(max(0, 1 - u * u)) if abs(u) < 1 else cy
            inner = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1
            if y < arc - 1 or inner:
                front[y, x, 3] = 0
    save('hole_front', Image.fromarray(front))
    # where a rat inside the hole may show: above the front arc of the opening (hole coords, 120 px of headroom)
    mw, mh, top = 160, 190, 130
    m = np.zeros((mh, mw, 4), np.uint8)
    for y in range(mh):
        for x in range(mw):
            hxp, hyp = x - 40, y - top
            u = (hxp - cx) / (rx + 1)
            arc = cy + ry * np.sqrt(max(0, 1 - u * u)) if abs(u) < 1 else cy - 6
            if hyp < arc - 1:
                m[y, x] = (255, 255, 255, 255)
    save('hole_mask', Image.fromarray(m))
    META['holeMask'] = {'dx': -40, 'dy': -top}
    lid = load('manhole_lid2.png')
    lid = lid.crop(lid.getbbox())
    ld = ImageDraw.Draw(lid)
    w, h = lid.size
    ld.rectangle((w // 2 - 4, h // 2 - 1, w // 2 + 4, h // 2), fill=(10, 10, 16, 255))  # the coin slot
    save('lid_flat', lid)
    frames('lid_spin', [f'lid_spin/{i}.png' for i in range(9)])


# ---------------------------------------------------------------- hero frames and recolours
DIRS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west']
TIERS = {'navy': None, 'green': (140, 0.8, 0.8), 'crimson': (352, 1.1, 1.1), 'brown': (32, 0.55, 0.75), 'black': (230, 0.3, 0.35)}
FURS = {'grey': None, 'brown': ((150, 110, 80), 0.55), 'white': ((235, 230, 220), 0.5), 'dark': ((70, 70, 80), 0.55)}
TEAM = [('green', 'brown'), ('crimson', 'grey'), ('brown', 'white'), ('black', 'grey'), ('navy', 'dark'), ('green', 'white'),
        ('crimson', 'dark'), ('brown', 'grey'), ('black', 'brown'), ('navy', 'white'), ('green', 'grey'), ('crimson', 'brown')]


def recolour(im, tier, fur):
    if TIERS[tier]:
        im = L.recolor_suit(im, *TIERS[tier])
    if FURS[fur]:
        im = L.tint_fur(im, *FURS[fur])
    return im


def hero():
    save('scruffy_s', load('hero2_scruffy/0.png'))
    save('suited_s', load('hero2_suited/0.png'))
    frames('burst', [f'hero2_burst/{i}.png' for i in range(9)])
    frames('look', [f'hero_look/{i}.png' for i in range(9)])
    frames('tie', [f'hero2_tie/{i}.png' for i in range(9)])
    frames('tumble', [f'hero2_tumble/{i}.png' for i in range(9)])
    frames('type', [f'hero_type/{i}.png' for i in range(9)])
    frames('crack', [f'hero_crack/{i}.png' for i in range(9)])
    for k, d in enumerate(DIRS):
        save(f'rot_suited_{k}', load(f'hero2_rot/Idle/rotations/{d}.png'))
        save(f'rot_scruffy_{k}', load(f'hero_scruffy_rot/Idle/rotations/{d}.png'))
    wd = os.path.join(RAW, 'hero2_rot', 'Idle', 'animations', 'walk', 'east')
    walk = sorted(os.listdir(wd)) if os.path.isdir(wd) else ['0.png'] * 8
    frames('walk_e', [f'hero2_rot/Idle/animations/walk/east/{f}' for f in walk])
    # the team and the pile: the hero in other suits and furs
    for v, (tier, fur) in enumerate(TEAM):
        for i in range(9):
            save(f'type_v{v}_{i}', recolour(load(f'hero_type/{i}.png'), tier, fur))
        for i in (3, 4, 5, 6, 7, 8):
            save(f'tumble_v{v}_{i}', recolour(load(f'hero2_tumble/{i}.png'), tier, fur))
        for k in (0, 1, 7):
            save(f'rot_v{v}_{k}', recolour(load(f'hero2_rot/Idle/rotations/{DIRS[k]}.png'), tier, fur))
    META['team'] = [f'{t}/{f}' for t, f in TEAM]


def fx():
    save('glow', banded_glow())
    save('coin', load('coin.png').crop(load('coin.png').getbbox()))
    frames('coin_spin', [f'coin_spin/{i}.png' for i in range(9)])
    frames('puff', [f'puff_anim/{i}.png' for i in range(9)])
    frames('boom', [f'boom_anim/{i}.png' for i in range(9)])
    frames('vault_open', [f'vault4_open/{i}.png' for i in range(9)])
    s = Image.new('RGBA', (5, 5), (0, 0, 0, 0))
    d = ImageDraw.Draw(s)
    L.sparkle(d, 2, 2)
    save('sparkle', s)


# ---------------------------------------------------------------- office (clock in, the team)
def office():
    W, H = 720, 520
    rnd = random.Random(8)
    base = Image.new('RGBA', (W, H), (0, 0, 0, 255))
    wall_h = 250
    d = ImageDraw.Draw(base)
    d.rectangle((0, 0, W, wall_h), fill=(30, 34, 58, 255))
    # tall windows onto the night city
    win = L.sky(W, wall_h, top=(6, 8, 22), bottom=(40, 34, 74), seed=31, stars=120)
    L.skyline(win, wall_h + 60, 0.35, 33)
    L.skyline(win, wall_h + 120, 0.55, 35)
    for x0 in range(20, W, 170):
        box = (x0, 30, x0 + 140, wall_h - 40)
        base.paste(win.crop(box), box[:2])
        d.rectangle(box, outline=(14, 16, 30, 255), width=3)
        d.line((x0 + 70, 30, x0 + 70, wall_h - 40), fill=(14, 16, 30, 255), width=2)
        d.line((x0, 110, x0 + 140, 110), fill=(14, 16, 30, 255), width=2)
    # the ticker board and the baseboard
    d.rectangle((0, 4, W, 22), fill=(10, 12, 20, 255))
    d.line((0, 23, W, 23), fill=(242, 193, 78, 255))
    d.rectangle((0, wall_h - 12, W, wall_h), fill=(20, 22, 38, 255))
    # carpet
    for y in range(wall_h, H):
        for x in range(0, W, 1):
            if rnd.random() < 0.1:
                d.point((x, y), fill=(44, 50, 88, 255))
    carpet = Image.new('RGBA', (W, H - wall_h), (36, 42, 76, 255))
    cp = np.array(carpet)
    noise = np.random.default_rng(3).integers(0, 3, cp.shape[:2])
    cp[:, :, :3] = np.clip(cp[:, :, :3].astype(int) + (noise[:, :, None] - 1) * 5, 0, 255)
    base.paste(Image.fromarray(cp.astype(np.uint8)), (0, wall_h))
    base = L.grade(base, (0.85, 0.88, 1.0))
    base = L.light(base, [(W // 2, wall_h + 120, 360, (120, 170, 255), 0.25)])
    save('office_plate', base)
    META['office'] = {'w': W, 'h': H, 'wall': wall_h, 'ticker': [4, 22]}
    # the desk faces the camera with the rat behind it: the tall monitor would hide its face, so it becomes a laptop
    desk = load('hero_desk.png')
    desk = desk.crop(desk.getbbox())
    a = np.array(desk)
    top = a[60, 16].copy()  # the desk top's wood
    lip = a[58, 16].copy()
    for y in range(a.shape[0]):
        for x in range(a.shape[1]):
            if 22 <= x <= 99 and y < 55:
                a[y, x, 3] = 0
            elif 30 <= x <= 92 and 55 <= y <= 65:
                a[y, x] = lip if y < 57 else top
    desk = Image.fromarray(a)
    d = ImageDraw.Draw(desk)
    lx0, lx1, ly0, ly1 = 42, 80, 38, 58
    d.rectangle((lx0 - 1, ly0 - 1, lx1 + 1, ly1), fill=(120, 200, 255, 255))  # screen light spilling round the lid
    d.rectangle((lx0, ly0, lx1, ly1), fill=L.INK + (255,))
    d.rectangle((lx0 + 1, ly0 + 1, lx1 - 1, ly1 - 1), fill=(52, 56, 78, 255))
    d.line((lx0 + 1, ly0 + 1, lx1 - 1, ly0 + 1), fill=(88, 94, 124, 255))
    d.rectangle(((lx0 + lx1) // 2 - 2, ly0 + 7, (lx0 + lx1) // 2 + 1, ly0 + 9), fill=(242, 193, 78, 255))  # a small gold badge
    save('desk', desk)
    META['desk'] = {'w': desk.width, 'h': desk.height, 'top': 56}
    save('chair', load('hero_chair.png').crop(load('hero_chair.png').getbbox()))


# ---------------------------------------------------------------- the vault ending
def vault_end():
    W, H = 1200, 760
    base = L.sky(W, H, top=(8, 8, 22), bottom=(52, 38, 56), seed=13, stars=320)
    rays = Image.new('RGBA', base.size, (0, 0, 0, 0))
    rd = ImageDraw.Draw(rays)
    import math
    cx, cy = W // 2, 330
    for k in range(14):
        a0 = -math.pi + k * math.pi / 13
        rd.polygon([(cx, cy), (cx + math.cos(a0) * 1200, cy + math.sin(a0) * 1200),
                    (cx + math.cos(a0 + 0.07) * 1200, cy + math.sin(a0 + 0.07) * 1200)], fill=(255, 210, 120, 22))
    base.alpha_composite(rays)
    L.skyline(base, H - 20, 0.25, 21)
    L.skyline(base, H + 60, 0.4, 23)
    d = ImageDraw.Draw(base)
    d.rectangle((0, H - 90, W, H), fill=(20, 18, 34, 255))
    base = L.light(base, [(cx, H - 100, 420, (255, 190, 100), 0.35)])
    save('end_bg', base)
    cat = L.key_bg(load('vault_cathedral_v2.png'), 10)
    cat = cat.crop(cat.getbbox())
    cat = L.light(cat, [(cat.width // 2, cat.height // 2 + 40, 300, (255, 200, 110), 0.35)])
    save('cathedral', cat)
    META['end'] = {'w': W, 'h': H, 'ground': H - 72, 'cathedral': [cat.width, cat.height]}

    # the close-up: the vault's front door, at night, with the street in front (tall enough for 9:16)
    FW, FH, FLOOR = 600, 640, 440
    front = L.sky(FW, FH, top=(8, 8, 22), bottom=(40, 30, 50), seed=17, stars=160)
    L.skyline(front, FLOOR + 10, 0.25, 19)
    fd = ImageDraw.Draw(front)
    fd.rectangle((0, FLOOR - 6, FW, FH), fill=(26, 26, 40, 255))
    walk = load('street_sidewalk.png')
    for i in range(-12, 12):
        for j in range(-12, 12):
            x, y = FW // 2 + (i - j) * 32 - 32, FLOOR + (i + j) * 16 - 22
            if -64 < x < FW and FLOOR - 40 < y < FH:
                front.alpha_composite(walk, (x, y))
    front = L.grade(front, (0.75, 0.75, 0.95)) if False else front
    vf = L.key_bg(load('vault_front.png'), 12)
    bb = vf.getbbox()
    vf = vf.crop(bb)
    ox, oy = (FW - vf.width) // 2, FLOOR - vf.height
    sky_part = front.crop((0, 0, FW, FLOOR - 6))
    front.alpha_composite(vf, (ox, oy))
    front = L.light(front, [(FW // 2, FLOOR - 140, 320, (255, 200, 120), 0.45)])
    front = L.vignette(front, 0.3)
    save('front_plate', front)
    # the door's hub on the sprite (400 x 300 canvas): x 200, y 124
    META['front'] = {'w': FW, 'h': FH, 'door': [ox + 200 - bb[0], oy + 124 - bb[1]], 'floor': FLOOR, 'cashRight': [ox + vf.width - 34, FLOOR - 64], 'top': oy}
    for name, lines, scale, depth in (('logo_door', ['WALL STREET', 'RATS'], 2, 3), ('logo_line', ['WALL STREET RATS'], 5, 7),
                                      ('logo_two', ['WALL STREET', 'RATS'], 4, 6)):
        parts = [L.gold_letters(s, scale if k == 0 else scale + 1, depth) for k, s in enumerate(lines)]
        w = max(p.width for p in parts)
        h = sum(p.height for p in parts) + 2 * (len(parts) - 1)
        im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        y = 0
        for p in parts:
            im.alpha_composite(p, ((w - p.width) // 2, y))
            y += p.height + 2
        if name == 'logo_door':  # an engraved steel plaque behind the letters
            pw, ph = w + 16, h + 12
            pl = Image.new('RGBA', (pw, ph), (0, 0, 0, 0))
            pd = ImageDraw.Draw(pl)
            pd.rectangle((0, 0, pw - 1, ph - 1), fill=L.INK + (255,))
            pd.rectangle((1, 1, pw - 2, ph - 2), fill=(150, 104, 36, 255))
            pd.rectangle((3, 3, pw - 4, ph - 4), fill=(32, 36, 58, 255))
            pd.line((3, 3, pw - 4, 3), fill=(70, 76, 110, 255))
            for bx, by in ((5, 5), (pw - 7, 5), (5, ph - 7), (pw - 7, ph - 7)):
                pd.rectangle((bx, by, bx + 1, by + 1), fill=(242, 193, 78, 255))
            pl.alpha_composite(im, (8, 6))
            im = pl
        save(name, im)


def pile():
    W, H = 760, 760
    base = L.sky(W, H, seed=4)
    L.skyline(base, H - 30, 0.28, 7)
    L.skyline(base, H + 60, 0.45, 9)
    base = L.light(base, [(W // 2, H // 2 + 40, 320, (255, 200, 110), 0.35)])
    save('pile_bg', base)
    META['pile'] = {'w': W, 'h': H}


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith('.png'):
            os.remove(os.path.join(OUT, f))
    for step in (street, hero, fx, office, vault_end, pile):
        step()
        print('baked', step.__name__)
    json.dump(META, open(os.path.join(OUT, 'meta.json'), 'w'), indent=1)
    print(len([f for f in os.listdir(OUT) if f.endswith('.png')]), 'textures')
    if MISSING:
        print('placeholders for', len(MISSING), 'missing raw files, e.g.', sorted(set(MISSING))[:6])
