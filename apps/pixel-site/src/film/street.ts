// Shots 1 and 2 on one set, and the loop's last two beats: a coin rolls to the manhole and drops in the slot, the
// lid blasts off, a scruffy rat bursts out, looks around, hops out, spins in a puff of smoke and lands in a suit.
// Everything here is a pure function of the beat, so a frame renders the same alone or inside the film.
import { Container, Sprite, Texture } from 'pixi.js';
import { HeroStage, at, frameAt, type View } from './stage';
import { anim, META, sprite, tex } from './pixel';
import { easeInCubic, easeInOutCubic, easeOutBack, easeOutCubic, lerp, noise, span } from './timeline';

const GREEN = 0x46ff96;

export class StreetScene {
  readonly stage: HeroStage;
  private plate = sprite(tex('street_plate'));
  private hole = sprite(tex('hole'));
  private holeFront = sprite(tex('hole_front'));
  private mask = sprite(tex('hole_mask'));
  private rat = sprite(tex('scruffy_s'));
  private lid = sprite(tex('lid_flat'), 0.5, 0.5);
  private coin = sprite(tex('coin_spin_0'), 0.5, 1);
  private glow = sprite(tex('glow'), 0.5, 0.5);
  private puffBack = sprite(tex('puff_0'), 0.5, 0.5);
  private wisps: Sprite[] = [];
  private sparks: Sprite[] = [];
  private flash = new Sprite(Texture.WHITE);
  private readonly hc: [number, number];
  private readonly f = {
    burst: anim('burst'),
    look: anim('look'),
    tie: anim('tie'),
    walk: anim('walk_e'),
    lidSpin: anim('lid_spin'),
    coin: anim('coin_spin'),
    puff: anim('puff'),
    scruffy: Array.from({ length: 8 }, (_, k) => tex(`rot_scruffy_${k}`)),
    suited: Array.from({ length: 8 }, (_, k) => tex(`rot_suited_${k}`)),
  };

  constructor(readonly view: View) {
    this.stage = new HeroStage(view);
    const w = this.stage.world;
    const [hx, hy] = META.street.hole as [number, number];
    this.hc = META.street.holeCentre as [number, number];
    w.addChild(this.plate, this.hole);
    at(this.hole, hx, hy);
    this.glow.tint = GREEN;
    this.glow.blendMode = 'add';
    w.addChild(this.glow, this.puffBack);
    this.rat.anchor.set(0, 0);
    w.addChild(this.rat);
    at(this.mask, hx + META.holeMask.dx, hy + META.holeMask.dy);
    w.addChild(this.mask);
    w.addChild(this.holeFront);
    at(this.holeFront, hx, hy);
    w.addChild(this.lid, this.coin);
    for (let k = 0; k < 10; k++) {
      const s = new Sprite(tex('glow'));
      s.anchor.set(0.5);
      s.tint = 0xb4c8c0;
      s.scale.set(4 / 96);
      this.wisps.push(w.addChild(s));
    }
    for (let k = 0; k < 8; k++) this.sparks.push(w.addChild(sprite(tex('sparkle'), 0.5, 0.5)));
    this.flash.width = view.w;
    this.flash.height = view.h;
    this.flash.blendMode = 'add';
    this.stage.root.addChild(this.flash);
  }

  get root(): Container {
    return this.stage.root;
  }

  /** L: beats from the coin drop (negative: the coin still rolling in, the loop's tail). frame: global frame. */
  frame(L: number, frame: number): void {
    const st = this.stage;
    const [cx, cy] = this.hc;
    const tall = this.view.tall;
    // ---- camera: on the hole, then over to where the rat lands, a snap zoom on the landing
    st.S = L >= 10 && L < 12.25 ? 10 : 8;
    const move = easeInOutCubic(span(L, 6, 7.6));
    st.camX = lerp(cx, cx + 22, move);
    st.camY = lerp(cy - (tall ? 38 : 12), cy - (tall ? 44 : 22), move) + (L >= 10 && L < 12.25 ? -6 : 0);
    if (L >= 12.25) st.camX += 0; // the rat walks out of frame
    // ---- shake: the lid blast, the landing, the lid falling back
    const hit = (b: number, amp: number, dur: number): number => (L >= b && L < b + dur ? amp * (1 - (L - b) / dur) : 0);
    st.shakeAmp = Math.max(hit(1, 14, 0.7), hit(10, 10, 0.5), hit(7.75, 5, 0.35));
    st.apply(frame);

    // ---- the coin rolls in along the street and drops in the slot at L = 0
    const roll = span(L, -2.2, -0.15);
    this.coin.visible = L < 0.05;
    if (this.coin.visible) {
      const x = lerp(cx - 190, cx, easeOutCubic(roll));
      const y = lerp(cy - 95, cy, easeOutCubic(roll));
      const hop = Math.abs(Math.sin(roll * Math.PI * 5)) * 4 * (1 - roll);
      const sink = L > -0.15 ? Math.floor(span(L, -0.15, 0.05) * 3) * 2 : 0;
      this.coin.texture = frameAt(this.f.coin, L, -3, 10, true);
      at(this.coin, x, y - hop + sink - 1);
    }

    // ---- the lid: shut, rattles, blasts off spinning, falls back with a clang
    const lidOff = L >= 1 && L < 7.75;
    if (L < 1 || L >= 7.75) {
      this.lid.texture = tex('lid_flat');
      const rattle = L >= 0.5 && L < 1 ? (Math.floor(frame / 2) % 2 ? 1 : -1) : 0;
      const bounce = L >= 7.75 && L < 8.1 ? -Math.round(Math.sin(span(L, 7.75, 8.1) * Math.PI) * 3) : 0;
      at(this.lid, cx + rattle, cy + 1 + bounce);
      this.lid.visible = true;
    } else {
      const u = span(L, 1, 2.2);
      this.lid.texture = frameAt(this.f.lidSpin, L, 1, 12, true);
      const back = span(L, 7.4, 7.75);
      if (L < 7.4) at(this.lid, cx + u * 150, cy - Math.sin(Math.min(1, u * 1.6) * Math.PI * 0.5) * 240 + u * u * 10);
      else at(this.lid, cx, lerp(cy - 150, cy + 1, easeInCubic(back)));
      this.lid.visible = lidOff && (L < 2.2 || L >= 7.4);
    }

    // ---- sewer glow: a gold flicker when the coin drops, green light once the lid is off
    const g = L < 0 ? 0.25 : L < 1 ? 0.35 + 0.25 * Math.abs(Math.sin(L * 20)) : L < 7.75 ? 1 - 0.5 * span(L, 1.2, 3) : 0.3;
    this.glow.tint = L >= 0 && L < 0.6 ? 0xffd070 : GREEN;
    this.glow.alpha = g;
    this.glow.scale.set(L >= 1 && L < 1.6 ? 1.3 : 1);
    at(this.glow, cx, cy - 4);

    // ---- steam: a burst when the lid goes, wisps the rest of the time
    const burst = L >= 1 && L < 2.6;
    this.puffBack.visible = burst || (L >= 8 && L < 10.8);
    if (burst) {
      this.puffBack.texture = frameAt(this.f.puff, L, 1, 5.5);
      at(this.puffBack, cx, cy - 34);
    }
    this.wisps.forEach((s, k) => {
      const period = 1.6;
      const ph = (((L + k * 0.37) % period) + period) % period;
      const side = k % 2 ? 1 : -1;
      s.visible = L < 8 || L > 11;
      const ox = side * (8 + (k * 7) % 14) + Math.round(noise(k, 3) * 3);
      at(s, cx + ox + ph * side * 3, cy + 2 - ph * 16);
      s.alpha = 0.55 * (1 - ph / period);
    });

    // ---- the rat
    const rat = this.rat;
    rat.visible = L >= 1.35;
    rat.mask = null;
    const standX = cx + 34 - 64;
    const standY = cy + 16 - 122;
    if (L < 6.5) {
      // in the hole: rises with the burst, arms up on beat 3, looks around
      const up = easeOutBack(span(L, 1.35, 2.5));
      const y = lerp(cy + 20 - 30, cy + 20 - 87, up);
      let t: Texture;
      if (L < 2.5) t = this.f.burst[Math.min(2, Math.floor(span(L, 1.35, 2.5) * 3))]!;
      else if (L < 4) t = this.f.burst[Math.min(8, 3 + Math.floor(span(L, 2.5, 3) * 4))]!;
      else if (L < 6) t = frameAt(this.f.look, L, 4, 4.5);
      else t = this.f.burst[1]!;
      rat.texture = t;
      const squash = L >= 3 && L < 3.12 ? 2 : L >= 6.1 ? 2 : 0;
      at(rat, cx - 64, y + squash);
      rat.mask = this.mask;
    } else if (L < 7.35) {
      // hops out of the hole to stand beside it
      const u = span(L, 6.5, 7.35);
      const x = lerp(cx - 64, standX, u);
      const y = lerp(cy + 20 - 87, standY, u) - Math.sin(u * Math.PI) * 26;
      rat.texture = this.f.scruffy[1]!;
      at(rat, x, y);
      if (u < 0.35) rat.mask = this.mask;
    } else if (L < 8.25) {
      rat.texture = tex('scruffy_s');
      at(rat, standX, standY + (L < 7.5 ? 2 : 0));
    } else if (L < 10) {
      // spins inside the smoke, faster and faster; the suit swaps in at the brightest flash
      const u = span(L, 8.25, 10);
      const turns = 3 * u * u + 0.5 * u;
      const k = Math.floor(turns * 8) % 8;
      rat.texture = (L < 9.25 ? this.f.scruffy : this.f.suited)[k]!;
      at(rat, standX, standY - Math.round(Math.sin(u * Math.PI) * 8));
    } else if (L < 12.25) {
      rat.texture = L < 10.5 ? tex('suited_s') : frameAt(this.f.tie, L, 10.5, 6);
      at(rat, standX, standY + (L < 10.12 ? 2 : 0));
    } else {
      // walks off to work
      rat.texture = frameAt(this.f.walk, L, 12.25, 6, true);
      at(rat, standX + (L - 12.25) * 38, standY);
    }
    if (L >= 8 && L < 10.8) {
      this.puffBack.texture = frameAt(this.f.puff, L, 8, 3.2);
      at(this.puffBack, standX + 64, standY + 80);
    }

    // ---- gold sparks: the fee going in, the burst, the suit landing
    this.sparks.forEach((s, k) => {
      const origin = L < 2 ? 0 : L < 6 ? 2.5 : 10;
      const ph = L - origin - k * 0.08;
      s.visible = ph > 0 && ph < 1.4 && (L < 6 || (L >= 10 && L < 12));
      const ang = (k / 8) * Math.PI * 2 + origin;
      const r = 6 + ph * 22;
      const ox = L >= 10 ? standX + 64 : cx;
      const oy = L >= 10 ? standY + 60 : L < 2 ? cy : cy - 40;
      at(s, ox + Math.cos(ang) * r, oy + Math.sin(ang) * r * 0.6 - ph * 10);
    });

    // ---- flashes: the blast, the suit swap, the landing
    const fl = (b: number, a: number, len: number): number => (L >= b && L < b + len ? a * (1 - (L - b) / len) : 0);
    this.flash.alpha = Math.max(fl(1, 0.55, 0.12), fl(9.25, 0.4, 0.1), fl(10, 0.6, 0.14));
    this.flash.tint = 0xffffff;
  }
}
