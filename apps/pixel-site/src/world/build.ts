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
import { CORRIDOR_TINT, LOT_TINT, ROOM_LOOK, STAGES, STREET_TINT } from '../floor/plan';
import { FLOOR_STYLES, T, idx, type FloorLayout, type Prop, type Room } from '../floor/types';

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
  setZoom(z: number): void;
  destroy(): void;
}

export const FURNACE_SCALE = [1, 1, 2, 2, 2, 3];

export function worldBounds(layout: FloorLayout): WorldBounds {
  const left = cellToScreen(0, layout.H).x - 64;
  const right = cellToScreen(layout.W, 0).x + 64;
  const top = cellToScreen(0, 0).y - 700;
  const bottom = cellToScreen(layout.W, layout.H).y + 64;
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

const FLOOR_FRAME: Record<string, string> = {
  office: 'world:floor_office', warm: 'world:floor_office', tile: 'world:floor_office', dark: 'world:floor_office',
  street: 'world:floor_office', marble: 'world:floor_hq', platform: 'world:floor_subway',
};
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

  // floor: rooms in their type colour, lots dark, the street round the current building
  const floorLayer = new SortedLayer(atlas.source, bounds, { position: false, vertex: false, uvs: false, color: false, rotation: false });
  const heights = new Uint8Array(plan.W * plan.H);
  for (let j = i0; j <= i1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = idx(W, i, j);
      const t = plan.tile[k];
      const r = plan.ringOf[k]!;
      let frame = 'world:floor_office';
      let tint = STREET_TINT;
      if (r > stage) {
        const near = Math.abs(i - ring.spawn.i) <= 2 && Math.abs(j - ring.spawn.j) <= 2;
        if (near) (frame = 'world:floor_subway'), (tint = 0x9aa1b8);
      } else if (t === T.ROOM) {
        if (growth.built[plan.roomOf[k]!]) {
          frame = FLOOR_FRAME[FLOOR_STYLES[plan.floorOf[k]!] ?? 'office'] ?? frame;
          tint = plan.floorTint[k]!;
        } else tint = LOT_TINT;
      } else if (t === T.CORRIDOR) tint = r === 5 ? 0xe2b4b4 : CORRIDOR_TINT;
      else if (t === T.DOOR && blocked[k] === 0) tint = CORRIDOR_TINT;
      else if (t === T.WALL || t === T.DOOR) {
        // a wall stands where it borders something built; otherwise this is open lot
        let near = false;
        for (let dj = -1; dj <= 1 && !near; dj++) for (let di = -1; di <= 1 && !near; di++) if (isBuiltCell(idx(W, i + di, j + dj))) near = true;
        if (near) {
          const edge = i === ring.i0 || j === ring.j0 ? 3 : i === ring.i1 || j === ring.j1 ? 1 : 2;
          heights[k] = edge;
          continue;
        }
        tint = r === stage && plan.ringOf[k] === stage ? LOT_TINT : STREET_TINT;
      }
      const p = cellToScreen(i, j);
      const tile = makeParticle(atlas.frame(frame), p.x, p.y);
      tile.tint = tint;
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
  // construction lots: a few boxes on each empty lot of the current ring
  for (const r of plan.rooms) {
    if (r.ring !== stage || built(r)) continue;
    for (let n = 0; n < 3; n++) {
      const i = r.i0 + 1 + ((r.id * 7 + n * 5) % Math.max(1, r.w - 2));
      const j = r.j0 + 1 + ((r.id * 3 + n * 11) % Math.max(1, r.h - 2));
      const c = cellCentre(i, j);
      const p = makeParticle(atlas.frame(n === 0 ? 'world:box_pile' : 'world:box_s'), c.x, c.y + 4, n % 2 === 1);
      main.add(p, i + j + 1);
    }
  }
  floorLayer.sync(true);
  const floor = floorLayer.container;

  // walls
  const wallFrames = [null, atlas.frame('world:wall'), atlas.frame('world:wall_x2'), atlas.frame('world:wall_x3')];
  const tint = stage >= 5 ? 0xd8b0b8 : 0xffffff;
  for (let j = i0; j <= i1; j++) {
    for (let i = i0; i <= i1; i++) {
      const h = heights[idx(W, i, j)]!;
      if (!h) continue;
      const p = cellToScreen(i, j);
      const w = makeParticle(wallFrames[h]!, p.x, p.y);
      if (plan.ringOf[idx(W, i, j)] === 5) w.tint = tint;
      main.add(w, i + j - 0.5);
    }
  }

  // desks (chairs only while their rat is away: empty desks stay chairless)
  const deskA = atlas.frame('world:desk_oak_clutter');
  const deskB = atlas.frame('world:desk_oak');
  const chairF = atlas.frame('world:chair');
  const chairs = new Map<number, LayerItem>();
  const chairAt = new Map<number, { x: number; y: number; mirror: boolean; depth: number }>();
  let delay = 0;
  for (const r of plan.rooms) {
    if (!built(r)) continue;
    const pop = popIn.has(r.id);
    for (const s of r.seats) {
      const c = cellCentre(s.desk.i, s.desk.j);
      const mirror = s.axis === 'i';
      const desk = makeParticle(s.variant === 1 ? deskB : deskA, c.x + s.dx, c.y + s.dy, mirror);
      desk.tint = r.kind === 'ceo' ? DESK_TINT[2]! : DESK_TINT[s.variant] ?? 0xffffff;
      const depth = s.cell.i + s.cell.j + 1;
      const item = main.add(desk, depth);
      if (pop) addPop(item, (delay += 0.015));
      const sc = cellCentre(s.pos.i, s.pos.j);
      chairAt.set(s.id, { x: sc.x + (mirror ? 10 : -10) + s.dx, y: sc.y - 1 + s.dy, mirror, depth: depth + 0.4 });
    }
  }

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
    const p = makeParticle(f, x, y, pr.mirror, pr.kind === 'furnace' ? fscale : 1);
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
      const left = x - f.anchorX * f.w;
      const top = y - f.anchorY * f.h;
      for (let n = 0; n < Math.min(14, px.length); n++) {
        const [lx, ly] = px[Math.floor(Math.random() * px.length)]!;
        rackLeds.push({ x: pr.mirror ? x + f.anchorX * f.w - 1 - lx : left + lx, y: top + ly, color: [0x6dffb0, 0x7ad7ff, 0xffc75a][n % 3]! });
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
  const depth = pr.i + pr.j + span - 1 - 0.5 + 0.05;
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
