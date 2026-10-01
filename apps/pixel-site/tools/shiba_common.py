"""Shared helpers for the Wall Street Inu (Shiba) sprites (tools/build_shiba.py, tools/build_rats2.py).

The Shiba character (PixelLab 0ca6ab26-609a-48e0-8e87-96c679852c13, "WSI C_doge") was created at size 68, so
PixelLab draws it on a 96x96 canvas; the rat was size 48 on a 68x68 canvas. Every PixelLab frame of the character is
brought down to 2/3 scale (96 -> 64) with a majority filter that keeps dark outline pixels, then set into the rat's
68x68 cell with the feet on the rat's foot row, so the game's anchors, desk offsets and on-screen height are unchanged.
Frames generated at 68x68 (edit_image_pixen / animate_image) are only snapped to the base palette.

Looks: the tiers recolour the suit (and tie); the fur coats recolour the fur. Both are exact colour swaps of one
base palette, so every look is the same Shiba (same face, proportions and shading).
"""
import colorsys, json, os
from collections import Counter
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(os.path.dirname(HERE), "assets", "raw", "shiba")
CELL = 68
FOOT_ROW = 59          # first empty row under the rat's feet in a 68 cell (bbox bottom of rot_s/rot_se)
SHIBA_FOOT_64 = 55     # the Shiba rotations' bbox bottom after the 2/3 downscale


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def _lum(c):
    return .3 * c[0] + .59 * c[1] + .11 * c[2]


def mode_downscale(im, num=2, den=3):
    """num/den scale by majority vote over each den x den block of the num x nearest-upscaled image."""
    im = im.convert("RGBA")
    big = im.resize((im.width * num, im.height * num), Image.NEAREST)
    W, H = big.width // den, big.height // den
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    p, b = out.load(), big.load()
    for y in range(H):
        for x in range(W):
            cs = [b[x * den + i, y * den + j] for j in range(den) for i in range(den)]
            op = [c[:3] for c in cs if c[3] > 127]
            if len(op) < 4:
                continue
            cnt = Counter(op)
            best = max(cnt.items(), key=lambda kv: kv[1] + (1.6 if _lum(kv[0]) < 45 else 0))[0]
            p[x, y] = best + (255,)
    return out


def to_cell(im96):
    """A 96x96 PixelLab Shiba frame -> a 68x68 cell, feet on the rat's foot row."""
    small = mode_downscale(im96)
    dy = FOOT_ROW - SHIBA_FOOT_64
    dx = (CELL - small.width) // 2
    out = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    out.alpha_composite(small, (dx, dy))
    return out


# ---------------------------------------------------------------- palette of the base character
SUIT = [rgb("#4e5668"), rgb("#2e3142"), rgb("#1e2144")]   # main, shade, deepest shade (slate navy)
SEAM = rgb("#292728")      # suit outline and seams; also the eyes and nose (above the collar)
SHIRT = rgb("#d4d2d6")
TIE = rgb("#1273aa")
OUTLINE = rgb("#16182c")   # 1px outer outline added to every look (as the rats had)
GLOOM, GLOOM_D = rgb("#4a68f0"), rgb("#3346c8")
# the black office chair the seated frames come with (kept out of the suit recolour)
CHAIR_PAL = [rgb(h) for h in ("#131025", "#171618", "#262325", "#322e33", "#3e3a40")]

_PAL = None


def base_palette():
    """Every colour of the base character's rotations, walk and idle frames (after the downscale)."""
    global _PAL
    if _PAL is None:
        cd = os.path.join(RAW, "character")
        meta = json.load(open(os.path.join(cd, "metadata.json")))["states"][0]["frames"]
        paths = list(meta["rotations"].values())
        for a in meta["animations"].values():
            for lst in a.values():
                paths += lst
        cols = set()
        for p in paths:
            im = to_cell(Image.open(os.path.join(cd, p)))
            cols |= {c[:3] for c in im.getdata() if c[3]}
        _PAL = sorted(cols)
    return _PAL


_SET = None


def _base_set():
    global _SET
    if _SET is None:
        _SET = set(base_palette())
    return _SET


def _dist(a, b):
    return (a[0] - b[0]) ** 2 * .3 + (a[1] - b[1]) ** 2 * .59 + (a[2] - b[2]) ** 2 * .11


def snap(im, gloom=False):
    """Every pixel onto the base palette (plus the chair blacks); alpha to 0/255. gloom: keep the blue scribble."""
    pal = base_palette() + CHAIR_PAL
    out = im.convert("RGBA").copy()
    p = out.load()
    cache = {}
    for y in range(out.height):
        for x in range(out.width):
            c = p[x, y]
            if c[3] < 128:
                p[x, y] = (0, 0, 0, 0)
                continue
            k = c[:3]
            if k not in cache:
                if gloom and k[2] > 150 and k[2] > k[0] + 60:
                    cache[k] = GLOOM if sum(k) > 330 else GLOOM_D
                else:
                    cache[k] = k if k in pal else min(pal, key=lambda q: _dist(q, k))
            p[x, y] = cache[k] + (255,)
    return out


def add_outline(im):
    out = im.copy()
    p, s = out.load(), im.load()
    for y in range(im.height):
        for x in range(im.width):
            if s[x, y][3]:
                continue
            if any(0 <= x + dx < im.width and 0 <= y + dy < im.height and s[x + dx, y + dy][3]
                   for dx in (-1, 0, 1) for dy in (-1, 0, 1)):
                p[x, y] = OUTLINE + (255,)
    return out


def collar_row(im, tie=TIE):
    """First row of the shirt and tie (base palette): a shirt/tie pixel with the suit within 2 px. A white highlight
    on the snout or cheek has no suit next to it, so it is not taken for the collar."""
    p = im.load()
    W, H = im.size
    first = None
    rows = {y for y in range(H) if any(p[x, y][3] and p[x, y][:3] in (SHIRT, tie) for x in range(W))}
    for y in range(H):
        if y not in rows or not (y + 1 in rows or y + 2 in rows):
            if y in rows and first is None:
                first = y
            continue
        for x in range(W):
            if p[x, y][3] and p[x, y][:3] in (SHIRT, tie):
                if first is None:
                    first = y
                if any(0 <= x + dx < W and 0 <= y + dy < H and p[x + dx, y + dy][3] and p[x + dx, y + dy][:3] in SUIT
                       for dx in range(-2, 3) for dy in range(-2, 3)):
                    return y
    return first if first is not None else H


# ---------------------------------------------------------------- tiers (suit colour carries the tier)
TIERS = {
    # owner: a light grey suit for the base tier; red tie as the rat intern had
    "intern": {"suit": ("#b3b7c0", "#8b909b", "#6e7380"), "seam": "#565b68", "tie": "#d0283a"},
    "analyst": {"suit": ("#2d3b6e", "#1f2850", "#18203f"), "tie": "#d0283a"},
    "associate": {"suit": ("#2f6a3e", "#1f4a2a", "#173a20"), "tie": "#e0b12e"},
    "vp": {"suit": ("#b3243c", "#80182b", "#5e1020"), "tie": "#e0b12e"},
    "partner": {"suit": ("#2c2c36", "#1b1b22", "#131318"), "tie": "#e8b923"},
}
TIER_NAMES = ["intern", "analyst", "associate", "vp", "partner", "frozen"]
ANALYST_TIE = rgb(TIERS["analyst"]["tie"])
GOLD, GOLD_LAPEL = rgb("#e8b923"), rgb("#f0c43a")


def tier_frame(im, t):
    """A base-palette frame in tier t's suit and tie (no outline)."""
    spec = TIERS[t]
    out = im.copy()
    p, s = out.load(), im.load()
    W, H = im.size
    cr = collar_row(im)
    suit = {SUIT[i]: rgb(spec["suit"][i]) for i in range(3)}
    tie = rgb(spec["tie"])
    seam = rgb(spec["seam"]) if "seam" in spec else None
    for y in range(H):
        for x in range(W):
            c = s[x, y]
            if not c[3]:
                continue
            k = c[:3]
            if k in suit:
                p[x, y] = suit[k] + (255,)
            elif k == TIE:
                p[x, y] = tie + (255,)
            elif seam and k == SEAM and y > cr + 1:
                # inner seams on a pale suit go mid grey; the suit's own edge (next to empty space) stays dark
                if all(s[x + dx, y + dy][3] for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)) if 0 <= x + dx < W and 0 <= y + dy < H):
                    p[x, y] = seam + (255,)
    if t == "partner":  # gold tie widened into the shirt, gold lapels, gold collar from behind
        has_tie = any(s[x, y][3] and s[x, y][:3] == TIE for y in range(H) for x in range(W))
        for y in range(cr, min(cr + 11, H - 1)):
            for x in range(1, W - 1):
                c = s[x, y]
                if not c[3]:
                    continue
                n8 = [s[x + dx, y + dy] for dx in (-1, 0, 1) for dy in (-1, 0, 1) if dx or dy]
                if not has_tie and y < cr + 2 and c[:3] == SHIRT:
                    p[x, y] = GOLD + (255,)
                elif c[:3] in SUIT[:2] and any(q[3] and q[:3] in (SHIRT, TIE) for q in n8):
                    p[x, y] = GOLD_LAPEL + (255,)
                elif c[:3] == SHIRT and y > cr and any(s[x + dx, y][3] and s[x + dx, y][:3] == TIE for dx in (-1, 1)):
                    p[x, y] = GOLD + (255,)
    return out


def frozen_frame(im):
    """Whole Shiba icy grey (outline kept)."""
    out = im.copy()
    p = out.load()
    for y in range(out.height):
        for x in range(out.width):
            c = p[x, y]
            if not c[3] or c[:3] == OUTLINE:
                continue
            lum = int(70 + _lum(c) * 0.62)
            p[x, y] = (lum, min(255, lum + 3), min(255, lum + 12), 255)
    return out


def look_frame(base_im, t):
    """A base-palette frame -> the final frame of tier t (with the 1px outline)."""
    if t == "frozen":
        return frozen_frame(add_outline(tier_frame(base_im, "analyst")))
    return add_outline(tier_frame(base_im, t))


# ---------------------------------------------------------------- fur coats
def _hls(c):
    return colorsys.rgb_to_hls(*[v / 255 for v in c])


def _from_hls(h, l, s):
    return tuple(max(0, min(255, round(v * 255))) for v in colorsys.hls_to_rgb(h % 1.0, max(0, min(1, l)), max(0, min(1, s))))


def fur_role(c):
    """'fur' (the orange coat and its brown shading/outline), 'cream' (mask, chest, tail tip) or None. Only colours
    of the base character count, so the gold ties and lapels of the tiers are never taken for fur."""
    if c not in _base_set():
        return None
    h, l, s = _hls(c)
    if not (10 / 360 <= h <= 48 / 360):
        return None
    if l >= 0.75 and s >= 0.5:
        return "cream"
    if s >= 0.3 and l >= 0.2:
        return "fur"
    return None


def coat_color(c, coat):
    """The colour a base fur/cream colour takes in a coat. Coat keys keep the rat fur names the site uses:
    grey = golden tan (as generated), brown = red, black = black and tan, white = cream."""
    role = fur_role(c)
    if coat == "grey" or role is None:
        return c
    h, l, s = _hls(c)
    if coat == "brown":   # red shiba: deeper red-orange coat, cream stays
        return _from_hls(h - 14 / 360, l * 0.86, min(1, s * 1.02)) if role == "fur" else c
    if coat == "black":   # black and tan: near-black coat (the tan rim is added by coat_swap), cream stays
        return _from_hls(255 / 360, 0.07 + l * 0.26, 0.18) if role == "fur" else c
    if coat == "white":   # cream shiba: pale cream coat, whiter mask
        if role == "cream":
            return _from_hls(38 / 360, min(0.95, l + 0.07), 0.75)
        return _from_hls(36 / 360, (l + 0.30) if l < 0.33 else (0.66 + l * 0.27), 0.55)
    raise ValueError(coat)


TAN = rgb("#c98a3c")


def coat_swap(im, coat):
    """Recolour an image's fur into a coat (exact colour swap; black and tan also gets tan points where the black
    coat meets the cream mask)."""
    if coat == "grey":
        return im
    out = im.copy()
    p, s = out.load(), im.load()
    W, H = im.size
    cache = {}
    for y in range(H):
        for x in range(W):
            c = s[x, y]
            if not c[3]:
                continue
            k = c[:3]
            if k not in cache:
                cache[k] = (coat_color(k, coat), fur_role(k))
            q, role = cache[k]
            if coat == "black" and role == "fur" and _hls(k)[1] > 0.4:
                # tan points: coat pixels touching the cream mask
                if any(0 <= x + dx < W and 0 <= y + dy < H and s[x + dx, y + dy][3] and fur_role(s[x + dx, y + dy][:3]) == "cream"
                       for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                    q = TAN
            p[x, y] = q + (c[3],)
    return out
