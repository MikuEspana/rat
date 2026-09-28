// Money you can see moving: bills fly in an arc into the Vault (every claim, every hire) and "+$X" popups rise
// and fade. Display only. Bills are sprites of the shared atlas (world:bill); popups are small pixel-text textures,
// made per popup and destroyed when they fade.
import { Container, Sprite, Texture } from 'pixi.js';
import type { Atlas } from '../gfx/atlas';
import { drawText, textWidth } from '../gfx/pixelfont';
import { usd } from '../ui/format';
import type { World } from './build';

interface Bill {
  s: Sprite;
  x0: number;
  y0: number;
  t: number;
  dur: number;
  arc: number;
  spin: number;
}

interface Pop {
  s: Sprite;
  y0: number;
  t: number;
  dur: number;
}

/** at most this many bills in the air (a big batch sends a representative handful) */
const MAX_BILLS = 160;
const MAX_POPS = 12;
/** one popup at a time above the Vault, this far apart (seconds): values that come in between add up */
const POP_EVERY = 0.7;

/**
 * Which "+$X" goes up next: claims (gold) and hires (green) take turns while both keep coming, so a rush of claims
 * never hides the stock bought. Pure.
 */
export function nextPopKind(pending: { claim: number; hire: number }, last: 'claim' | 'hire' | null): 'claim' | 'hire' | null {
  const c = pending.claim > 0;
  const h = pending.hire > 0;
  if (c && h) return last === 'claim' ? 'hire' : 'claim';
  return c ? 'claim' : h ? 'hire' : null;
}

function popTexture(text: string, color: string, scale: number): Texture {
  const pad = 2;
  const w = textWidth(text, scale) + pad * 2 + 2;
  const h = 7 * scale + pad * 2 + 2;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  // a dark outline so the text reads on any floor
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1]] as const) drawText(ctx, text, pad + 1 + dx, pad + 1 + dy, '#10121f', scale);
  drawText(ctx, text, pad + 1, pad + 1, color, scale);
  const tex = Texture.from(c);
  tex.source.scaleMode = 'nearest';
  return tex;
}

export class MoneyFx {
  readonly container = new Container();
  private bills: Bill[] = [];
  private pops: Pop[] = [];
  private zoom = 1;
  /** money waiting for its popup: fees claimed, stock bought */
  private pending = { claim: 0, hire: 0 };
  private nextPop = 0;
  private lastPop: 'claim' | 'hire' | null = null;

  constructor(
    private readonly atlas: Atlas,
    private world: World,
  ) {}

  setWorld(world: World): void {
    this.world = world;
  }

  setZoom(z: number): void {
    this.zoom = z;
  }

  /** `n` bills from these points (round robin) into the Vault, a little apart. */
  flyIn(from: Array<{ x: number; y: number }>, n: number): void {
    if (!from.length) return;
    const tex = this.atlas.frame('world:bill').texture;
    const v = this.world.vault;
    for (let k = 0; k < n && this.bills.length < MAX_BILLS; k++) {
      const src = from[k % from.length]!;
      const s = new Sprite(tex);
      s.anchor.set(0.5);
      s.position.set(src.x, src.y);
      s.scale.set(Math.max(1.5, 1.2 / this.zoom));
      s.visible = false;
      this.container.addChild(s);
      const dist = Math.hypot(v.x - src.x, v.y - src.y);
      this.bills.push({
        s,
        x0: src.x + (Math.random() - 0.5) * 14,
        y0: src.y - 20 + (Math.random() - 0.5) * 10,
        t: -k * 0.06 - Math.random() * 0.05,
        dur: Math.min(2.2, 0.7 + dist / 1600),
        arc: 60 + Math.min(420, dist * 0.35),
        spin: (Math.random() - 0.5) * 10,
      });
    }
  }

  /** Money into the Vault: a "+$X" popup rises above it (claims in gold, bought stock in green). */
  addValue(kind: 'claim' | 'hire', usdValue: number): void {
    if (usdValue > 0) this.pending[kind] += usdValue;
  }

  /** "+$X" rising from a point (default: above the Vault). */
  popup(text: string, color = '#ffd23f', at?: { x: number; y: number }, big = false): void {
    if (this.pops.length >= MAX_POPS) {
      const old = this.pops.shift()!;
      old.s.destroy({ texture: true });
    }
    const v = at ?? this.world.vaultPop;
    const s = new Sprite(popTexture(text, color, big ? 3 : 2));
    s.anchor.set(0.5, 1);
    s.position.set(v.x + (Math.random() - 0.5) * 90, v.y);
    s.scale.set(Math.max(1, 0.9 / this.zoom));
    this.container.addChild(s);
    this.pops.push({ s, y0: s.position.y, t: 0, dur: big ? 2.6 : 2.2 });
  }

  get airborne(): number {
    return this.bills.length;
  }

  update(dt: number): void {
    // one popup every POP_EVERY seconds, claims and stock bought taking turns, each adding up what came in since
    this.nextPop -= dt;
    const kind = this.nextPop <= 0 ? nextPopKind(this.pending, this.lastPop) : null;
    if (kind) {
      if (kind === 'claim') this.popup(`+${usd(this.pending.claim)}`, '#ffd23f', undefined, true);
      else this.popup(`+${usd(this.pending.hire)}`, '#6dff9a');
      this.pending[kind] = 0;
      this.lastPop = kind;
      this.nextPop = POP_EVERY;
    }
    const v = this.world.vault;
    for (let k = this.bills.length - 1; k >= 0; k--) {
      const b = this.bills[k]!;
      b.t += dt;
      if (b.t < 0) continue;
      b.s.visible = true;
      const u = Math.min(1, b.t / b.dur);
      const e = u * u * (3 - 2 * u);
      b.s.position.set(b.x0 + (v.x - b.x0) * e, b.y0 + (v.y - b.y0) * e - Math.sin(Math.PI * u) * b.arc);
      b.s.rotation = b.spin * u;
      if (u >= 1) {
        this.world.flare();
        b.s.destroy();
        this.bills.splice(k, 1);
      }
    }
    for (let k = this.pops.length - 1; k >= 0; k--) {
      const p = this.pops[k]!;
      p.t += dt;
      const u = Math.min(1, p.t / p.dur);
      p.s.position.y = p.y0 - (150 * (1 - (1 - u) ** 2)) / Math.max(0.5, this.zoom);
      p.s.alpha = u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3;
      if (u >= 1) {
        p.s.destroy({ texture: true });
        this.pops.splice(k, 1);
      }
    }
  }
}
