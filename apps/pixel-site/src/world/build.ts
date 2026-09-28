// Builds what stands of the office from the master plan and the growth state: floor tiles (a colour per room type),
// empty lots for rooms not built yet, the street around the current building, walls, desks, props, things hung on
// walls, the subway stairs, the furnace (it grows with the company) and its light beam, lamp glows, blinking
// server lights, wall tickers and big room signs for reading the building from far away.
// Rebuilt from scratch whenever a room is built (rare); new rooms pop in.
import { Container, Particle, ParticleContainer, Rectangle, Sprite, Texture } from 'pixi.js';
import type { StockView } from '@rat/contract';
import type { Atlas, Frame } from '../gfx/atlas';
import { makeParticle, SortedLayer, type LayerItem } from '../gfx/layer';
import { drawText, shearLeftWall, shearRightWall, textWidth } from '../gfx/pixelfont';
import { cellCentre, cellToScreen } from '../iso';
import type { Growth } from '../floor/growth';
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
  floor: Container;
  main: SortedLayer;
  overlay: Container; // tickers, drawn above the walls
  lights: Container; // additive glows and blinking lights
  signs: Container; // room signs, readable when zoomed out
  tickers: Ticker[];
  furnaceGlow: Sprite;
  furnaceMouth: { x: number; y: number };
  /** the walk mask this world was built for */
  blocked: Uint8Array;
  /** call every frame: server lights blink, new rooms pop in, the beam pulses */
  update(dt: number): void;
  setChair(seatId: number, visible: boolean): void;
  /** a rat got a desk in a pod still under construction: the site clears and the desks pop in. Returns where. */
  activatePod(seatId: number): { x: number; y: number } | null;
  setZoom(z: number): void;
  destroy(): void;
}

export const FURNACE_SCALE = [1, 1, 2, 2, 2, 3];

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

function beamTexture(): Texture {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(32, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 32; x++) {
      const across = Math.exp(-(((x - 15.5) / 7) ** 2));
      const up = (y / 255) ** 1.4;
      const k = (y * 32 + x) * 4;
      img.data[k] = 255;
      img.data[k + 1] = 150 + 60 * across;
      img.data[k + 2] = 70;
      img.data[k + 3] = Math.round(255 * across * up * 0.8);
    }
  }
  ctx.putImageData(img, 0, 0);
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
  t: number;
}

export function buildWorld(
  plan: FloorLayout,
  growth: Growth,
  atlas: Atlas,
  stocks: Map<string, StockView>,
  popIn: ReadonlySet<number> = new Set(),
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
  const pops: Pop[] = [];
  const built = (r: Room): boolean => growth.isBuilt(r);
  const M = 7;
  const i0 = ring.i0 - M;
  const i1 = ring.i1 + M;
  const inStreet = (i: number, j: number): boolean => i >= i0 && i <= i1 && j >= i0 && j <= i1;
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
    pops.push({ item, sx: item.p.scaleX, sy: item.p.scaleY, t: -delay });
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
  for (const r of plan.rooms) {
    if (r.ring !== stage || built(r)) continue;
    for (let i = r.i0; i < r.i0 + r.w; i++) {
      for (let j = r.j0; j < r.j0 + r.h; j++) {
        const p = cellToScreen(i, j);
        const t = makeParticle(atlas.frame(styleFrame('blueprint', i, j)), p.x, p.y);
        floorLayer.add(t, 1e5 + i + j);
      }
    }
    const what = r.kind === 'stock' || r.kind === 'open' ? 'DESKS' : ROOM_LOOK[r.kind].label;
    const when = r.unlockAt !== null ? `${r.unlockAt.toLocaleString('en-US')} RATS` : 'NEXT HIRES';
    const s = new Sprite(lockTexture(what, when));
    const c = cellToScreen(r.i0 + r.w / 2, r.j0 + r.h / 2);
    s.anchor.set(0.5, 1);
    s.position.set(c.x, c.y - 4);
    signs.addChild(s);
    lockSigns.push(s);
  }

  // the city round the building: it changes with the stage (suburb, downtown, towers, the evil empire)
  const city = buildCity(plan, stage, atlas, main, floorLayer);

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
  const fscale = FURNACE_SCALE[stage] ?? 1;
  const fp = cellCentre(plan.furnace.i, plan.furnace.j);
  for (const pr of plan.props) {
    if (pr.flat || !propVisible(pr)) continue;
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
    const sc = pr.kind === 'furnace' ? fscale : pr.scale ?? 1;
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
  const extras: Array<{ p: Particle; frames: Frame[]; k: number; t: number; fps: number; hold: boolean }> = [];
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

  // the furnace: glow, and a light beam that grows with the company (the landmark you see from anywhere)
  const mouth = { x: fp.x + 10 * fscale, y: fp.y + 4 - 30 * fscale };
  const furnaceGlow = addGlow(glowTexture(255, 120, 40), fp.x + 8 * fscale, fp.y - 18 * fscale, 2.2 * fscale);
  const beam = new Sprite(beamTexture());
  beam.anchor.set(0.5, 1);
  beam.position.set(fp.x + 4 * fscale, fp.y - 40 * fscale);
  beam.scale.set(1.2 + stage * 0.5, 1.6 + stage * 0.45);
  beam.blendMode = 'add';
  lights.addChild(beam);
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
  for (const r of plan.rooms) {
    if (!built(r)) continue;
    const label = r.kind === 'stock' ? growth.symbolOf[r.id] ?? '' : ROOM_LOOK[r.kind].label;
    if (!label) continue;
    const s = new Sprite(signTexture(label, r.tint, 2));
    const c = cellToScreen(r.i0 + r.w / 2, r.j0 + r.h / 2);
    s.anchor.set(0.5, 1);
    s.position.set(c.x, c.y - 24);
    signs.addChild(s);
    roomSigns.push(s);
  }
  const top = cellToScreen(ring.i0, ring.j0);
  const name = new Sprite(signTexture(`RAT RACE ${STAGES[stage]!.name}`, STAGE_COLOR[stage] ?? 0xffd36b, 3));
  name.anchor.set(0.5, 1);
  name.position.set(top.x, top.y - 70);
  signs.addChild(name);

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

  main.sync(true);
  let blink = 0;
  let clock = 0;
  return {
    bounds,
    floor,
    main,
    overlay,
    lights,
    signs,
    tickers,
    furnaceGlow,
    furnaceMouth: mouth,
    blocked,
    update(dt: number): void {
      clock += dt;
      city.update(dt);
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
      }
      for (const t of tears) {
        t.t = (t.t + dt) % 0.8;
        t.s.y = t.y + t.t * 14;
        t.s.alpha = 1 - t.t / 0.8;
      }
      beam.alpha = 0.75 + 0.25 * Math.sin(clock * 2.1);
      if (pops.length) {
        for (let k = pops.length - 1; k >= 0; k--) {
          const p = pops[k]!;
          p.t += dt;
          if (p.t < 0) continue;
          const u = Math.min(1, p.t / 0.35);
          const e = 1 + 2.4 * (u - 1) ** 3 + 1.4 * (u - 1) ** 2; // ease out with a little overshoot
          p.item.p.scaleX = p.sx * e;
          p.item.p.scaleY = p.sy * e;
          if (u >= 1) {
            p.item.p.scaleX = p.sx;
            p.item.p.scaleY = p.sy;
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
      // room signs fade in as you zoom out and grow so they stay readable; the stage sign always shows
      const a = z <= 0.55 ? 1 : z >= 0.8 ? 0 : (0.8 - z) / 0.25;
      const s = Math.max(1, Math.min(4, 0.9 / z));
      for (const sg of roomSigns) {
        sg.alpha = a;
        sg.scale.set(s);
        sg.visible = a > 0.01;
      }
      name.scale.set(Math.max(1, Math.min(4, 0.6 / z)));
      for (const l of lockSigns) l.scale.set(Math.max(1, Math.min(5, 0.9 / z)));
    },
    destroy(): void {
      for (const c of [floor, main.container, overlay, lights, signs]) {
        c.parent?.removeChild(c);
      }
      (main.container as ParticleContainer).particleChildren.length = 0;
      floor.destroy({ children: true });
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

interface CityLook {
  ground: string;
  groundTint: number;
  back: string[];
  front: string[];
  cars: string[];
  scale: number;
  tint: number;
}

const CITY: CityLook[] = [
  { ground: 'grass', groundTint: 0xffffff, back: ['house_a', 'tree_round', 'house_b', 'tree_bushy', 'tree_pine'], front: ['tree_round', 'mailbox', 'tree_bushy', 'tree_pine'], cars: ['car_red', 'car_blue', 'van'], scale: 1, tint: 0xffffff },
  { ground: 'sidewalk', groundTint: 0xffffff, back: ['shop', 'house_b', 'brick_block', 'shop', 'tree_square'], front: ['tree_square', 'bench', 'hydrant', 'trash_can', 'bus_stop'], cars: ['taxi', 'car_blue', 'van', 'car_red'], scale: 1, tint: 0xffffff },
  { ground: 'sidewalk', groundTint: 0xffffff, back: ['brick_block', 'shop', 'glass_tower', 'brick_block', 'shop'], front: ['tree_square', 'bench', 'hydrant', 'bus_stop', 'trash_can'], cars: ['taxi', 'car_white', 'van', 'police', 'car_blue'], scale: 1.2, tint: 0xffffff },
  { ground: 'sidewalk', groundTint: 0xe8ecf4, back: ['glass_tower', 'deco_tower', 'brick_block', 'glass_tower'], front: ['tree_square', 'bus_stop', 'hydrant', 'bench'], cars: ['taxi', 'limo', 'car_white', 'taxi'], scale: 1.5, tint: 0xffffff },
  { ground: 'sidewalk', groundTint: 0xdfe4f0, back: ['deco_tower', 'glass_tower', 'glass_tower', 'deco_tower', 'crane'], front: ['tree_square', 'bus_stop', 'hydrant'], cars: ['limo', 'taxi', 'police', 'car_white'], scale: 1.9, tint: 0xffffff },
  { ground: 'asphalt', groundTint: 0xd89090, back: ['evil_tower', 'evil_rat_tower', 'glass_tower', 'evil_tower', 'deco_tower'], front: ['skull_flag', 'barrier', 'cone'], cars: ['limo', 'car_gold', 'police', 'limo'], scale: 2.1, tint: 0xffb0b0 },
];

/** Ground, neighbour buildings, trees, benches and parked cars round the current building. */
function buildCity(plan: FloorLayout, stage: number, atlas: Atlas, main: SortedLayer, floor: SortedLayer): { update(dt: number): void } {
  const ring = plan.rings[stage]!;
  const look = CITY[stage] ?? CITY[0]!;
  const rng = (n: number): number => ((Math.imul(n + stage * 977, 2654435761) >>> 0) % 10000) / 10000;
  const lo = ring.i0;
  const hi = ring.i1;
  const IN = 8; // the street square drawn by the floor pass
  const OUT = 22;
  // ground beyond the street
  for (let j = lo - OUT; j <= hi + OUT; j++) {
    for (let i = lo - OUT; i <= hi + OUT; i++) {
      const d = Math.max(lo - i, i - hi, lo - j, j - hi);
      if (d < IN) continue;
      const v = ((Math.imul(i, 73856093) ^ Math.imul(j, 19349663)) >>> 0) % 4;
      const style = d <= IN + 1 && look.ground === 'grass' ? 'sidewalk' : look.ground;
      const p = cellToScreen(i, j);
      const t = makeParticle(atlas.frame(`world:fl_${style}_${v}`), p.x, p.y);
      t.tint = look.groundTint;
      floor.add(t, i + j);
    }
  }
  const put = (kind: string, i: number, j: number, mirror: boolean, scale = 1, tint = 0xffffff): void => {
    if (!atlas.has(`world:${kind}`)) return;
    const c = cellCentre(i, j);
    const p = makeParticle(atlas.frame(`world:${kind}`), c.x, c.y, mirror, scale);
    p.tint = tint;
    main.add(p, i + j + 1);
  };
  // neighbour buildings along the two back sides (they never hide the office), a landmark on the back corner
  const big = (k: string): boolean => k.includes('tower') || k === 'brick_block' || k === 'crane' || k === 'shop' || k.startsWith('house');
  let n = 0;
  const step = Math.round(7 * look.scale);
  for (let s = lo - 4; s <= hi + 6; s += step) {
    const kind = look.back[n++ % look.back.length]!;
    const sc = big(kind) ? look.scale : 1;
    const tint = kind === 'glass_tower' ? look.tint : 0xffffff;
    put(kind, s, lo - IN - 3 - Math.round(rng(n) * 2), rng(n + 7) < 0.5, sc, tint);
    const kind2 = look.back[(n + 2) % look.back.length]!;
    put(kind2, lo - IN - 3 - Math.round(rng(n + 3) * 2), s, rng(n + 9) < 0.5, big(kind2) ? look.scale : 1, kind2 === 'glass_tower' ? look.tint : 0xffffff);
  }
  put(look.back[0]!, lo - IN - 6, lo - IN - 6, false, look.scale * 1.15, look.back[0] === 'glass_tower' ? look.tint : 0xffffff);
  // low things along the two front sides, in the band past the road
  n = 0;
  for (let s = lo - 2; s <= hi + 4; s += 5) {
    const a = look.front[n++ % look.front.length]!;
    const b = look.front[(n + 1) % look.front.length]!;
    put(a, s, hi + IN + 1, rng(n) < 0.5);
    put(b, hi + IN + 1, s, rng(n + 5) < 0.5);
  }
  // parked cars on the road ring (sprites run along j; mirrored along i)
  n = 0;
  for (let s = lo - 3; s <= hi + 3; s += 6) {
    for (const [i, j, mirror] of [[s, lo - 5, true], [lo - 5, s, false], [s, hi + 5, true], [hi + 5, s, false]] as const) {
      if (rng(n * 13 + i + j) < 0.45) continue;
      const near = Math.abs(i - ring.spawn.i) + Math.abs(j - ring.spawn.j) < 6;
      if (near) continue;
      put(look.cars[n++ % look.cars.length]!, i, j, mirror);
    }
  }
  // the suburb: a driveway up to the garage door, the family car on it
  if (stage === 0) {
    const d = ring.entrance[0]!;
    for (let j = d.j + 1; j <= d.j + 3; j++) {
      for (let i = d.i - 4; i <= d.i - 2; i++) {
        const p = cellToScreen(i, j);
        floor.add(makeParticle(atlas.frame(`world:fl_driveway_${(i + j) & 3}`), p.x, p.y), 2e5 + i + j);
      }
    }
    put('car_red', d.i - 3, d.j + 2, true);
    put('mailbox', d.i - 5, d.j + 3, false);
  }
  return { update(): void {} };
}
