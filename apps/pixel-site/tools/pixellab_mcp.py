#!/usr/bin/env python3
"""Call a PixelLab MCP tool over streamable HTTP. Reads PIXELLAB_API_KEY from env, never prints it.

usage: plmcp.py <tool_name> '<json args>'   -> prints the tool result (text parts) and saves raw JSON
"""
import json, os, sys, urllib.request, time

URL = "https://api.pixellab.ai/mcp"
KEY = os.environ.get("PIXELLAB_API_KEY")
if not KEY:
    sys.exit("PIXELLAB_API_KEY not set")


def call(tool, args, timeout=300):
    body = json.dumps({"jsonrpc": "2.0", "id": int(time.time() * 1000), "method": "tools/call",
                       "params": {"name": tool, "arguments": args}}).encode()
    req = urllib.request.Request(URL, data=body, method="POST", headers={
        "Authorization": f"Bearer {KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode()
    msg = None
    for line in raw.splitlines():
        if line.startswith("data: "):
            m = json.loads(line[6:])
            if "result" in m or "error" in m:
                msg = m
    if msg is None:
        msg = json.loads(raw)
    return msg


if __name__ == "__main__":
    tool = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    msg = call(tool, args)
    out_dir = os.environ.get("PIXELLAB_CALL_LOG", "/tmp/pixellab-calls")
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, f"{int(time.time())}_{tool}.json"), "w") as f:
        json.dump(msg, f, indent=1)
    if "error" in msg:
        print("ERROR:", json.dumps(msg["error"])[:2000])
        sys.exit(1)
    res = msg["result"]
    out = sys.argv[3] if len(sys.argv) > 3 else None
    n_img = 0
    for part in res.get("content", []):
        if part.get("type") == "text":
            print(part["text"])
        elif part.get("type") == "image" and out:
            import base64
            path = out if n_img == 0 else out.replace(".png", f"_{n_img}.png")
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            with open(path, "wb") as f:
                f.write(base64.b64decode(part["data"]))
            print(f"[saved image -> {path}]")
            n_img += 1
        else:
            print(f"[{part.get('type')} part, {len(json.dumps(part))} bytes]")
    if res.get("isError"):
        sys.exit(2)
