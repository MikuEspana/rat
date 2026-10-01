#!/usr/bin/env python3
"""Build the pixel-site sprite atlases from the raw PixelLab outputs in assets/raw/.

Every pixel edit runs through the PixelLab MCP `pixelart_workbench` tool (free), so the art is PixelLab's and the
edits are replayable. This script only decides the edits, arranges frames and packs atlases.

  pip install pillow
  PIXELLAB_API_KEY=... python3 tools/build_assets.py

Outputs (assets/):
  rats.png + rats.json    one atlas, every tier x every animation, 68x68 cells (one texture for all 3,000 rats)
  world.png + world.json  tiles and props
  preview/                contact sheets and GIFs for review
  build/                  intermediate sheets and the workbench image ids (build/edits.json)
"""
import base64, io, json, math, os, sys, urllib.request
from PIL import Image, ImageDraw

if "--legacy-rats" not in sys.argv:
    # Wall Street Inu: the character sheets (rats.png/json, build/tier_*.png) now come from tools/build_shiba.py.
    # This script would overwrite them with the old rat; world.png is unchanged and needs no rebuild.
    raise SystemExit("rats.png is built by tools/build_shiba.py now; pass --legacy-rats to rebuild the old rat and world atlases")

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
RAW = os.path.join(APP, "assets", "raw")
OUT = os.path.join(APP, "assets")
BUILD = os.path.join(OUT, "build")
PREV = os.path.join(OUT, "preview")
for d in (BUILD, PREV):
    os.makedirs(d, exist_ok=True)
sys.path.insert(0, HERE)
from pixellab_mcp import call  # noqa: E402

CELL = 68
EDIT_LOG = {}


def hx(c):
    return "#%02x%02x%02x" % tuple(c[:3])


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def workbench(name, img, changes, note):
    """Run one pixelart_workbench edit on a PIL image; return the edited PIL image."""
    buf = io.BytesIO()
    img.save(buf, "PNG")
    data = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    for attempt in range(4):
        try:
            msg = call("pixelart_workbench", {"argv": ["edit", data, "--changes", json.dumps(changes)], "notes": note})
            break
        except Exception as e:  # network blips
            print(f"  {name}: retry after {e}")
    text = "\n".join(p.get("text", "") for p in msg["result"]["content"] if p.get("type") == "text")
    ids = [l.split(": ")[1] for l in text.splitlines() if l.startswith("image_id")]
    if not ids:
        raise SystemExit(f"{name}: workbench refused:\n{text[:1500]}")
    with urllib.request.urlopen(f"https://api.pixellab.ai/mcp/pixel-tools/{ids[0]}/image.png", timeout=60) as r:
        out = Image.open(io.BytesIO(r.read())).convert("RGBA")
    EDIT_LOG[name] = {"workbenchImageId": ids[0], "ops": [l.strip() for l in text.splitlines() if "px changed" in l]}
    json.dump(changes, open(os.path.join(BUILD, f"edit_{name}.json"), "w"))
    print(f"  {name}: {ids[0]} {EDIT_LOG[name]['ops'][:4]}")
    return out


def grid(frames, cols):
    rows = math.ceil(len(frames) / cols)
    g = Image.new("RGBA", (cols * CELL, rows * CELL), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        g.alpha_composite(f, ((i % cols) * CELL, (i // cols) * CELL))
    return g


def ungrid(g, n, cols):
    return [g.crop(((i % cols) * CELL, (i // cols) * CELL, (i % cols) * CELL + CELL, (i // cols) * CELL + CELL)) for i in range(n)]


def L(p):
    return Image.open(p).convert("RGBA")


# ---------------------------------------------------------------- palette of the Phase 1 rat (grey suit)
FUR, FUR_D = (0x74, 0x73, 0x83), (0x4E, 0x4B, 0x5C)
TEAL, WHITE = (0x14, 0x7E, 0x89), (0xE1, 0xE1, 0xE4)
PINK = {(0xDF, 0x84, 0x93), (0xCC, 0x58, 0x73), (0xE8, 0x7A, 0x91), (0xEE, 0x94, 0xA1), (0x9D, 0x5E, 0x72)}
SEAM = (0x32, 0x2E, 0x33)
NAVY, NAVY_D, RED = "#2d3b6e", "#1f2850", "#d0283a"
OUTLINE = "#16182c"
GLOOM, GLOOM_D = "#4a68f0", "#3346c8"


def navy_changes(g, n, cols):
    """Owner-approved analyst look: suit below each cell's collar row -> navy, teal tie -> red, thin tail edge kept
    grey, 1px outer outline. Fur and suit share one grey, hence the per-cell collar split."""
    px = g.load()
    ch, restore = [], []
    for f in range(n):
        x0, y0 = (f % cols) * CELL, (f // cols) * CELL
        collar = next((y for y in range(CELL) if any(px[x0 + x, y0 + y][3] and px[x0 + x, y0 + y][:3] in (WHITE, TEAL)
                                                    for x in range(CELL))), None)
        if collar is None:
            raise SystemExit(f"cell {f}: no collar row")
        ch.append({"operation": "map_colors", "layer": "image", "frames": [1],
                   "region": [x0, y0 + collar, x0 + CELL - 1, y0 + CELL - 1], "colors": {hx(FUR): NAVY, hx(FUR_D): NAVY_D},
                   "reason": f"cell {f + 1}: suit below collar row {collar} goes navy"})
        for y in range(collar, CELL):
            for x in range(CELL):
                c = px[x0 + x, y0 + y]
                if not c[3] or c[:3] not in (FUR, FUR_D):
                    continue
                nb = lambda dx, dy: px[x0 + x + dx, y0 + y + dy] if 0 <= x + dx < CELL and 0 <= y + dy < CELL else (0, 0, 0, 0)
                n8 = [nb(dx, dy)[:3] for dx in (-1, 0, 1) for dy in (-1, 0, 1) if (dx or dy) and nb(dx, dy)[3]]
                n4 = [nb(dx, dy)[:3] for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)) if nb(dx, dy)[3]]
                if any(p in PINK for p in n8) and sum(p in (FUR, FUR_D) for p in n4) <= 2:
                    restore.append([x0 + x, y0 + y, NAVY if c[:3] == FUR else NAVY_D, hx(c)])
    ch.append({"operation": "map_colors", "layer": "image", "frames": [1], "region": [0, 0, g.width - 1, g.height - 1],
               "colors": {hx(TEAL): RED}, "reason": "teal tie -> red tie"})
    if restore:
        ch.append({"operation": "patch_pixels", "layer": "image", "frames": [1], "pixels": restore,
                   "reason": "thin tail edge pixels keep the fur grey"})
    ch.append({"operation": "outline", "mode": "outside", "layer": "image", "frames": [1], "width": 1, "connectivity": 8,
               "color": OUTLINE, "reason": "1px dark outer outline so rats read on the pale floor"})
    return ch


# ---------------------------------------------------------------- 1) grey PixelLab frames -> navy analyst
ORDER = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"]
SHORT = {"south": "s", "south-east": "se", "east": "e", "north-east": "ne", "north": "n", "north-west": "nw", "west": "w", "south-west": "sw"}
meta = json.load(open(os.path.join(RAW, "character", "metadata.json")))["states"][0]["frames"]
cd = os.path.join(RAW, "character")
grey = [("rot_" + SHORT[d], L(os.path.join(cd, meta["rotations"][d]))) for d in ORDER]
for anim, n in (("idle", 4), ("walk", 8)):
    for d in ("south-east", "north-east"):
        paths = meta["animations"][anim][d]
        assert len(paths) == n, (anim, d, len(paths))
        grey += [(f"{anim}_{SHORT[d]}_{i}", L(os.path.join(cd, p))) for i, p in enumerate(paths)]
print("grey frames:", len(grey))
g = grid([f for _, f in grey], 8)
g.save(os.path.join(BUILD, "grey_frames.png"))
navy = ungrid(workbench("navy", g, navy_changes(g, len(grey), 8), "Analyst look for all PixelLab character frames."),
              len(grey), 8)
base = list(zip([k for k, _ in grey], navy))

# ---------------------------------------------------------------- 2) animate_image frames: clean + snap to the palette
PAL = {c for _, f in base for c in {f.getpixel((x, y))[:3] for y in range(CELL) for x in range(CELL) if f.getpixel((x, y))[3]}}
gen = []
for anim, n in (("cheer", 9), ("type", 7), ("slump", 7)):
    gen += [(f"{anim}_{i}", L(os.path.join(RAW, "anim", anim, f"{i}.png"))) for i in range(n)]
g2 = grid([f for _, f in gen], 8)
g2.save(os.path.join(BUILD, "generated_frames.png"))
p2 = g2.load()
erase, snap, gloom = [], {}, {}
for idx, (k, f) in enumerate(gen):
    x0, y0 = (idx % 8) * CELL, (idx // 8) * CELL
    if k.startswith("type_"):  # stray white/cyan glitch in the empty top-right corner of some typing frames
        for y in range(0, 27):
            for x in range(44, CELL):
                c = p2[x0 + x, y0 + y]
                if c[3]:
                    erase.append([x0 + x, y0 + y, hx(c) + "ff", "#00000000"])
for y in range(g2.height):
    for x in range(g2.width):
        c = p2[x, y]
        if not c[3] or c[:3] in PAL:
            continue
        if c[2] > 150 and c[2] > c[0] + 60:  # slump gloom scribble: keep it, as two clean blues
            gloom[hx(c)] = GLOOM if sum(c[:3]) > 330 else GLOOM_D
        else:
            snap[hx(c)] = hx(min(PAL, key=lambda p: (p[0] - c[0]) ** 2 * .3 + (p[1] - c[1]) ** 2 * .59 + (p[2] - c[2]) ** 2 * .11))
ch2 = []
if erase:
    ch2.append({"operation": "patch_pixels", "layer": "image", "frames": [1], "pixels": erase,
                "reason": "erase a stray glitch in the typing frames"})
ch2.append({"operation": "map_colors", "layer": "image", "frames": [1], "region": [0, 0, g2.width - 1, g2.height - 1],
            "colors": {**snap, **gloom}, "reason": "snap drifted colors to the rat palette; gloom scribble to 2 blues"})
gen_clean = ungrid(workbench("generated_clean", g2, ch2, "Clean and palette-snap the cheer, type and slump frames."),
                   len(gen), 8)
base += list(zip([k for k, _ in gen], gen_clean))

# ---------------------------------------------------------------- 3) base sheet (analyst) -> all tiers
NAMES = [k for k, _ in base]
N = len(base)
COLS = 10
sheet = grid([f for _, f in base], COLS)
sheet.save(os.path.join(BUILD, "tier_analyst.png"))
sp = sheet.load()
SEATED = {i for i, k in enumerate(NAMES) if k.startswith(("type_", "slump_"))}


def collar_rows():
    rows = []
    for f in range(N):
        x0, y0 = (f % COLS) * CELL, (f // COLS) * CELL
        rows.append(next((y for y in range(CELL) if any(sp[x0 + x, y0 + y][3] and sp[x0 + x, y0 + y][:3] in (WHITE, rgb(RED))
                                                        for x in range(CELL))), 0))
    return rows


COLLAR = collar_rows()
FULL = [0, 0, sheet.width - 1, sheet.height - 1]
TIERS = {
    "intern": {"suit": ("#7a5a32", "#57401f"), "tie": RED},
    "associate": {"suit": ("#2f6a3e", "#1f4a2a"), "tie": "#e0b12e"},
    "vp": {"suit": ("#b3243c", "#80182b"), "tie": "#e0b12e"},
}
tiers = {"analyst": sheet}
for t, spec in TIERS.items():
    tiers[t] = workbench(f"tier_{t}", sheet, [{"operation": "map_colors", "layer": "image", "frames": [1], "region": FULL,
                                               "colors": {NAVY: spec["suit"][0], NAVY_D: spec["suit"][1], RED: spec["tie"]},
                                               "reason": f"{t}: suit color carries the tier"}], f"Tier {t}.")

# partner: black suit, gold tie widened into the shirt, bright gold lapels, gold seams (standing frames), gold collar from behind
GOLD, GOLD_LAPEL, GOLD_SEAM = "#e8b923", "#f0c43a", "#e2b42c"
seam, lapel, tie, collar = [], [], [], []
for f in range(N):
    x0, y0 = (f % COLS) * CELL, (f // COLS) * CELL
    top = y0 + COLLAR[f]
    has_tie = any(sp[x, y][3] and sp[x, y][:3] == rgb(RED) for y in range(y0, y0 + CELL) for x in range(x0, x0 + CELL))
    for y in range(top, min(top + 11, y0 + CELL)):
        for x in range(x0, x0 + CELL):
            c = sp[x, y]
            if not c[3]:
                continue
            n4 = [sp[x + dx, y + dy] for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))]
            n8 = [sp[x + dx, y + dy] for dx in (-1, 0, 1) for dy in (-1, 0, 1) if dx or dy]
            if not has_tie and y < top + 2 and c[:3] == WHITE:
                collar.append([x, y, hx(WHITE), GOLD])
            elif f not in SEATED and c[:3] == SEAM and all(q[3] and q[:3] != rgb(OUTLINE) for q in n4):
                seam.append([x, y, hx(SEAM), GOLD_SEAM])
            elif c[:3] in (rgb(NAVY), rgb(NAVY_D)) and any(q[3] and q[:3] in (WHITE, rgb(RED)) for q in n8):
                lapel.append([x, y, "#23232b" if c[:3] == rgb(NAVY) else "#16161c", GOLD_LAPEL])
            elif c[:3] == WHITE and y > top and any(sp[x + dx, y][:3] == rgb(RED) for dx in (-1, 1)):
                tie.append([x, y, hx(WHITE), GOLD])
tiers["partner"] = workbench("tier_partner", sheet, [
    {"operation": "map_colors", "layer": "image", "frames": [1], "region": FULL,
     "colors": {NAVY: "#23232b", NAVY_D: "#16161c", RED: GOLD}, "reason": "partner: black suit, gold tie"},
    {"operation": "patch_pixels", "layer": "image", "frames": [1], "pixels": seam, "reason": "gold seams (standing frames only)"},
    {"operation": "patch_pixels", "layer": "image", "frames": [1], "pixels": lapel, "reason": "bright gold lapels"},
    {"operation": "patch_pixels", "layer": "image", "frames": [1], "pixels": tie, "reason": "bigger gold tie"},
    {"operation": "patch_pixels", "layer": "image", "frames": [1], "pixels": collar, "reason": "gold collar on back views"},
], "Tier partner: louder gold so it separates from navy at half zoom.")

cols_all = sorted({sp[x, y][:3] for y in range(sheet.height) for x in range(sheet.width) if sp[x, y][3]})
frozen_map = {}
for c in cols_all:
    if hx(c) == OUTLINE:
        continue
    lum = int(70 + (0.30 * c[0] + 0.59 * c[1] + 0.11 * c[2]) * 0.62)
    frozen_map[hx(c)] = "#%02x%02x%02x" % (lum, lum, min(255, lum + 6))
tiers["frozen"] = workbench("tier_frozen", sheet, [{"operation": "map_colors", "layer": "image", "frames": [1], "region": FULL,
                                                   "colors": frozen_map, "reason": "frozen: whole rat grey, outline kept"}],
                            "Frozen rat: desaturated grey.")

# ---------------------------------------------------------------- 4) rats atlas
TIER_ORDER = ["intern", "analyst", "associate", "vp", "partner", "frozen"]
TW, TH = sheet.size
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


for ti, t in enumerate(TIER_ORDER):
    ox, oy = (ti % 2) * TW, (ti // 2) * TH
    atlas.alpha_composite(tiers[t], (ox, oy))
    tiers[t].save(os.path.join(BUILD, f"tier_{t}.png"))
    for i, k in enumerate(NAMES):
        x, y = ox + (i % COLS) * CELL, oy + (i // COLS) * CELL
        key = f"{t}/{k}"
        ak = anim_key(k)
        ref = base[NAMES.index({"type": "type_0", "slump": "slump_0", "cheer": "cheer_0"}.get(ak, "rot_s"))][1]
        frames[key] = {"frame": {"x": x, "y": y, "w": CELL, "h": CELL}, "rotated": False, "trimmed": False,
                       "spriteSourceSize": {"x": 0, "y": 0, "w": CELL, "h": CELL}, "sourceSize": {"w": CELL, "h": CELL},
                       "anchor": {"x": 0.5, "y": round(foot(ref) / CELL, 4)}}
        if ak != "rot":
            anims.setdefault(f"{t}/{ak}", []).append(key)
atlas.save(os.path.join(OUT, "rats.png"), optimize=True)
json.dump({"frames": frames, "animations": anims,
           "meta": {"app": "rat-race pixel-site tools/build_assets.py", "image": "rats.png", "format": "RGBA8888",
                    "size": {"w": atlas.width, "h": atlas.height}, "scale": "1",
                    "tiers": TIER_ORDER, "cell": CELL,
                    "anims": {k: ({"fps": v[0], "loop": v[1]} if v else {"static": True}) for k, v in ANIM_INFO.items()},
                    "notes": "Directions: se and ne are drawn; sw and nw are the same frames mirrored (scale.x = -1). "
                             "rot_<dir> are single standing frames for all 8 directions. type and slump are seated on the "
                             "rat's own chair, facing screen right; mirror to face left. slump: play once, then loop "
                             "its last 3 frames."}},
          open(os.path.join(OUT, "rats.json"), "w"), indent=1)
print("rats atlas", atlas.size, len(frames), "frames", len(anims), "animations")

# ---------------------------------------------------------------- 5) world props
props = {}
props["floor_office"] = L(os.path.join(RAW, "tiles", "floor_office.png"))
props["floor_subway"] = L(os.path.join(RAW, "tiles", "floor_subway.png"))
props["floor_hq"] = L(os.path.join(RAW, "tiles", "floor_hq.png"))
props["wall"] = L(os.path.join(RAW, "tiles", "wall.png"))
desk_raw = L(os.path.join(RAW, "props", "desk.png"))
desk_oak = workbench("desk_oak", desk_raw, json.load(open(os.path.join(HERE, "edits", "desk_oak.json"))),
                     "Oak desk top with a lit green screen.")
props["desk_oak"] = desk_oak
props["desk_oak_clutter"] = workbench("desk_oak_clutter", desk_oak,
                                      json.load(open(os.path.join(HERE, "edits", "desk_oak_clutter.json"))),
                                      "A3 desk clutter on the oak desk.")
sheet_p = L(os.path.join(RAW, "props", "props_sheet.png"))
for name, (a, b) in zip(["plant", "mug", "papers", "lamp_and_cables", "bin"], [(17, 52), (79, 112), (136, 179), (204, 244), (273, 298)]):
    c = sheet_p.crop((a, 0, b, sheet_p.height))
    props[name] = c.crop(c.getbbox())
lc = props.pop("lamp_and_cables")
lamp, cables = lc.copy(), Image.new("RGBA", lc.size, (0, 0, 0, 0))
for y in range(lc.height):
    for x in range(lc.width):
        if x <= 20 and y >= 25 and lc.getpixel((x, y))[3]:
            cables.putpixel((x, y), lc.getpixel((x, y)))
            lamp.putpixel((x, y), (0, 0, 0, 0))
props["lamp"], props["cables"] = lamp.crop(lamp.getbbox()), cables.crop(cables.getbbox())
chair = L(os.path.join(RAW, "props", "chair.png"))
props["chair"] = chair.crop(chair.getbbox())
# dark chair for empty seats: same black chair the seated rat sprites sit on, same 1px outline
RAMP = ["#131025", "#171618", "#262325", "#322e33", "#4e4b5c"]
ch = props["chair"]
pad = Image.new("RGBA", (ch.width + 2, ch.height + 2), (0, 0, 0, 0))
pad.alpha_composite(ch, (1, 1))
cols = {pad.getpixel((x, y))[:3] for y in range(pad.height) for x in range(pad.width) if pad.getpixel((x, y))[3]}
lums = sorted(0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2] for c in cols)
lo, hi = lums[0], lums[-1]
dark_map = {hx(c): RAMP[min(len(RAMP) - 1, int((0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2] - lo) / max(1, hi - lo) * len(RAMP)))] for c in cols}
props["chair_dark"] = workbench("chair_dark", pad, [
    {"operation": "map_colors", "layer": "image", "frames": [1], "region": [0, 0, pad.width - 1, pad.height - 1],
     "colors": dark_map, "reason": "empty-seat chair in the seated rats' black chair palette"},
    {"operation": "outline", "mode": "outside", "layer": "image", "frames": [1], "width": 1, "connectivity": 8,
     "color": OUTLINE, "reason": "same 1px outline as the rats"}], "Dark chair for empty seats.")
tk = L(os.path.join(RAW, "props", "ticker.png"))
tk = tk.crop(tk.getbbox())
tp = tk.load()
text_px = [[x, y, hx(tp[x, y]), "#0a0a0a"] for y in range(tk.height) for x in range(tk.width)
           if tp[x, y][3] and 3 <= x < tk.width - 3 and 3 <= y < tk.height - 3
           and ((tp[x, y][1] > tp[x, y][0] + 10 and tp[x, y][1] > tp[x, y][2] + 6 and tp[x, y][1] > 24)
                or (tp[x, y][0] > tp[x, y][1] + 14 and tp[x, y][0] > 30))]
blank = workbench("ticker_blank", tk, [{"operation": "patch_pixels", "layer": "image", "frames": [1], "pixels": text_px,
                                         "reason": "blank the demo numbers; the site draws live symbol and 24h % on it"}],
                  "Blank wall ticker screen for live text.")


def shear_right_wall(im):  # each column down x/2: sits on the left face of a wall running down-right (2:1)
    out = Image.new("RGBA", (im.width, im.height + im.width // 2 + 1), (0, 0, 0, 0))
    for x in range(im.width):
        out.paste(im.crop((x, 0, x + 1, im.height)), (x, x // 2))
    return out


props["ticker_wall"] = shear_right_wall(blank)
props["ticker_wall_busy"] = shear_right_wall(tk)
for name in ("stairs", "furnace", "cashbag"):
    im = L(os.path.join(RAW, "props", f"{name}.png"))
    props[name] = im.crop(im.getbbox())

# shelf-pack into 512 wide
order = sorted(props, key=lambda k: -props[k].height)
W, x, y, rowh, pos = 512, 0, 0, 0, {}
for k in order:
    im = props[k]
    if x + im.width > W:
        x, y, rowh = 0, y + rowh + 2, 0
    pos[k] = (x, y)
    x += im.width + 2
    rowh = max(rowh, im.height)
world = Image.new("RGBA", (W, y + rowh), (0, 0, 0, 0))
wf = {}
TILE_ANCHOR = {"floor_office": (16, 11), "floor_subway": (16, 11), "floor_hq": (16, 11), "wall": (16, 16)}
for k, (x, y) in pos.items():
    im = props[k]
    world.alpha_composite(im, (x, y))
    ax, ay = TILE_ANCHOR.get(k, (im.width / 2, im.height))
    wf[k] = {"frame": {"x": x, "y": y, "w": im.width, "h": im.height}, "rotated": False, "trimmed": False,
             "spriteSourceSize": {"x": 0, "y": 0, "w": im.width, "h": im.height}, "sourceSize": {"w": im.width, "h": im.height},
             "anchor": {"x": round(ax / im.width, 4), "y": round(ay / im.height, 4)}}
world.save(os.path.join(OUT, "world.png"), optimize=True)
json.dump({"frames": wf, "meta": {"app": "rat-race pixel-site tools/build_assets.py", "image": "world.png", "format": "RGBA8888",
                                  "size": {"w": world.width, "h": world.height}, "scale": "1",
                                  "notes": "Isometric cell = 32x16. Tiles anchor at the top apex of their top face; props anchor "
                                           "at the bottom centre (stand on the cell centre). ticker_wall is pre-skewed for a "
                                           "wall running down-right; mirror it for a wall running down-left."}},
          open(os.path.join(OUT, "world.json"), "w"), indent=1)
print("world atlas", world.size, len(wf), "props")
json.dump(EDIT_LOG, open(os.path.join(BUILD, "edits.json"), "w"), indent=1)

# ---------------------------------------------------------------- 6) previews
BG = (226, 232, 238, 255)
show = ["walk_se", "walk_ne", "idle_se", "cheer", "type", "slump"]
S = 2
nframes = 18
gif = []
for fi in range(nframes):
    fr = Image.new("RGBA", (len(show) * CELL * S + 20, len(TIER_ORDER) * CELL * S + 20), BG)
    for ti, t in enumerate(TIER_ORDER):
        for ai, a in enumerate(show):
            names = anims[f"{t}/{a}"]
            k = names[fi % len(names)] if a not in ("cheer", "slump") else names[min(fi, len(names) - 1)]
            f = frames[k]["frame"]
            im = atlas.crop((f["x"], f["y"], f["x"] + CELL, f["y"] + CELL))
            fr.alpha_composite(im.resize((CELL * S, CELL * S), Image.NEAREST), (10 + ai * CELL * S, 10 + ti * CELL * S))
    gif.append(fr.convert("P", palette=Image.ADAPTIVE))
gif[0].save(os.path.join(PREV, "rats_all_tiers.gif"), save_all=True, append_images=gif[1:], duration=120, loop=0, disposal=2)
still = Image.new("RGBA", (world.width + 20, world.height + 20), BG)
still.alpha_composite(world, (10, 10))
still.resize((still.width * 2, still.height * 2), Image.NEAREST).save(os.path.join(PREV, "world_atlas_2x.png"))
print("previews written")
