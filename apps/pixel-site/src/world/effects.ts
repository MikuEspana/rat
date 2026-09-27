// Burn: cash bags fly from desks across the floor into the HQ furnace, and the furnace flares.
import { Container, Sprite } from 'pixi.js';
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

export class Effects {
  readonly container = new Container();
  private bags: Bag[] = [];
  private flare = 0;
  private baseGlow: number;

  constructor(
    private readonly atlas: Atlas,
    private readonly world: World,
  ) {
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

  update(dt: number): void {
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
    return this.bags.length;
  }
}
