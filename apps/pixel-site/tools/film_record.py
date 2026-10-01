#!/usr/bin/env python3
"""Record the ?film sequence frame by frame. Deterministic: the page only moves when a frame is rendered, and each
frame is read straight off the WebGL canvas (lossless RGBA) and piped to ffmpeg (H.264, 60 fps, yuv420p).

  python3 tools/film_record.py all OUTDIR                  every export (4 passes in parallel, then the joins)
  python3 tools/film_record.py pass OUTDIR NAME            one pass: film16 | film9 | extras16 | extras9 (handles, the pile)
  python3 tools/film_record.py joins OUTDIR                per-shot clips, the pile cut and the shot 6 loops from the passes
  python3 tools/film_record.py shot OUTDIR N [--aspect 9x16] [--end pile]   re-record one shot (text + no text)
  python3 tools/film_record.py stills OUTDIR --frames=0,120 [--aspect 9x16] [--end pile] [--text 0]

Needs the site served (pnpm --filter @rat/pixel-site dev; FILM_URL overrides http://localhost:5173/). Uses the
Chromium Playwright finds (PLAYWRIGHT_BROWSERS_PATH) and ffmpeg from imageio-ffmpeg. FILM_GPU=1 records in a visible
Chrome window on the machine's graphics card (much faster than a server's software rendering).
"""
import argparse, base64, os, socket, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # --help works without it; recording needs it (pip install playwright)
    sync_playwright = None

URL = os.environ.get('FILM_URL', 'http://localhost:5173/')
FPS = 60
HERE = os.path.dirname(os.path.abspath(__file__))


def ffmpeg():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return 'ffmpeg'


def chromium_path():
    root = os.environ.get('PLAYWRIGHT_BROWSERS_PATH', '/opt/pw-browsers')
    for d in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        p = os.path.join(root, d, 'chrome-linux', 'chrome')
        if d.startswith('chromium-') and os.path.exists(p):
            return p
    return None


X264 = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-tune', 'animation', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']


class Encoder:
    def __init__(self, out, w, h):
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        self.out = out
        self.n = 0
        self.p = subprocess.Popen([ffmpeg(), '-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', str(FPS),
                                   '-i', '-', *X264, out], stdin=subprocess.PIPE)

    def write(self, raw):
        self.p.stdin.write(raw)
        self.n += 1

    def close(self):
        self.p.stdin.close()
        self.p.wait()
        print(f'wrote {self.out} ({self.n} frames)', flush=True)


class Sink:
    """A local HTTP server the page POSTs raw frames to (much faster than moving 8 MB through the debug protocol)."""

    def __init__(self):
        self.last = None
        sink = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers['Content-Length'])
                sink.last = self.rfile.read(n)
                self.send_response(200)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Length', '0')
                self.end_headers()

            def do_OPTIONS(self):
                self.send_response(204)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Allow-Methods', 'POST')
                self.send_header('Access-Control-Allow-Headers', '*')
                self.end_headers()

            def log_message(self, *a):
                pass

        s = socket.socket()
        s.bind(('127.0.0.1', 0))
        self.port = s.getsockname()[1]
        s.close()
        self.srv = ThreadingHTTPServer(('127.0.0.1', self.port), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.port}/frame'


class Film:
    def __init__(self, pw, aspect='16x9', end='vault'):
        self.sink = Sink()
        self.w, self.h = (1080, 1920) if aspect == '9x16' else (1920, 1080)
        if os.environ.get('FILM_GPU'):
            # your own machine: a visible Chrome window on the real graphics card (many times faster than software)
            self.browser = pw.chromium.launch(headless=False, args=['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-renderer-backgrounding',
                                                                    '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'])
        else:
            # a server with no GPU: software rendering (slow, same pixels)
            self.browser = pw.chromium.launch(executable_path=chromium_path(), args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        self.page = self.browser.new_page(viewport={'width': self.w, 'height': self.h}, device_scale_factor=1)
        self.page.goto(URL + f'?film&aspect={aspect}&end={end}&frame=0')
        self.page.wait_for_function('window.__film && window.__film.ready', timeout=180000)
        self.meta = self.page.evaluate('({total: window.__film.total, shots: window.__film.shots})')
        self.cdp = self.page.context.new_cdp_session(self.page)

    def shot_range(self, n):
        return self.page.evaluate(f'window.__film.shotRange({n})')

    def frame_of(self, beat):
        return round(beat * 60 / 128 * FPS)

    def render(self, f, shot=None, text=True):
        self.page.evaluate(f'window.__film.render({f}, {shot if shot else "undefined"}, {"true" if text else "false"})')

    def redraw(self, text):
        self.page.evaluate(f'window.__film.redraw({"true" if text else "false"})')

    def jpeg(self):
        """The frame as a quality-100 JPEG (the fastest way out of the software renderer)."""
        return base64.b64decode(self.cdp.send('Page.captureScreenshot', {'format': 'jpeg', 'quality': 100, 'optimizeForSpeed': True})['data'])

    def grab(self):
        self.sink.last = None
        status = self.page.evaluate(f'window.__film.post({self.sink.url!r})')
        if status != 200 or self.sink.last is None:
            return base64.b64decode(self.page.evaluate('window.__film.pixels()'))  # fallback: the slow path
        return self.sink.last

    def png(self, raw, path):
        from PIL import Image
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        Image.frombytes('RGBA', (self.w, self.h), raw).transpose(Image.FLIP_TOP_BOTTOM).convert('RGB').save(path)

    def still(self, path, text):
        """A lossless PNG of the current frame (stills only: it is the slow path)."""
        self.redraw(text)
        self.png(self.grab(), path)

    def record(self, frames, shot, text_out, notext_out, stills=None):
        """Render frames once; write the captioned and the clean stream. stills: {frame: (path_text, path_notext)}"""
        enc_t = Encoder(text_out, self.w, self.h) if text_out else None
        enc_n = Encoder(notext_out, self.w, self.h) if notext_out else None
        t0 = time.time()
        frames = list(frames)
        for k, f in enumerate(frames):
            self.render(f, shot, True)
            if enc_t:
                enc_t.write(self.jpeg())
            if enc_n:
                self.redraw(False)
                enc_n.write(self.jpeg())
            if stills and f in stills:
                self.still(stills[f][0], True)
                self.still(stills[f][1], False)
            if k % 240 == 0:
                print(f'  {os.path.basename(text_out or notext_out)}: {k}/{len(frames)} ({time.time() - t0:.0f}s)', flush=True)
        for e in (enc_t, enc_n):
            if e:
                e.close()

    def close(self):
        self.browser.close()
        self.sink.srv.shutdown()


def ratio(aspect):
    return '16x9' if aspect == '16x9' else '9x16'


def fb(beat):
    return round(beat * 60 / 128 * FPS)


SHOTS = [(1, 'hook', 0, 8), (2, 'suit-up', 8, 12), (3, 'clock-in', 12, 20), (4, 'the-team', 20, 28), (5, 'the-fund', 28, 40),
         (6, 'expansion', 40, 56), (7, 'proof', 56, 64), (8, 'end-card', 64, 76)]
H1 = FPS          # 1 s handle
H6 = FPS * 3 // 2  # shot 6 gets 1.5 s each side: its 10 s loop is cut from the same frames


def tmp(out, *p):
    return os.path.join(out, '_parts', *p)


def do_pass(out, name):
    aspect = '16x9' if name.endswith('16') else '9x16'
    with sync_playwright() as pw:
        if name.startswith('film'):
            film = Film(pw, aspect, 'vault')
            film.record(range(0, film.meta['total']), None, os.path.join(out, f'wall-street-inu_{aspect}.mp4'),
                        os.path.join(out, 'clean', f'wall-street-inu_{aspect}_notext.mp4'),
                        stills={fb(73.9): (os.path.join(out, f'end-card_{aspect}.png'), os.path.join(out, 'clean', f'end-card_{aspect}_notext.png'))})
            film.close()
            return
        # the handles: each shot keeps running on its own set for a second before its first beat and after its last
        film = Film(pw, aspect, 'vault')
        for n, sid, b0, b1 in SHOTS:
            h = H6 if n == 6 else H1
            film.record(range(fb(b0) - h, fb(b0)), n, tmp(out, aspect, f'pre{n}_text.mp4'), tmp(out, aspect, f'pre{n}_notext.mp4'))
            film.record(range(fb(b1), fb(b1) + h), n, tmp(out, aspect, f'post{n}_text.mp4'), tmp(out, aspect, f'post{n}_notext.mp4'))
        film.close()
        # the alternative ending, with its handles
        film = Film(pw, aspect, 'pile')
        film.record(range(fb(64) - H1, fb(76) + H1), 8, tmp(out, aspect, 'pile8_text.mp4'), tmp(out, aspect, 'pile8_notext.mp4'),
                    stills={fb(73.9): (os.path.join(out, 'alt-ending-pile', f'end-card-pile_{aspect}.png'),
                                       os.path.join(out, 'alt-ending-pile', f'end-card-pile_{aspect}_notext.png'))})
        film.close()


def ff_join(parts, dst):
    """parts: [(file, start_frame, end_frame)] joined in order and re-encoded."""
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    args, chains = [], []
    for k, (f, a, b) in enumerate(parts):
        args += ['-i', f]
        chains.append(f'[{k}:v]trim=start_frame={a}:end_frame={b},setpts=PTS-STARTPTS[p{k}]')
    fc = ';'.join(chains) + ';' + ''.join(f'[p{k}]' for k in range(len(parts))) + f'concat=n={len(parts)}:v=1[v]'
    subprocess.run([ffmpeg(), '-y', '-loglevel', 'error', *args, '-filter_complex', fc, '-map', '[v]', '-r', str(FPS), *X264, dst], check=True)
    print('wrote', dst, flush=True)


def joins(out):
    """Per-shot clips (handles + the shot's frames from the full film), the pile cut, the shot 6 loops."""
    total = fb(76)
    for aspect in ('16x9', '9x16'):
        for kind in ('text', 'notext'):
            full = os.path.join(out, f'wall-street-inu_{aspect}.mp4') if kind == 'text' else os.path.join(out, 'clean', f'wall-street-inu_{aspect}_notext.mp4')
            for n, sid, b0, b1 in SHOTS:
                h = H6 if n == 6 else H1
                pre, post = tmp(out, aspect, f'pre{n}_{kind}.mp4'), tmp(out, aspect, f'post{n}_{kind}.mp4')
                cut = 60 if n == 6 else 0  # shot 6 clip: 1 s handles like the others
                ff_join([(pre, cut, h), (full, fb(b0), min(total, fb(b1))), (post, 0, h - cut)],
                        os.path.join(out, 'shots', aspect, f'shot{n}_{sid}_{kind}.mp4'))
            # the 10 s loop of shot 6: 10.5 s, its last half second cross-faded over its first
            loop_src = tmp(out, aspect, f'loop6_{kind}.mp4')
            ff_join([(tmp(out, aspect, f'pre6_{kind}.mp4'), 0, H6), (full, fb(40), fb(56)), (tmp(out, aspect, f'post6_{kind}.mp4'), 0, H6)], loop_src)
            dst = os.path.join(out, 'loops', f'shot6_loop_10s_{aspect}_{kind}.mp4')
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            subprocess.run([ffmpeg(), '-y', '-loglevel', 'error', '-i', loop_src, '-filter_complex',
                            '[0:v]split[m][t];[m]trim=start=0.5:end=10.5,setpts=PTS-STARTPTS[main];[t]trim=start=0:end=0.5,setpts=PTS-STARTPTS[head];'
                            '[main][head]xfade=transition=fade:duration=0.5:offset=9.5[v]', '-map', '[v]', '-t', '10', '-r', str(FPS), *X264, dst], check=True)
            print('wrote', dst, flush=True)
            # the pile: its shot clip, and the whole film with the pile ending
            pile = tmp(out, aspect, f'pile8_{kind}.mp4')
            n8 = fb(76) - fb(64) + 2 * H1
            ff_join([(pile, 0, n8)], os.path.join(out, 'alt-ending-pile', 'shots', aspect, f'shot8_pile_{kind}.mp4'))
            if kind == 'text':
                ff_join([(full, 0, fb(64)), (pile, H1, H1 + fb(76) - fb(64))], os.path.join(out, 'alt-ending-pile', f'wall-street-inu_pile_{aspect}.mp4'))
            else:
                ff_join([(full, 0, fb(64)), (pile, H1, H1 + fb(76) - fb(64))], os.path.join(out, 'alt-ending-pile', 'clean', f'wall-street-inu_pile_{aspect}_notext.mp4'))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('mode', choices=['all', 'pass', 'shot', 'stills', 'joins'])
    ap.add_argument('out')
    ap.add_argument('name', nargs='?')
    ap.add_argument('--aspect', default='16x9')
    ap.add_argument('--end', default='vault')
    ap.add_argument('--text', default='1')
    ap.add_argument('--frames')
    a = ap.parse_args()
    if sync_playwright is None and a.mode != 'joins':
        raise SystemExit('needs Python Playwright: pip install playwright imageio-ffmpeg && python -m playwright install chromium')
    if a.mode == 'all':
        procs = [subprocess.Popen([sys.executable, __file__, 'pass', a.out, n]) for n in ('film16', 'film9', 'extras16', 'extras9')]
        codes = [p.wait() for p in procs]
        if any(codes):
            raise SystemExit(f'a pass failed: {codes}')
        joins(a.out)
        return
    if a.mode == 'pass':
        do_pass(a.out, a.name)
        return
    if a.mode == 'joins':
        joins(a.out)
        return
    with sync_playwright() as pw:
        film = Film(pw, a.aspect, a.end)
        if a.mode == 'shot':
            n = int(a.name)
            r0, r1 = film.shot_range(n)
            sid = film.meta['shots'][n - 1]['id']
            base = os.path.join(a.out, f'shot{n}_{sid}_{a.end}_{a.aspect}')
            film.record(range(r0, r1), n, base + '_text.mp4', base + '_notext.mp4')  # rendered whole, on its own set
        else:
            os.makedirs(a.out, exist_ok=True)
            for f in [int(x) for x in a.frames.split(',')]:
                film.render(f, None, a.text != '0')
                open(os.path.join(a.out, f'f{f:05d}.jpg'), 'wb').write(film.jpeg())
        film.close()


if __name__ == '__main__':
    main()
