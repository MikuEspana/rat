#!/usr/bin/env python3
"""Cut the picked Wall Street Inu props in assets/raw/props7/ into assets/raw/props7/crops/<frame>.png (free).

  python3 tools/cut_props7.py

The evil tower keeps its original pixels below the roof and takes only the edited Shiba statue on top; vault_5's
opaque background is flood-filled out from the edges;
the rich sheet is split into its separate objects and the shiba statue (4th from the left) kept.
tools/build_props3.py then uses these crops in place of the rat frames of the same name.
"""
import os
from collections import deque
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(os.path.dirname(HERE), "assets", "raw", "props7")
CROPS = os.path.join(RAW, "crops")


def key_out(im, tol=40):
    """clear every pixel connected to the border whose colour is within tol of the corner colour"""
    im = im.convert("RGBA")
    px, (w, h) = im.load(), im.size
    bg = px[0, 0]
    near = lambda c: c[3] < 20 or sum(abs(c[i] - bg[i]) for i in range(3)) <= tol
    seen, q = set(), deque((x, y) for x in range(w) for y in (0, h - 1)) + deque((x, y) for y in range(h) for x in (0, w - 1))
    while q:
        x, y = q.popleft()
        if (x, y) in seen or not (0 <= x < w and 0 <= y < h):
            continue
        seen.add((x, y))
        if near(px[x, y]):
            px[x, y] = (0, 0, 0, 0)
            q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return im


def tight(im):
    return im.crop(im.getbbox())


def columns(im):
    """split a one-row sheet into objects at fully transparent columns"""
    a = im.getchannel("A")
    w, h = im.size
    filled = [any(a.getpixel((x, y)) > 20 for y in range(h)) for x in range(w)]
    runs, start = [], None
    for x, f in enumerate(filled + [False]):
        if f and start is None:
            start = x
        elif not f and start is not None:
            runs.append((start, x)); start = None
    return [tight(im.crop((s, 0, e, h))) for s, e in runs if e - s > 4]


def tower(cut=72):
    """the rat tower with only its rooftop statue swapped: the edited image above row `cut`, the original below"""
    orig = Image.open(os.path.join(RAW, "evil_rat_tower_in.png")).convert("RGBA")
    edit = Image.open(os.path.join(RAW, "evil_rat_tower_edit.png")).convert("RGBA")
    out = orig.copy()
    out.paste(edit.crop((0, 0, orig.width, cut)), (0, 0))
    return tight(out)


os.makedirs(CROPS, exist_ok=True)
out = {
    "giant_rat_statue": tight(Image.open(os.path.join(RAW, "giant_shiba_statue.png")).convert("RGBA")),
    "evil_rat_tower": tower(),
    "vault_5": tight(key_out(Image.open(os.path.join(RAW, "vault_5.png")))),
    "rat_statue": columns(Image.open(os.path.join(RAW, "rich.png")).convert("RGBA"))[3],
}
# the Vault's keep-out box (src/floor/signs.ts vaultKeepOut) is sized off the widest stage: keep the money bin
# no wider than the rat one (222 px) so THE VAULT's sign layout is unchanged
v = out["vault_5"]
if v.width > 222:
    out["vault_5"] = v.resize((222, round(v.height * 222 / v.width)), Image.NEAREST)
for name, im in out.items():
    im.save(os.path.join(CROPS, f"{name}.png"))
    print(name, im.size)
