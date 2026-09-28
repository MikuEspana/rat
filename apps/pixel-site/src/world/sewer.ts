// The sewer new rats come out of, in front of the lobby (parts and stages in floor/sewer.ts). A hire: the lid wobbles,
// pops up with a bounce and a puff of steam, the rat climbs out, shakes itself off, straightens its tie and walks to
// its desk (the rat system takes over). A burst keeps the lid open for a line of rats; then it drops back with a clank.
// From the big sewer entrance on, rats also march out in a line.
import { Container, Rectangle, Sprite, Texture } from 'pixi.js';
import type { Atlas, Frame } from '../gfx/atlas';
import { makeParticle, type LayerItem, type SortedLayer } from '../gfx/layer';
import { cellCentre, cellToScreen } from '../iso';
import type { SewerPart } from '../floor/sewer';
import { SEWER_TUNNEL_SCALE } from '../floor/signs';
import { sound } from '../ui/sound';

interface Lid {
  s: Sprite;
  x: number;
  y: number;
  state: 'shut' | 'wobble' | 'up' | 'open' | 'down';
  t: number;
}

interface Climber {
  s: Sprite;
  /** the rat's frame cut at the rim while it climbs out */
  crop: Texture;
  frames: Frame[];
  x: number;
  y: number;
  t: number;
  climb: boolean;
  done: () => void;
}

interface Drop {
  s: Sprite;
  vx: number;
  vy: number;
  t: number;
}

interface Marcher {
  item: LayerItem;
  frames: Frame[];
  i: number;
  j: number;
  k: number;
  t: number;
}

let glowTex: Texture | null = null;
function greenGlow(): Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(120,255,150,0.9)');
  g.addColorStop(1, 'rgba(120,255,150,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  glowTex = Texture.from(c);
  return glowTex;
}

let puffTex: Texture | null = null;
function puff(): Texture {
  if (puffTex) return puffTex;
  const c = document.createElement('canvas');
  c.width = c.height = 12;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(236,240,250,0.85)';
  ctx.beginPath();
  ctx.arc(6, 6, 5, 0, Math.PI * 2);
  ctx.fill();
  puffTex = Texture.from(c);
  puffTex.source.scaleMode = 'nearest';
  return puffTex;
}

export const SEWER_SCALE: Record<string, number> = { sewer_grate: 0.85, sewer_tunnel: SEWER_TUNNEL_SCALE };

export class SewerView {
  /** manholes and vents, flat on the ground under the rats */
  readonly flat = new Container();
  /** flying lids, rats climbing out, steam, glow: above the world */
  readonly fx = new Container();
  private main: SortedLayer | null = null;
  private items: LayerItem[] = [];
  private parts: SewerPart[] = [];
  private lid: Lid | null = null;
  private exitAt = { x: 0, y: 0 };
  private exitKind: SewerPart['kind'] = 'manhole';
  private queue: Array<{ look: string; done: () => void }> = [];
  private climbers: Climber[] = [];
  private drops: Drop[] = [];
  private steam: Array<{ s: Sprite; x: number; y: number; t: number; life: number }> = [];
  private vents: Array<{ x: number; y: number; t: number }> = [];
  private glows: Sprite[] = [];
  private marchers: Marcher[] = [];
  private door = 0;
  private idle = 0;
  private gap = 0;
  private time = 0;

  constructor(private readonly atlas: Atlas) {}

  /** The world was (re)built: draw the sewer's parts as the scene placed them. */
  attach(main: SortedLayer, parts: SewerPart[], doorJ: number): void {
    // anything still coming out finishes at once (no rat is lost)
    for (const c of this.climbers) {
      c.crop.destroy(false);
      c.done();
    }
    for (const q of this.queue) q.done();
    this.climbers = [];
    this.queue = [];
    this.flat.removeChildren().forEach((c) => c.destroy());
    this.fx.removeChildren().forEach((c) => c.destroy());
    this.drops = [];
    this.steam = [];
    this.vents = [];
    this.glows = [];
    this.marchers = [];
    this.items = [];
    this.lid = null;
    this.main = main;
    this.parts = parts;
    this.door = doorJ;
    for (const p of parts) {
      const c = cellCentre(p.i0 + p.w / 2 - 0.5, p.j0 + p.h / 2 - 0.5);
      if (p.kind === 'manhole') {
        const hole = this.sprite('manhole_hole', c.x, c.y + 6, 1);
        this.flat.addChild(hole);
        const s = this.sprite('manhole_lid', c.x, c.y + 6, 0.72);
        this.flat.addChild(s);
        if (p.main) this.lid = { s, x: c.x, y: c.y + 6, state: 'shut', t: 0 };
      } else if (p.kind === 'vent') {
        this.flat.addChild(this.sprite('steam_vent', c.x, c.y + 6, 0.8));
        this.vents.push({ x: c.x, y: c.y, t: Math.random() });
      } else {
        const kind = `sewer_${p.kind}`;
        if (!this.atlas.has(`world:${kind}`)) continue;
        const f = this.atlas.frame(`world:${kind}`);
        const front = cellToScreen(p.i0 + p.w, p.j0 + p.h);
        const base = { x: c.x, y: Math.min(front.y, c.y + (p.w * 16) / 2) };
        this.items.push(main.add(makeParticle(f, base.x, base.y + 4, false, SEWER_SCALE[kind] ?? 1), p.i0 + p.w + p.j0 + p.h - 1));
        const glow = new Sprite(greenGlow());
        glow.anchor.set(0.5);
        glow.position.set(c.x, c.y - (p.kind === 'tunnel' ? 10 : 20));
        glow.scale.set(p.w * 0.9);
        glow.blendMode = 'add';
        this.fx.addChild(glow);
        this.glows.push(glow);
      }
      if (p.main) {
        this.exitKind = p.kind;
        const front = cellCentre(p.i0 + p.w / 2 - 0.5, p.j0 + p.h - 1);
        this.exitAt = p.kind === 'manhole' ? { x: c.x, y: c.y + 6 } : p.kind === 'grate' ? { x: c.x, y: c.y + 4 } : { x: front.x, y: front.y + 2 };
        // rats marching out of the big entrance in a line
        const lines = p.kind === 'tunnel' ? [p.i0 + 1] : [];
        // the line runs from the mouth through the lobby door and a few tiles into the lobby, a rat every 1.3 tiles
        const start = p.j0 + p.h - 1;
        const end = doorJ - 5;
        const n = Math.floor((start - end) / 1.3);
        for (const li of lines) {
          for (let k = 0; k < n; k++) {
            const look = ['intern', 'intern.brown', 'analyst.white', 'intern.black', 'associate'][(k + li) % 5]!;
            let frames: Frame[];
            try {
              frames = this.atlas.anim(`${look}/walk_ne`);
            } catch {
              continue;
            }
            const j = start - k * 1.3 - (li - lines[0]!) * 0.65;
            const q = cellCentre(li, j);
            const item = main.add(makeParticle(frames[0]!, q.x, q.y, false, 0.9), li + j + 1.2);
            this.marchers.push({ item, frames, i: li, j, k: Math.floor(Math.random() * frames.length), t: 0 });
          }
        }
      }
    }
  }

  private sprite(kind: string, x: number, y: number, scale: number): Sprite {
    const f = this.atlas.frame(`world:${this.atlas.has(`world:${kind}`) ? kind : 'cone'}`);
    const s = new Sprite(f.texture);
    s.anchor.set(f.anchorX, f.anchorY);
    s.position.set(x, y);
    s.scale.set(scale);
    return s;
  }

  /** Where rats come out (world px). */
  exit(): { x: number; y: number } {
    return this.exitAt;
  }

  focus(): { x: number; y: number; h: number } {
    const big = this.exitKind === 'tunnel' ? 190 : 150;
    return { x: this.exitAt.x, y: this.exitAt.y - 30, h: big };
  }

  /** A new rat: it comes out of the sewer, then `done` hands it to the rat system (which walks it to its desk). */
  enqueue(look: string, done: () => void): void {
    this.queue.push({ look, done });
  }

  get waiting(): number {
    return this.queue.length + this.climbers.length;
  }

  update(dt: number): void {
    this.time += dt;
    // the lid: wobble, pop, stay open while rats come, drop back with a clank
    const lid = this.lid;
    const busy = this.queue.length > 0;
    if (lid) {
      lid.t += dt;
      if (lid.state === 'shut') {
        lid.s.position.set(lid.x, lid.y);
        lid.s.rotation = 0;
        if (busy) this.lidTo(lid, 'wobble');
      } else if (lid.state === 'wobble') {
        lid.s.rotation = Math.sin(lid.t * 60) * 0.1;
        lid.s.x = lid.x + Math.sin(lid.t * 45) * 1.5;
        if (lid.t > 0.35) {
          this.lidTo(lid, 'up');
          sound.pop();
          this.puffs(lid.x, lid.y - 4, 8);
        }
      } else if (lid.state === 'up') {
        const u = Math.min(1, lid.t / 0.35);
        lid.s.x = lid.x + 16 * u;
        lid.s.y = lid.y - Math.sin(u * Math.PI) * 22 + 4 * u;
        lid.s.rotation = u * 0.6;
        if (u >= 1) this.lidTo(lid, 'open');
      } else if (lid.state === 'open') {
        lid.s.position.set(lid.x + 16 + (lid.t < 0.2 ? Math.sin(lid.t * 30) * 2 : 0), lid.y + 4);
        if (!busy && this.climbers.length === 0) {
          this.idle += dt;
          if (this.idle > 0.7) this.lidTo(lid, 'down');
        } else this.idle = 0;
      } else if (lid.state === 'down') {
        const u = Math.min(1, lid.t / 0.3);
        lid.s.x = lid.x + 16 * (1 - u);
        lid.s.y = lid.y + 4 * (1 - u) - Math.sin(u * Math.PI) * 10;
        lid.s.rotation = 0.6 * (1 - u);
        if (u >= 1) {
          this.lidTo(lid, 'shut');
          sound.clank();
          this.puffs(lid.x, lid.y, 4);
          if (busy) this.lidTo(lid, 'wobble');
        }
      }
    }
    // the next rat comes out when the way is open (the lid up, or no lid at all), a line of them in a burst
    const open = !lid || lid.state === 'open';
    this.gap -= dt;
    if (open && busy && this.gap <= 0) {
      const q = this.queue.shift()!;
      this.gap = 0.45;
      this.climb(q.look, q.done);
    }
    for (let k = this.climbers.length - 1; k >= 0; k--) {
      const c = this.climbers[k]!;
      c.t += dt;
      const f = c.frames[0]!;
      if (c.climb && c.t < 0.5) {
        // climbing out: only the part above the rim shows
        const u = c.t / 0.5;
        c.crop.frame.height = Math.max(1, Math.min(f.texture.frame.height, Math.round(f.h * u)));
        c.crop.updateUvs();
        c.s.texture = c.crop;
        c.s.anchor.set(f.anchorX, 1);
        c.s.position.set(c.x, c.y);
      } else if (c.t < (c.climb ? 0.85 : 0.35)) {
        // out: shake off the sewer water
        c.s.texture = f.texture;
        c.s.anchor.set(f.anchorX, f.anchorY);
        c.s.position.set(c.x, c.y);
        c.s.scale.x = Math.floor(c.t / 0.06) % 2 === 0 ? 0.95 : -0.95;
        if (Math.random() < 0.5) this.drop(c.x, c.y - f.h * 0.6);
      } else if (c.t < (c.climb ? 1.15 : 0.65)) {
        // straighten the tie: a little bob
        c.s.scale.set(0.95, 0.95 * (1 - 0.04 * Math.sin((c.t * 20) % Math.PI)));
      } else {
        c.s.destroy();
        c.crop.destroy(false);
        this.climbers.splice(k, 1);
        c.done();
      }
    }
    for (let k = this.drops.length - 1; k >= 0; k--) {
      const d = this.drops[k]!;
      d.t += dt;
      d.vy += 220 * dt;
      d.s.x += d.vx * dt;
      d.s.y += d.vy * dt;
      d.s.alpha = 1 - d.t / 0.5;
      if (d.t >= 0.5) {
        d.s.destroy();
        this.drops.splice(k, 1);
      }
    }
    // steam from the vents, the glow breathing, the marching lines
    for (const v of this.vents) {
      v.t += dt;
      if (v.t > 0.35) {
        v.t = 0;
        const s = new Sprite(puff());
        s.anchor.set(0.5);
        this.fx.addChild(s);
        this.steam.push({ s, x: v.x + (Math.random() - 0.5) * 6, y: v.y, t: 0, life: 1.4 });
      }
    }
    for (let k = this.steam.length - 1; k >= 0; k--) {
      const p = this.steam[k]!;
      p.t += dt;
      const u = p.t / p.life;
      p.s.position.set(p.x + Math.sin(u * 5 + p.x) * 3, p.y - u * 30);
      p.s.scale.set(0.5 + u * 1.3);
      p.s.alpha = 0.7 * (1 - u);
      if (u >= 1) {
        p.s.destroy();
        this.steam.splice(k, 1);
      }
    }
    for (const g of this.glows) g.alpha = 0.45 + 0.2 * Math.sin(this.time * 2.2);
    const main = this.main;
    if (main) {
      for (const m of this.marchers) {
        m.j -= dt * 1.5;
        const exitJ = this.parts.find((p) => p.main);
        if (exitJ && m.j <= this.door - 5) m.j += exitJ.j0 + exitJ.h - 1 - (this.door - 5);
        const q = cellCentre(m.i, m.j);
        const p = m.item.p;
        p.x = q.x;
        p.y = q.y;
        m.t += dt;
        if (m.t > 0.1) {
          m.t = 0;
          m.k = (m.k + 1) % m.frames.length;
          const f = m.frames[m.k]!;
          p.texture = f.texture;
          p.anchorX = f.anchorX;
          p.anchorY = f.anchorY;
        }
        main.moved(m.item, m.i + m.j + 1.2);
      }
    }
  }

  private lidTo(lid: Lid, state: Lid['state']): void {
    lid.state = state;
    lid.t = 0;
  }

  private climb(look: string, done: () => void): void {
    let frames: Frame[];
    try {
      frames = this.atlas.anim(`${look}/idle_se`);
    } catch {
      done();
      return;
    }
    const f = frames[0]!;
    const crop = new Texture({ source: f.texture.source, frame: new Rectangle(f.texture.frame.x, f.texture.frame.y, f.texture.frame.width, 1) });
    const s = new Sprite(crop);
    s.scale.set(0.95);
    this.fx.addChild(s);
    const climb = this.exitKind === 'manhole' || this.exitKind === 'grate';
    this.climbers.push({ s, crop, frames, x: this.exitAt.x, y: this.exitAt.y, t: 0, climb, done });
    if (!climb) this.puffs(this.exitAt.x, this.exitAt.y - 10, 3);
  }

  private drop(x: number, y: number): void {
    const s = new Sprite(puff());
    s.anchor.set(0.5);
    s.scale.set(0.25);
    s.tint = 0x8fe8b0;
    s.position.set(x, y);
    this.fx.addChild(s);
    this.drops.push({ s, vx: (Math.random() - 0.5) * 90, vy: -40 - Math.random() * 40, t: 0 });
  }

  private puffs(x: number, y: number, n: number): void {
    for (let k = 0; k < n; k++) {
      const s = new Sprite(puff());
      s.anchor.set(0.5);
      this.fx.addChild(s);
      this.steam.push({ s, x: x + (k - n / 2) * 4, y, t: Math.random() * 0.3, life: 0.9 });
    }
  }
}
