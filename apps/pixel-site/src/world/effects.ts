// Burn: cash bags fly from desks across the floor into the HQ furnace, and the furnace flares.
// Dust: a puff where something just got built.
import { Container, Sprite, Texture } from 'pixi.js';
import type { Atlas } from '../gfx/atlas';
import type { World } from './build';

interface Bag {
  s: Sprite;
  x0: number;
  y0: number;
  t: number;
  dur: number;
  delay: number;
  arc: number;
}

interface Puff {
  s: Sprite;
  vx: number;
  vy: number;
  t: number;
  life: number;
}

let puffTex: Texture | null = null;
function puffTexture(): Texture {
  if (puffTex) return puffTex;
  const c = document.createElement('canvas');
  c.width = c.height = 12;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#16182c';
  ctx.beginPath();
  ctx.arc(6, 6, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e8e2d6';
  ctx.beginPath();
  ctx.arc(6, 6, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fbf8f2';
  ctx.beginPath();
  ctx.arc(5, 4.5, 2.5, 0, Math.PI * 2);
  ctx.fill();
  puffTex = Texture.from(c);
  puffTex.source.scaleMode = 'nearest';
  return puffTex;
}

export class Effects {
  readonly container = new Container();
  private bags: Bag[] = [];
  private puffs: Puff[] = [];
  private flare = 0;
  private baseGlow: number;

  constructor(
    private readonly atlas: Atlas,
    private world: World,
  ) {
    this.baseGlow = world.furnaceGlow.scale.x;
  }

  /** The world was rebuilt: aim at the new furnace. */
  setWorld(world: World): void {
    this.world = world;
    this.baseGlow = world.furnaceGlow.scale.x;
  }

  /** Bags scale with the SOL spent: 3 to 24. */
  burn(solSpent: number, from: Array<{ x: number; y: number }>): void {
    const n = Math.max(3, Math.min(24, Math.round(solSpent * 3)));
    const tex = this.atlas.frame('world:cashbag');
    for (let k = 0; k < n; k++) {
      const src = from[k % Math.max(1, from.length)] ?? { x: this.world.furnaceMouth.x - 300, y: this.world.furnaceMouth.y };
      const s = new Sprite(tex.texture);
      s.anchor.set(0.5);
      s.position.set(src.x, src.y);
      s.visible = false;
      this.container.addChild(s);
      const dist = Math.hypot(this.world.furnaceMouth.x - src.x, this.world.furnaceMouth.y - src.y);
      this.bags.push({ s, x0: src.x, y0: src.y, t: 0, dur: 0.9 + dist / 900, delay: k * 0.12, arc: 60 + Math.min(260, dist * 0.35) });
    }
  }

  /** A puff of dust (something just got built here). */
  dust(x: number, y: number, n = 14): void {
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + Math.random() * 0.4;
      const s = new Sprite(puffTexture());
      s.anchor.set(0.5);
      s.position.set(x + Math.cos(a) * 6, y + Math.sin(a) * 3 - 6);
      s.scale.set(0.6 + Math.random() * 0.6);
      this.container.addChild(s);
      const v = 28 + Math.random() * 30;
      this.puffs.push({ s, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.5 - 12, t: 0, life: 0.55 + Math.random() * 0.35 });
    }
  }

  update(dt: number): void {
    for (let k = this.puffs.length - 1; k >= 0; k--) {
      const p = this.puffs[k]!;
      p.t += dt;
      const u = p.t / p.life;
      p.s.x += p.vx * dt;
      p.s.y += p.vy * dt;
      p.vx *= 0.9;
      p.vy = p.vy * 0.9 - 6 * dt;
      p.s.alpha = Math.max(0, 1 - u);
      p.s.scale.set(p.s.scale.x + dt * 0.8);
      if (u >= 1) {
        p.s.destroy();
        this.puffs.splice(k, 1);
      }
    }
    const m = this.world.furnaceMouth;
    for (let k = this.bags.length - 1; k >= 0; k--) {
      const b = this.bags[k]!;
      if (b.delay > 0) {
        b.delay -= dt;
        continue;
      }
      b.s.visible = true;
      b.t += dt;
      const u = Math.min(1, b.t / b.dur);
      const e = u * u * (3 - 2 * u);
      b.s.x = b.x0 + (m.x - b.x0) * e;
      b.s.y = b.y0 + (m.y - b.y0) * e - Math.sin(Math.PI * u) * b.arc;
      b.s.rotation = Math.sin(u * 10) * 0.25;
      b.s.scale.set(u > 0.85 ? Math.max(0.1, (1 - u) / 0.15) : 1);
      if (u >= 1) {
        this.flare = Math.min(1.5, this.flare + 0.35);
        b.s.destroy();
        this.bags.splice(k, 1);
      }
    }
    this.flare = Math.max(0, this.flare - dt * 0.8);
    const g = this.world.furnaceGlow;
    g.scale.set(this.baseGlow * (1 + this.flare * 0.6 + Math.sin(performance.now() / 180) * 0.03));
    g.alpha = 0.85 + this.flare * 0.15;
  }

  get active(): number {
    return this.bags.length + this.puffs.length;
  }
}
