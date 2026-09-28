#!/usr/bin/env python3
"""Record the ?film sequence frame by frame (deterministic: the page only moves when a frame is rendered).

  python3 tools/film_record.py video OUT.mp4 [--aspect 9x16] [--text 0] [--end pile] [--shot N | --range A:B]
  python3 tools/film_record.py stills OUTDIR --frames 0,120,240 [--aspect 9x16] [--text 0] [--end pile]
  python3 tools/film_record.py all OUTDIR          # every export (full films, per-shot clips, shot 6 loop, end still)

Needs the site served (pnpm --filter @rat/pixel-site dev, or FILM_URL=http://host:port/). Uses the Chromium that
Playwright finds (PLAYWRIGHT_BROWSERS_PATH) and ffmpeg from imageio-ffmpeg (libx264). Output: H.264, 60 fps, yuv420p.
"""
import argparse, os, subprocess, sys, time

from playwright.sync_api import sync_playwright

URL = os.environ.get('FILM_URL', 'http://localhost:5173/')
FPS = 60


def ffmpeg_exe():
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


class Film:
    def __init__(self, pw, aspect='16x9', text=True, end='vault'):
        self.w, self.h = (1080, 1920) if aspect == '9x16' else (1920, 1080)
        self.browser = pw.chromium.launch(executable_path=chromium_path(), args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        self.page = self.browser.new_page(viewport={'width': self.w, 'height': self.h}, device_scale_factor=1)
        q = f'?film&aspect={aspect}&text={1 if text else 0}&end={end}&frame=0'
        self.page.goto(URL + q)
        self.page.wait_for_function('window.__film && window.__film.ready', timeout=120000)
        self.canvas = self.page.locator('canvas')

    def meta(self):
        return self.page.evaluate('({total: window.__film.total, shots: window.__film.shots})')

    def shot_range(self, n):
        return self.page.evaluate(f'window.__film.shotRange({n})')

    def frame_png(self, f):
        self.page.evaluate(f'window.__film.render({f})')
        return self.page.screenshot(type='png', clip={'x': 0, 'y': 0, 'width': self.w, 'height': self.h}, animations='disabled', caret='initial')

    def close(self):
        self.browser.close()


def encode(film, frames, out):
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    cmd = [ffmpeg_exe(), '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', str(FPS), '-c:v', 'png', '-i', '-',
           '-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-tune', 'animation', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    t0 = time.time()
    for k, f in enumerate(frames):
        p.stdin.write(film.frame_png(f))
        if k % 120 == 0:
            print(f'  {os.path.basename(out)}: {k}/{len(frames)} frames, {time.time() - t0:.0f}s', flush=True)
    p.stdin.close()
    p.wait()
    print(f'wrote {out} ({len(frames)} frames, {time.time() - t0:.0f}s)', flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mode', choices=['video', 'stills', 'all'])
    ap.add_argument('out')
    ap.add_argument('--aspect', default='16x9')
    ap.add_argument('--text', default='1')
    ap.add_argument('--end', default='vault')
    ap.add_argument('--shot', type=int)
    ap.add_argument('--range')
    ap.add_argument('--frames')
    a = ap.parse_args()
    with sync_playwright() as pw:
        if a.mode == 'stills':
            film = Film(pw, a.aspect, a.text != '0', a.end)
            os.makedirs(a.out, exist_ok=True)
            for f in [int(x) for x in a.frames.split(',')]:
                open(os.path.join(a.out, f'f{f:05d}.png'), 'wb').write(film.frame_png(f))
            film.close()
            return
        if a.mode == 'video':
            film = Film(pw, a.aspect, a.text != '0', a.end)
            if a.shot:
                r0, r1 = film.shot_range(a.shot)
            elif a.range:
                r0, r1 = (int(x) for x in a.range.split(':'))
            else:
                r0, r1 = 0, film.meta()['total']
            encode(film, range(r0, r1), a.out)
            film.close()
            return
        # everything
        out = a.out
        jobs = [('16x9', True, 'vault', None, 'wall-street-rats_16x9.mp4'), ('9x16', True, 'vault', None, 'wall-street-rats_9x16.mp4'),
                ('16x9', False, 'vault', None, 'wall-street-rats_16x9_notext.mp4'), ('9x16', False, 'vault', None, 'wall-street-rats_9x16_notext.mp4'),
                ('16x9', True, 'pile', None, 'alt-ending-pile/wall-street-rats_pile_16x9.mp4'),
                ('9x16', True, 'pile', None, 'alt-ending-pile/wall-street-rats_pile_9x16.mp4')]
        for aspect, text, end, _, name in jobs:
            film = Film(pw, aspect, text, end)
            encode(film, range(0, film.meta()['total']), os.path.join(out, name))
            film.close()
        for aspect in ('16x9', '9x16'):
            for text in (True, False):
                for end in ('vault', 'pile'):
                    film = Film(pw, aspect, text, end)
                    shots = [8] if end == 'pile' else range(1, 9)
                    for n in shots:
                        r0, r1 = film.shot_range(n)
                        sid = film.meta()['shots'][n - 1]['id']
                        sub = 'alt-ending-pile/shots' if end == 'pile' else 'shots'
                        encode(film, range(r0, r1), os.path.join(out, sub, aspect, f'shot{n}_{sid}_{"text" if text else "notext"}.mp4'))
                    film.close()
        print('done')


if __name__ == '__main__':
    main()
