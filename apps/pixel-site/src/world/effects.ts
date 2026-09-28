// Dust: a puff where something just got built. Demolition: when the office takes a lot, what stood there shakes,
// sinks into a cloud of dust and is gone. (The money flying into the Vault lives in vault.ts.)
import { Container, Sprite, Texture } from 'pixi.js';
import type { CityPart } from './build';

interface Wreck {
  s: Sprite;
  x: number;
  y: number;
  sy: number;
  h: number;
  t: number;
  delay: number;
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
  private puffs: Puff[] = [];
  private wrecks: Wreck[] = [];

  /** The office expands over these: shake, sink, dust (at most 40, nearest first; the rest just vanish). */
  demolish(parts: CityPart[]): void {
    parts.slice(0, 40).forEach((p, k) => {
      const s = new Sprite(p.texture);
      s.anchor.set(p.ax, p.ay);
      s.position.set(p.x, p.y);
      s.scale.set(p.sx, p.sy);
      s.tint = p.tint;
      this.container.addChild(s);
      this.wrecks.push({ s, x: p.x, y: p.y, sy: p.sy, h: p.texture.height * Math.abs(p.sy), t: 0, delay: (k % 12) * 0.05 });
    });
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
    for (let k = this.wrecks.length - 1; k >= 0; k--) {
      const w = this.wrecks[k]!;
      if (w.delay > 0) {
        w.delay -= dt;
        continue;
      }
      w.t += dt;
      if (w.t < 0.25) w.s.x = w.x + (Math.random() - 0.5) * 3; // it shakes
      else {
        // then sinks and crumbles, dust boiling up round its base
        const u = Math.min(1, (w.t - 0.25) / 0.6);
        w.s.x = w.x;
        w.s.scale.y = w.sy * (1 - u * 0.8);
        w.s.alpha = 1 - u;
        if (Math.random() < 0.5) this.dust(w.x + (Math.random() - 0.5) * 30, w.y, 2);
      }
      if (w.t >= 0.85) {
        w.s.destroy();
        this.wrecks.splice(k, 1);
      }
    }
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
  }

  get active(): number {
    return this.puffs.length + this.wrecks.length;
  }
}
