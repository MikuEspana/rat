// ?film: a 35.6 s product film on a fixed 128 BPM timeline, rendered frame by frame (tools/film_record.py).
//
//   ?film                 16:9, 1920x1080, captions on, the Vault ending
//   &aspect=9x16          1080x1920, every shot re-framed for vertical
//   &text=0               no captions, counters or stage banners (clean plates for the edit)
//   &end=pile             the alternative ending (rats pile up into the logo)
//   &shot=N               start on shot N (1 s before its first beat)
//   &frame=F              render frame F once and stop (stills)
//
// Nothing of the live site runs: no API, no HUD, no feed, no panels. Time only moves when a frame is rendered, and
// randomness is seeded (clock.ts), so the same frame always has the same pixels.
import { Application, Container, Sprite, Texture } from 'pixi.js';
import { setFilmTime, reseed } from './clock';
import { loadFilmTextures, textTexture, sprite, INK } from './pixel';
import { BEAT, CAPTIONS, FPS, HANDLE, SHOTS, TOTAL_BEATS, TOTAL_FRAMES, frameOf } from './timeline';
import type { View } from './stage';
import { StreetScene } from './street';
import { OfficeScene } from './office';
import { WorldScene } from './worldscene';
import { VaultEnd, PileEnd } from './ending';
import { loadAtlas, type Atlas } from '../gfx/atlas';

export interface FilmApi {
  ready: boolean;
  total: number;
  view: View;
  shots: typeof SHOTS;
  /** render one frame (may be negative or past the end for handles) */
  render(frame: number): void;
  /** frame range of a shot with 1 s handles */
  shotRange(n: number): [number, number];
}

interface SceneLike {
  root: Container;
}

export async function bootFilm(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const tall = q.get('aspect') === '9x16';
  const view: View = { w: tall ? 1080 : 1920, h: tall ? 1920 : 1080, tall };
  const showText = q.get('text') !== '0';
  const ending = q.get('end') === 'pile' ? 'pile' : 'vault';
  document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
  document.getElementById('status')?.remove();

  const app = new Application();
  await app.init({
    width: view.w,
    height: view.h,
    background: '#05060c',
    antialias: false,
    resolution: 1,
    autoDensity: false,
    preference: 'webgl',
    autoStart: false,
    preserveDrawingBuffer: true,
  });
  app.ticker.stop();
  const canvas = app.canvas as HTMLCanvasElement;
  canvas.style.cssText = `display:block;width:${view.w}px;height:${view.h}px;image-rendering:pixelated`;
  document.getElementById('stage')!.appendChild(canvas);

  const [atlas] = await Promise.all([loadAtlas(), loadFilmTextures()]);
  const scenes = new Container();
  const overlay = new Container();
  const flash = new Sprite(Texture.WHITE);
  flash.width = view.w;
  flash.height = view.h;
  flash.alpha = 0;
  app.stage.addChild(scenes, overlay, flash);

  // scenes are built on first use
  let street: StreetScene | null = null;
  let office: OfficeScene | null = null;
  let world: WorldScene | null = null;
  let end: VaultEnd | PileEnd | null = null;
  const all = (): SceneLike[] => [street, office, world, end].filter((s): s is NonNullable<typeof s> => s !== null);
  const show = (s: SceneLike): void => {
    for (const x of all()) x.root.visible = x === s;
    if (s.root.parent !== scenes) scenes.addChild(s.root);
  };

  // captions: pop in on the beat (two frames a size up, two frames half a size up), out on the beat
  const caps = CAPTIONS.map((c) => {
    const t = textTexture(tall ? c.tall : [c.wide]);
    const s = sprite(t, 0.5, 0.5);
    s.visible = false;
    overlay.addChild(s);
    return { c, s };
  });
  const capScale = tall ? 12 : 10;
  const drawCaptions = (b: number, frame: number): void => {
    for (const { c, s } of caps) {
      const bb = ((b % TOTAL_BEATS) + TOTAL_BEATS) % TOTAL_BEATS;
      const on = showText && bb >= c.b0 && bb < c.b1;
      s.visible = on;
      if (!on) continue;
      const since = frame - frameOf(c.b0) - (b >= TOTAL_BEATS ? frameOf(TOTAL_BEATS) : b < 0 ? -frameOf(TOTAL_BEATS) : 0);
      const k = since < 3 ? capScale + 2 : since < 6 ? capScale + 1 : capScale;
      s.scale.set(k);
      const hh = s.texture.height * capScale;
      const y = c.at === 'top' ? (tall ? 220 : 70) + hh / 2 : view.h - (tall ? 330 : 90) - hh / 2;
      s.position.set(Math.round(view.w / 2), Math.round(y));
    }
  };

  const render = (frame: number): void => {
    const t = frame / FPS;
    const b = t / BEAT;
    setFilmTime(t * 1000);
    reseed(1000 + frame);
    let flashA = 0;
    // the loop: before 0 and after 74 beats we are on the street, with the coin rolling to the manhole
    if (b < 12 || b >= 74) {
      street ??= new StreetScene(view);
      show(street);
      street.frame(b < 12 ? b : b - TOTAL_BEATS, frame);
    } else if (b < 28) {
      office ??= new OfficeScene(view, atlas);
      show(office);
      office.frame(b, frame);
    } else if (b < 64) {
      world ??= new WorldScene(view, atlas, showText);
      show(world);
      flashA = world.frame(b, frame);
    } else {
      end ??= ending === 'pile' ? new PileEnd(view, atlas) : new VaultEnd(view, atlas);
      show(end);
      flashA = end.frame(b, frame);
    }
    flash.alpha = flashA;
    drawCaptions(b, frame);
    app.render();
  };

  const api: FilmApi = {
    ready: true,
    total: TOTAL_FRAMES,
    view,
    shots: SHOTS,
    render,
    shotRange(n: number): [number, number] {
      const s = SHOTS.find((x) => x.n === n)!;
      return [frameOf(s.b0 - HANDLE), frameOf(s.b1 + HANDLE)];
    },
  };
  (window as unknown as { __film: FilmApi }).__film = api;
  void INK;

  const still = q.get('frame');
  const shot = Number(q.get('shot'));
  if (still !== null) render(Number(still));
  else render(shot ? api.shotRange(shot)[0] : 0);
}

export type { Atlas };
