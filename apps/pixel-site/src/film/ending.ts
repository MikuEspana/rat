// Shot 8, two versions. Both end on a coin rolling out of frame; the film then cuts to the street, where it rolls
// into the manhole's slot: the first frame of shot 1, so the film loops.
//
//   VaultEnd (the main ending): pull back to reveal the Vault as a cathedral of money with rats at work on it,
//   push in to its door, cut close: the logo slams onto the door while the hero straightens its tie in front.
//   PileEnd (the alternative): rats rain down and pile up, the logo lands on the pile, the hero lands on top.
import { Container, Sprite, type Texture } from 'pixi.js';
import type { Atlas } from '../gfx/atlas';
import { HeroStage, at, frameAt, type View } from './stage';
import { anim, META, sprite, tex } from './pixel';
import { easeInCubic, easeInOutCubic, easeOutBack, easeOutCubic, lerp, noise, span } from './timeline';

const TIERS = ['analyst', 'associate', 'vp', 'intern', 'partner'];

/** A walker patrolling a short line (world-scale game rat), a pure function of the beat. */
interface Patrol {
  s: Sprite;
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  speed: number;
  frames: Texture[];
  phase: number;
  bill: Sprite | null;
}

export class VaultEnd {
  readonly root = new Container();
  // the reveal: world scale, a free (eased) zoom
  private wide = new Container();
  private patrols: Patrol[] = [];
  private flying: { s: Sprite; k: number; side: number }[] = [];
  // the close-up: hero scale
  private close: HeroStage;
  private plaque = sprite(tex('logo_door'), 0.5, 0.5);
  private hero = sprite(tex('suited_s'), 0, 0);
  private coin = sprite(tex('coin_spin_0'), 0.5, 1);
  private sparks: Sprite[] = [];
  private dust: Sprite[] = [];
  private readonly tie = anim('tie');
  private readonly coinSpin = anim('coin_spin');

  constructor(readonly view: View, atlas: Atlas) {
    // ---- the wide set
    const E = META.end;
    this.wide.addChild(sprite(tex('end_bg')));
    const cat = sprite(tex('cathedral'), 0.5, 1);
    at(cat, E.w / 2, E.ground);
    this.wide.addChild(cat);
    const catX = E.w / 2 - E.cathedral[0] / 2;
    const catY = E.ground - E.cathedral[1];
    if (atlas.has('world:crane')) {
      const crane = new Sprite(atlas.frame('world:crane').texture);
      crane.anchor.set(0.5, 1);
      at(crane, catX + E.cathedral[0] + 30, E.ground);
      this.wide.addChild(crane);
      const cash = new Sprite(atlas.frame('world:cash_pile').texture);
      cash.anchor.set(0.5, 0);
      at(cash, catX + E.cathedral[0] + 150, E.ground - crane.height + 70);
      this.wide.addChild(cash);
    }
    // rats at work on the roofs and on the plaza, carrying bills in
    const bill = atlas.frame('world:bill').texture;
    const spots: [number, number, number, number][] = [
      [120, 150, 30, 15], [170, 128, -26, 13], [250, 150, 28, -14], [290, 172, -24, -12], [90, 205, 26, 13], [205, 92, 20, -10],
      [320, 208, -22, 11], [62, 252, 24, -12], [150, 250, 30, 15], [230, 260, -28, 14],
    ];
    const street: [number, number, number, number][] = [
      [-230, 34, 120, 0], [-150, 40, -90, 0], [-60, 30, 110, 0], [40, 38, -120, 0], [130, 32, 100, 0], [220, 40, -110, 0], [-300, 36, 90, 0], [300, 30, -80, 0],
    ];
    const make = (x0: number, y0: number, dx: number, dy: number, k: number, carry: boolean): void => {
      const tier = TIERS[k % TIERS.length]!;
      const frames = atlas.anim(`${tier}/walk_se`).map((f) => f.texture);
      const s = new Sprite(frames[0]!);
      s.anchor.set(0.5, 1);
      this.wide.addChild(s);
      const b = carry ? new Sprite(bill) : null;
      if (b) {
        b.anchor.set(0.5, 1);
        this.wide.addChild(b);
      }
      this.patrols.push({ s, x0, y0, dx, dy, speed: 0.5 + (k % 3) * 0.12, frames, phase: k * 0.37, bill: b });
    };
    spots.forEach(([x, y, dx, dy], k) => make(catX + x, catY + y, dx, dy, k, k % 2 === 0));
    street.forEach(([x, y, dx, dy], k) => make(E.w / 2 + x, E.ground + y, dx, dy, k + 3, k % 3 !== 1));
    for (let k = 0; k < 16; k++) {
      const s = new Sprite(bill);
      s.anchor.set(0.5);
      this.wide.addChild(s);
      this.flying.push({ s, k, side: k % 2 ? 1 : -1 });
    }
    this.root.addChild(this.wide);

    // ---- the close-up
    this.close = new HeroStage(view);
    this.close.S = 4;
    const w = this.close.world;
    w.addChild(sprite(tex('front_plate')));
    w.addChild(this.plaque, this.hero, this.coin);
    for (let k = 0; k < 10; k++) this.sparks.push(w.addChild(sprite(tex('sparkle'), 0.5, 0.5)));
    for (let k = 0; k < 8; k++) {
      const d = sprite(tex('glow'), 0.5, 0.5);
      d.tint = 0xc8b8a0;
      d.scale.set(10 / 96);
      this.dust.push(w.addChild(d));
    }
    this.root.addChild(this.close.root);
  }

  /** Returns the white flash alpha. */
  frame(b: number, frame: number): number {
    const wideOn = b < 69;
    this.wide.visible = wideOn;
    this.close.root.visible = !wideOn;
    if (wideOn) this.frameWide(b);
    else this.frameClose(b, frame);
    return b >= 70 && b < 70.12 ? 0.35 : 0;
  }

  private frameWide(b: number): void {
    const E = META.end;
    const tall = this.view.tall;
    const catY = E.ground - E.cathedral[1];
    const start = { x: E.w / 2, y: catY + 130, z: tall ? 4 : 4 };
    const full = { x: E.w / 2, y: catY + (tall ? 150 : 175), z: tall ? 2.6 : 2 };
    const door = { x: E.w / 2 + 60, y: E.ground - 110, z: tall ? 4 : 3.4 };
    let c = start;
    if (b >= 64 && b < 67) c = mixCam(start, full, easeInOutCubic(span(b, 64, 67)));
    else if (b >= 67) c = mixCam(full, door, easeInCubic(span(b, 67, 69)));
    this.wide.scale.set(c.z);
    this.wide.position.set(Math.round(this.view.w / 2 - c.x * c.z), Math.round(this.view.h / 2 - c.y * c.z));
    for (const p of this.patrols) {
      const u = Math.sin((b * p.speed + p.phase) * Math.PI);
      const dir = Math.cos((b * p.speed + p.phase) * Math.PI) > 0 ? 1 : -1;
      p.s.texture = p.frames[Math.floor(b * 5 + p.phase * 8) % p.frames.length]!;
      p.s.scale.x = dir * (p.dx < 0 ? -1 : 1);
      at(p.s, p.x0 + (p.dx * u) / 2, p.y0 + (p.dy * u) / 2);
      if (p.bill) at(p.bill, p.s.x, p.s.y - 40);
    }
    for (const f of this.flying) {
      const t = ((b * 0.35 + f.k * 0.13) % 1 + 1) % 1;
      const x0 = E.w / 2 + f.side * (360 + (f.k % 4) * 40);
      const x1 = E.w / 2 + f.side * 30 + ((f.k * 13) % 40) - 20;
      const y0 = E.ground - 20;
      const y1 = catY + 90;
      at(f.s, lerp(x0, x1, t), lerp(y0, y1, t) - Math.sin(t * Math.PI) * 150);
      f.s.visible = t > 0.02 && t < 0.97;
    }
  }

  private frameClose(b: number, frame: number): void {
    const F = META.front;
    const st = this.close;
    const tall = this.view.tall;
    const [dx, dy] = F.door as [number, number];
    st.S = tall ? 4 : 4;
    st.camX = dx;
    st.camY = lerp(tall ? dy + 30 : dy + 50, tall ? dy + 22 : dy + 42, easeInOutCubic(span(b, 69, 74)));
    const hit = (at0: number, amp: number, dur: number): number => (b >= at0 && b < at0 + dur ? amp * (1 - (b - at0) / dur) : 0);
    st.shakeAmp = Math.max(hit(70, 16, 0.6), hit(69, 4, 0.2));
    st.apply(frame);
    // the logo slams onto the door on beat 70
    const drop = easeInCubic(span(b, 69.4, 70));
    const land = b >= 70 && b < 70.1 ? 2 : 0;
    this.plaque.visible = b >= 69.4;
    at(this.plaque, dx, lerp(dy - 260, dy + 4, drop) + land);
    // the hero in front of the door: stands, straightens its tie as the logo lands
    this.hero.texture = b < 70.1 ? tex('suited_s') : frameAt(this.tie, b, 70.1, 6);
    const breathe = b < 70 && Math.floor(b * 2) % 2 ? 1 : 0;
    at(this.hero, dx - 64, F.floor + 12 - 122 + breathe);
    // sparks off the plaque, a puff of dust at its edges
    this.sparks.forEach((s, k) => {
      const ph = b - 70 - k * 0.05;
      s.visible = ph > 0 && ph < 1.2;
      const ang = (k / 10) * Math.PI * 2;
      at(s, dx + Math.cos(ang) * (60 + ph * 50), dy + 4 + Math.sin(ang) * (22 + ph * 26));
    });
    this.dust.forEach((d, k) => {
      const ph = b - 70;
      d.visible = ph > 0 && ph < 0.9;
      d.alpha = 0.6 * (1 - ph / 0.9);
      const side = k % 2 ? 1 : -1;
      at(d, dx + side * (80 + ph * 30 + (k >> 1) * 6), dy - 20 + (k >> 1) * 14 - ph * 10);
    });
    // the loop: a coin rolls off the cash pile, down to the street and out of frame
    const [cx, cy] = F.cashRight as [number, number];
    this.coin.visible = b >= 72.5;
    if (this.coin.visible) {
      const u = span(b, 72.5, 74);
      const fall = span(u, 0, 0.35);
      const x = cx + u * 240;
      const y = u < 0.35 ? lerp(cy, F.floor + 16, easeInCubic(fall)) : F.floor + 16 - Math.abs(Math.sin((u - 0.35) * 12)) * 8 * (1 - u);
      this.coin.texture = frameAt(this.coinSpin, b, 72.5, 10, true);
      at(this.coin, x, y);
    }
  }
}

function mixCam(a: { x: number; y: number; z: number }, c: { x: number; y: number; z: number }, u: number): { x: number; y: number; z: number } {
  return { x: lerp(a.x, c.x, u), y: lerp(a.y, c.y, u), z: Math.exp(lerp(Math.log(a.z), Math.log(c.z), u)) };
}

// ---------------------------------------------------------------- the alternative: the pile
interface Faller {
  s: Sprite;
  x: number;
  y: number;
  land: number;
  frames: Texture[];
}

export class PileEnd {
  readonly root = new Container();
  private stage: HeroStage;
  private logo: Sprite;
  private fallers: Faller[] = [];
  private hero = sprite(tex('suited_s'), 0.5, 1);
  private coin = sprite(tex('coin_spin_0'), 0.5, 0.5);
  private sparks: Sprite[] = [];
  private readonly tie = anim('tie');
  private readonly coinSpin = anim('coin_spin');
  private logoTop: number;

  constructor(readonly view: View, _atlas: Atlas) {
    const tall = view.tall;
    this.stage = new HeroStage(view);
    this.stage.S = 3;
    const w = this.stage.world;
    const P = META.pile;
    w.addChild(sprite(tex('pile_bg')));
    this.logo = sprite(tex(tall ? 'logo_two' : 'logo_line'), 0.5, 1);
    const cx = P.w / 2;
    this.logoTop = tall ? 300 : 330;
    const bottom = this.logoTop + this.logo.height;
    // where every rat ends up: a mound under the letters, a few on top of them
    const spots: { x: number; y: number; stand: boolean }[] = [];
    const rows: [number, number, number][] = tall
      ? [[bottom + 62, 5, 150], [bottom + 96, 6, 165], [bottom + 132, 7, 175], [bottom + 170, 7, 180], [bottom + 210, 8, 185]]
      : [[bottom + 64, 8, 270], [bottom + 98, 9, 300], [bottom + 134, 10, 330]];
    for (const [yb, n, half] of rows) {
      for (let k = 0; k < n; k++) spots.push({ x: cx - half + ((2 * half) * (k + 0.5)) / n + (noise(k, yb) * 8), y: yb + noise(yb, k) * 5, stand: false });
    }
    spots.sort((a, b) => a.y - b.y);
    const onTop = tall ? [cx - 120, cx + 120] : [cx - 190, cx + 200];
    const n = spots.length;
    spots.forEach((p, i) => {
      const v = i % 12;
      const pose = [3, 4, 5, 6, 7, 8][(i * 5) % 6]!;
      const s = sprite(tex(`tumble_v${v}_${pose}`), 0.5, 1);
      if (i % 2) s.scale.x = -1;
      // they land from the back of the pile to the front, faster and faster
      const land = 64.4 + 3.5 * Math.sqrt(i / n);
      this.fallers.push({ s, x: p.x, y: p.y, land, frames: [3, 4, 5].map((f) => tex(`tumble_v${v}_${f}`)) });
    });
    w.addChild(this.logo);
    at(this.logo, cx, bottom);
    onTop.forEach((x, k) => {
      const s = sprite(tex(`rot_v${k + 2}_${k ? 7 : 1}`), 0.5, 1);
      this.fallers.push({ s, x, y: this.logoTop + 6, land: 68.6 + k * 0.25, frames: [tex(`tumble_v${k + 2}_3`)] });
    });
    // back of the pile first, then the front, so the pile paints in depth
    for (const f of [...this.fallers].sort((a, b) => a.y - b.y)) w.addChild(f.s);
    w.addChild(this.logo);
    for (const f of this.fallers.filter((x) => x.y <= this.logoTop + 6)) w.addChild(f.s);
    for (const f of this.fallers.filter((x) => x.y > bottom)) w.addChild(f.s);
    w.addChild(this.hero, this.coin);
    for (let k = 0; k < 10; k++) this.sparks.push(w.addChild(sprite(tex('sparkle'), 0.5, 0.5)));
    this.root.addChild(this.stage.root);
  }

  frame(b: number, frame: number): number {
    const P = META.pile;
    const st = this.stage;
    const tall = this.view.tall;
    const cx = P.w / 2;
    st.camX = cx;
    st.camY = lerp(tall ? 390 : 370, tall ? 380 : 360, easeInOutCubic(span(b, 64, 74)));
    const hit = (a: number, amp: number, dur: number): number => (b >= a && b < a + dur ? amp * (1 - (b - a) / dur) : 0);
    st.shakeAmp = Math.max(hit(68, 18, 0.7), hit(69.5, 6, 0.3));
    st.apply(frame);
    for (const f of this.fallers) {
      const u = span(b, f.land - 0.7, f.land);
      f.s.visible = b >= f.land - 0.7;
      if (b < f.land) {
        f.s.texture = f.frames[Math.floor(b * 10) % f.frames.length]!;
        at(f.s, f.x, lerp(f.y - 420, f.y, easeInCubic(u)));
      } else {
        at(f.s, f.x, f.y + (b < f.land + 0.08 ? 2 : 0));
      }
    }
    // the logo drops onto the pile on beat 68
    const bottom = this.logoTop + this.logo.height;
    this.logo.visible = b >= 67.5;
    at(this.logo, cx, lerp(bottom - 420, bottom, easeInCubic(span(b, 67.5, 68))) + (b >= 68 && b < 68.1 ? 3 : 0));
    // the hero drops on top, lands, straightens its tie
    this.hero.visible = b >= 68.9;
    const hu = span(b, 68.9, 69.5);
    this.hero.texture = b < 69.5 ? tex('tumble_3') : b < 70 ? tex('suited_s') : frameAt(this.tie, b, 70, 6);
    at(this.hero, cx, lerp(this.logoTop - 380, this.logoTop + 6 + 6, easeInCubic(hu)) + (b >= 69.5 && b < 69.6 ? 2 : 0));
    this.sparks.forEach((s, k) => {
      const ph = b - 68 - k * 0.04;
      s.visible = ph > 0 && ph < 1.3;
      const ang = (k / 10) * Math.PI * 2;
      at(s, cx + Math.cos(ang) * (150 + ph * 80), bottom - 24 + Math.sin(ang) * (30 + ph * 30));
    });
    // the loop: a coin flips off the pile and out of frame
    this.coin.visible = b >= 72.5;
    if (this.coin.visible) {
      const u = span(b, 72.5, 74);
      this.coin.texture = frameAt(this.coinSpin, b, 72.5, 12, true);
      at(this.coin, cx + 120 + u * 320, bottom + 30 - Math.sin(Math.min(1, u * 1.3) * Math.PI) * 120 + u * u * 160);
    }
    return b >= 68 && b < 68.1 ? 0.3 : 0;
  }
}

void easeOutBack;
void easeOutCubic;
