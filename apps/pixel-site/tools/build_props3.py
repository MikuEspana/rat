#!/usr/bin/env python3
"""Build assets/props3.png + props3.json: the PixelLab world and vignette props (round 2).

  python3 tools/build_props3.py

Crops come from assets/raw/props3/crops/ (cut from the generated sheets; ids and prompts in assets/raw/props3/log.json
and assets/manifest.json). Every frame anchors at its bottom centre (where it stands). Frames load with the 'world:'
prefix.
"""
import json, os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
OUT = os.path.join(APP, "assets")
CROPS = os.path.join(OUT, "raw", "props3", "crops")

NAMES = {
    "house_a_0": "house_a", "house_b_0": "house_b", "shop_row_0": "shop", "brick_block_0": "brick_block",
    "glass_tower_0": "glass_tower", "deco_tower_0": "deco_tower", "evil_tower_0": "evil_tower", "evil_block_0": "evil_rat_tower",
    "crane_0": "crane", "scaffold_0": "scaffold",
    "street_props_0": "hydrant", "street_props_1": "bus_stop", "street_props_2": "bench", "street_props_3": "mailbox",
    "street_props_4": "trash_can",
    "trees_0": "tree_round", "trees_1": "tree_pine", "trees_2": "tree_bushy", "trees_3": "tree_square",
    "cars_a_0": "car_red", "cars_a_1": "car_blue", "cars_a_2": "taxi", "cars_a_3": "van",
    "cars_b_0": "limo", "cars_b_1": "police", "cars_b_2": "car_white", "cars_b_3": "car_gold",
    "construction_kit_0": "cone", "construction_kit_1": "ladder", "construction_kit_2": "sign_post", "construction_kit_3": "cement",
    "construction_kit_4": "barrier",
    "disaster_0": "rack_fire", "disaster_1": "copier_jam", "disaster_2": "fax_smoke", "disaster_3": "copier_beige",
    "disaster_4": "wet_floor", "disaster_5": "extinguisher",
    "party_0": "donut_box", "party_1": "pizza_boxes", "party_2": "cake", "party_3": "punch", "party_4": "balloons",
    "fun_0": "ping_pong", "fun_1": "foosball", "fun_2": "arcade", "fun_3": "beanbag", "fun_4": "aquarium",
    "rich_0": "gold_bars", "rich_1": "money_counter", "rich_2": "rat_statue", "rich_3": "cash_pile", "rich_4": "globe",
    "meeting_0": "chart_screen", "meeting_1": "chart_crash", "meeting_2": "chart_up", "meeting_3": "projector",
    "meeting_4": "water_jug",
    "evil_0": "throne", "evil_1": "red_button", "evil_2": "shark_tank", "evil_3": "coin_stack", "evil_4": "skull_flag",
    "eggs_0": "disco_ball", "eggs_1": "phone_booth", "eggs_2": "treasure", "eggs_3": "ufo", "eggs_4": "rubber_duck",
}

items = []
for src, name in NAMES.items():
    im = Image.open(os.path.join(CROPS, f"{src}.png")).convert("RGBA")
    im = im.crop(im.getbbox())
    items.append((name, src, im))

W = 1024
x = y = row = 0
pos = {}
for name, _, im in sorted(items, key=lambda t: -t[2].height):
    if x + im.width > W:
        x, y, row = 0, y + row + 1, 0
    pos[name] = (x, y)
    x += im.width + 1
    row = max(row, im.height)
H = y + row + 1
sheet = Image.new("RGBA", (W, H), (0, 0, 0, 0))
frames = {}
for name, src, im in items:
    px, py = pos[name]
    sheet.alpha_composite(im, (px, py))
    frames[name] = {"frame": {"x": px, "y": py, "w": im.width, "h": im.height}, "anchor": {"x": 0.5, "y": 1.0}, "source": f"raw/props3/crops/{src}.png"}
sheet.save(os.path.join(OUT, "props3.png"), optimize=True)
json.dump({"frames": frames, "meta": {"app": "rat-race pixel-site tools/build_props3.py", "image": "props3.png", "size": {"w": W, "h": H}}},
          open(os.path.join(OUT, "props3.json"), "w"), indent=1)
print(f"props3.png {W}x{H}, {len(frames)} frames")
