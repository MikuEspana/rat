// Builds what stands of the office from the master plan and the growth state: floor tiles (a colour per room type),
// empty lots for rooms not built yet, the street around the current building, walls, desks, props, things hung on
// walls, the subway stairs, the Vault's money pile (vault.ts sets it from the portfolio value), lamp glows, blinking
// server lights, wall tickers and big room signs for reading the building from far away.
// Rebuilt from scratch whenever a room is built (rare); new rooms pop in.
import { Container, Graphics, Particle, ParticleContainer, Rectangle, Sprite, Texture } from 'pixi.js';
import type { StockView } from '@rat/contract';
import type { Atlas, Frame } from '../gfx/atlas';
import { makeParticle, SortedLayer, type LayerItem } from '../gfx/layer';
import { drawText, shearLeftWall, shearRightWall, textWidth } from '../gfx/pixelfont';
import { cellCentre, cellToScreen, type Cell } from '../iso';
import type { Growth } from '../floor/growth';
import { buildCity as planCity, CITY_KEY, type City } from '../floor/city';
import { layoutScene, type Scene } from '../floor/scene';
import { openness } from '../floor/zones';
import { layoutLabels } from '../floor/labels';
import { planSigns, SIGN_PRIO, signAlpha, signScale as scaleFor, type SignKind } from '../floor/signs';
import { type Focus, renderLandmarks } from './landmarks';
import type { VaultAnchor } from './vault';
import { TIER_SCALE } from './rats';
import { CORRIDOR_TINT, ROOM_LOOK, STAGES } from '../floor/plan';
import { FLOOR_STYLES, T, idx, type FloorLayout, type Prop, type Room, type Seat } from '../floor/types';

export interface WorldBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Ticker {
  room: Room;
  symbol: string;
  text: Sprite;
  axis: 'i' | 'j';
  lastText: string;
}

export interface World {
  bounds: WorldBounds;
  backdrop: Container;
  floor: Container;
  under: Container;
  main: SortedLayer;
  overlay: Container; // tickers, drawn above the walls
  lights: Container; // additive glows and blinking lights
  signs: Container; // room signs, readable when zoomed out
  tickers: Ticker[];
  /** the Vault's money pile in the middle of the building (VaultView drives it) */
  vault: VaultAnchor;
  /** the job-fair line, head first (outdoor tiles the scene kept free for it) */
  line: Cell[];
  /** the walk mask this world was built for */
  blocked: Uint8Array;
  /** call every frame: server lights blink, new rooms pop in */
  update(dt: number): void;
  setChair(seatId: number, visible: boolean): void;
  /** where a landmark stands and how tall it is (world px), for the camera */
  landmarkFocus(id: string): Focus | null;
  /** the top of the office tower (world px), null before it goes up */
  crown: { x: number; y: number } | null;
  /** within 10% of the next stage: scaffolding, a crane and a crew on the lots the office takes next */
  setPrep(on: boolean): void;
  /** the camera moved: the skyline layers drift at their own depth */
  parallax(cx: number, cy: number): void;
  /** the city's buildings and props standing in a cell rectangle (to demolish when the office takes the ground) */
  cityParts(i0: number, j0: number, i1: number, j1: number): CityPart[];
  /** a rat got a desk in a pod still under construction: the site clears and the desks pop in. Returns where. */
  activatePod(seatId: number): { x: number; y: number } | null;
  setZoom(z: number): void;
  /** the JOB FAIR sign over the head of the line outside (hidden when nobody is waiting) */
  setJobFair(count: number, head: Cell | null): void;
  destroy(): void;
}

/** 4x4 ordered dither thresholds (0..1) for fading the city's edge */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

function darken(tint: number, k: number): number {
  const r = (tint >> 16) & 255;
  const g = (tint >> 8) & 255;
  const b = tint & 255;
  const f = (v: number, to: number): number => Math.round(v + (to - v) * k);
  return (f(r, 20) << 16) | (f(g, 24) << 8) | f(b, 48);
}

export function worldBounds(layout: FloorLayout): WorldBounds {
  // the city round the building reaches 22 cells past the street and its towers stand tall
  const left = cellToScreen(-24, layout.H + 24).x - 64;
  const right = cellToScreen(layout.W + 24, -24).x + 64;
  const top = cellToScreen(-24, -24).y - 1100;
  const bottom = cellToScreen(layout.W + 24, layout.H + 24).y + 64;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function glowTexture(r: number, g: number, b: number): Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(64, 32, 2, 64, 32, 62);
  grad.addColorStop(0, `rgba(${r},${g},${b},0.55)`);
  grad.addColorStop(0.5, `rgba(${r},${g},${b},0.18)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.save();
  ctx.scale(1, 0.5);
  ctx.beginPath();
  ctx.arc(64, 64, 62, 0, Math.PI * 2);
  ctx.restore();
  ctx.fill();
  return Texture.from(c);
}


export function tickerText(stock: StockView | undefined, symbol: string): string {
  if (!stock) return `${symbol}\n--`;
  if (stock.status === 'paused') return `${symbol}\nPAUSED`;
  const c = stock.change24hPct;
  if (c === null) return `${symbol}\n--`;
  return `${symbol}\n${c >= 0 ? '^+' : '_'}${c.toFixed(2)}%`;
}

function renderTickerText(text: string, width: number, height: number, axis: 'i' | 'j'): Texture {
  const [line1 = '', line2 = ''] = text.split('\n');
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  const color = line2.startsWith('^') ? '#3dff7a' : line2.startsWith('_') ? '#ff4d5e' : '#ffb13d';
  drawText(ctx, line1, Math.max(6, Math.floor((width - textWidth(line1)) / 2)), 7, '#d6ecff');
  drawText(ctx, line2, Math.max(6, Math.floor((width - textWidth(line2)) / 2)), 18, color);
  const tex = Texture.from(axis === 'i' ? shearRightWall(c) : shearLeftWall(c));
  tex.source.scaleMode = 'nearest';
  return tex;
}

function hex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

/** A sign: pixel text on a dark plate with a coloured frame. */
function signTexture(text: string, color: number, scale: number): Texture {
  const pad = 3 * scale;
  const w = textWidth(text, scale) + pad * 2 + 4;
  const h = 7 * scale + pad * 2 + 4;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#16182c';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = hex(color);
  ctx.fillRect(0, 0, w, 2);
  ctx.fillRect(0, h - 2, w, 2);
  ctx.fillRect(0, 0, 2, h);
  ctx.fillRect(w - 2, 0, 2, h);
  drawText(ctx, text, pad + 2, pad + 2, '#f4f6ff', scale);
  const tex = Texture.from(c);
  tex.source.scaleMode = 'nearest';
  return tex;
}

/** The top of the wall face at a wall cell: left end for a back-right wall, right end for a back-left wall. */
function faceTop(heights: Uint8Array, W: number, i: number, j: number, axis: 'i' | 'j'): { x: number; y: number; h: number } {
  const p = cellToScreen(i, j);
  const h = Math.max(1, heights[idx(W, i, j)] ?? 1);
  return { x: axis === 'i' ? p.x - 16 : p.x + 16, y: p.y - 8 - 16 * (h - 1), h };
}

/** Pixel positions of the lit dots on a sprite (the server racks' status lights). */
function ledPixels(atlas: Atlas, f: Frame): Array<[number, number]> {
  const ctx = atlas.canvas.getContext('2d', { willReadFrequently: true })!;
  const data = ctx.getImageData(f.x, f.y, f.w, f.h).data;
  const out: Array<[number, number]> = [];
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const k = (y * f.w + x) * 4;
      const r = data[k]!;
      const g = data[k + 1]!;
      const b = data[k + 2]!;
      if (data[k + 3]! > 0 && g > 90 && g > r + 40 && g >= b - 10) out.push([x, y]);
    }
  }
  return out;
}

const DESK_TINT = [0xffffff, 0xffffff, 0xe6c07a];
const STAGE_COLOR = [0xbdb5a6, 0x9fe0a8, 0x6fa8ff, 0xffd36b, 0xffa040, 0xff4040];

interface Pop {
  item: LayerItem;
  sx: number;
  sy: number;
  y: number;
  t: number;
}

/** Ease out with bounces: things drop in and land. */
function bounceOut(u: number): number {
  const n = 7.5625;
  const d = 2.75;
  if (u < 1 / d) return n * u * u;
  if (u < 2 / d) return n * (u -= 1.5 / d) * u + 0.75;
  if (u < 2.5 / d) return n * (u -= 2.25 / d) * u + 0.9375;
  return n * (u -= 2.625 / d) * u + 0.984375;
}

export function buildWorld(
  plan: FloorLayout,
  growth: Growth,
  atlas: Atlas,
  stocks: Map<string, StockView>,
  popIn: ReadonlySet<number> = new Set(),
  freshLandmarks: ReadonlySet<string> = new Set(),
): World {
  const bounds = worldBounds(plan);
  const { W } = plan;
  const stage = growth.stage;
  const ring = plan.rings[stage]!;
  const blocked = growth.blocked();
  const main = new SortedLayer(atlas.source, bounds, { position: true, vertex: true, uvs: true, color: false, rotation: false });
  const overlay = new Container();
  const lights = new Container();
  const signs = new Container();
  const fx = new Container(); // cranes and scaffolding while something is being built
  overlay.addChild(fx);
  const under = new Container(); // grey shells of lots to come, under everything that stands
  const backdrop = new Container(); // the far skyline, behind the city
  const pops: Pop[] = [];
  const built = (r: Room): boolean => growth.isBuilt(r);
  // the building and its 2-cell apron come from the plan; everything past it is the city of this stage
  const APRON = 2;
  // wings: a ring's strips open one at a time (plan.ts wingOrder); the ones still shut are city for now
  // wings open one at a time; the shut ones are building sites inside the office's outline (never city)
  const open = openness(plan, stage, (id) => growth.built[id] === 1);
  const openStrip = open.openStrip;
  const inClosed = (i: number, j: number): boolean => open.closedRects.some((r) => i >= r.i0 && i < r.i0 + r.w && j >= r.j0 && j < r.j0 + r.h);
  const city = planCity(plan, stage, (k) => atlas.has(`world:${k}`), (k) => atlas.frame(`world:${k}`));
  // what stands where: every placement claims its tiles in its zone, what does not fit is skipped (floor/scene.ts)
  const scene = layoutScene(plan, open, city, growth.count);
  // every sign's spot, worked out once (floor/signs.ts; the label tests check these same spots)
  const signSpots = planSigns({
    plan, stage, count: growth.count, built: (id) => growth.built[id] === 1, symbolOf: growth.symbolOf, city, scene,
    frames: (k) => (atlas.has(`world:${k}`) ? atlas.frame(`world:${k}`) : null),
  });
  const spotAt = new Map(signSpots.map((x) => [x.key, x]));
  const a0 = ring.i0 - APRON;
  const a1 = ring.i1 + APRON;
  const inApron = (i: number, j: number): boolean => i >= a0 && i <= a1 && j >= a0 && j <= a1;
  const i0 = Math.min(a0, city.i0, city.j0);
  const i1 = Math.max(a1, city.i1, city.j1);
  /** a cell next to (or on) something built: walls here bound the building, even beside a shut wing */
  function nearBuiltCell(i: number, j: number): boolean {
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (isBuiltCell(idx(W, i + di, j + dj))) return true;
    return false;
  }
  function isBuiltCell(k: number): boolean {
    const t = plan.tile[k];
    if (plan.ringOf[k]! > stage) return false;
    if (t === T.ROOM) return growth.built[plan.roomOf[k]!] === 1;
    return t === T.CORRIDOR;
  }

  // floor: a look per room type (carpet, wood, tile, marble...), lots bare, the street round the current building
  const floorLayer = new SortedLayer(atlas.source, bounds, { position: false, vertex: false, uvs: false, color: false, rotation: false });
  const heights = new Uint8Array(plan.W * plan.H);
  const outer = plan.rings[stage]!;
  const variantAt = (i: number, j: number): number => ((Math.imul(i, 73856093) ^ Math.imul(j, 19349663)) >>> 0) % 4;
  const styleFrame = (style: string, i: number, j: number): string => {
    if (style === 'platform') return 'world:floor_subway';
    return `world:fl_${style === 'street' ? 'asphalt' : style}_${variantAt(i, j)}`;
  };
  const wallish = (k: number): boolean => {
    const t = plan.tile[k];
    return t === T.WALL || (t === T.DOOR && blocked[k] === 1);
  };
  /** the floor a cell shows (walls show the floor of the cell behind them) */
  const floorOfCell = (i: number, j: number): { frame: string; tint: number } => {
    const k = idx(W, i, j);
    const t = plan.tile[k];
    const r = plan.ringOf[k]!;
    if (r > stage || t === T.STREET || t === T.VOID) {
      const near = Math.abs(i - ring.spawn.i) <= 2 && Math.abs(j - ring.spawn.j) <= 2;
      if (near) return { frame: 'world:floor_subway', tint: 0x9aa1b8 };
      const d = Math.max(outer.i0 - i, i - outer.i1, outer.j0 - j, j - outer.j1);
      if (d >= 1 && d <= 2) return { frame: styleFrame('sidewalk', i, j), tint: 0xffffff };
      return { frame: styleFrame('asphalt', i, j), tint: 0xffffff };
    }
    if (t === T.ROOM) {
      if (growth.built[plan.roomOf[k]!]) return { frame: styleFrame(FLOOR_STYLES[plan.floorOf[k]!] ?? 'carpet', i, j), tint: plan.floorTint[k]! };
      return { frame: styleFrame('lot', i, j), tint: 0xffffff };
    }
    if (t === T.CORRIDOR) return { frame: styleFrame('vinyl', i, j), tint: r === 5 ? 0xe8b8b8 : CORRIDOR_TINT };
    if (t === T.DOOR && blocked[k] === 0) return { frame: styleFrame('vinyl', i, j), tint: CORRIDOR_TINT };
    return { frame: styleFrame('lot', i, j), tint: 0xffffff };
  };
  interface Face {
    i: number;
    j: number;
    axis: 'i' | 'j';
    tall: boolean;
    kind: 'plain' | 'window' | 'panel';
  }
  const faces: Face[] = [];
  const mounted = new Set<number>();
  for (const pr of plan.props) if (pr.wall) for (let n = 0; n < Math.ceil((atlas.has(`world:${pr.kind}`) ? atlas.frame(`world:${pr.kind}`).w : 32) / 16); n++) mounted.add(pr.wall === 'i' ? idx(W, pr.i + n, pr.j) : idx(W, pr.i, pr.j + n));
  for (const r of plan.rooms) if (r.ticker && r.kind === 'stock' && built(r) && growth.symbolOf[r.id]) for (let n = 0; n < 7; n++) mounted.add(r.ticker.axis === 'i' ? idx(W, r.ticker.i + n, r.ticker.j) : idx(W, r.ticker.i, r.ticker.j + n));
  for (let j = i0; j <= i1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (inClosed(i, j) && !nearBuiltCell(i, j) && plan.ringOf[idx(W, i, j)]! <= stage) {
        // a shut wing: a building site inside the office's outline
        const p = cellToScreen(i, j);
        const t = makeParticle(atlas.frame(styleFrame('dirt', i, j)), p.x, p.y);
        t.tint = 0xcabca6;
        floorLayer.add(t, i + j);
        continue;
      }
      if (!inApron(i, j)) {
        // the city: dithered and darkened towards its edge, so it fades into the night instead of stopping
        const g = city.ground.get(CITY_KEY(i, j));
        if (!g || g.fade > BAYER[(i & 3) * 4 + (j & 3)]!) continue;
        const p = cellToScreen(i, j);
        const t = makeParticle(atlas.frame(styleFrame(g.style, i, j)), p.x, p.y);
        t.tint = darken(g.tint, g.fade * 0.7);
        floorLayer.add(t, i + j);
        continue;
      }
      const k = idx(W, i, j);
      const t = plan.tile[k];
      let cell = floorOfCell(i, j);
      if (wallish(k) || t === T.DOOR) {
        let near = false;
        for (let dj = -1; dj <= 1 && !near; dj++) for (let di = -1; di <= 1 && !near; di++) if (isBuiltCell(idx(W, i + di, j + dj))) near = true;
        if (near && wallish(k)) {
          // thin walls on the cell's front edges; the cell shows the floor behind the wall
          const alongI = wallish(idx(W, i - 1, j)) || wallish(idx(W, i + 1, j));
          const alongJ = wallish(idx(W, i, j - 1)) || wallish(idx(W, i, j + 1));
          const tee = (a: number, b: number, c: number): boolean => wallish(a) && wallish(b) && !wallish(c);
          const faceI = (!wallish(idx(W, i, j + 1)) && (alongI || !alongJ)) || (wallish(idx(W, i, j + 1)) && tee(idx(W, i - 1, j), idx(W, i + 1, j), idx(W, i - 1, j + 1)));
          const faceJ = (!wallish(idx(W, i + 1, j)) && (alongJ || !alongI)) || (wallish(idx(W, i + 1, j)) && tee(idx(W, i, j - 1), idx(W, i, j + 1), idx(W, i + 1, j - 1)));
          const behindOut = (bk: number): boolean => !isBuiltCell(bk) && !wallish(bk) && plan.tile[bk] !== T.DOOR;
          if (faceI) {
            const out = behindOut(idx(W, i, j - 1));
            const tall = out || mounted.has(k);
            faces.push({ i, j, axis: 'i', tall, kind: out ? 'window' : mounted.has(k) ? 'panel' : 'plain' });
            if (tall) heights[k] = 3;
          }
          if (faceJ) {
            const out = behindOut(idx(W, i - 1, j));
            const tall = out || mounted.has(k);
            faces.push({ i, j, axis: 'j', tall, kind: out ? 'window' : mounted.has(k) ? 'panel' : 'plain' });
            if (tall) heights[k] = 3;
          }
          if (!heights[k]) heights[k] = 1;
          const behind = isBuiltCell(idx(W, i, j - 1)) ? [i, j - 1] : isBuiltCell(idx(W, i - 1, j)) ? [i - 1, j] : isBuiltCell(idx(W, i, j + 1)) ? [i, j + 1] : [i + 1, j];
          const bi = behind[0]!;
          const bj = behind[1]!;
          cell = floorOfCell(bi, bj);
          if (!isBuiltCell(idx(W, bi, bj))) cell = { frame: styleFrame('lot', i, j), tint: 0xffffff };
        } else if (!near) {
          const outside = plan.ringOf[k]! > stage || plan.ringOf[k]! === stage + 1;
          cell = outside ? floorOfCell(i + 99, j + 99) : { frame: styleFrame('lot', i, j), tint: 0xffffff };
          if (plan.ringOf[k]! > stage) cell = floorOfCell(Math.min(i, W - 1), j);
        }
      }
      const p = cellToScreen(i, j);
      const tile = makeParticle(atlas.frame(cell.frame), p.x, p.y);
      tile.tint = cell.tint;
      floorLayer.add(tile, i + j);
    }
  }

  // which room a prop belongs to (wall pieces belong to the room they face)
  const roomOfProp = (pr: Prop): Room | null => {
    if (pr.ring !== undefined) return null;
    const i = pr.wall === 'j' ? pr.i + 1 : pr.i;
    const j = pr.wall === 'i' ? pr.j + 1 : pr.j;
    const id = plan.roomOf[idx(W, i, j)]!;
    return id >= 0 ? plan.rooms[id]! : null;
  };
  const propVisible = (pr: Prop): boolean => {
    if (pr.ring !== undefined) return pr.ring === stage;
    const r = roomOfProp(pr);
    return !!r && built(r);
  };
  const popping = (pr: Prop): boolean => {
    const r = roomOfProp(pr);
    return !!r && popIn.has(r.id);
  };
  const addPop = (item: LayerItem, delay: number): void => {
    pops.push({ item, sx: item.p.scaleX, sy: item.p.scaleY, y: item.p.y, t: -delay });
    item.p.scaleX = 0;
    item.p.scaleY = 0;
  };

  for (const pr of plan.props) {
    if (!pr.flat || !propVisible(pr)) continue;
    const c = cellCentre(pr.i, pr.j);
    const p = makeParticle(atlas.frame(`world:${pr.kind}`), c.x + (pr.dx ?? 0), c.y + (pr.dy ?? 0), pr.mirror);
    if (pr.tint !== undefined) p.tint = pr.tint;
    floorLayer.add(p, 1e6 + pr.i + pr.j);
  }
  // lots of the current ring not built yet: blueprint floor, and a lock sign saying what comes and when
  const lockSigns: Sprite[] = [];
  // signs only on what comes next: the next few amenities by rat count and the next desk rooms in build order
  const lots = plan.rooms.filter((r) => r.ring === stage && !built(r) && openStrip.has(`${r.ring}:${r.strip}`));
  for (const r of lots) {
    for (let i = r.i0; i < r.i0 + r.w; i++) {
      for (let j = r.j0; j < r.j0 + r.h; j++) {
        const p = cellToScreen(i, j);
        // a building site, not a flat blueprint: dug-over dirt, hazard tape round the edge
        const t = makeParticle(atlas.frame(styleFrame('dirt', i, j)), p.x, p.y);
        t.tint = 0xd8ccb8;
        floorLayer.add(t, 1e5 + i + j);
        if (j === r.j0) floorLayer.add(makeParticle(atlas.frame('world:tape_i'), p.x + 8, p.y + 4), 1e6 + i + j);
        if (j === r.j0 + r.h - 1) floorLayer.add(makeParticle(atlas.frame('world:tape_i'), p.x - 8, p.y + 12), 1e6 + i + j);
        if (i === r.i0) floorLayer.add(makeParticle(atlas.frame('world:tape_j'), p.x - 8, p.y + 4), 1e6 + i + j);
        if (i === r.i0 + r.w - 1) floorLayer.add(makeParticle(atlas.frame('world:tape_j'), p.x + 8, p.y + 12), 1e6 + i + j);
      }
    }
    const sp = spotAt.get(`lock:${r.id}`);
    if (!sp) continue;
    const s = new Sprite(lockTexture(sp.text, sp.sub ?? ''));
    s.anchor.set(0.5, 1);
    s.position.set(sp.x, sp.y);
    signs.addChild(s);
    lockSigns.push(s);
  }

  // the city round the building: lots, street furniture, street scenes, traffic, upcoming lots as grey shells
  const cityView = renderCity(city, stage, atlas, main, floorLayer, under, signs, backdrop, lights, scene);
  lockSigns.push(...cityView.shells);


  const floor = floorLayer.container;

  // walls: thin faces, low (cut away) inside, tall on the building's back walls and where things hang
  const evil = stage >= 5 ? 0xe0a0a8 : 0xffffff;
  // the founders' garage keeps its roll-up door (open) over the front door
  const gdoor = plan.rings[0]!.entrance;
  const gi = Math.min(...gdoor.map((c) => c.i));
  for (let i = gi - 1; i <= gi + 2; i++) {
    const p = cellToScreen(i, gdoor[0]!.j);
    main.add(makeParticle(atlas.frame('world:wf_i_tall_header'), p.x, p.y), i + gdoor[0]!.j + 0.52);
  }
  for (const f of faces) {
    const name = `world:wf_${f.axis}_${f.tall ? 'tall' : 'low'}${f.tall && f.kind !== 'plain' ? '_' + f.kind : ''}`;
    const p = cellToScreen(f.i, f.j);
    const w = makeParticle(atlas.frame(name), p.x, p.y);
    if (plan.ringOf[idx(W, f.i, f.j)] === 5) w.tint = evil;
    main.add(w, f.i + f.j + 0.5);
  }

  // desks, in pods; a pod stands once one of its rats is in, until then it is a taped-off building site.
  // Chairs only while their rat is away (empty desks stay chairless).
  const deskA = atlas.frame('world:desk_oak_clutter');
  const deskB = atlas.frame('world:desk_oak');
  const deskF = atlas.frame('world:desk_back');
  const chairF = atlas.frame('world:chair');
  const chairs = new Map<number, LayerItem>();
  const chairAt = new Map<number, { x: number; y: number; mirror: boolean; depth: number }>();
  const podSeats = new Map<number, Seat[]>();
  const podRoom = new Map<number, Room>();
  const podItems = new Map<number, { main: LayerItem[]; floor: LayerItem[] }>();
  let delay = 0;
  const placeDesk = (r: Room, s: Seat, pop: boolean): LayerItem => {
    const c = cellCentre(s.deskAt.i, s.deskAt.j);
    const frameD = s.view === 'front' ? deskF : s.variant === 1 ? deskB : deskA;
    const desk = makeParticle(frameD, c.x, c.y + 20, s.axis === 'i');
    desk.tint = r.kind === 'ceo' ? DESK_TINT[2]! : 0xffffff;
    const item = main.add(desk, s.deskAt.i + s.deskAt.j + 1);
    if (pop) addPop(item, (delay += 0.015));
    return item;
  };
  const siteItems = (pod: number): { main: LayerItem[]; floor: LayerItem[] } => {
    // tape round the pod's cells, a boxed-up desk and a ladder or cones
    const seats = podSeats.get(pod)!;
    const cells = new Set<number>();
    for (const s of seats) for (const c of s.cells) cells.add(idx(W, c.i, c.j));
    const out = { main: [] as LayerItem[], floor: [] as LayerItem[] };
    for (const k of cells) {
      const i = k % W;
      const j = Math.floor(k / W);
      const p = cellToScreen(i, j);
      if (!cells.has(idx(W, i, j - 1))) out.floor.push(floorLayer.add(makeParticle(atlas.frame('world:tape_i'), p.x + 8, p.y + 4), 1e6 + i + j));
      if (!cells.has(idx(W, i, j + 1))) out.floor.push(floorLayer.add(makeParticle(atlas.frame('world:tape_i'), p.x - 8, p.y + 12), 1e6 + i + j));
      if (!cells.has(idx(W, i - 1, j))) out.floor.push(floorLayer.add(makeParticle(atlas.frame('world:tape_j'), p.x - 8, p.y + 4), 1e6 + i + j));
      if (!cells.has(idx(W, i + 1, j))) out.floor.push(floorLayer.add(makeParticle(atlas.frame('world:tape_j'), p.x + 8, p.y + 12), 1e6 + i + j));
    }
    const s0 = seats[0]!;
    const c = cellCentre(s0.deskAt.i, s0.deskAt.j);
    out.main.push(main.add(makeParticle(atlas.frame(pod % 3 === 0 ? 'world:box_pile' : 'world:box_long'), c.x, c.y + 4, pod % 2 === 0), s0.deskAt.i + s0.deskAt.j + 1));
    const s1 = seats[seats.length - 1]!;
    const c1 = cellCentre(s1.pos.i, s1.pos.j);
    out.main.push(main.add(makeParticle(atlas.frame(pod % 2 === 0 ? 'world:box_s' : 'world:box_half'), c1.x, c1.y + 2, pod % 3 === 1), s1.pos.i + s1.pos.j + 1));
    return out;
  };
  for (const r of plan.rooms) {
    if (!built(r)) continue;
    for (const s of r.seats) {
      const l = podSeats.get(s.pod) ?? [];
      l.push(s);
      podSeats.set(s.pod, l);
      podRoom.set(s.pod, r);
      const sc = cellCentre(s.pos.i, s.pos.j);
      chairAt.set(s.id, { x: sc.x, y: sc.y + 3, mirror: s.axis === 'j' ? s.view === 'back' : s.view === 'front', depth: s.pos.i + s.pos.j + 0.95 });
    }
  }
  const podActive = (pod: number): boolean => {
    const r = podRoom.get(pod)!;
    return r.kind === 'ceo' || podSeats.get(pod)!.some((s) => growth.owner[s.id]! >= 0);
  };
  for (const [pod, seats] of podSeats) {
    const r = podRoom.get(pod)!;
    if (podActive(pod)) {
      const pop = popIn.has(r.id);
      podItems.set(pod, { main: seats.map((s) => placeDesk(r, s, pop)), floor: [] });
    } else podItems.set(pod, siteItems(pod));
  }
  floorLayer.sync(true);

  // props, wall pieces and glows
  const warm = glowTexture(255, 186, 102);
  const cool = glowTexture(120, 200, 255);
  const rackLeds: Array<{ x: number; y: number; color: number }> = [];
  const ledCache = new Map<string, Array<[number, number]>>();
  const addGlow = (tex: Texture, x: number, y: number, scale: number, alpha = 1): Sprite => {
    const g = new Sprite(tex);
    g.anchor.set(0.5);
    g.position.set(x, y);
    g.scale.set(scale);
    g.alpha = alpha;
    g.blendMode = 'add';
    lights.addChild(g);
    return g;
  };
  for (const pr of plan.props) {
    if (pr.flat || !propVisible(pr)) continue;
    if (pr.kind === 'street_lamp' && pr.ring !== undefined) continue; // the city places its own lamps
    const f = atlas.frame(`world:${pr.kind}`);
    const pop = popping(pr);
    if (pr.wall) {
      const item = placeOnWall(heights, W, main, f, pr);
      if (pop) addPop(item, (delay += 0.02));
      if (pr.kind === 'tv_wall') {
        const t = faceTop(heights, W, pr.i, pr.j, pr.wall);
        addGlow(cool, t.x + (pr.wall === 'i' ? 18 : -18), t.y + 18, 0.5, 0.7);
      }
      continue;
    }
    const c = cellCentre(pr.i, pr.j);
    const x = c.x + (pr.dx ?? 0);
    const y = c.y + (pr.dy ?? 0);
    const sc = pr.scale ?? 1;
    const p = makeParticle(f, x, y, pr.mirror, sc);
    if (pr.tint !== undefined) p.tint = pr.tint;
    const item = main.add(p, pr.i + pr.j + 1 + (pr.bias ?? 0));
    if (pop) addPop(item, (delay += 0.02));
    if (pr.kind === 'lamp') addGlow(warm, x, y - 6, 1.6);
    if (pr.glow !== undefined) {
      addGlow(warm, x, y - f.h + 12, 0.7, 0.8);
      addGlow(warm, x, y, 1.5, 0.45);
    }
    if (pr.kind.startsWith('server_rack')) {
      let px = ledCache.get(pr.kind);
      if (!px) ledCache.set(pr.kind, (px = ledPixels(atlas, f)));
      const left = x - f.anchorX * f.w * sc;
      const top = y - f.anchorY * f.h * sc;
      for (let n = 0; n < Math.min(12, px.length); n++) {
        const [lx, ly] = px[Math.floor(Math.random() * px.length)]!;
        rackLeds.push({ x: Math.round(pr.mirror ? x + (f.anchorX * f.w - 1 - lx) * sc : left + lx * sc), y: Math.round(top + ly * sc), color: [0x6dffb0, 0x7ad7ff, 0xffc75a][n % 3]! });
      }
    }
  }

  // vignette extras: posed rats that belong to the set, animated in place (tears for the one crying in the WC)
  const extras: Array<{ p: Particle; frames: Frame[]; k: number; t: number; fps: number; hold: boolean; acc?: Particle; accFrames?: Frame[] }> = [];
  const tears: Array<{ s: Sprite; x: number; y: number; t: number }> = [];
  const tearTex = (() => {
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 3;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#8fd8ff';
    ctx.fillRect(0, 0, 2, 3);
    ctx.fillStyle = '#e8f8ff';
    ctx.fillRect(0, 0, 1, 1);
    const t = Texture.from(c);
    t.source.scaleMode = 'nearest';
    return t;
  })();
  for (const a of plan.actors) {
    const room = plan.rooms[a.room]!;
    if (!built(room)) continue;
    let frames: Frame[];
    try {
      frames = atlas.anim(`${a.look}/${a.anim}`);
    } catch {
      continue;
    }
    const c = cellCentre(a.i, a.j);
    const tier = a.look.split('.')[0] as keyof typeof TIER_SCALE;
    const sc = TIER_SCALE[tier] ?? 1;
    const f0 = frames[0]!;
    const p = makeParticle(f0, c.x + a.dx, c.y + a.dy, a.mirror, sc);
    const item = main.add(p, a.i + a.j + 1.25 + (a.dy < -10 ? 1.2 : 0));
    if (popIn.has(room.id)) addPop(item, (delay += 0.02));
    const fps = a.anim === 'cheer' ? 9 : a.anim.startsWith('walk') ? 10 : 4;
    extras.push({ p, frames, k: Math.floor(Math.random() * frames.length), t: 0, fps, hold: a.anim === 'slump' });
    if (a.tears) {
      for (let n = 0; n < 2; n++) {
        const s = new Sprite(tearTex);
        s.position.set(c.x + a.dx + (a.mirror ? -4 : 4) - n * 6, c.y + a.dy - 30 * sc);
        overlay.addChild(s);
        tears.push({ s, x: s.x, y: s.y, t: n * 0.4 });
      }
    }
  }

  // never empty: applicants queue in the lobby, the founders hang about the garage at the start
  const posed = (look: string, anim: string, i: number, j: number, mirror: boolean, acc?: string, claimed = false): void => {
    // a rat on its own tile: skipped when the tile is taken (the scene already claimed its own rats)
    if (!claimed && !scene.zoning.claim({ what: `${look}/${anim}`, cat: 'extra', cells: [[i, j]] }, ['office', 'slot', 'apron', 'site'])) return;
    let frames: Frame[];
    try {
      frames = atlas.anim(`${look}/${anim}`);
    } catch {
      return;
    }
    const c = cellCentre(i, j);
    const sc = TIER_SCALE[look.split('.')[0] as keyof typeof TIER_SCALE] ?? 1;
    const p = makeParticle(frames[0]!, c.x, c.y, mirror, sc);
    main.add(p, i + j + 1.25);
    const k = Math.floor(Math.random() * frames.length);
    let hat: Particle | undefined;
    let accFrames: Frame[] | undefined;
    if (acc) {
      try {
        accFrames = atlas.anim(`acc/${acc}/${anim}`);
        hat = makeParticle(accFrames[k] ?? accFrames[0]!, c.x, c.y, mirror, sc);
        main.add(hat, i + j + 1.26);
      } catch {
        accFrames = undefined;
      }
    }
    extras.push({ p, frames, k, t: 0, fps: anim === 'cheer' ? 8 : 4, hold: false, acc: hat, accFrames });
  };
  {
    const lobby = plan.rooms[ring.lobby]!;
    const door = ring.entrance[1] ?? ring.entrance[0]!;
    const inI = door.i === ring.i1; // the door is in the +i wall: walk in towards -i
    const queue = 2 + (growth.count % 4);
    const looks = ['intern', 'intern.brown', 'analyst.white', 'intern.black', 'associate'];
    for (let k = 0; k < queue; k++) {
      const i = inI ? door.i - 2 - k : door.i + (k % 2 === 0 ? 0 : 1) - 1;
      const j = inI ? door.j + (k % 2 === 0 ? 0 : 1) - 1 : door.j - 2 - k;
      if (i < lobby.i0 || j < lobby.j0) break;
      posed(looks[k % looks.length]!, 'idle_ne', i, j, inI);
    }
    if (stage === 0) {
      const g = plan.garage;
      posed('partner', 'idle_ne', g.i0 + 3, g.j0 + 2, false);
      posed('vp.white', 'cheer', plan.vault.i + 3, plan.vault.j - 2, true);
    }
  }

  // the building sites (rooms still to come, shut wings): material and cones on the dirt, a crane and a hard-hat crew
  // on the next rooms to open; all placed by the scene, one thing per free tile
  for (const q of scene.siteProps) {
    if (!atlas.has(`world:${q.kind}`)) continue;
    const c = cellCentre(q.i, q.j);
    main.add(makeParticle(atlas.frame(`world:${q.kind}`), c.x, c.y + 4, q.mirror, q.scale), q.i + q.j + 1);
  }
  for (const q of scene.cranes) {
    if (!atlas.has('world:crane')) continue;
    const c = cellCentre(q.i, q.j);
    main.add(makeParticle(atlas.frame('world:crane'), c.x, c.y, q.mirror, q.scale), q.i + q.j + 1);
  }
  for (const q of scene.crew) posed(q.look, q.anim, q.i, q.j, q.mirror, q.acc, true);

  // blinking server lights
  const dot = document.createElement('canvas');
  dot.width = 2;
  dot.height = 1;
  dot.getContext('2d')!.fillRect(0, 0, 2, 1);
  const leds = new ParticleContainer({ dynamicProperties: { position: false, vertex: false, uvs: false, color: true, rotation: false } });
  leds.blendMode = 'add';
  leds.boundsArea = new Rectangle(bounds.x, bounds.y, bounds.w, bounds.h);
  const ledParticles: Particle[] = [];
  const dotTex = Texture.from(dot);
  for (const l of rackLeds) {
    const p = new Particle({ texture: dotTex, x: l.x, y: l.y, tint: l.color, alpha: Math.random() < 0.5 ? 1 : 0.15 });
    leds.addParticle(p);
    ledParticles.push(p);
  }
  lights.addChild(leds);

  // the Vault: the money pile on the plaza in the middle of the garage, the centre of the building. Its sprite and
  // size follow the portfolio value (VaultView); here it only gets its place in the depth order and its glow.
  const vc = cellToScreen(plan.vault.i, plan.vault.j);
  const vaultItem = main.add(makeParticle(atlas.frame('world:vault_0'), vc.x, vc.y), plan.vault.i + plan.vault.j + 1);
  const vaultGlow = addGlow(glowTexture(110, 255, 150), vc.x, vc.y - 24, 3.2, 0);
  const sp = cellCentre(ring.spawn.i, ring.spawn.j);
  addGlow(glowTexture(140, 255, 170), sp.x, sp.y + 10, 1.4, 0.5);

  // wall tickers on built stock rooms
  const tickerFrame = atlas.frame('world:ticker_wall');
  const tickers: Ticker[] = [];
  for (const r of plan.rooms) {
    const symbol = growth.symbolOf[r.id];
    if (r.kind !== 'stock' || !r.ticker || !symbol || !built(r)) continue;
    const t = faceTop(heights, W, r.ticker.i, r.ticker.j, r.ticker.axis);
    const screen = new Sprite(tickerFrame.texture);
    const text = new Sprite(Texture.EMPTY);
    const y = t.y - 2;
    if (r.ticker.axis === 'i') {
      screen.position.set(t.x + 3, y);
      text.position.set(t.x + 3, y);
    } else {
      screen.scale.x = -1;
      screen.position.set(t.x - 3, y);
      text.position.set(t.x - 3 - tickerFrame.w, y);
    }
    overlay.addChild(screen, text);
    tickers.push({ room: r, symbol, text, axis: r.ticker.axis, lastText: '' });
  }
  updateTickers({ tickers }, stocks);

  // signs: every built room gets one (stock rooms show their symbol), the building gets its stage name
  const roomSigns: Sprite[] = [];
  const landmarkSigns: Sprite[] = [];
  const signBase = new Map<Sprite, number>();
  let lastLayoutZoom = -1;
  for (const r of plan.rooms) {
    const sp = spotAt.get(`room:${r.id}`);
    if (!sp) continue;
    const s = new Sprite(signTexture(sp.text, r.tint, 2));
    s.anchor.set(0.5, 1);
    s.position.set(sp.x, sp.y);
    signs.addChild(s);
    roomSigns.push(s);
  }
  // the company name: over the building, or on tower A's roof once it stands
  const nameAt = spotAt.get('name')!;
  const name = new Sprite(signTexture(nameAt.text, STAGE_COLOR[stage] ?? 0xffd36b, 3));
  name.anchor.set(0.5, 1);
  name.position.set(nameAt.x, nameAt.y);
  signs.addChild(name);

  // landmark set pieces (one per milestone) and the towers that grow the office upwards
  const lm = renderLandmarks({
    plan, stage, count: growth.count, built: (id) => growth.built[id] === 1, city, atlas, main, lights, signs, fresh: freshLandmarks,
    addPop, posed, sign: (t, c) => signTexture(t, c, 2), scene,
  });
  landmarkSigns.push(...lm.signs);

  // a new room goes up: scaffolding over it and a crane beside it, for a moment
  const builders: Array<{ s: Sprite; t: number; life: number; base: number }> = [];
  for (const r of plan.rooms) {
    if (!popIn.has(r.id) || r.kind === 'lobby') continue;
    const c = cellCentre(r.i0 + r.w / 2 - 0.5, r.j0 + r.h / 2 - 0.5);
    const sc = new Sprite(atlas.frame('world:scaffold').texture);
    sc.anchor.set(0.5, 1);
    sc.position.set(c.x, c.y + 20);
    fx.addChild(sc);
    builders.push({ s: sc, t: 0, life: 1.6 + builders.length * 0.05, base: 1 });
    if (builders.length < 12) {
      const cr = new Sprite(atlas.frame('world:crane').texture);
      const cc = cellCentre(r.i0 - 1, r.j0 + r.h - 1);
      cr.anchor.set(0.5, 1);
      cr.position.set(cc.x, cc.y);
      cr.scale.set(0.8);
      fx.addChild(cr);
      builders.push({ s: cr, t: 0, life: 2.4, base: 0.8 });
    }
  }

  // the job-fair sign: made when the first rat lines up outside, redrawn when the count changes
  let fair: Sprite | null = null;
  let fairText = '';
  let fairOn = false;
  let zoom = 1;
  const signGroups = (): Array<[Sprite[], SignKind]> => [
    [landmarkSigns, 'landmark'],
    [[name], 'name'],
    [fair ? [fair] : [], 'fair'],
    [lockSigns, 'lock'],
    [roomSigns, 'room'],
  ];
  /** Lay the signs showing at this zoom out so none overlaps: the less important move up a step or hide. */
  const relayout = (): void => {
    lastLayoutZoom = zoom;
    const shown = signGroups().flatMap(([list, kind]) => list.filter((x) => x.visible && x.alpha > 0.01).map((x) => ({ s: x, ...SIGN_PRIO[kind] })));
    for (const x of shown) if (!signBase.has(x.s)) signBase.set(x.s, x.s.y);
    const boxes = shown.map((x) => ({ x: x.s.x, y: signBase.get(x.s)!, w: x.s.texture.width * Math.abs(x.s.scale.x), h: x.s.texture.height * Math.abs(x.s.scale.y), prio: x.prio, steps: x.steps }));
    const spots = layoutLabels(boxes);
    shown.forEach((x, n) => {
      const sp = spots[n]!;
      x.s.y = signBase.get(x.s)! - sp.dy;
      x.s.renderable = sp.visible;
    });
  };

  main.sync(true);
  let blink = 0;
  let clock = 0;
  return {
    bounds,
    backdrop,
    floor,
    under,
    main,
    overlay,
    lights,
    signs,
    tickers,
    vault: { item: vaultItem, x: vc.x, y: vc.y, glow: vaultGlow },
    line: scene.line,
    blocked,
    update(dt: number): void {
      clock += dt;
      cityView.update(dt);
      lm.update(dt);
      for (let k = builders.length - 1; k >= 0; k--) {
        const b = builders[k]!;
        b.t += dt;
        const u = b.t / b.life;
        if (u > 0.75) b.s.alpha = Math.max(0, 1 - (u - 0.75) / 0.25);
        if (u >= 1) {
          b.s.destroy();
          builders.splice(k, 1);
        }
      }
      for (const e of extras) {
        e.t += dt;
        if (e.t < 1 / e.fps) continue;
        e.t = 0;
        e.k = e.k + 1 >= e.frames.length ? (e.hold ? e.frames.length - 3 : 0) : e.k + 1;
        const f = e.frames[e.k]!;
        e.p.texture = f.texture;
        e.p.anchorX = f.anchorX;
        e.p.anchorY = f.anchorY;
        const g = e.accFrames?.[e.k];
        if (e.acc && g) {
          e.acc.texture = g.texture;
          e.acc.anchorX = g.anchorX;
          e.acc.anchorY = g.anchorY;
        }
      }
      for (const t of tears) {
        t.t = (t.t + dt) % 0.8;
        t.s.y = t.y + t.t * 14;
        t.s.alpha = 1 - t.t / 0.8;
      }
      if (pops.length) {
        for (let k = pops.length - 1; k >= 0; k--) {
          const p = pops[k]!;
          p.t += dt;
          if (p.t < 0) continue;
          // drop in from above and bounce on landing
          const u = Math.min(1, p.t / 0.5);
          p.item.p.scaleX = p.sx;
          p.item.p.scaleY = p.sy;
          p.item.p.y = p.y - 46 * (1 - bounceOut(u));
          if (u >= 1) {
            p.item.p.y = p.y;
            pops.splice(k, 1);
          }
        }
      }
      blink += dt;
      if (blink < 0.12 || !ledParticles.length) return;
      blink = 0;
      for (let n = 0; n < Math.max(1, ledParticles.length >> 4); n++) {
        const p = ledParticles[Math.floor(Math.random() * ledParticles.length)]!;
        p.alpha = p.alpha > 0.5 ? 0.12 : 1;
      }
      leds.update();
    },
    setChair(seatId: number, visible: boolean): void {
      let item = chairs.get(seatId);
      if (visible) {
        if (item) main.readd(item, item.depth);
        else {
          const at = chairAt.get(seatId);
          if (!at) return;
          item = main.add(makeParticle(chairF, at.x, at.y, at.mirror), at.depth);
          chairs.set(seatId, item);
        }
      } else if (item) main.remove(item);
    },
    setPrep(on: boolean): void {
      cityView.setPrep(on);
    },
    parallax(cx: number, cy: number): void {
      cityView.parallax(cx, cy);
    },
    cityParts(i0: number, j0: number, i1: number, j1: number): CityPart[] {
      return cityView.parts(i0, j0, i1, j1);
    },
    crown: lm.crown,
    landmarkFocus(id: string): Focus | null {
      return lm.focus.get(id) ?? null;
    },
    activatePod(seatId: number): { x: number; y: number } | null {
      const s = plan.seats[seatId];
      if (!s) return null;
      const items = podItems.get(s.pod);
      const r = podRoom.get(s.pod);
      if (!items || !r || items.floor.length === 0) return null;
      for (const it of items.main) main.remove(it);
      for (const it of items.floor) floorLayer.remove(it);
      floorLayer.sync(true);
      delay = 0;
      podItems.set(s.pod, { main: podSeats.get(s.pod)!.map((x) => placeDesk(r, x, true)), floor: [] });
      const c = cellCentre(s.deskAt.i, s.deskAt.j);
      return { x: c.x, y: c.y };
    },
    setZoom(z: number): void {
      zoom = z;
      // every kind of sign by the shared rules (floor/signs.ts): room names only at mid zoom, padlocks from mid zoom
      // in, the landmark and company names bigger the further out you are
      for (const [list, kind] of signGroups()) {
        const a = signAlpha(kind, z);
        const k = scaleFor(kind, z);
        for (const sg of list) {
          sg.alpha = a;
          sg.scale.set(k);
          sg.visible = a > 0.01 && (sg !== fair || fairOn);
        }
      }
      // no two signs overlap: landmarks first, then the company name and the job fair, padlocks, room names
      if (Math.abs(z - lastLayoutZoom) < 0.005) return;
      relayout();
    },
    setJobFair(count: number, head: Cell | null): void {
      fairOn = !!head && count > 0;
      if (!fairOn || !head) {
        if (fair) fair.visible = false;
        return;
      }
      const text = `JOB FAIR: ${count.toLocaleString('en-US')} IN LINE`;
      if (!fair) {
        fair = new Sprite(signTexture(text, 0x43d17a, 2));
        fair.anchor.set(0.5, 1);
        signs.addChild(fair);
      } else if (text !== fairText) {
        const old = fair.texture;
        fair.texture = signTexture(text, 0x43d17a, 2);
        old.destroy(true);
      }
      fair.scale.set(scaleFor('fair', zoom));
      fair.visible = true;
      const c = cellCentre(head.i, head.j);
      const moved = text.length !== fairText.length || signBase.get(fair) !== c.y - 56;
      fairText = text;
      fair.position.set(c.x, c.y - 56);
      signBase.set(fair, c.y - 56);
      if (moved) relayout();
    },
    destroy(): void {
      for (const c of [backdrop, floor, under, main.container, overlay, lights, signs]) {
        c.parent?.removeChild(c);
      }
      (main.container as ParticleContainer).particleChildren.length = 0;
      floor.destroy({ children: true });
      backdrop.destroy({ children: true, texture: true });
      under.destroy({ children: true });
      main.container.destroy();
      overlay.destroy({ children: true, texture: true });
      lights.destroy({ children: true });
      signs.destroy({ children: true, texture: true });
    },
  };
}

function placeOnWall(heights: Uint8Array, W: number, main: SortedLayer, f: Frame, pr: Prop): LayerItem {
  const axis = pr.wall!;
  const t = faceTop(heights, W, pr.i, pr.j, axis);
  const flatH = f.h - Math.floor(f.w / 2) - 1;
  const oy = Math.max(1, Math.floor((16 * t.h - flatH) / 2));
  const span = Math.ceil(f.w / 16);
  const depth = pr.i + pr.j + span - 1 + 0.55;
  const x = axis === 'i' ? t.x + 2 : t.x - 2;
  return main.add(makeParticle(f, x, t.y + oy, axis === 'j'), depth);
}

export function updateTickers(world: Pick<World, 'tickers'>, stocks: Map<string, StockView>): void {
  for (const t of world.tickers) {
    const text = tickerText(stocks.get(t.symbol), t.symbol);
    if (text === t.lastText) continue;
    t.lastText = text;
    const old = t.text.texture;
    t.text.texture = renderTickerText(text, 101, 32, t.axis);
    if (old !== Texture.EMPTY) old.destroy(true);
  }
}

/** A lock sign for a lot: what comes here and when. */
function lockTexture(what: string, when: string): Texture {
  const scale = 1;
  const w = Math.max(textWidth(what, scale), textWidth(when, scale)) + 22;
  const h = 26;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#10244e';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#6f9cf0';
  ctx.fillRect(0, 0, w, 1);
  ctx.fillRect(0, h - 1, w, 1);
  ctx.fillRect(0, 0, 1, h);
  ctx.fillRect(w - 1, 0, 1, h);
  // padlock
  ctx.fillStyle = '#ffd23f';
  ctx.fillRect(4, 10, 9, 7);
  ctx.fillRect(5, 6, 1, 4);
  ctx.fillRect(11, 6, 1, 4);
  ctx.fillRect(6, 5, 5, 1);
  ctx.fillStyle = '#10244e';
  ctx.fillRect(8, 12, 1, 3);
  drawText(ctx, what, 17, 4, '#e8f0ff', scale);
  drawText(ctx, when, 17, 14, '#ffd23f', scale);
  const tex = Texture.from(c);
  tex.source.scaleMode = 'nearest';
  return tex;
}


/** One layer of the far skyline: towers of one shade with lit windows, their bottom melting into the haze. Far layers
 *  are paler (haze), taller and smaller-windowed; near ones darker, lower and busier. */
function skylineLayer(width: number, evil: boolean, seed: number, depth: number): Texture {
  const h = 320;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = h;
  const ctx = c.getContext('2d')!;
  let s = seed >>> 0 || 1;
  const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  // depth 0 = farthest
  const far = ['#2a3358', '#202a4c', '#182040', '#10162c'];
  const farEvil = ['#4a1a26', '#3a1420', '#2c0e18', '#1e0a10'];
  const shade = (evil ? farEvil : far)[depth]!;
  const lit = evil ? [255, 90, 90] : [255, 214, 140];
  const tall = [1, 0.85, 0.65, 0.45][depth]!;
  let x = 0;
  while (x < width) {
    const w = [10, 14, 22, 30][depth]! + Math.floor(rnd() * [20, 30, 40, 52][depth]!);
    const bh = Math.floor((50 + rnd() * 230) * tall * (0.55 + 0.45 * Math.sin((x / width) * Math.PI)));
    ctx.fillStyle = shade;
    ctx.fillRect(x, h - bh, w, bh);
    // spires, stepped tops and the odd antenna with a red light
    if (rnd() < 0.25) ctx.fillRect(x + Math.floor(w / 2) - 1, h - bh - 12 - depth * 2, 2, 12 + depth * 2);
    if (rnd() < 0.3) ctx.fillRect(x + 3, h - bh - 6, w - 6, 6);
    if (depth >= 2 && rnd() < 0.2) {
      ctx.fillStyle = 'rgba(255,60,60,0.8)';
      ctx.fillRect(x + Math.floor(w / 2) - 1, h - bh - 14 - depth * 2, 2, 2);
    }
    ctx.fillStyle = `rgba(${lit[0]},${lit[1]},${lit[2]},${[0.18, 0.28, 0.42, 0.55][depth]})`;
    const step = [5, 6, 7, 8][depth]!;
    for (let y = h - bh + 5; y < h - 4; y += step) for (let wx = x + 2; wx < x + w - 2; wx += step - 1) if (rnd() < 0.08 + depth * 0.04) ctx.fillRect(wx, y, depth >= 2 ? 2 : 1, depth >= 2 ? 2 : 1);
    x += w + Math.floor(rnd() * (6 + depth * 3));
  }
  // melt the bottom into the haze: no hard line where the layer stops
  const img = ctx.getImageData(0, 0, width, h);
  for (let y = 0; y < h; y++) {
    const k = y < h * 0.4 ? 1 : Math.max(0, 1 - (y - h * 0.4) / (h * 0.6));
    for (let x = 0; x < width; x++) img.data[(y * width + x) * 4 + 3] = Math.round(img.data[(y * width + x) * 4 + 3]! * k);
  }
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(c);
  tex.source.scaleMode = 'nearest';
  return tex;
}

/** A city sprite as it stands (for the demolition effect). */
export interface CityPart {
  texture: Texture;
  x: number;
  y: number;
  ax: number;
  ay: number;
  sx: number;
  sy: number;
  tint: number;
}

/** Everything the city puts on screen, and the traffic and extras that move. */
function renderCity(
  city: City,
  stage: number,
  atlas: Atlas,
  main: SortedLayer,
  floor: SortedLayer,
  under: Container,
  signs: Container,
  backdrop: Container,
  lights: Container | undefined,
  scene: Scene,
): { update(dt: number): void; shells: Sprite[]; setPrep(on: boolean): void; parallax(cx: number, cy: number): void; parts(i0: number, j0: number, i1: number, j1: number): CityPart[] } {
  const fadeAt = (i: number, j: number): number => city.ground.get(CITY_KEY(Math.round(i), Math.round(j)))?.fade ?? 1;
  const warm = glowTexture(255, 186, 102);
  const drawn: Array<{ i: number; j: number; p: Particle }> = [];
  city.items.forEach((it, n) => {
    if (!scene.keepItem[n]) return; // it did not fit its zone (floor/scene.ts)
    const fade = fadeAt(it.i, it.j);
    if (fade > 0.8) return;
    const c = cellCentre(it.i, it.j);
    const f = atlas.frame(`world:${it.kind}`);
    const p = makeParticle(f, c.x + (it.dx ?? 0), c.y + (it.dy ?? 0), it.mirror, it.scale);
    p.tint = darken(it.tint ?? 0xffffff, fade * 0.8 + (stage >= 5 && !it.flat ? 0.12 : 0));
    if (it.flat) floor.add(p, 1e6 + it.i + it.j);
    else {
      main.add(p, it.i + it.j + 1);
      drawn.push({ i: it.i, j: it.j, p });
    }
    if (it.kind === 'street_lamp' && lights) {
      const g = new Sprite(warm);
      g.anchor.set(0.5);
      g.position.set(c.x, c.y);
      g.scale.set(1.5);
      g.alpha = 0.45 * (1 - fade);
      g.blendMode = 'add';
      lights.addChild(g);
    }
  });
  // lots the office takes next: grey shells with a label
  const shells: Sprite[] = [];
  const g = new Graphics();
  under.addChild(g);
  const next = STAGES[stage + 1];
  for (const l of city.lots) {
    if (l.use !== 'shell') continue;
    const H = 34;
    const P = (i: number, j: number): { x: number; y: number } => cellToScreen(i, j);
    const t0 = P(l.i0, l.j0);
    const t1 = P(l.i0 + l.w, l.j0);
    const t2 = P(l.i0 + l.w, l.j0 + l.h);
    const t3 = P(l.i0, l.j0 + l.h);
    const up = (p: { x: number; y: number }): { x: number; y: number } => ({ x: p.x, y: p.y - H });
    g.poly([t3.x, t3.y, t2.x, t2.y, up(t2).x, up(t2).y, up(t3).x, up(t3).y]).fill({ color: 0x8a93aa, alpha: 0.28 }).stroke({ color: 0xb8c6ee, width: 1, alpha: 0.7 });
    g.poly([t2.x, t2.y, t1.x, t1.y, up(t1).x, up(t1).y, up(t2).x, up(t2).y]).fill({ color: 0x6a7390, alpha: 0.28 }).stroke({ color: 0xb8c6ee, width: 1, alpha: 0.7 });
    g.poly([up(t0).x, up(t0).y, up(t1).x, up(t1).y, up(t2).x, up(t2).y, up(t3).x, up(t3).y]).fill({ color: 0xaab4cc, alpha: 0.22 }).stroke({ color: 0xd8e2ff, width: 1, alpha: 0.8 });
    if (next) {
      const s = new Sprite(lockTexture('NEXT FLOOR', `AT ${next.min.toLocaleString('en-US')} RATS`));
      const c = up(P(l.i0 + l.w / 2, l.j0 + l.h / 2));
      s.anchor.set(0.5, 1);
      s.position.set(c.x, c.y - 4);
      signs.addChild(s);
      shells.push(s);
    }
  }
  // at 90% of the next stage the shells get scaffolding, a crane and a crew (hidden until then)
  const prep: Array<{ p: Particle; sx: number; sy: number }> = [];
  const prepAdd = (p: Particle, depth: number): void => {
    main.add(p, depth);
    prep.push({ p, sx: p.scaleX, sy: p.scaleY });
    p.scaleX = 0;
    p.scaleY = 0;
  };
  city.lots.filter((l) => l.use === 'shell').forEach((l, n) => {
    const ci = l.i0 + l.w / 2 - 0.5;
    const cj = l.j0 + l.h / 2 - 0.5;
    const c = cellCentre(ci, cj);
    if (atlas.has('world:scaffold')) prepAdd(makeParticle(atlas.frame('world:scaffold'), c.x, c.y + 10, n % 2 === 1, 0.9), ci + cj + 1);
    if (n === 0 && atlas.has('world:crane')) {
      const cc = cellCentre(l.i0, l.j0);
      prepAdd(makeParticle(atlas.frame('world:crane'), cc.x, cc.y, false, 0.9 + stage * 0.1), l.i0 + l.j0 + 1);
    }
    for (const [di, dj, anim, mirror] of [[l.w - 1, 0, 'idle_se', false], [0, l.h - 1, 'cheer', true]] as const) {
      try {
        const frames = atlas.anim(`intern/${anim}`);
        const hat = atlas.anim(`acc/hat_hard/${anim}`);
        const cp = cellCentre(l.i0 + di, l.j0 + dj);
        prepAdd(makeParticle(frames[0]!, cp.x, cp.y, mirror, 0.9), l.i0 + di + l.j0 + dj + 1.25);
        prepAdd(makeParticle(hat[0]!, cp.x, cp.y, mirror, 0.9), l.i0 + di + l.j0 + dj + 1.26);
      } catch {
        /* no such frames: skip the crew */
      }
    }
  });

  // the far skyline behind the back corner of the city: four layers, the farthest highest and palest, each drifting
  // a little with the camera (parallax, see World.parallax)
  const top = cellToScreen(city.i0, city.j0);
  const span = (city.i1 - city.i0 + city.j1 - city.j0) * 16;
  const skyW = Math.min(4000, Math.max(800, Math.round(span * 0.9)));
  const skyScale = Math.max(1, span / 1800);
  const skyLayers: Array<{ s: Sprite; x: number; y: number; k: number }> = [];
  for (let d = 0; d < 4; d++) {
    const sky = new Sprite(skylineLayer(skyW, stage >= 5, 97 + stage * 7 + d * 131, d));
    sky.anchor.set(0.5, 1);
    const x = top.x;
    const y = top.y + span * 0.08 - (3 - d) * 26 * skyScale;
    sky.position.set(x, y);
    sky.scale.set(skyScale * (1.1 - d * 0.04));
    sky.alpha = [0.45, 0.55, 0.7, 0.85][d]!;
    backdrop.addChild(sky);
    skyLayers.push({ s: sky, x, y, k: [0.3, 0.2, 0.11, 0.04][d]! });
  }
  // extras: street scenes (food truck queue, the smoker, the delivery, the crew)
  const extras: Array<{ p: Particle; acc: Particle | null; frames: Frame[]; accFrames: Frame[]; k: number; t: number; fps: number }> = [];
  const puffs: Array<{ s: Sprite; x: number; y: number; t: number }> = [];
  for (const [n, x] of city.extras.entries()) {
    if (!scene.keepExtra[n] || fadeAt(x.i, x.j) > 0.5) continue;
    let frames: Frame[];
    try {
      frames = atlas.anim(`${x.look}/${x.anim}`);
    } catch {
      continue;
    }
    const c = cellCentre(x.i, x.j);
    const tier = x.look.split('.')[0] as keyof typeof TIER_SCALE;
    const sc = TIER_SCALE[tier] ?? 1;
    const p = makeParticle(frames[0]!, c.x, c.y, x.mirror, sc);
    main.add(p, x.i + x.j + 1.25);
    let acc: Particle | null = null;
    let accFrames: Frame[] = [];
    if (x.acc) {
      try {
        accFrames = atlas.anim(`acc/${x.acc}/${x.anim}`);
        acc = makeParticle(accFrames[0]!, c.x, c.y, x.mirror, sc);
        main.add(acc, x.i + x.j + 1.26);
      } catch {
        acc = null;
      }
    }
    if (x.carry === 'box_s') main.add(makeParticle(atlas.frame('world:box_s'), c.x + (x.mirror ? -5 : 5), c.y - 14 * sc), x.i + x.j + 1.27);
    if (x.carry === 'smoke') {
      for (let n = 0; n < 2; n++) {
        const s = new Sprite(puffTex());
        s.position.set(c.x + (x.mirror ? -8 : 8), c.y - 34 * sc);
        s.alpha = 0.6;
        signs.addChild(s);
        puffs.push({ s, x: s.x, y: s.y, t: n * 0.9 });
      }
    }
    extras.push({ p, acc, frames, accFrames, k: 0, t: Math.random(), fps: x.anim === 'cheer' ? 8 : x.anim.startsWith('walk') ? 8 : 4 });
  }
  // visitors every few minutes: a pizza delivery, the inspector cat, a pigeon (when their art is in the atlas)
  type Visitor = { item: LayerItem; extra: LayerItem | null; kind: string; path: Array<{ i: number; j: number }>; seg: number; pos: { i: number; j: number }; wait: number; t: number; k: number };
  let visitor: Visitor | null = null;
  let nextVisit = 12 + Math.random() * 20;
  let visits = 0;
  const kinds = ['pizza', ...(atlas.has('world:cat_walk_se_0') ? ['cat'] : []), ...(atlas.has('world:pigeon_walk_se_0') ? ['pigeon'] : [])];
  const walkFrames = (kind: string, dir: 'se' | 'ne'): Frame[] => {
    if (kind === 'pizza') return atlas.anim(`intern.brown/walk_${dir}`);
    const out: Frame[] = [];
    for (let n = 0; atlas.has(`world:${kind}_walk_${dir}_${n}`); n++) out.push(atlas.frame(`world:${kind}_walk_${dir}_${n}`));
    return out;
  };
  const spawnVisitor = (): void => {
    const kind = kinds[visits++ % kinds.length]!;
    const there = city.visitorPath;
    if (there.length < 2) return;
    const path = [...there, ...[...there].reverse().slice(1)];
    const c = cellCentre(path[0]!.i, path[0]!.j);
    const f = walkFrames(kind, 'se')[0];
    if (!f) return;
    const item = main.add(makeParticle(f, c.x, c.y), path[0]!.i + path[0]!.j + 1.25);
    const extra = kind === 'pizza' && atlas.has('world:pizza_boxes') ? main.add(makeParticle(atlas.frame('world:pizza_boxes'), c.x, c.y - 16, false, 0.45), path[0]!.i + path[0]!.j + 1.3) : null;
    visitor = { item, extra, kind, path, seg: 1, pos: { ...path[0]! }, wait: 0, t: 0, k: 0 };
  };
  const moveVisitor = (dt: number): void => {
    const v = visitor;
    if (!v) {
      nextVisit -= dt;
      if (nextVisit <= 0) spawnVisitor();
      return;
    }
    if (v.wait > 0) {
      v.wait -= dt;
      return;
    }
    const to = v.path[v.seg];
    if (!to) {
      main.remove(v.item);
      if (v.extra) main.remove(v.extra);
      visitor = null;
      nextVisit = 70 + Math.random() * 110;
      return;
    }
    const di = to.i - v.pos.i;
    const dj = to.j - v.pos.j;
    const d = Math.abs(di) + Math.abs(dj);
    const step = (v.kind === 'pigeon' ? 1.2 : v.kind === 'cat' ? 1.8 : 2.4) * dt;
    if (d <= step) {
      v.pos = { ...to };
      v.seg++;
      if (v.seg === Math.ceil(v.path.length / 2)) v.wait = 2.5; // at the door for a moment
    } else {
      v.pos = { i: v.pos.i + (di / d) * step, j: v.pos.j + (dj / d) * step };
    }
    const dir = Math.abs(di) >= Math.abs(dj) ? (di >= 0 ? 'se' : 'nw') : dj >= 0 ? 'sw' : 'ne';
    const frames = walkFrames(v.kind, dir === 'se' || dir === 'sw' ? 'se' : 'ne');
    v.t += dt;
    if (v.t > 0.1) {
      v.t = 0;
      v.k = (v.k + 1) % Math.max(1, frames.length);
    }
    const f = frames[v.k] ?? frames[0];
    const c = cellCentre(v.pos.i, v.pos.j);
    const p = v.item.p;
    if (f) {
      p.texture = f.texture;
      p.anchorX = f.anchorX;
      p.anchorY = f.anchorY;
    }
    p.x = c.x;
    p.y = c.y;
    p.scaleX = dir === 'sw' || dir === 'nw' ? -1 : 1;
    main.moved(v.item, v.pos.i + v.pos.j + 1.25);
    if (v.extra) {
      v.extra.p.x = c.x;
      v.extra.p.y = c.y - 30;
      main.moved(v.extra, v.pos.i + v.pos.j + 1.3);
    }
  };

  // traffic
  const movers = city.movers.map((m) => {
    const pos = m.from + m.phase * (m.to - m.from);
    const c = m.axis === 'i' ? cellCentre(pos, m.fixed) : cellCentre(m.fixed, pos);
    const item = main.add(makeParticle(atlas.frame(`world:${m.kind}`), c.x, c.y, m.mirror), pos + m.fixed + 1);
    return { m, item, pos };
  });
  return {
    shells,
    parts(i0: number, j0: number, i1: number, j1: number): CityPart[] {
      return drawn
        .filter((d) => d.i >= i0 && d.i <= i1 && d.j >= j0 && d.j <= j1 && d.p.scaleY !== 0)
        .map((d) => ({ texture: d.p.texture, x: d.p.x, y: d.p.y, ax: d.p.anchorX, ay: d.p.anchorY, sx: d.p.scaleX, sy: d.p.scaleY, tint: d.p.tint }));
    },
    parallax(cx: number, cy: number): void {
      for (const l of skyLayers) {
        l.s.x = l.x + (cx - l.x) * l.k;
        l.s.y = l.y + (cy - l.y) * l.k * 0.3;
      }
    },
    setPrep(on: boolean): void {
      for (const x of prep) {
        x.p.scaleX = on ? x.sx : 0;
        x.p.scaleY = on ? x.sy : 0;
      }
    },
    update(dt: number): void {
      moveVisitor(dt);
      for (const v of movers) {
        v.pos += v.m.speed * dt * v.m.dir;
        if (v.pos > v.m.to) v.pos = v.m.from;
        if (v.pos < v.m.from) v.pos = v.m.to;
        const c = v.m.axis === 'i' ? cellCentre(v.pos, v.m.fixed) : cellCentre(v.m.fixed, v.pos);
        v.item.p.x = c.x;
        v.item.p.y = c.y;
        const fade = fadeAt(v.m.axis === 'i' ? v.pos : v.m.fixed, v.m.axis === 'i' ? v.m.fixed : v.pos);
        v.item.p.scaleY = fade > 0.7 ? 0 : 1;
        v.item.p.scaleX = fade > 0.7 ? 0 : v.m.mirror ? -1 : 1;
        main.moved(v.item, v.pos + v.m.fixed + 1);
      }
      for (const e of extras) {
        e.t += dt;
        if (e.t < 1 / e.fps) continue;
        e.t = 0;
        e.k = (e.k + 1) % e.frames.length;
        const f = e.frames[e.k]!;
        e.p.texture = f.texture;
        e.p.anchorX = f.anchorX;
        e.p.anchorY = f.anchorY;
        const a = e.accFrames[e.k];
        if (e.acc && a) {
          e.acc.texture = a.texture;
          e.acc.anchorX = a.anchorX;
          e.acc.anchorY = a.anchorY;
        }
      }
      for (const p of puffs) {
        p.t = (p.t + dt) % 1.8;
        p.s.y = p.y - p.t * 10;
        p.s.alpha = 0.6 * (1 - p.t / 1.8);
      }
    },
  };
}

let puffTexCache: Texture | null = null;
function puffTex(): Texture {
  if (puffTexCache) return puffTexCache;
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 4;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#d8dce8';
  ctx.fillRect(1, 0, 2, 4);
  ctx.fillRect(0, 1, 4, 2);
  puffTexCache = Texture.from(c);
  puffTexCache.source.scaleMode = 'nearest';
  return puffTexCache;
}
