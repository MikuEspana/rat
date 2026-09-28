// Builds the static office floor from the layout: floor tiles, walls, desks, props, things hung on walls, the
// subway stairs, the HQ furnace, lamp glows, blinking server lights and the wall tickers.
import { Container, Particle, ParticleContainer, Rectangle, Sprite, Texture } from 'pixi.js';
import type { StockView } from '@rat/contract';
import type { Atlas, Frame } from '../gfx/atlas';
import { makeParticle, SortedLayer, type LayerItem } from '../gfx/layer';
import { drawText, shearLeftWall, shearRightWall, textWidth } from '../gfx/pixelfont';
import { cellCentre, cellToScreen } from '../iso';
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
  tickers: Ticker[];
  /** the empty chair at each seat (by seat id), shown while nobody sits there */
  chairs: Map<number, LayerItem>;
  furnaceGlow: Sprite;
  furnaceMouth: { x: number; y: number };
  /** call every frame: server lights blink */
  update(dt: number): void;
  setChair(seatId: number, visible: boolean): void;
}

export function worldBounds(layout: FloorLayout): WorldBounds {
  const left = cellToScreen(0, layout.H).x - 64;
  const right = cellToScreen(layout.W, 0).x + 64;
  const top = cellToScreen(0, 0).y - 200;
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

/** The top of the wall face at a wall cell: left end for a back-right wall, right end for a back-left wall. */
function faceTop(layout: FloorLayout, i: number, j: number, axis: 'i' | 'j'): { x: number; y: number; h: number } {
  const p = cellToScreen(i, j);
  const h = Math.max(1, layout.wallH[idx(layout.W, i, j)] ?? 1);
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

export function buildWorld(layout: FloorLayout, atlas: Atlas, stocks: Map<string, StockView>): World {
  const bounds = worldBounds(layout);
  const { W, H } = layout;
  const main = new SortedLayer(atlas.source, bounds, { position: true, vertex: true, uvs: true, color: false, rotation: false });
  const overlay = new Container();
  const lights = new Container();

  // floor: one tile per cell in a static particle layer, uploaded once and never culled; flat clutter on top
  const floorLayer = new SortedLayer(atlas.source, bounds, { position: false, vertex: false, uvs: false, color: false, rotation: false });
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = idx(W, i, j);
      const t = layout.tile[k];
      if (t === T.VOID || t === T.WALL) continue;
      const style = FLOOR_STYLES[layout.floorOf[k]!] ?? 'office';
      const p = cellToScreen(i, j);
      const tile = makeParticle(atlas.frame(FLOOR_FRAME[style] ?? 'world:floor_office'), p.x, p.y);
      tile.tint = layout.floorTint[k]!;
      floorLayer.add(tile, i + j);
    }
  }
  for (const pr of layout.props) {
    if (!pr.flat) continue;
    const c = cellCentre(pr.i, pr.j);
    const f = atlas.frame(`world:${pr.kind}`);
    const p = makeParticle(f, c.x + (pr.dx ?? 0), c.y + (pr.dy ?? 0), pr.mirror);
    if (pr.tint !== undefined) p.tint = pr.tint;
    floorLayer.add(p, 1e6 + pr.i + pr.j);
  }
  floorLayer.sync(true);
  const floor = floorLayer.container;

  // walls: one sprite per wall cell (2 and 3 high walls are pre-stacked)
  const wallFrames = [null, atlas.frame('world:wall'), atlas.frame('world:wall_x2'), atlas.frame('world:wall_x3')];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const h = layout.wallH[idx(W, i, j)]!;
      if (!h) continue;
      const p = cellToScreen(i, j);
      main.add(makeParticle(wallFrames[Math.min(3, h)]!, p.x, p.y), i + j - 0.5);
    }
  }

  // desks, each with an empty chair until a rat sits down
  const deskA = atlas.frame('world:desk_oak_clutter');
  const deskB = atlas.frame('world:desk_oak');
  const chairF = atlas.frame('world:chair_dark');
  const chairs = new Map<number, LayerItem>();
  const chairDepth = new Map<number, number>();
  for (const s of layout.seats) {
    const c = cellCentre(s.desk.i, s.desk.j);
    const mirror = s.axis === 'i';
    const desk = makeParticle(s.variant === 1 ? deskB : deskA, c.x + s.dx, c.y + s.dy, mirror);
    desk.tint = DESK_TINT[s.variant] ?? 0xffffff;
    const depth = s.cell.i + s.cell.j + 1;
    main.add(desk, depth);
    const sc = cellCentre(s.pos.i, s.pos.j);
    const chair = makeParticle(chairF, sc.x + (mirror ? 10 : -10) + s.dx, sc.y - 1 + s.dy, mirror);
    chairs.set(s.id, main.add(chair, depth + 0.4));
    chairDepth.set(s.id, depth + 0.4);
  }

  // props, wall pieces and glows
  const warm = glowTexture(255, 186, 102);
  const cool = glowTexture(120, 200, 255);
  const rackLeds: Array<{ x: number; y: number; color: number }> = [];
  const ledCache = new Map<string, Array<[number, number]>>();
  const addGlow = (tex: Texture, x: number, y: number, scale: number, alpha = 1): void => {
    const g = new Sprite(tex);
    g.anchor.set(0.5);
    g.position.set(x, y);
    g.scale.set(scale);
    g.alpha = alpha;
    g.blendMode = 'add';
    lights.addChild(g);
  };
  for (const pr of layout.props) {
    if (pr.flat) continue;
    const f = atlas.frame(`world:${pr.kind}`);
    if (pr.wall) {
      placeOnWall(layout, main, f, pr);
      if (pr.kind === 'tv_wall') {
        const t = faceTop(layout, pr.i, pr.j, pr.wall);
        addGlow(cool, t.x + (pr.wall === 'i' ? 18 : -18), t.y + 18, 0.5, 0.7);
      }
      continue;
    }
    const c = cellCentre(pr.i, pr.j);
    const x = c.x + (pr.dx ?? 0);
    const y = c.y + (pr.dy ?? 0);
    const p = makeParticle(f, x, y, pr.mirror);
    if (pr.tint !== undefined) p.tint = pr.tint;
    main.add(p, pr.i + pr.j + 1 + (pr.bias ?? 0));
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

  // blinking server lights: tiny additive particles, a few flip every frame
  const dot = document.createElement('canvas');
  dot.width = 2;
  dot.height = 1;
  dot.getContext('2d')!.fillRect(0, 0, 2, 1);
  const dotTex = Texture.from(dot);
  const leds = new ParticleContainer({ dynamicProperties: { position: false, vertex: false, uvs: false, color: true, rotation: false } });
  leds.blendMode = 'add';
  leds.boundsArea = new Rectangle(bounds.x, bounds.y, bounds.w, bounds.h);
  const ledParticles: Particle[] = [];
  for (const l of rackLeds) {
    const p = new Particle({ texture: dotTex, x: l.x, y: l.y, tint: l.color, alpha: Math.random() < 0.5 ? 1 : 0.15 });
    leds.addParticle(p);
    ledParticles.push(p);
  }
  lights.addChild(leds);

  // subway stairs glow and HQ furnace
  const fp = cellCentre(layout.furnace.i, layout.furnace.j);
  const furnaceGlow = new Sprite(glowTexture(255, 120, 40));
  furnaceGlow.anchor.set(0.5);
  furnaceGlow.position.set(fp.x + 8, fp.y - 18);
  furnaceGlow.scale.set(2.2);
  furnaceGlow.blendMode = 'add';
  lights.addChild(furnaceGlow);
  const sp = cellCentre(layout.spawn.i, layout.spawn.j);
  addGlow(glowTexture(140, 255, 170), sp.x, sp.y + 10, 1.4, 0.5);

  // wall tickers: a screen on the back wall of every stock room, live symbol and 24h % drawn on top
  const tickerFrame = atlas.frame('world:ticker_wall');
  const tickers: Ticker[] = [];
  for (const r of layout.rooms) {
    if (r.kind !== 'stock' || !r.ticker || !r.symbol) continue;
    const t = faceTop(layout, r.ticker.i, r.ticker.j, r.ticker.axis);
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
    tickers.push({ room: r, symbol: r.symbol, text, axis: r.ticker.axis, lastText: '' });
  }
  updateTickers({ tickers }, stocks);

  main.sync(true);
  let blink = 0;
  return {
    bounds,
    floor,
    main,
    overlay,
    lights,
    tickers,
    chairs,
    furnaceGlow,
    furnaceMouth: { x: fp.x + 10, y: fp.y - 26 },
    update(dt: number): void {
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
      const item = chairs.get(seatId);
      if (!item) return;
      const shown = main.has(item);
      if (visible && !shown) main.readd(item, chairDepth.get(seatId) ?? item.depth);
      else if (!visible && shown) main.remove(item);
    },
  };
}

function placeOnWall(layout: FloorLayout, main: SortedLayer, f: Frame, pr: Prop): void {
  const axis = pr.wall!;
  const t = faceTop(layout, pr.i, pr.j, axis);
  const flatH = f.h - Math.floor(f.w / 2) - 1;
  const oy = Math.max(1, Math.floor((16 * t.h - flatH) / 2));
  const span = Math.ceil(f.w / 16);
  const depth = pr.i + pr.j + span - 1 - 0.5 + 0.05;
  const x = axis === 'i' ? t.x + 2 : t.x - 2;
  main.add(makeParticle(f, x, t.y + oy, axis === 'j'), depth);
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
