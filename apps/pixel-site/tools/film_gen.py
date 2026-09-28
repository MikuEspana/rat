#!/usr/bin/env python3
"""PixelLab gens for the ?film demo. Every call is logged in assets/film/manifest.json (tool, args, cost, ids, files).

  python3 tools/film_gen.py log <id> <tool> <cost> <pixellab_id> '<args json>' [note]   # log a call made elsewhere
  python3 tools/film_gen.py image <id> <tool> '<args json>'       # edit_image_pixen / animate_image: run, poll, save frames
  python3 tools/film_gen.py object <id> '<args json>'             # create_map_object: run, poll, save the png
  python3 tools/film_gen.py tile <id> '<args json>'               # create_isometric_tile
  python3 tools/film_gen.py character <id> <character_id>         # download a character ZIP into raw/<id>/

Image inputs: pass "image_file" / "first_frame_file" / "last_frame_file" (paths relative to assets/film/) and they are
sent as data URLs; the manifest keeps the path, not the pixels. Reads PIXELLAB_API_KEY from env, never prints it.
"""
import base64, io, json, os, re, sys, time, urllib.error, urllib.request, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
FILM = os.path.join(os.path.dirname(HERE), "assets", "film")
RAW = os.path.join(FILM, "raw")
MAN = os.path.join(FILM, "manifest.json")
sys.path.insert(0, HERE)
from pixellab_mcp import call  # noqa: E402


def load():
    if os.path.exists(MAN):
        return json.load(open(MAN))
    return {
        "about": "PixelLab gens for the ?film demo (branch film/demo). costGenerations is what PixelLab reported for the call. "
                 "Image inputs are logged as paths under assets/film/. Look-test budget 30 gens, full film budget 300.",
        "generations": [],
        "totals": {},
    }


def save(man):
    total = sum(g["costGenerations"] for g in man["generations"])
    by = {}
    for g in man["generations"]:
        by[g.get("phase", "looktest")] = by.get(g.get("phase", "looktest"), 0) + g["costGenerations"]
    man["totals"] = {"generations": total, "calls": len(man["generations"]), "byPhase": by,
                     "budgets": {"looktest": 60, "detail": 5, "fullBuild": 150}}
    with open(MAN, "w") as f:
        json.dump(man, f, indent=1)
        f.write("\n")


def log(id_, tool, cost, pid, args, raw, note=""):
    man = load()
    man["generations"] = [g for g in man["generations"] if g["id"] != id_]
    man["generations"].append({"id": id_, "phase": os.environ.get("FILM_PHASE", "fullBuild"), "tool": tool,
                               "costGenerations": cost, "pixellabId": pid, "args": args,
                               "raw": raw, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "note": note})
    save(man)
    print(f"logged {id_}: {tool}, {cost} gens (total {man['totals']['generations']})")


def text(msg):
    return "\n".join(p.get("text", "") for p in msg.get("result", {}).get("content", []) if p.get("type") == "text")


def create(tool, args, tries=40):
    """Start a job; PixelLab allows 8 at once, so wait and retry while it says the limit is hit (a refused call is free)."""
    for _ in range(tries):
        try:
            t = text(call(tool, args))
        except (urllib.error.URLError, ConnectionError) as e:
            print("create retry:", e)
            time.sleep(15)
            continue
        if "rate limit" in t or "429" in t or "concurrent" in t:
            time.sleep(20)
            continue
        return t
    raise SystemExit(f"{tool}: still rate limited")


def cost_of(t, default):
    m = re.search(r"(\d+)\s+generations?", t)
    return int(m.group(1)) if m else default


def data_url(rel):
    return "data:image/png;base64," + base64.b64encode(open(os.path.join(FILM, rel), "rb").read()).decode()


def poll(tool, arg, every=8, limit=900):
    t0 = time.time()
    while time.time() - t0 < limit:
        try:
            msg = call(tool, arg)
        except (urllib.error.URLError, ConnectionError) as e:  # the MCP endpoint resets now and then; the job lives on
            print("poll retry:", e)
            time.sleep(every)
            continue
        t = text(msg)
        m = re.search(r"status:\s*(\w+)", t)
        st = m.group(1) if m else ""
        if st in ("completed", "complete", "done"):
            return msg, t
        if st == "failed":
            raise SystemExit(f"{tool} failed:\n{t[:800]}")
        time.sleep(every)
    raise SystemExit(f"{tool}: timed out")


def fetch(url, dest):
    with urllib.request.urlopen(url, timeout=120) as r:
        open(dest, "wb").write(r.read())


def run_image(id_, tool, args):
    sent, logged = dict(args), dict(args)
    for k in ("image_file", "first_frame_file", "last_frame_file"):
        if k in sent:
            sent[k.replace("_file", "_url")] = data_url(sent.pop(k))
    t = create(tool, sent)
    print(t)
    jid = re.search(r"job_id:\s*([0-9a-f-]{36})", t).group(1)
    _, t2 = poll("get_image", {"job_id": jid})
    print(t2[:600])
    out = os.path.join(RAW, id_)
    os.makedirs(out, exist_ok=True)
    n = 1 if tool.startswith("edit_image") else sent.get("frame_count", 8) + 1
    m = re.search(r"(\d+)\s+images?", t2)
    if m:
        n = int(m.group(1))
    for i in range(n):
        try:
            fetch(f"https://api.pixellab.ai/mcp/images/{jid}/download?index={i}", os.path.join(out, f"{i}.png"))
        except Exception as e:  # past the last frame
            print("stop at", i, e)
            break
    log(id_, tool, cost_of(t, 1), jid, logged, f"raw/{id_}/")


def run_object(id_, tool, args):
    t = create(tool, args)
    print(t)
    oid = re.search(r"id:\s*([0-9a-f-]{36})", t).group(1)
    getter, key = ("get_isometric_tile", "tile_id") if tool == "create_isometric_tile" else ("get_map_object", "object_id")
    msg, t2 = poll(getter, {key: oid})
    imgs = [base64.b64decode(p["data"]) for p in msg["result"]["content"] if p.get("type") == "image"]
    os.makedirs(RAW, exist_ok=True)
    dest = os.path.join(RAW, f"{id_}.png")
    if imgs:
        open(dest, "wb").write(imgs[0])
    else:
        m = re.search(r"(https://\S+\.png)", t2)
        fetch(m.group(1), dest)
    log(id_, tool, cost_of(t, 1), oid, args, f"raw/{id_}.png")


def download_character(id_, cid):
    data = b""
    for _ in range(90):  # the ZIP answers 423 (or an error JSON) until every job on the character has finished
        try:
            with urllib.request.urlopen(f"https://api.pixellab.ai/mcp/characters/{cid}/download", timeout=60) as r:
                data = r.read()
        except urllib.error.HTTPError as e:
            if e.code != 423:
                raise
        if data.startswith(b"PK"):
            break
        time.sleep(10)
    dest = os.path.join(RAW, id_)
    zipfile.ZipFile(io.BytesIO(data)).extractall(dest)
    print("extracted to", dest)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "log":
        log(sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5], json.loads(sys.argv[6]), f"raw/{sys.argv[2]}/",
            sys.argv[7] if len(sys.argv) > 7 else "")
    elif cmd == "image":
        run_image(sys.argv[2], sys.argv[3], json.loads(sys.argv[4]))
    elif cmd == "object":
        run_object(sys.argv[2], "create_map_object", json.loads(sys.argv[3]))
    elif cmd == "tile":
        run_object(sys.argv[2], "create_isometric_tile", json.loads(sys.argv[3]))
    elif cmd == "recover":  # recover <id> <job_id> <cost> '<args>': a job whose poll timed out, fetched when done
        id_, jid, cost, args = sys.argv[2], sys.argv[3], int(sys.argv[4]), json.loads(sys.argv[5])
        poll("get_image", {"job_id": jid}, every=15, limit=5400)
        out = os.path.join(RAW, id_)
        os.makedirs(out, exist_ok=True)
        for i in range(args.get("frame_count", 8) + 1):
            fetch(f"https://api.pixellab.ai/mcp/images/{jid}/download?index={i}", os.path.join(out, f"{i}.png"))
        log(id_, "animate_image", cost, jid, args, f"raw/{id_}/", "recovered after a poll timeout (PixelLab queue slow)")
    elif cmd == "character":
        download_character(sys.argv[2], sys.argv[3])
    else:
        raise SystemExit(__doc__)
