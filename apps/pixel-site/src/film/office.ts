// Shots 3 and 4 on one set: the hero walks in, sits, cracks its knuckles and types; its stock coin (NVDAx) drops
// onto its head. Then the team: a rat drops into every chair on the beat, faster and faster, each with its own
// stock, and the camera snaps out a step on the landings. A pure function of the beat.
import { Container, Sprite, Texture } from 'pixi.js';
import { HeroStage, at, frameAt, type View } from './stage';
import { anim, has, META, sprite, tex, textTexture, GOLD } from './pixel';
import { easeInCubic, easeInOutCubic, easeOutBack, lerp, span } from './timeline';
import type { Atlas } from '../gfx/atlas';

interface Seat {
  x: number;
  /** desk bottom (floor line) */
  y: number;
  /** beat the rat lands (hero: sits) */
  land: number;
  stock: string;
  variant: number; // -1: the hero
  rat: Sprite;
  chair: Sprite;
  desk: Sprite;
  coin: Sprite;
  tag: Sprite;
  glow: Sprite;
}

const DESK_TOP = 56; // desk sprite: its top surface
const WAIST = 87; // rat sprite: the waist line (128 px canvas)
const FEET = 122;

export class OfficeScene {
  readonly stage: HeroStage;
  private seats: Seat[] = [];
  private ticker: Sprite;
  private tickerW: number;
  private readonly f = {
    walk: has('walk_e_0') ? anim('walk_e') : [tex('rot_suited_2')],
    crack: anim('crack'),
    type: anim('type'),
    coin: anim('coin_spin'),
    east: tex('rot_suited_2'),
    south: tex('suited_s'),
  };

  constructor(readonly view: View, _atlas: Atlas) {
    this.stage = new HeroStage(view);
    const w = this.stage.world;
    w.addChild(sprite(tex('office_plate')));
    // the ticker board: the stocks the rats hold, scrolling
    const tickTex = textTexture(['NVDAx   AAPLx   TSLAx   AMZNx   METAx   MSFTx   GOOGLx   '], { fill: GOLD, outline: null }, 0, 'left');
    this.tickerW = tickTex.width - 5;
    const band = new Container();
    const mask = new Sprite(Texture.WHITE);
    mask.width = META.office.w;
    mask.height = 16;
    mask.position.set(0, 5);
    band.addChild(mask);
    this.ticker = new Sprite(tickTex);
    const t2 = new Sprite(tickTex);
    this.ticker.addChild(t2);
    t2.x = this.tickerW;
    const t3 = new Sprite(tickTex);
    this.ticker.addChild(t3);
    t3.x = this.tickerW * 2;
    band.addChild(this.ticker);
    this.ticker.mask = mask;
    w.addChild(band);

    // two rows of desks; the hero sits front and centre
    const layout: [number, number, number, string, number][] = [
      // x, desk bottom, landing beat, stock, variant
      [165, 368, 26, 'MSFTx', 3],
      [295, 368, 24, 'AMZNx', 2],
      [425, 368, 25, 'METAx', 4],
      [555, 368, 26.5, 'GOOGLx', 5],
      [40, 448, 27, 'COINx', 6],
      [230, 448, 20, 'AAPLx', 0],
      [360, 448, 14, 'NVDAx', -1],
      [490, 448, 22, 'TSLAx', 1],
      [680, 448, 27, 'SPYx', 7],
    ];
    for (const [x, y, land, stock, variant] of layout) {
      const chair = sprite(tex('chair'), 0.5, 1);
      const rat = sprite(variant < 0 ? this.f.south : tex(`type_v${variant}_0`), 0, 0);
      const desk = sprite(tex('desk'), 0.5, 1);
      const glow = sprite(tex('glow'), 0.5, 0.5);
      glow.tint = 0x78c8ff;
      glow.blendMode = 'add';
      glow.scale.set(0.5);
      const coin = sprite(this.f.coin[0]!, 0.5, 1);
      const tag = sprite(textTexture([stock], { fill: GOLD }), 0.5, 1);
      w.addChild(chair, rat, desk, glow, coin, tag);
      at(chair, x, y - 10);
      at(desk, x, y);
      this.seats.push({ x, y, land, stock, variant, rat, chair, desk, coin, tag, glow });
    }
  }

  get root(): Container {
    return this.stage.root;
  }

  frame(b: number, frame: number): void {
    const st = this.stage;
    const tall = this.view.tall;
    // ---- camera: track the hero in, hold on it typing, then snap out a step on each landing
    const steps = tall ? [8, 6, 4, 3, 2] : [8, 6, 5, 4, 3];
    const k = b < 20 ? 0 : b < 22 ? 1 : b < 24 ? 2 : b < 27 ? 3 : 4;
    st.S = steps[k]!;
    const walkIn = easeInOutCubic(span(b, 12, 14.2));
    const hero = this.seats.find((s) => s.variant < 0)!;
    const cyHero = hero.y - 55;
    if (b < 20) {
      st.camX = lerp(hero.x - 70, hero.x, walkIn);
      st.camY = cyHero + (tall ? 0 : 4);
    } else {
      st.camX = tall ? 360 : 360;
      st.camY = [cyHero, cyHero - 14, cyHero - 22, cyHero - 30, cyHero - 36][k]! + (tall ? 20 : 0);
    }
    const landHit = [20, 22, 24, 25, 26, 26.5, 27].find((x) => b >= x && b < x + 0.3);
    st.shakeAmp = landHit !== undefined ? 6 * (1 - (b - landHit) / 0.3) : b >= 18 && b < 18.25 ? 4 : 0;
    st.apply(frame);
    this.ticker.x = -Math.round(((b * 10) % this.tickerW + this.tickerW) % this.tickerW);

    for (const s of this.seats) {
      const seatedY = s.y - 10 - DESK_TOP + 2 - WAIST + (s.y - s.y); // waist on the desk top
      const deskTop = s.y - META.desk.h + DESK_TOP;
      const sitY = deskTop - WAIST + 4;
      void seatedY;
      if (s.variant < 0) this.hero(s, b, sitY);
      else this.teammate(s, b, sitY);
    }
  }

  private hero(s: Seat, b: number, sitY: number): void {
    const r = s.rat;
    r.visible = b >= 12;
    const standY = s.y - 12 - FEET;
    if (b < 14) {
      // walks in from the left behind the desks
      r.texture = frameAt(this.f.walk, b, 12, 6, true);
      at(r, lerp(s.x - 64 - 150, s.x - 64, span(b, 12, 14)), standY);
    } else if (b < 14.5) {
      // turns to the camera and sits
      const u = span(b, 14.1, 14.4);
      r.texture = b < 14.1 ? this.f.east : this.f.south;
      at(r, s.x - 64, lerp(standY, sitY + 2, easeInCubic(u)));
    } else if (b < 16) {
      r.texture = b < 15 ? this.f.south : frameAt(this.f.crack, b, 15, 8);
      at(r, s.x - 64, sitY + (b < 14.6 ? 2 : 0));
    } else {
      r.texture = frameAt(this.f.type, b, 16, 6, true);
      at(r, s.x - 64, sitY);
    }
    s.glow.visible = b >= 14.5;
    s.glow.alpha = 0.45 + 0.15 * Math.sin(b * 9);
    at(s.glow, s.x, s.y - META.desk.h + 44);
    this.coinDrop(s, b, 17, 18);
  }

  private teammate(s: Seat, b: number, sitY: number): void {
    const r = s.rat;
    r.visible = b >= s.land - 0.5;
    if (!r.visible) {
      s.coin.visible = s.tag.visible = s.glow.visible = false;
      return;
    }
    if (b < s.land) {
      // drops in from above straight into the chair
      const u = easeInCubic(span(b, s.land - 0.5, s.land));
      r.texture = tex(`type_v${s.variant}_0`);
      at(r, s.x - 64, lerp(sitY - 190, sitY, u));
    } else {
      r.texture = tex(`type_v${s.variant}_${Math.floor((b - s.land) * 6 + s.variant * 3) % 9}`);
      at(r, s.x - 64, sitY + (b < s.land + 0.08 ? 3 : 0));
    }
    s.glow.visible = b >= s.land;
    s.glow.alpha = 0.4 + 0.15 * Math.sin(b * 9 + s.variant);
    at(s.glow, s.x, s.y - META.desk.h + 44);
    this.coinDrop(s, b, s.land + 0.25, s.land + 0.75);
  }

  /** The stock coin: spins down onto the rat's head, bounces, the ticker tag pops under it. */
  private coinDrop(s: Seat, b: number, from: number, land: number): void {
    const headY = s.y - META.desk.h + DESK_TOP - 52;
    s.coin.visible = b >= from;
    s.tag.visible = b >= land;
    if (!s.coin.visible) return;
    const u = span(b, from, land);
    const bounce = b >= land ? Math.max(0, Math.sin(span(b, land, land + 0.35) * Math.PI)) * 6 : 0;
    const bob = b > land + 0.35 ? Math.round(Math.sin((b - land) * 3) * 1.5) : 0;
    s.coin.texture = frameAt(this.f.coin, b, from, 9, true);
    at(s.coin, s.x, lerp(headY - 160, headY, easeOutBack(u) > 1 ? 1 : u * u) - bounce + bob);
    const pop = b < land + 0.1 ? 2 : 1;
    s.tag.scale.set(pop === 2 ? 1 : 1);
    at(s.tag, s.x, headY - 30 + bob);
  }
}
