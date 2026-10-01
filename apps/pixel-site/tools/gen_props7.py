#!/usr/bin/env python3
"""Generate the Wall Street Inu (Shiba) replacements for the rat-themed props into assets/raw/props7/.

  PIXELLAB_API_KEY=... python3 tools/gen_props7.py <name> [<name> ...]     # 1 generation each
  PIXELLAB_API_KEY=... python3 tools/gen_props7.py --edit evil_rat_tower    # edit_image_pixen, 1 generation

Same tool, size, view and style words as the rat originals (assets/raw/props3|5|6/log.json), with rat swapped for
shiba inu. Each call is appended to assets/raw/props7/log.json; files land as <name>.png (earlier ones kept as
<name>_reject<n>.png). Then tools/build_props3.py picks them up.
"""
import json, os, re, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "assets", "raw", "props7")
sys.path.insert(0, HERE)
from regenerate import text, image_parts, poll  # noqa: E402

STYLE = {"view": "high top-down", "outline": "selective outline", "shading": "basic shading", "detail": "high detail"}
ALONE = "a single object standing alone in the centre, no surrounding scenery, transparent background."
JOBS = {
    "giant_shiba_statue": (160, 224, "a giant shiny solid gold metal statue of a shiba inu dog, the whole dog cast in gleaming yellow gold with gold highlights, not orange fur, sitting proudly in the classic doge pose, pointy ears, curled tail, head tilted with a smug side-eye, on top of a tall white marble plinth with a stepped base, the whole plinth fully visible down to its bottom edge with empty space below it, " + ALONE + " Night city, clean bright corporate style, isometric three-quarter view"),
    "rich": (400, 96, "sprite sheet of five separate office props in one row with empty space between them, not touching, each standing on its own: stack of shiny gold bars, electronic money counting machine with banknotes, big pile of green cash stacks on a small table, small golden shiba inu dog statue sitting on a marble pedestal, antique globe on a wooden stand. Clean bright corporate office, isometric three-quarter view"),
    "evil_block": (224, 288, "dark grey fortress-like office block with red neon trim and a giant glowing shiba inu dog head logo sign on its front, " + "a single object standing alone in the centre. Night city, clean bright corporate style, isometric three-quarter view"),
    "rocket": (112, 256, "a tall white space rocket standing upright on its three fins, a large rocket filling the frame from top to bottom, two big pointy triangular orange shiba inu dog ears sticking up from the sides of the nose cone, a round doge meme shiba inu face logo painted on its side (golden tan and cream fur, cream face mask, side-eye expression), engines off, the bottom of the rocket clean with no flame, no fire, no smoke, no exhaust, " + ALONE + " Night city, clean bright corporate style, isometric three-quarter view"),
    "vault_5": (256, 256, "a giant round riveted steel money bin like a huge silo, filled to the brim with gold coins and green cash, three small doge meme shiba inu dogs with golden tan and cream fur, cream face masks, side-eye expressions, pointy ears and fluffy curled tails, wearing navy business suits with white shirts and blue ties, swimming and diving in the coins, " + ALONE + " Night office, clean bright corporate style, isometric three-quarter view"),
}


EDITS = {
    # the rat on the roof is the only rat on this tower: edit just that (tools/cut_props7.py keeps the original pixels
    # everywhere below the statue)
    "evil_rat_tower": ("evil_rat_tower_in.png", "replace the big red rat statue sitting on the roof with a big red glowing shiba inu dog statue sitting in the doge meme pose, pointy ears, fluffy curled tail, side-eye expression, same red colour and size; keep the dark tower, its red neon trim and everything else exactly the same"),
}


def edit(name):
    import base64
    from pixellab_mcp import call, KEY
    src, desc = EDITS[name]
    data = "data:image/png;base64," + base64.b64encode(open(os.path.join(OUT, src), "rb").read()).decode()
    args = {"description": desc, "image_url": data}
    t = text(call("edit_image_pixen", args))
    jid = re.search(r"job_id:\s*([0-9a-f-]{36})", t).group(1)
    poll(call, "get_image", {"job_id": jid})
    req = urllib.request.Request(f"https://api.pixellab.ai/mcp/images/{jid}/download?index=0",
                                 headers={"Authorization": f"Bearer {KEY}", "User-Agent": "curl/8.7.1"})
    dest = os.path.join(OUT, f"{name}_edit.png")
    open(dest, "wb").write(urllib.request.urlopen(req, timeout=60).read())
    logf = os.path.join(OUT, "log.json")
    log = json.load(open(logf))
    log["_gens_used"] += 1
    log.setdefault(name, {"tool": "edit_image_pixen", "attempts": []})["attempts"].append(
        {"job_id": jid, "args": {"description": desc, "image": f"raw/props7/{src}"}})
    json.dump(log, open(logf, "w"), indent=1)
    print(f"{name}: {jid} -> {dest}")


def main():
    if sys.argv[1] == "--edit":
        for n in sys.argv[2:]:
            edit(n)
        return
    from pixellab_mcp import call
    os.makedirs(OUT, exist_ok=True)
    logf = os.path.join(OUT, "log.json")
    log = json.load(open(logf)) if os.path.exists(logf) else {"_gens_used": 0}
    for name in sys.argv[1:]:
        w, h, desc = JOBS[name]
        args = {"description": desc, "width": w, "height": h, **STYLE}
        t = text(call("create_map_object", args))
        oid = re.search(r"id:\s*([0-9a-f-]{36})", t).group(1)
        log["_gens_used"] += 1
        msg = poll(call, "get_map_object", {"object_id": oid})
        dest = os.path.join(OUT, f"{name}.png")
        if os.path.exists(dest):
            n = 1
            while os.path.exists(os.path.join(OUT, f"{name}_reject{n}.png")):
                n += 1
            os.rename(dest, os.path.join(OUT, f"{name}_reject{n}.png"))
        open(dest, "wb").write(image_parts(msg)[0])
        log.setdefault(name, {"tool": "create_map_object", "attempts": []})["attempts"].append({"id": oid, "args": args})
        json.dump(log, open(logf, "w"), indent=1)
        print(f"{name}: {oid} -> {dest}")


if __name__ == "__main__":
    main()
