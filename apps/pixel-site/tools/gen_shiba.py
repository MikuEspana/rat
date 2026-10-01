#!/usr/bin/env python3
"""Run one PixelLab image job for the Shiba (edit_image_pixen or animate_image), wait, download every frame into
assets/raw/shiba/<name>/ and log the call in assets/raw/shiba/log.json.

  PIXELLAB_API_KEY=... python3 tools/gen_shiba.py <name> edit_image_pixen '{"image": "raw/shiba/in.png", "description": "..."}'
  PIXELLAB_API_KEY=... python3 tools/gen_shiba.py <name> animate_image '{"first_frame": "raw/shiba/x.png", "action": "...", "frame_count": 6}'

Costs 1 generation per call at 68x68 (both tools).
"""
import base64, json, os, re, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")
RAW = os.path.join(ASSETS, "raw", "shiba")
sys.path.insert(0, HERE)
from pixellab_mcp import call, KEY  # noqa: E402


def text(msg):
    return "\n".join(p.get("text", "") for p in msg.get("result", {}).get("content", []) if p.get("type") == "text")


def data_url(rel):
    return "data:image/png;base64," + base64.b64encode(open(os.path.join(ASSETS, rel), "rb").read()).decode()


def fetch(url):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {KEY}", "User-Agent": "curl/8.7.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def main():
    name, tool, args = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
    a = dict(args)
    if "image" in a:
        a["image_url"] = data_url(a.pop("image"))
    if "first_frame" in a:
        a["first_frame_url"] = data_url(a.pop("first_frame"))
    t = ""
    for attempt in range(30):
        t = text(call(tool, a))
        if "rate limit" in t:
            time.sleep(20)
            continue
        break
    m = re.search(r"job_id:\s*([0-9a-f-]{36})", t)
    if not m:
        raise SystemExit(f"{name}: no job\n{t[:1200]}")
    jid = m.group(1)
    cost = re.search(r"cost:\s*([^\n]+)", t)
    print(f"{name}: job {jid} cost {cost.group(1) if cost else '?'}", flush=True)
    t0 = time.time()
    while True:
        r = text(call("get_image", {"job_id": jid}))
        st = re.search(r"status:\s*(\w+)", r)
        st = st.group(1) if st else ""
        if st == "completed":
            break
        if st == "failed" or time.time() - t0 > 900:
            raise SystemExit(f"{name}: {st}\n{r[:800]}")
        time.sleep(8)
    n = int(re.search(r"frames:\s*(\d+)", r).group(1))
    out = os.path.join(RAW, name)
    os.makedirs(out, exist_ok=True)
    for i in range(n):
        open(os.path.join(out, f"{i}.png"), "wb").write(fetch(f"https://api.pixellab.ai/mcp/images/{jid}/download?index={i}"))
    logp = os.path.join(RAW, "log.json")
    log = json.load(open(logp)) if os.path.exists(logp) else []
    log.append({"name": name, "tool": tool, "args": args, "job_id": jid, "cost": cost.group(1) if cost else None,
                "frames": n, "submit_text": t[:1500], "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    json.dump(log, open(logp, "w"), indent=1)
    print(f"{name}: {n} frames -> {out}")


if __name__ == "__main__":
    main()
