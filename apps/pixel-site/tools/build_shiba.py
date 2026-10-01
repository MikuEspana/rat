#!/usr/bin/env python3
"""Build the Wall Street Inu (Shiba) tier sheets and assets/rats.png + rats.json from assets/raw/shiba/.

  python3 tools/build_shiba.py        # free, local (PIL only), a few seconds
  python3 tools/build_rats2.py        # then the full look atlas the site loads (rats2.png + rats2.json)

Drop-in replacement for the rat part of tools/build_assets.py: same 55 frame names in the same order, same 68x68
cells, same tier sheets (assets/build/tier_<tier>.png, 10 columns) and the same rats.json keys and anchors, so the
game code needs no change. File and key names still say "rat"; the art is the Shiba.

Sources (every PixelLab call is logged in assets/raw/shiba/log.json and in assets/manifest.json):
- raw/shiba/character/  the base character 0ca6ab26-609a-48e0-8e87-96c679852c13 ("WSI C_doge"): 8 rotations,
                        walk (walking-8-frames) and idle (breathing-idle) for south-east and north-east, 96 canvas,
                        brought down to the rat's 68 cell by shiba_common.to_cell.
- raw/shiba/cheer, type, slump  animate_image at 68x68 (cheer from rot_se, type and slump from raw/shiba/seat, an
                        edit_image_pixen of rot_e), snapped to the base palette.
Tiers are local recolours of suit and tie (shiba_common.look_frame), so every look is the same Shiba.
"""
import json, math, os, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
OUT = os.path.join(APP, "assets")
RAW = os.path.join(OUT, "raw", "shiba")
BUILD = os.path.join(OUT, "build")
PREV = os.path.join(OUT, "preview")
sys.path.insert(0, HERE)
from shiba_common import CELL, TIER_NAMES, look_frame, snap, to_cell  # noqa: E402


def L(p):
    return Image.open(p).convert("RGBA")


ORDER = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"]
SHORT = {"south": "s", "south-east": "se", "east": "e", "north-east": "ne", "north": "n", "north-west": "nw", "west": "w", "south-west": "sw"}

# ---------------------------------------------------------------- 1) base frames (the Shiba as generated)
cd = os.path.join(RAW, "character")
meta = json.load(open(os.path.join(cd, "metadata.json")))["states"][0]["frames"]
base = [("rot_" + SHORT[d], to_cell(L(os.path.join(cd, meta["rotations"][d])))) for d in ORDER]
for anim, n in (("idle", 4), ("walk", 8)):
    for d in ("south-east", "north-east"):
        paths = meta["animations"][anim][d]
        assert len(paths) == n, (anim, d, len(paths))
        base += [(f"{anim}_{SHORT[d]}_{i}", to_cell(L(os.path.join(cd, p)))) for i, p in enumerate(paths)]
for anim, n in (("cheer", 9), ("type", 7), ("slump", 7)):
    base += [(f"{anim}_{i}", snap(L(os.path.join(RAW, anim, f"{i}.png")), gloom=anim == "slump")) for i in range(n)]
NAMES = [k for k, _ in base]
assert len(NAMES) == 55, len(NAMES)
os.makedirs(BUILD, exist_ok=True)
COLS = 10


def grid(frames, cols):
    rows = math.ceil(len(frames) / cols)
    g = Image.new("RGBA", (cols * CELL, rows * CELL), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        g.alpha_composite(f, ((i % cols) * CELL, (i // cols) * CELL))
    return g


grid([f for _, f in base], COLS).save(os.path.join(BUILD, "shiba_base.png"))  # base palette, used by build_rats2.py

# ---------------------------------------------------------------- 2) tiers
looks = {t: [look_frame(f, t) for _, f in base] for t in TIER_NAMES}
sheets = {t: grid(fr, COLS) for t, fr in looks.items()}
for t, sh in sheets.items():
    sh.save(os.path.join(BUILD, f"tier_{t}.png"))

# ---------------------------------------------------------------- 3) rats atlas (same layout as build_assets.py)
TW, TH = sheets["analyst"].size
atlas = Image.new("RGBA", (TW * 2, TH * 3), (0, 0, 0, 0))
frames, anims = {}, {}
ANIM_INFO = {"rot": None, "idle_se": (5, True), "idle_ne": (5, True), "walk_se": (10, True), "walk_ne": (10, True),
             "cheer": (10, False), "type": (8, True), "slump": (6, False)}


def anim_key(name):
    for p in ("idle_se", "idle_ne", "walk_se", "walk_ne"):
        if name.startswith(p + "_"):
            return p
    return name.rsplit("_", 1)[0]


def foot(frame):
    bb = frame.getbbox()
    return bb[3] if bb else CELL


analyst = looks["analyst"]
for ti, t in enumerate(TIER_NAMES):
    ox, oy = (ti % 2) * TW, (ti // 2) * TH
    atlas.alpha_composite(sheets[t], (ox, oy))
    for i, k in enumerate(NAMES):
        x, y = ox + (i % COLS) * CELL, oy + (i // COLS) * CELL
        key = f"{t}/{k}"
        ak = anim_key(k)
        ref = analyst[NAMES.index({"type": "type_0", "slump": "slump_0", "cheer": "cheer_0"}.get(ak, "rot_s"))]
        frames[key] = {"frame": {"x": x, "y": y, "w": CELL, "h": CELL}, "rotated": False, "trimmed": False,
                       "spriteSourceSize": {"x": 0, "y": 0, "w": CELL, "h": CELL}, "sourceSize": {"w": CELL, "h": CELL},
                       "anchor": {"x": 0.5, "y": round(foot(ref) / CELL, 4)}}
        if ak != "rot":
            anims.setdefault(f"{t}/{ak}", []).append(key)
atlas.save(os.path.join(OUT, "rats.png"), optimize=True)
json.dump({"frames": frames, "animations": anims,
           "meta": {"app": "wall-street-inu pixel-site tools/build_shiba.py", "image": "rats.png", "format": "RGBA8888",
                    "size": {"w": atlas.width, "h": atlas.height}, "scale": "1",
                    "tiers": TIER_NAMES, "cell": CELL,
                    "anims": {k: ({"fps": v[0], "loop": v[1]} if v else {"static": True}) for k, v in ANIM_INFO.items()},
                    "notes": "Wall Street Inu (Shiba) sprites; keys keep the old rat names. Directions: se and ne are "
                             "drawn; sw and nw are the same frames mirrored (scale.x = -1). rot_<dir> are single "
                             "standing frames for all 8 directions. type and slump are seated on the Shiba's own chair, "
                             "facing screen right; mirror to face left. slump: play once, then loop its last 3 frames."}},
          open(os.path.join(OUT, "rats.json"), "w"), indent=1)
print("rats atlas", atlas.size, len(frames), "frames", len(anims), "animations")

# ---------------------------------------------------------------- 4) preview (tiers x animations)
BG = (226, 232, 238, 255)
show = ["walk_se", "walk_ne", "idle_se", "cheer", "type", "slump"]
S = 2
gif = []
for fi in range(18):
    fr = Image.new("RGBA", (len(show) * CELL * S + 20, len(TIER_NAMES) * CELL * S + 20), BG)
    for ti, t in enumerate(TIER_NAMES):
        for ai, a in enumerate(show):
            names = anims[f"{t}/{a}"]
            k = names[fi % len(names)] if a not in ("cheer", "slump") else names[min(fi, len(names) - 1)]
            f = frames[k]["frame"]
            im = atlas.crop((f["x"], f["y"], f["x"] + CELL, f["y"] + CELL))
            fr.alpha_composite(im.resize((CELL * S, CELL * S), Image.NEAREST), (10 + ai * CELL * S, 10 + ti * CELL * S))
    gif.append(fr)
gif[4].convert("RGB").save(os.path.join(PREV, "rats_all_tiers.png"))
gp = [g.convert("P", palette=Image.ADAPTIVE) for g in gif]
gp[0].save(os.path.join(PREV, "rats_all_tiers.gif"), save_all=True, append_images=gp[1:], duration=120, loop=0, disposal=2)
print("previews written")
