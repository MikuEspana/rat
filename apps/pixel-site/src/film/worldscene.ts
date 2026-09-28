// Shots 5 to 7 in the real game world (the same renderer as the site): the Vault bursts open and bills pour in,
// BOOM into the corporate floor, BOOM into Wall Street, then a cursor clicks one rat and its card opens.
//
// The world is a simulation (rats walk, bills fly), so this scene steps through time in order from a fixed start
// (1 s before shot 5) with a seeded clock: the same frame gives the same picture, alone or inside the film.
import { CanvasSource, Container, Sprite, Texture } from 'pixi.js';
import type { RatsResponse, StateResponse } from '@rat/contract';
import stateJson from '../../../../packages/contract/mock/state.json';
import ratsJson from '../../../../packages/contract/mock/rats.json';
import { Store, type RatRecord } from '../data/store';
import { padRoster } from '../data/stress';
import { Growth } from '../floor/growth';
import { buildMaster } from '../floor/plan';
import { unlocked } from '../floor/landmarks';
import { cellCentre } from '../iso';
import { Sky } from '../gfx/sky';
import type { Atlas } from '../gfx/atlas';
import { buildWorld, type World } from '../world/build';
import { Effects } from '../world/effects';
import { VaultView } from '../world/vault';
import { SewerView } from '../world/sewer';
import { RatSystem } from '../world/rats';
import { reseed, setFilmTime } from './clock';
import { anim, sprite, tex, textTexture, CREAM, GOLD, GREEN, INK } from './pixel';
import type { View } from './stage';
import { BEAT, FPS, HANDLE, easeInCubic, easeInOutCubic, easeOutBack, easeOutCubic, frameOf, lerp, noise, span } from './timeline';

export const WORLD_B0 = 28 - HANDLE;
const N_FUND = 90;
const N_CORP = 700;
const N_WALL = 2600; // megacorp: the grandest look that is not the red last stage; the banner calls it Wall Street

interface Cam {
  x: number;
  y: number;
  z: number;
}

export class WorldScene {
  readonly root = new Container();
  private sky = new Sky();
  private stageRoot = new Container();
  private store = new Store();
  private plan = buildMaster();
  private growth!: Growth;
  private world!: World;
  private rats!: RatSystem;
  private effects = new Effects();
  private vault!: VaultView;
  private sewer!: SewerView;
  private recs: RatRecord[] = [];
  private everyone: RatRecord[] = [];
  private cur = -1e9; // frame the simulation is at
  private fired = new Set<string>();
  private n = 0;
  // film overlays
  private fx = new Container(); // world space, above the world
  private ui = new Container(); // screen space
  private open = sprite(tex('vault_open_0'), 0.5, 1);
  private booms: { s: Sprite; b0: number }[] = [];
  private scaffolds: { s: Sprite; b0: number; x: number; y: number }[] = [];
  private counter = new Sprite(Texture.EMPTY);
  private counterLabel: Sprite;
  private banner = new Container();
  private bannerTitle = new Sprite(Texture.EMPTY);
  private bannerKicker: Sprite;
  private card = new Container();
  private cursor: Sprite;
  private ring: Sprite;
  private marker: Sprite;
  private button: Sprite;
  private buttonHi: Sprite;
  private target: number | null = null;
  private lastCount = '';

  constructor(readonly view: View, private atlas: Atlas, private showText: boolean) {
    this.sky.resize(view.w, view.h);
    this.root.addChild(this.sky.sprite, this.stageRoot, this.ui);
    const state = stateJson as unknown as StateResponse;
    this.store.initState(state);
    this.store.loadRoster(padRoster(ratsJson as unknown as RatsResponse, state, N_WALL + 200));
    this.everyone = [...this.store.rats.values()].sort((a, b) => a.facts.id - b.facts.id);
    this.vault = new VaultView(atlas, null as never);
    this.sewer = new SewerView(atlas);
    this.open.visible = false;
    // the counter and the stage banner (captions layer: off with text=0)
    this.counterLabel = sprite(textTexture(["THE RATS' FUND"], { fill: GOLD }), 0.5, 0.5);
    this.counter.anchor.set(0.5);
    this.bannerKicker = sprite(textTexture(['STAGE UNLOCKED'], { fill: GOLD, outline: null }), 0.5, 0.5);
    this.bannerTitle.anchor.set(0.5);
    this.banner.addChild(this.bannerKicker, this.bannerTitle);
    this.ui.addChild(this.counterLabel, this.counter, this.banner);
    // the proof: cursor, click ring, marker and the rat card
    this.cursor = sprite(cursorTexture(false), 0, 0);
    this.ring = sprite(tex('glow'), 0.5, 0.5);
    this.ring.tint = 0xf2c14e;
    this.ring.blendMode = 'add';
    this.marker = sprite(textTexture(['V'], { fill: GOLD }), 0.5, 1);
    this.button = sprite(buttonTexture(false), 0, 0);
    this.buttonHi = sprite(buttonTexture(true), 0, 0);
    this.ui.addChild(this.card, this.ring, this.cursor);
    this.reset();
  }

  // ---------------------------------------------------------------- building the company at n rats
  private build(n: number, announce: boolean): void {
    const before = this.growth ? new Set(this.plan.rooms.filter((r) => this.growth.isBuilt(r)).map((r) => r.id)) : new Set<number>();
    const landmarksBefore = unlocked(this.n);
    const old = this.world;
    this.n = n;
    this.growth = new Growth(this.plan);
    this.recs = this.everyone.slice(0, n);
    for (const r of this.recs) this.growth.add(r.facts.id, r.facts.stock);
    const popIn = announce ? new Set(this.plan.rooms.filter((r) => this.growth.isBuilt(r) && !before.has(r.id)).map((r) => r.id)) : new Set<number>();
    const fresh = announce ? new Set([...unlocked(n)].filter((id) => !landmarksBefore.has(id))) : new Set<string>();
    if (announce && old) {
      const r = this.plan.rings[this.growth.stage]!;
      this.effects.demolish(old.cityParts(r.i0 - 2, r.j0 - 2, r.i1 + 2, r.j1 + 2));
    }
    this.world = buildWorld(this.plan, this.growth, this.atlas, this.store.stocks, popIn.size < 80 ? popIn : new Set(), fresh);
    this.rats = new RatSystem(this.atlas, this.plan, this.growth, this.world.main, this.world.blocked, this.world.line);
    this.rats.onChair = (seatId, visible) => this.world.setChair(seatId, visible);
    for (const s of this.store.stocks.keys()) this.rats.setMood(s, 'flat');
    this.rats.load(this.recs);
    this.vault.setAnchor(this.world.vault);
    this.sewer.attach(this.world.main, this.world.sewer, this.world.sewerDoor);
    this.sky.setEvil(false);
    this.stageRoot.removeChildren();
    this.stageRoot.addChild(this.world.backdrop, this.world.floor, this.sewer.flat, this.world.under, this.world.main.container, this.world.overlay,
      this.world.lights, this.effects.container, this.vault.fx, this.sewer.fx, this.fx);
    old?.destroy();
    if (announce) {
      for (const id of [...popIn].slice(0, 24)) {
        const r = this.plan.rooms[id]!;
        const c = cellCentre(r.i0 + r.w / 2 - 0.5, r.j0 + r.h / 2 - 0.5);
        this.effects.dust(c.x, c.y, 20);
      }
    }
  }

  private reset(): void {
    reseed(90210);
    this.fired.clear();
    this.effects = new Effects();
    this.vault = new VaultView(this.atlas, null as never);
    this.sewer = new SewerView(this.atlas);
    this.growth = undefined as never;
    this.world?.destroy();
    this.world = undefined as never;
    this.n = 0;
    this.build(N_FUND, false);
    this.vault.set(60_000, 4, false);
    this.fx.removeChildren();
    this.fx.addChild(this.open);
    this.booms = [];
    this.scaffolds = [];
    this.cur = frameOf(WORLD_B0);
    this.target = null;
  }

  private once(key: string, b: number, at: number, fn: () => void): void {
    if (b >= at && !this.fired.has(key)) {
      this.fired.add(key);
      fn();
    }
  }

  /** Where a stage's ring sits in the world, and the zoom that fits it in the frame. */
  private ringFrame(stage: number, fill: number): Cam {
    const r = this.plan.rings[stage]!;
    const pts = [cellCentre(r.i0, r.j0), cellCentre(r.i1, r.j0), cellCentre(r.i0, r.j1), cellCentre(r.i1, r.j1)];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs) + 160;
    const h = Math.max(...ys) - Math.min(...ys) + 220;
    // vertical frames crop the sides: the building fills the height, not the width
    const z = this.view.tall ? (this.view.h * 0.62 * fill) / h : Math.min((this.view.w * fill) / w, (this.view.h * fill) / h);
    return { x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2 - 40, z };
  }

  // ---------------------------------------------------------------- one simulation step (1/60 s)
  private step(frame: number): void {
    const b = frame / FPS / BEAT;
    const dt = 1 / FPS;
    // each step has its own clock and random stream, so a frame is the same whether the scene caught up to it in
    // one go (a shot rendered alone) or stepped there frame by frame (the whole film)
    setFilmTime((frame / FPS) * 1000);
    reseed(frame * 7919 + 13);
    // the Vault door bursts open, bills pour in from every desk
    this.once('open', b, 31.5, () => {
      const p = this.world.vault.item.p;
      this.open.visible = true;
      this.open.position.set(Math.round(p.x), Math.round(p.y));
      this.open.scale.set(1.1);
    });
    this.once('bin', b, 33, () => {
      this.open.visible = false;
      this.vault.set(600_000, 12, true);
      const f = this.vault.focus();
      this.effects.dust(f.x, f.y + f.h / 2 - 60, 30);
    });
    if (b >= 32 && b < 40 && frame % 4 === 0) this.billFromDesk(frame);
    if (b >= 34 && b < 40 && frame % 14 === 0) this.rats.addApplicants(3, true);
    // BOOM: the corporate floor
    this.once('boom1', b, 40, () => this.boom(N_CORP, b));
    if (b >= 41 && b < 48 && frame % 5 === 0) this.billFromDesk(frame);
    if (b >= 42 && b < 47.5 && frame % 10 === 0) this.rats.addApplicants(4, true);
    // BOOM: Wall Street
    this.once('boom2', b, 48, () => this.boom(N_WALL, b));
    if (b >= 49 && b < 54 && frame % 6 === 0) this.billFromDesk(frame);
    this.once('pick', b, 55, () => this.pickRat());
    this.rats.update(dt);
    this.world.update(dt);
    this.effects.update(dt);
    this.vault.update(dt);
    this.sewer.update(dt);
    if (!this.open.visible && b >= 31.5 && b < 33) this.open.visible = true;
  }

  private billFromDesk(frame: number): void {
    const r = this.recs[(frame * 7919) % this.recs.length];
    const p = r ? this.rats.positionOf(r.facts.id) : null;
    if (p) this.vault.hire({ x: p.x, y: p.y - 20 }, r!.facts.costUsd, 2);
  }

  private boom(n: number, b: number): void {
    this.build(n, true);
    const ring = this.plan.rings[this.growth.stage]!;
    const corners = [cellCentre(ring.i0, ring.j0), cellCentre(ring.i1, ring.j0), cellCentre(ring.i0, ring.j1), cellCentre(ring.i1, ring.j1)];
    const mids = corners.map((c, k) => {
      const d = corners[(k + 1) % 4]!;
      return { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
    });
    for (const [k, c] of [...corners, ...mids].entries()) {
      const s = sprite(tex('boom_0'), 0.5, 0.85);
      s.position.set(Math.round(c.x), Math.round(c.y));
      s.scale.set(n > 1000 ? 2 : 1.5);
      this.fx.addChild(s);
      this.booms.push({ s, b0: b + k * 0.06 });
    }
    // scaffolding slams up round the new ring, then the crews take it down
    const scaf = this.atlas.has('world:scaffold') ? this.atlas.frame('world:scaffold').texture : null;
    if (scaf) {
      for (const [k, c] of mids.entries()) {
        for (let m = -1; m <= 1; m++) {
          const s = new Sprite(scaf);
          s.anchor.set(0.5, 1);
          this.fx.addChild(s);
          this.scaffolds.push({ s, b0: b + 0.25 + k * 0.1 + (m + 1) * 0.05, x: c.x + m * 70, y: c.y + m * 35 });
        }
      }
    }
  }

  /** The proof rat: a seated rat near the Vault. */
  private pickRat(): void {
    const v = this.vault.focus();
    let best: { id: number; d: number } | null = null;
    for (const r of this.recs) {
      const p = this.rats.positionOf(r.facts.id);
      if (!p) continue;
      const d = Math.hypot(p.x - (v.x + 180), p.y - (v.y + 120));
      if (!best || d < best.d) best = { id: r.facts.id, d };
    }
    this.target = best?.id ?? null;
    const rec = this.recs.find((r) => r.facts.id === this.target);
    this.makeCard(rec ?? null);
  }

  private makeCard(rec: RatRecord | null): void {
    this.card.removeChildren();
    const stock = rec?.facts.stock ?? 'NVDAx';
    const k = this.view.tall ? 5 : 4;
    const lines: [string, string, number][] = [
      ['RAT #0427', CREAM, 1.4],
      [`HOLDS ${stock}`, GOLD, 1],
      [`0.0275 SHARES   $5.04`, GREEN, 0.75],
      ['WALLET 7RAT...0427', '#9aa4cc', 0.75],
    ];
    const bg = new Sprite(Texture.WHITE);
    const border = new Sprite(Texture.WHITE);
    const inner = new Container();
    let y = 10;
    let w = 0;
    for (const [t, fill, sc] of lines) {
      const s = sprite(textTexture([t], { fill, outline: null }), 0, 0);
      const kk = Math.max(2, Math.round(k * sc));
      s.scale.set(kk);
      s.position.set(18, y);
      y += s.height + 10;
      w = Math.max(w, s.width + 36);
      inner.addChild(s);
    }
    this.button.scale.set(k - 1);
    this.buttonHi.scale.set(k - 1);
    this.button.position.set(18, y + 6);
    this.buttonHi.position.set(18, y + 6);
    y += this.button.height + 30;
    w = Math.max(w, this.button.width + 36);
    border.tint = 0xf2c14e;
    border.width = w + 8;
    border.height = y + 8;
    border.position.set(-4, -4);
    bg.tint = 0x121528;
    bg.width = w;
    bg.height = y;
    const shadow = new Sprite(Texture.WHITE);
    shadow.tint = 0x05060c;
    shadow.alpha = 0.6;
    shadow.width = w + 8;
    shadow.height = y + 8;
    shadow.position.set(4, 8);
    this.card.addChild(shadow, border, bg, inner, this.button, this.buttonHi, this.marker);
    this.card.visible = false;
  }

  // ---------------------------------------------------------------- the shot list: camera, overlays
  private camera(b: number): Cam {
    const v = this.vault.focus();
    const tall = this.view.tall;
    const zt = tall ? 0.62 : 1; // vertical frames are narrower: pull back a little
    const fund0: Cam = { x: v.x - 90, y: v.y + 70, z: 3.2 * zt };
    const fund1: Cam = { x: v.x, y: v.y - 10, z: 2 * zt };
    const fund2: Cam = { x: v.x, y: v.y + 10, z: 1.3 * zt };
    if (b < 28) return fund0;
    if (b < 31.5) return mix(fund0, fund1, easeInOutCubic(span(b, 28, 31.5)));
    if (b < 40) return mix(fund1, fund2, easeInOutCubic(span(b, 32, 40)));
    const corp = this.ringFrame(3, tall ? 1.05 : 0.9);
    if (b < 48) return mix(fund2, corp, easeOutCubic(span(b, 40, 42.5)));
    const wall = this.ringFrame(4, tall ? 1.0 : 0.95);
    const wallIn = { ...wall, z: wall.z * 1.12 };
    if (b < 56) return b < 52 ? mix(corp, wall, easeOutCubic(span(b, 48, 51))) : mix(wall, wallIn, easeInOutCubic(span(b, 52, 56)));
    // the proof: a slow push in to the picked rat
    const p = this.target !== null ? this.rats.positionOf(this.target) : null;
    const tgt: Cam = p ? { x: p.x + (tall ? 0 : 70), y: p.y - (tall ? -40 : 30), z: 3 * (tall ? 0.8 : 1) } : wallIn;
    return mix(wallIn, tgt, easeInOutCubic(span(b, 56, 59.5)));
  }

  /** Captions layer on or off (the counter and the stage banners), for the clean plates. */
  setText(on: boolean): void {
    this.showText = on;
    this.counter.visible = this.counterLabel.visible = on && this.counter.visible;
    this.banner.visible = on && this.banner.visible;
  }

  /** Render film beat b. Returns the white flash alpha. */
  frame(b: number, frame: number): number {
    if (frame < this.cur - 0 || this.cur < frameOf(WORLD_B0) - 1) this.reset();
    // every step sets the camera it would have had: the world culls by view, so the sequence of calls is the same
    // whether the scene steps here frame by frame or catches up in one go
    while (this.cur < frame) {
      this.step(++this.cur);
      this.applyView(this.cur / FPS / BEAT, this.cur);
    }
    const cam = this.applyView(b, frame);
    return this.overlays(b, frame, cam);
  }

  private applyView(b: number, frame: number): Cam {
    const cam = this.camera(b);
    const hit = (at: number, amp: number, dur: number): number => (b >= at && b < at + dur ? amp * (1 - (b - at) / dur) : 0);
    const shake = Math.max(hit(31.5, 6, 0.5), hit(40, 18, 0.9), hit(48, 24, 1.1), hit(33, 5, 0.4));
    const sx = shake ? Math.round(noise(frame, 5) * shake) : 0;
    const sy = shake ? Math.round(noise(frame, 6) * shake) : 0;
    const sr = this.stageRoot;
    sr.scale.set(cam.z);
    sr.position.set(Math.round(this.view.w / 2 - cam.x * cam.z) + sx, Math.round(this.view.h / 2 - cam.y * cam.z) + sy);
    const vw = this.view.w / cam.z;
    const vh = this.view.h / cam.z;
    this.world.main.setView(cam.x - vw / 2, cam.y - vh / 2, vw, vh);
    this.world.setZoom(cam.z);
    this.world.parallax(cam.x, cam.y);
    this.world.main.sync(); // depth sort and cull, once per frame (as the site does)
    return cam;
  }

  private overlays(b: number, frame: number, cam: Cam): number {
    this.world.signs.visible = false;
    this.vault.fx.visible = b < 56; // the proof shot stays clean: no bills or +$ labels over the Vault

    // the Vault door bursting open (frame by frame), BOOM clouds and scaffolding
    if (this.open.visible) this.open.texture = anim('vault_open')[Math.min(8, Math.floor(span(b, 31.5, 33) * 9))]!;
    const p = this.world.vault.item.p;
    if (b >= 31.5 && b < 33) p.scaleX = p.scaleY = 0.0001;
    for (const bm of this.booms) {
      const u = (b - bm.b0) / 1.6;
      bm.s.visible = u >= 0 && u < 1;
      if (bm.s.visible) bm.s.texture = anim('boom')[Math.min(8, Math.floor(u * 9))]!;
    }
    for (const sc of this.scaffolds) {
      const u = b - sc.b0;
      sc.s.visible = u >= 0 && u < 2.6;
      const drop = easeOutBack(span(u, 0, 0.3));
      sc.s.position.set(Math.round(sc.x), Math.round(lerp(sc.y - 300, sc.y, Math.min(1, drop))));
      sc.s.alpha = u > 2.2 ? 1 - (u - 2.2) / 0.4 : 1;
    }
    // Wall Street: the skyline lights up in waves
    const lit = b >= 48 ? easeOutCubic(span(b, 48.5, 52)) : 1;
    this.world.backdrop.children.forEach((c, k) => {
      const u = Math.min(1, Math.max(0, lit * 1.4 - k * 0.12));
      const v = Math.round(90 + 165 * u);
      (c as Sprite).tint = (v << 16) | (v << 8) | Math.min(255, v + 20);
    });

    // counter: the rats' fund races up while the bills pour in
    const showCounter = this.showText && b >= 32 && b < 40;
    this.counter.visible = this.counterLabel.visible = showCounter;
    if (showCounter) {
      const value = Math.round(1_284_907 * easeInCubic(span(b, 32, 39.5)));
      const txt = '$' + value.toLocaleString('en-US');
      if (txt !== this.lastCount) {
        if (this.lastCount) this.counter.texture.destroy(true);
        this.counter.texture = textTexture([txt], { fill: GREEN });
        this.lastCount = txt;
      }
      const k = this.view.tall ? 11 : 12;
      this.counter.scale.set(frame - frameOf(32) < 4 ? k + 2 : k);
      this.counterLabel.scale.set(this.view.tall ? 5 : 5);
      const top = this.view.tall ? 260 : 70;
      this.counterLabel.position.set(this.view.w / 2, top);
      this.counter.position.set(this.view.w / 2, top + 30 + (this.counter.texture.height * k) / 2);
    }
    // stage banners
    const bannerOn = (at: number): boolean => b >= at && b < at + 3;
    const title = bannerOn(40.5) ? 'CORPORATE FLOOR' : bannerOn(48.5) ? 'WALL STREET' : null;
    this.banner.visible = this.showText && title !== null;
    if (this.banner.visible && title) {
      if ((this.bannerTitle as Sprite & { key?: string }).key !== title) {
        this.bannerTitle.texture = textTexture([title], { fill: CREAM });
        (this.bannerTitle as Sprite & { key?: string }).key = title;
      }
      const at = title === 'WALL STREET' ? 48.5 : 40.5;
      const since = frame - frameOf(at);
      const k = this.view.tall ? (title === 'WALL STREET' ? 12 : 9) : title === 'WALL STREET' ? 14 : 11;
      this.bannerTitle.scale.set(since < 3 ? k + 2 : since < 6 ? k + 1 : k);
      this.bannerKicker.scale.set(4);
      const y = this.view.tall ? 360 : 170;
      this.bannerKicker.position.set(this.view.w / 2, y - 60);
      this.bannerTitle.position.set(this.view.w / 2, y + 20);
    }
    this.proof(b, frame, cam);
    const fl = (at: number, a: number, len: number): number => (b >= at && b < at + len ? a * (1 - (b - at) / len) : 0);
    return Math.max(fl(31.5, 0.35, 0.3), fl(33, 0.3, 0.25), fl(40, 0.95, 0.35), fl(48, 1, 0.45));
  }

  private proof(b: number, frame: number, cam: Cam): void {
    const on = b >= 56.8 && this.target !== null;
    this.cursor.visible = on;
    this.card.visible = on && b >= 58.5;
    this.ring.visible = on && b >= 58 && b < 58.6;
    if (!on) return;
    const p = this.rats.positionOf(this.target!)!;
    const sx = this.view.w / 2 + (p.x - cam.x) * cam.z;
    const sy = this.view.h / 2 + (p.y - 22 - cam.y) * cam.z;
    // the card opens beside the rat (below it on vertical), pops in two steps
    const tall = this.view.tall;
    const cardX = tall ? this.view.w / 2 - this.card.width / 2 : sx + 120;
    const cardY = tall ? sy - this.card.height - 260 : sy - this.card.height / 2 - 40;
    const pop = frame - frameOf(58.5);
    this.card.scale.set(pop < 2 ? 0.9 : pop < 4 ? 1.04 : 1);
    this.card.position.set(Math.round(cardX), Math.round(cardY));
    this.marker.scale.set(tall ? 6 : 5);
    this.marker.position.set(Math.round(sx - cardX), Math.round(sy - 70 - cardY + Math.sin(b * 6) * 6));
    // the cursor glides in, clicks the rat, then hovers the Solscan button
    const btn = { x: cardX + this.button.x + this.button.width * 0.7, y: cardY + this.button.y + this.button.height * 0.6 };
    const start = { x: this.view.w * 0.92, y: this.view.h * 0.95 };
    let c = start;
    if (b < 58) c = mixXY(start, { x: sx + 6, y: sy - 10 }, easeInOutCubic(span(b, 56.8, 58)));
    else if (b < 60) c = { x: sx + 6, y: sy - 10 };
    else c = mixXY({ x: sx + 6, y: sy - 10 }, btn, easeInOutCubic(span(b, 60, 61)));
    const down = (b >= 58 && b < 58.15) || (b >= 61.5 && b < 61.65);
    this.cursor.texture = cursorTexture(down);
    this.cursor.scale.set(tall ? 6 : 5);
    this.cursor.position.set(Math.round(c.x), Math.round(c.y));
    this.ring.position.set(Math.round(sx), Math.round(sy - 10));
    this.ring.scale.set(1 + span(b, 58, 58.6) * 3);
    this.ring.alpha = 1 - span(b, 58, 58.6);
    const hover = b >= 61;
    this.button.visible = !hover;
    this.buttonHi.visible = hover;
  }
}

function mix(a: Cam, c: Cam, u: number): Cam {
  // zoom eases in log space so the move feels even
  return { x: lerp(a.x, c.x, u), y: lerp(a.y, c.y, u), z: Math.exp(lerp(Math.log(a.z), Math.log(c.z), u)) };
}

function mixXY(a: { x: number; y: number }, c: { x: number; y: number }, u: number): { x: number; y: number } {
  return { x: lerp(a.x, c.x, u), y: lerp(a.y, c.y, u) };
}

const cursorCache = new Map<boolean, Texture>();
function cursorTexture(down: boolean): Texture {
  const hit = cursorCache.get(down);
  if (hit) return hit;
  const shape = ['#.........', '##........', '#o#.......', '#oo#......', '#ooo#.....', '#oooo#....', '#ooooo#...', '#oooooo#..', '#ooooooo#.',
    '#oooo#####', '#oo#o#....', '#o#.#o#...', '##..#o#...', '#....#o#..', '.....###..'];
  const c = document.createElement('canvas');
  c.width = 10;
  c.height = 15;
  const ctx = c.getContext('2d')!;
  shape.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '#') ctx.fillStyle = INK;
    else if (ch === 'o') ctx.fillStyle = down ? '#f2c14e' : '#ffffff';
    else return;
    ctx.fillRect(x, y + (down ? 1 : 0), 1, 1);
  }));
  const t = textureOf(c);
  cursorCache.set(down, t);
  return t;
}

function buttonTexture(hi: boolean): Texture {
  const label = textTexture(['VIEW ON SOLSCAN >'], { fill: hi ? '#121528' : GREEN, outline: null });
  const w = label.width + 10;
  const h = label.height + 6;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = GREEN;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = hi ? GREEN : '#121528';
  ctx.fillRect(1, 1, w - 2, h - 2);
  ctx.drawImage((label.source.resource as HTMLCanvasElement), 5, 3);
  return textureOf(c);
}

function textureOf(c: HTMLCanvasElement): Texture {
  return new Texture({ source: new CanvasSource({ resource: c, scaleMode: 'nearest' }) });
}
