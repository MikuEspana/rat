// The Vault on screen: the money pile at the centre of the building (stages in floor/vault.ts), the bills every hire
// sends flying into it with a floating "+$X", bills raining from the ceiling on a burst of hires, the upgrade when it
// reaches a new stage, and its breathing with the market: a green shimmer while the portfolio is up, dim while down.
import { Container, Sprite, Texture } from 'pixi.js';
import type { Atlas } from '../gfx/atlas';
import type { LayerItem } from '../gfx/layer';
import { drawText, textWidth } from '../gfx/pixelfont';
import { shortUsd, VAULT_STAGES, vaultStageOf } from '../floor/vault';

/** Where the world put the pile: its particle (depth-sorted with the rats), the plaza centre, and its glow. */
export interface VaultAnchor {
  item: LayerItem;
  x: number;
  y: number;
  glow: Sprite;
}

interface Bill {
  s: Sprite;
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  t: number;
  dur: number;
  delay: number;
  label: string | null;
}

interface Float {
  s: Sprite;
  t: number;
}

interface Spark {
  s: Sprite;
  t: number;
  life: number;
}

const labelCache = new Map<string, Texture>();
function labelTexture(text: string): Texture {
  const hit = labelCache.get(text);
  if (hit) return hit;
  const sc = 2;
  const w = textWidth(text, sc) + 6;
  const h = 7 * sc + 6;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  // a dark outline all round, then the green figure
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]] as const) drawText(ctx, text, 3 + dx * 2, 3 + dy * 2, '#16182c', sc);
  drawText(ctx, text, 3, 3, '#7dff9a', sc);
  const tex = Texture.from(c);
  tex.source.scaleMode = 'nearest';
  labelCache.set(text, tex);
  return tex;
}

let sparkTex: Texture | null = null;
function sparkTexture(): Texture {
  if (sparkTex) return sparkTex;
  const c = document.createElement('canvas');
  c.width = c.height = 5;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#eafff0';
  ctx.fillRect(2, 0, 1, 5);
  ctx.fillRect(0, 2, 5, 1);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(2, 2, 1, 1);
  sparkTex = Texture.from(c);
  sparkTex.source.scaleMode = 'nearest';
  return sparkTex;
}

const lerpTint = (a: number, b: number, u: number): number => {
  const ch = (s: number): number => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * u);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

export class VaultView {
  /** flying bills, "+$X" labels and sparkles: above the world */
  readonly fx = new Container();
  stage = -1;
  value = 0;
  pnlPct = 0;
  private bills: Bill[] = [];
  private floats: Float[] = [];
  private sparks: Spark[] = [];
  private t = 0;
  private bounce = 0;
  private grow = 1;
  private sparkT = 0;

  constructor(
    private readonly atlas: Atlas,
    private anchor: VaultAnchor,
  ) {}

  /** The world was rebuilt: the pile has a new particle. */
  setAnchor(a: VaultAnchor): void {
    this.anchor = a;
    if (this.stage >= 0) this.show(this.stage);
  }

  private frameOf(stage: number): { kind: string; scale: number } {
    const s = VAULT_STAGES[stage]!;
    return { kind: this.atlas.has(`world:${s.kind}`) ? s.kind : 'cashbag', scale: s.scale };
  }

  private show(stage: number): void {
    const { kind, scale } = this.frameOf(stage);
    const f = this.atlas.frame(`world:${kind}`);
    const p = this.anchor.item.p;
    p.texture = f.texture;
    p.anchorX = f.anchorX;
    p.anchorY = f.anchorY;
    // the base of the pile sits on the plaza centre (a sprite's base diamond is about a quarter of its width deep)
    p.x = this.anchor.x;
    p.y = this.anchor.y + f.w * scale * 0.22;
    p.scaleX = p.scaleY = scale;
  }

  /** Size of the pile now (world px). */
  private box(): { x: number; y: number; w: number; h: number } {
    const { kind, scale } = this.frameOf(Math.max(0, this.stage));
    const f = this.atlas.frame(`world:${kind}`);
    const p = this.anchor.item.p;
    return { x: p.x, y: p.y, w: f.w * scale, h: f.h * scale };
  }

  /** Where bills land: a little below the top of the pile. */
  top(): { x: number; y: number } {
    const b = this.box();
    return { x: b.x, y: b.y - b.h * 0.7 };
  }

  /** For the camera: the pile's middle and height. */
  focus(): { x: number; y: number; h: number } {
    const b = this.box();
    return { x: b.x, y: b.y - b.h / 2, h: b.h + 120 };
  }

  /** Did a click at this world point land on the pile? */
  hit(x: number, y: number): boolean {
    const b = this.box();
    const w = Math.max(40, b.w);
    const h = Math.max(40, b.h);
    return x >= b.x - w / 2 && x <= b.x + w / 2 && y >= b.y - h && y <= b.y + 6;
  }

  /** New portfolio value. Returns the stages when the pile went up one (for the banner), else null. */
  set(valueUsd: number, pnlPct: number, animate: boolean): { from: number; to: number } | null {
    this.value = valueUsd;
    this.pnlPct = pnlPct;
    const s = vaultStageOf(valueUsd);
    const before = this.stage;
    if (s === before) return null;
    this.stage = s;
    this.show(s);
    if (animate && before >= 0 && s > before) {
      this.grow = 0; // the new pile rises from the floor with a bounce
      this.rain(28);
      return { from: before, to: s };
    }
    return null;
  }

  /** A hire: bills fly from where the rat came in to the pile, and "+$X" floats up where they land. */
  hire(from: { x: number; y: number }, usd: number, n = 3): void {
    const to = this.top();
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const dur = Math.min(2.8, 0.9 + dist / 800);
    for (let k = 0; k < n; k++) {
      const x1 = to.x + (Math.random() - 0.5) * 30;
      const y1 = to.y + (Math.random() - 0.5) * 16;
      this.bills.push(this.bill(from.x, from.y, (from.x + x1) / 2, Math.min(from.y, y1) - 60 - dist * 0.25, x1, y1, dur, k * 0.12, k === 0 ? `+${shortUsd(usd)}` : null));
    }
  }

  /** A burst of hires: bills rain from the ceiling onto the pile. */
  rain(n: number): void {
    const b = this.box();
    for (let k = 0; k < n; k++) {
      const x = b.x + (Math.random() - 0.5) * Math.max(80, b.w * 1.1);
      const y1 = b.y - b.h * (0.35 + Math.random() * 0.45);
      const y0 = y1 - 260 - Math.random() * 180;
      this.bills.push(this.bill(x, y0, x + (Math.random() - 0.5) * 40, (y0 + y1) / 2, x + (Math.random() - 0.5) * 20, y1, 1.2 + Math.random() * 0.8, Math.random() * 1.2, null));
    }
  }

  private bill(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, dur: number, delay: number, label: string | null): Bill {
    const f = this.atlas.frame(this.atlas.has('world:bill') ? 'world:bill' : 'world:cashbag');
    const s = new Sprite(f.texture);
    s.anchor.set(0.5);
    s.position.set(x0, y0);
    s.visible = false;
    this.fx.addChild(s);
    return { s, x0, y0, cx, cy, x1, y1, t: 0, dur, delay, label };
  }

  update(dt: number): void {
    this.t += dt;
    const p = this.anchor.item.p;
    const { scale } = this.frameOf(Math.max(0, this.stage));
    // rising after an upgrade, a small bounce when bills land
    if (this.grow < 1) this.grow = Math.min(1, this.grow + dt * 1.6);
    const g = this.grow < 1 ? easeOutBack(this.grow) : 1;
    this.bounce = Math.max(0, this.bounce - dt * 3);
    const squash = 1 + Math.sin(this.bounce * Math.PI) * 0.04;
    p.scaleX = scale * g * (2 - squash);
    p.scaleY = scale * g * squash;
    // breathing with the market: up shimmers green, down goes dim
    const up = this.pnlPct >= 0;
    const mag = Math.min(1, Math.abs(this.pnlPct) / 10);
    const wave = 0.5 + 0.5 * Math.sin(this.t * (up ? 2.4 : 1.2));
    p.tint = up ? lerpTint(0xffffff, 0xd4ffd8, wave * (0.35 + 0.65 * mag)) : lerpTint(0x9c9cac, 0xb8b8c6, wave);
    const glow = this.anchor.glow;
    glow.alpha = up ? (0.18 + 0.3 * mag) * (0.7 + 0.3 * wave) : 0;
    if (up) {
      this.sparkT += dt * (2 + 10 * mag);
      while (this.sparkT >= 1) {
        this.sparkT -= 1;
        const b = this.box();
        const s = new Sprite(sparkTexture());
        s.anchor.set(0.5);
        s.position.set(b.x + (Math.random() - 0.5) * b.w * 0.8, b.y - b.h * (0.2 + Math.random() * 0.7));
        s.tint = 0x9dffb0;
        this.fx.addChild(s);
        this.sparks.push({ s, t: 0, life: 0.5 + Math.random() * 0.4 });
      }
    }
    for (let k = this.sparks.length - 1; k >= 0; k--) {
      const sp = this.sparks[k]!;
      sp.t += dt;
      const u = sp.t / sp.life;
      sp.s.alpha = u < 0.5 ? u * 2 : (1 - u) * 2;
      sp.s.scale.set(0.6 + Math.sin(u * Math.PI) * 0.8);
      if (u >= 1) {
        sp.s.destroy();
        this.sparks.splice(k, 1);
      }
    }
    // flying bills: a curve to the pile, fluttering
    for (let k = this.bills.length - 1; k >= 0; k--) {
      const b = this.bills[k]!;
      if (b.delay > 0) {
        b.delay -= dt;
        continue;
      }
      b.s.visible = true;
      b.t += dt;
      const u = Math.min(1, b.t / b.dur);
      const a = 1 - u;
      b.s.x = a * a * b.x0 + 2 * a * u * b.cx + u * u * b.x1;
      b.s.y = a * a * b.y0 + 2 * a * u * b.cy + u * u * b.y1;
      b.s.scale.set(1.3 * Math.cos(b.t * 13), 1.3);
      b.s.rotation = Math.sin(b.t * 7) * 0.35;
      if (u >= 1) {
        this.bounce = Math.min(1, this.bounce + 0.35);
        if (b.label) {
          const s = new Sprite(labelTexture(b.label));
          s.anchor.set(0.5, 1);
          s.position.set(b.x1, b.y1 - 6);
          this.fx.addChild(s);
          this.floats.push({ s, t: 0 });
        }
        b.s.destroy();
        this.bills.splice(k, 1);
      }
    }
    for (let k = this.floats.length - 1; k >= 0; k--) {
      const f = this.floats[k]!;
      f.t += dt;
      f.s.y -= dt * 26;
      f.s.alpha = f.t < 1.1 ? 1 : Math.max(0, 1 - (f.t - 1.1) / 0.6);
      if (f.t >= 1.7) {
        f.s.destroy();
        this.floats.splice(k, 1);
      }
    }
  }

  get active(): number {
    return this.bills.length + this.floats.length;
  }
}

function easeOutBack(u: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (u - 1) ** 3 + c1 * (u - 1) ** 2;
}
