// Builds the static office floor from the layout: floor tiles, back walls, desks, decor, the subway stairs, the HQ
// furnace, lamp glows and the wall tickers. One tile per cell (no pre-rendered giant image).
import { Container, Sprite, Texture } from 'pixi.js';
import type { StockView } from '@rat/contract';
import type { Atlas } from '../gfx/atlas';
import { makeParticle, SortedLayer, type LayerItem } from '../gfx/layer';
import { drawText, shearRightWall, textWidth } from '../gfx/pixelfont';
import { cellCentre, cellToScreen } from '../iso';
import { CORRIDOR, hash32, type FloorLayout, type Room } from '../layout';

export const WALL_HEIGHT = 3;

export interface WorldBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Ticker {
  room: Room;
  text: Sprite;
  lastText: string;
}

export interface World {
  bounds: WorldBounds;
  floor: Container;
  main: SortedLayer;
  overlay: Container; // tickers, drawn above the walls
  lights: Container; // additive glows
  tickers: Map<string, Ticker>;
  /** empty-seat chairs by "symbol:seatIndex"; a rat taking the seat removes its chair */
  chairs: Map<string, LayerItem>;
  furnaceGlow: Sprite;
  furnaceMouth: { x: number; y: number };
}

export function worldBounds(layout: FloorLayout): WorldBounds {
  const { i0, j0, i1, j1 } = layout.bounds;
  const left = cellToScreen(i0, j1).x - 64;
  const right = cellToScreen(i1, j0).x + 64;
  const top = cellToScreen(i0, j0).y - 200;
  const bottom = cellToScreen(i1, j1).y + 64;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function roomAt(layout: FloorLayout, i: number, j: number): Room | null {
  for (const r of layout.rooms) {
    if (i >= r.i0 && i < r.i0 + r.w && j >= r.j0 && j < r.j0 + r.h) return r;
  }
  return null;
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

function renderTickerText(text: string, width: number, height: number): Texture {
  const [line1 = '', line2 = ''] = text.split('\n');
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  const color = line2.startsWith('^') ? '#3dff7a' : line2.startsWith('_') ? '#ff4d5e' : '#ffb13d';
  drawText(ctx, line1, Math.max(6, Math.floor((width - textWidth(line1)) / 2)), 7, '#d6ecff');
  drawText(ctx, line2, Math.max(6, Math.floor((width - textWidth(line2)) / 2)), 18, color);
  const tex = Texture.from(shearRightWall(c));
  tex.source.scaleMode = 'nearest';
  return tex;
}

export function buildWorld(layout: FloorLayout, atlas: Atlas, stocks: Map<string, StockView>): World {
  const bounds = worldBounds(layout);
  const main = new SortedLayer(atlas.source, bounds, { position: true, vertex: true, uvs: true, color: false, rotation: false });
  const overlay = new Container();
  const lights = new Container();

  // floor: one tile per cell in a static particle layer, uploaded once and never culled (floors never change, so
  // they cost no CPU per frame; a real GPU draws the whole floor in one call)
  const floorLayer = new SortedLayer(atlas.source, bounds, { position: false, vertex: false, uvs: false, color: false, rotation: false });
  const fOffice = atlas.frame('world:floor_office');
  const fSubway = atlas.frame('world:floor_subway');
  const fHq = atlas.frame('world:floor_hq');
  const pitch = layout.slot + CORRIDOR;
  for (let i = 0; i < layout.bounds.i1; i++) {
    for (let j = 0; j < layout.bounds.j1; j++) {
      const r = roomAt(layout, i, j);
      const corridor = i % pitch >= layout.slot || j % pitch >= layout.slot;
      // HQ: marble plaza around the furnace on warm office floor. Subway: platform tiles ringing the stairs.
      const plaza = Math.max(3, Math.floor(layout.slot / 6));
      const nearFurnace = Math.abs(i + 0.5 - layout.furnace.i) <= plaza && Math.abs(j + 0.5 - layout.furnace.j) <= plaza;
      const nearStairs = Math.abs(i + 0.5 - layout.spawn.i) <= 3 && Math.abs(j + 0.5 - layout.spawn.j) <= 3;
      const f = r?.kind === 'hq' && nearFurnace ? fHq : r?.kind === 'subway' && nearStairs ? fSubway : fOffice;
      const p = cellToScreen(i, j);
      const tile = makeParticle(f, p.x, p.y);
      if (f === fOffice && ((!r && corridor) || r?.kind === 'subway')) tile.tint = 0xcfd6e2; // walkways: a shade cooler
      if (f === fOffice && r?.kind === 'hq') tile.tint = 0xf6ecdc; // HQ: warm
      floorLayer.add(tile, i + j);
    }
  }
  floorLayer.sync(true);
  const floor = floorLayer.container;

  // back walls of stock rooms and HQ
  const wall = atlas.frame('world:wall');
  for (const r of layout.rooms) {
    if (r.kind !== 'stock' && r.kind !== 'hq') continue;
    const cells: Array<[number, number]> = [];
    for (let k = r.i0 - 1; k < r.i0 + r.w; k++) cells.push([k, r.j0 - 1]);
    for (let k = r.j0; k < r.j0 + r.h; k++) cells.push([r.i0 - 1, k]);
    for (const [i, j] of cells) {
      for (let z = 0; z < WALL_HEIGHT; z++) {
        const p = cellToScreen(i, j);
        main.add(makeParticle(wall, p.x, p.y - 16 * z), i + j - 0.5 + z * 0.01);
      }
    }
  }

  // desks, each with an empty chair until a rat sits down
  const deskA = atlas.frame('world:desk_oak_clutter');
  const deskB = atlas.frame('world:desk_oak');
  const chair = atlas.frame('world:chair_dark');
  const chairs = new Map<string, LayerItem>();
  for (const r of layout.rooms) {
    for (const s of r.seats) {
      const c = cellCentre(s.deskI, s.deskJ);
      const f = hash32(`${r.symbol}:${s.deskI}:${s.deskJ}`) % 3 === 0 ? deskB : deskA;
      main.add(makeParticle(f, c.x, c.y), s.deskI + s.deskJ + 1);
      const sc = cellCentre(s.i, s.j);
      chairs.set(`${r.symbol}:${s.index}`, main.add(makeParticle(chair, sc.x - 10, sc.y - 1), s.deskI + s.deskJ + 1.4));
    }
  }

  // decor and lamp glows
  const warm = glowTexture(255, 186, 102);
  for (const r of layout.rooms) {
    for (const d of r.decor) {
      const c = cellCentre(d.i, d.j);
      main.add(makeParticle(atlas.frame(`world:${d.kind}`), c.x, c.y, d.mirror), d.i + d.j + 1);
      if (d.kind === 'lamp') {
        const g = new Sprite(warm);
        g.anchor.set(0.5);
        g.position.set(c.x, c.y - 6);
        g.scale.set(1.6);
        g.blendMode = 'add';
        lights.addChild(g);
      }
    }
  }

  // subway stairs and HQ furnace
  const sp = cellCentre(layout.spawn.i, layout.spawn.j);
  main.add(makeParticle(atlas.frame('world:stairs'), sp.x, sp.y + 24), layout.spawn.i + layout.spawn.j - 0.2);
  const fp = cellCentre(layout.furnace.i, layout.furnace.j);
  const fs = layout.furnaceScale;
  main.add(makeParticle(atlas.frame('world:furnace'), fp.x, fp.y, false, fs), layout.furnace.i + layout.furnace.j + 1);
  const furnaceGlow = new Sprite(glowTexture(255, 120, 40));
  furnaceGlow.anchor.set(0.5);
  furnaceGlow.position.set(fp.x + 8 * fs, fp.y - 18 * fs);
  furnaceGlow.scale.set(2.2 * fs);
  furnaceGlow.blendMode = 'add';
  lights.addChild(furnaceGlow);

  // wall tickers: screen on the back-right wall, live symbol and 24h % drawn on top
  const tickerFrame = atlas.frame('world:ticker_wall');
  const tickers = new Map<string, Ticker>();
  for (const r of layout.rooms) {
    if (r.kind !== 'stock' || r.tickerI === null || !r.symbol) continue;
    const p = cellToScreen(r.tickerI, r.j0 - 1);
    const x = p.x - 16 + 3;
    const y = p.y - 16 * WALL_HEIGHT + 8 + 5;
    const screen = new Sprite(tickerFrame.texture);
    screen.position.set(x, y);
    overlay.addChild(screen);
    const text = new Sprite(Texture.EMPTY);
    text.position.set(x, y);
    overlay.addChild(text);
    const t: Ticker = { room: r, text, lastText: '' };
    tickers.set(r.symbol, t);
  }
  updateTickers({ tickers } as World, stocks);

  main.sync(true);
  return { bounds, floor, main, overlay, lights, tickers, chairs, furnaceGlow, furnaceMouth: { x: fp.x + 10 * fs, y: fp.y - 26 * fs } };
}

export function updateTickers(world: Pick<World, 'tickers'>, stocks: Map<string, StockView>): void {
  for (const [symbol, t] of world.tickers) {
    const text = tickerText(stocks.get(symbol), symbol);
    if (text === t.lastText) continue;
    t.lastText = text;
    const old = t.text.texture;
    t.text.texture = renderTickerText(text, 101, 32);
    if (old !== Texture.EMPTY) old.destroy(true);
  }
}
