#!/usr/bin/env python3
"""Regenerate one PixelLab asset from assets/manifest.json into assets/raw/.

  PIXELLAB_API_KEY=... python3 tools/regenerate.py <id>          # shows the call and its cost, spends nothing
  PIXELLAB_API_KEY=... python3 tools/regenerate.py <id> --yes    # runs it (costs the listed generations)

Then `python3 tools/build_assets.py` rebuilds the atlases (free). Most tools take no seed, so a regeneration is a new
variation of the same prompt, not the same pixels.
"""
import base64, io, json, os, re, sys, time, urllib.request, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")
sys.path.insert(0, HERE)


def text(msg):
    return "\n".join(p.get("text", "") for p in msg.get("result", {}).get("content", []) if p.get("type") == "text")


def image_parts(msg):
    return [base64.b64decode(p["data"]) for p in msg.get("result", {}).get("content", []) if p.get("type") == "image"]


def data_url(rel):
    return "data:image/png;base64," + base64.b64encode(open(os.path.join(ASSETS, rel), "rb").read()).decode()


def poll(call, tool, arg, key="status", done="completed", every=10, limit=900):
    t0 = time.time()
    while time.time() - t0 < limit:
        msg = call(tool, arg)
        t = text(msg)
        m = re.search(r"status:\s*(\w+)", t)
        st = m.group(1) if m else ""
        if st == done:
            return msg
        if st == "failed":
            raise SystemExit(f"{tool} failed:\n{t[:800]}")
        time.sleep(every)
    raise SystemExit(f"{tool}: timed out")


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    man = json.load(open(os.path.join(ASSETS, "manifest.json")))
    entry = next((g for g in man["generations"] if g["id"] == sys.argv[1]), None)
    if not entry:
        raise SystemExit(f"no generation entry '{sys.argv[1]}'. ids: {', '.join(g['id'] for g in man['generations'])}")
    print(f"{entry['id']}: {entry['tool']} ({entry['costGenerations']} generation) -> assets/{entry['raw']}")
    print(json.dumps(entry["args"], indent=1))
    if "--yes" not in sys.argv:
        print("dry run: add --yes to spend the generation")
        return
    from pixellab_mcp import call

    tool, args, raw = entry["tool"], dict(entry["args"]), os.path.join(ASSETS, entry["raw"])
    if tool in ("create_isometric_tile", "create_map_object"):
        t = text(call(tool, args))
        oid = re.search(r"id:\s*([0-9a-f-]{36})", t).group(1)
        getter, key = ("get_isometric_tile", "tile_id") if tool == "create_isometric_tile" else ("get_map_object", "object_id")
        msg = poll(call, getter, {key: oid})
        open(raw, "wb").write(image_parts(msg)[0])
    elif tool in ("create_character", "animate_character"):
        t = text(call(tool, args))
        cid = args.get("character_id") or re.search(r"id:\s*([0-9a-f-]{36})", t).group(1)
        time.sleep(20)
        for _ in range(90):  # the character ZIP answers with an error JSON until every job on it has finished
            with urllib.request.urlopen(f"https://api.pixellab.ai/mcp/characters/{cid}/download", timeout=60) as r:
                data = r.read()
            if data.startswith(b"PK"):
                break
            time.sleep(10)
        dest = os.path.join(ASSETS, "raw", "character")
        zipfile.ZipFile(io.BytesIO(data)).extractall(dest)
        if tool == "create_character":
            print(f"NEW character id {cid}: re-run every rat_* animate_character entry with this id")
    elif tool in ("edit_image_pixen", "animate_image"):
        a = dict(args)
        if "image" in a:
            a["image_url"] = data_url(a.pop("image"))
        if "first_frame" in a:
            a["first_frame_url"] = data_url(a.pop("first_frame"))
        t = text(call(tool, a))
        jid = re.search(r"job_id:\s*([0-9a-f-]{36})", t).group(1)
        poll(call, "get_image", {"job_id": jid})
        n = 1 if tool == "edit_image_pixen" else a.get("frame_count", 8) + 1
        if tool == "edit_image_pixen":
            with urllib.request.urlopen(f"https://api.pixellab.ai/mcp/images/{jid}/download?index=0", timeout=60) as r:
                open(raw, "wb").write(r.read())
        else:
            os.makedirs(raw, exist_ok=True)
            for i in range(n):
                with urllib.request.urlopen(f"https://api.pixellab.ai/mcp/images/{jid}/download?index={i}", timeout=60) as r:
                    open(os.path.join(raw, f"{i}.png"), "wb").write(r.read())
    else:
        raise SystemExit(f"unsupported tool {tool}")
    print("done: now run python3 tools/build_assets.py")


if __name__ == "__main__":
    main()
