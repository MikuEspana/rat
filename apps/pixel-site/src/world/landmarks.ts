// Draws the landmark set pieces that are unlocked (floor/landmarks.ts): the interior ones in the space their room
// kept clear, the office tower (it rises a floor every 60 rats, with the glass elevator on its face and the helipad
// on its roof), the second tower with the pool party and a sky bridge, the basement gym, the rocket lot and the
// throne room's laser. Returns where each one is, for the camera, and their name signs.
import { Container, Sprite, Texture } from 'pixi.js';
import type { Atlas, Frame } from '../gfx/atlas';
import { makeParticle, type LayerItem, type SortedLayer } from '../gfx/layer';
import { cellCentre, cellToScreen } from '../iso';
import type { City } from '../floor/city';
import { LANDMARKS, TOWER_SLOT, towerFloors } from '../floor/landmarks';
import type { FloorLayout } from '../floor/types';
import type { Scene } from '../floor/scene';

export interface Focus {
  x: number;
  y: number;
  /** how tall the set piece is (world px) */
  h: number;
}

export interface LandmarkView {
  /** where each landmark stands (world px) and how tall it is, so the camera can frame it */
  focus: Map<string, Focus>;
  signs: Sprite[];
  /** the top of the office tower, where the company name goes (null before the tower) */
  crown: { x: number; y: number } | null;
  update(dt: number): void;
}

interface Opts {
  plan: FloorLayout;
  stage: number;
  count: number;
  built: (roomId: number) => boolean;
  city: City;
  atlas: Atlas;
  main: SortedLayer;
  lights: Container;
  signs: Container;
  fresh: ReadonlySet<string>;
  addPop: (item: LayerItem, delay: number) => void;
  posed: (look: string, anim: string, i: number, j: number, mirror: boolean, acc?: string, claimed?: boolean) => void;
  sign: (text: string, color: number) => Texture;
  /** what the zoning let stand (floor/scene.ts): landmarks in their slots, the kneelers, the annex's pylon */
  scene: Scene;
}

const TOWER_TINT = [0xffffff, 0xffffff, 0xd8e4ff, 0xffe2b0, 0xffd070, 0xff9a9a];

function redBeam(): Texture {
  const c = document.createElement('canvas');
  c.width = 24;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(24, 512);
  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 24; x++) {
      const across = Math.exp(-(((x - 11.5) / 4) ** 2));
      const k = (y * 24 + x) * 4;
      img.data[k] = 255;
      img.data[k + 1] = 40 + 120 * across * across;
      img.data[k + 2] = 60;
      img.data[k + 3] = Math.round(255 * across * (0.5 + 0.5 * (y / 511)));
    }
  }
  ctx.putImageData(img, 0, 0);
  return Texture.from(c);
}

let steamTex: Texture | null = null;
function steamTexture(): Texture {
  if (steamTex) return steamTex;
  const c = document.createElement('canvas');
  c.width = c.height = 12;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(240,244,255,0.9)';
  ctx.beginPath();
  ctx.arc(6, 6, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.beginPath();
  ctx.arc(5, 4.5, 2, 0, Math.PI * 2);
  ctx.fill();
  steamTex = Texture.from(c);
  steamTex.source.scaleMode = 'nearest';
  return steamTex;
}

export function renderLandmarks(o: Opts): LandmarkView {
  const { plan, stage, count, atlas, main } = o;
  const has = (k: string): boolean => atlas.has(`world:${k}`);
  const on = (id: string): boolean => count >= (LANDMARKS.find((l) => l.id === id)?.at ?? Infinity);
  const focus = new Map<string, Focus>();
  const signs: Sprite[] = [];
  let delay = 0;
  let crown: { x: number; y: number } | null = null;
  const steam: Array<{ x: number; y: number; t: number }> = [];
  const put = (kind: string, x: number, y: number, depth: number, scale = 1, mirror = false, tint = 0xffffff, id = ''): LayerItem | null => {
    if (!has(kind)) return null;
    const p = makeParticle(atlas.frame(`world:${kind}`), x, y, mirror, scale);
    p.tint = tint;
    const item = main.add(p, depth);
    if (id && o.fresh.has(id)) o.addPop(item, (delay += 0.06));
    return item;
  };
  const label = (id: string, x: number, y: number): void => {
    const def = LANDMARKS.find((l) => l.id === id)!;
    const s = new Sprite(o.sign(def.name, 0xffd23f));
    s.anchor.set(0.5, 1);
    s.position.set(x, y);
    o.signs.addChild(s);
    signs.push(s);
    if (!focus.has(id)) focus.set(id, { x, y: y + 50, h: 150 });
  };
  const fit = (kind: string, cells: number): number => (has(kind) ? (cells * 32) / atlas.frame(`world:${kind}`).w : 1);

  // interior set pieces, in the space their room kept clear
  for (const [id, sp] of Object.entries(plan.landmarkSpots)) {
    if (id === 'elevator' || id === 'pool' || id === 'gym') continue; // the towers and the gym are drawn below
    if (!on(id) || !o.built(sp.room) || !o.scene.standing.has(id)) continue;
    const ci = sp.i0 + sp.w / 2 - 0.5;
    const cj = sp.j0 + sp.h / 2 - 0.5;
    const c = cellCentre(ci, cj);
    const d = ci + cj + 1;
    let top = c.y - 70; // where the name sign goes
    if (id === 'espresso') {
      // a giant espresso machine with the garage's back corner to itself, steam puffing from its top, and rats
      // kneeling round it in worship (only on free floor)
      const kind = has('espresso_giant') ? 'espresso_giant' : 'espresso_shrine';
      const em = put(kind, c.x, c.y + 14, d, fit(kind, 3.4), false, 0xffffff, id);
      const eh = em ? em.p.scaleY * atlas.frame(`world:${kind}`).h : 90;
      top = Math.min(top, c.y - eh);
      focus.set(id, { x: c.x, y: c.y + 14 - eh / 2, h: eh + 130 });
      for (let k = 0; k < 3; k++) steam.push({ x: c.x - 10 + k * 10, y: c.y + 14 - eh * 0.92, t: k * 0.6 });
      for (const q of o.scene.kneelers) o.posed(q.look, q.anim, q.i, q.j, q.mirror, undefined, true);
    } else if (id === 'pingpong') {
      put('ping_pong', c.x, c.y + 8, d, fit('ping_pong', 3), false, 0xffffff, id);
      o.posed('intern.brown', 'cheer', sp.i0 - 1, sp.j0 + 1, false);
      o.posed('analyst.white', 'idle_ne', sp.i0 + sp.w, sp.j0 + 1, true);
    } else if (id === 'pit') {
      if (!put('trading_pit', c.x, c.y + 20, d, fit('trading_pit', 5), false, 0xffffff, id)) {
        put('chart_screen', c.x, c.y, d, 1.4, false, 0xffffff, id);
      }
      for (const [di, dj, anim] of [[-1, 0, 'cheer'], [sp.w, 1, 'cheer'], [1, sp.h, 'idle_ne'], [sp.w - 1, -1, 'cheer']] as const) {
        o.posed(['vp', 'associate.black', 'analyst', 'intern.white'][(di + dj + 8) % 4]!, anim, sp.i0 + di, sp.j0 + dj, di > 1);
      }
    } else if (id === 'statue') {
      const st = put('giant_rat_statue', c.x, c.y + 10, d, fit('giant_rat_statue', 3.2), false, 0xffffff, id) ?? put('rat_statue', c.x, c.y + 10, d, 2.6, false, 0xffffff, id);
      const sh = st ? st.p.scaleY * atlas.frame(`world:${has('giant_rat_statue') ? 'giant_rat_statue' : 'rat_statue'}`).h : 120;
      focus.set(id, { x: c.x, y: c.y + 10 - sh / 2, h: sh + 110 });
      top = Math.min(top, c.y - sh);
    } else if (id === 'throne') {
      put('throne', c.x - 16, c.y, d, 1.4, false, 0xffffff, id);
      put('red_button', c.x + 18, c.y + 10, d + 0.5, 1, false, 0xffffff, id);
      const lc = put('laser_cannon', c.x + 40, c.y - 6, d, fit('laser_cannon', 2), false, 0xffffff, id);
      // the laser: a red beam from the throne room up into the sky
      const beam = new Sprite(redBeam());
      beam.anchor.set(0.5, 1);
      beam.position.set(c.x + (lc ? 40 : 0), c.y - (lc ? 70 : 20));
      beam.scale.set(2.2, 9);
      beam.blendMode = 'add';
      o.lights.addChild(beam);
    }
    label(id, c.x, top);
  }

  // the towers stand in their slots in the core (plan.ts): A from the glass elevator on, a floor every 25 rats; B, the
  // pool party's, from megacorp on; an elevated sky bridge runs between them round the back of the first ring.
  // Before they go up their slots are taped-off pads.
  const ring = plan.rings[stage]!;
  const floors = towerFloors(count);
  const tint = TOWER_TINT[stage] ?? 0xffffff;
  const A = plan.landmarkSpots.elevator;
  const B = plan.landmarkSpots.pool;
  /** a tower with its front vertex at cell (fi, fj): base storey, n floors, roof */
  const towerAt = (fi: number, fj: number, n: number, scale: number, tint: number, id: string): { top: number; x: number; base: number; d: number } => {
    const base = cellToScreen(fi, fj);
    const d = fi + fj - 1;
    let y = base.y;
    put('tower_base', base.x, y, d, scale, false, tint, id);
    y -= 22 * scale;
    for (let k = 0; k < n; k++) {
      put(`tower_floor_${k % 3}`, base.x, y, d + 0.001 * (k + 1), scale, false, tint, id);
      y -= 12 * scale;
    }
    put('tower_roof', base.x, y + 1, d + 0.2, scale, false, tint, id);
    return { top: y, x: base.x, base: base.y, d };
  };
  const pad = (sp: { i0: number; j0: number; w: number; h: number }): void => {
    for (let i = sp.i0; i < sp.i0 + sp.w; i++) {
      const a = cellToScreen(i, sp.j0);
      const b = cellToScreen(i, sp.j0 + sp.h - 1);
      put('tape_i', a.x + 8, a.y + 4, i + sp.j0 - 0.8);
      put('tape_i', b.x - 8, b.y + 12, i + sp.j0 + sp.h - 0.8);
    }
    for (let j = sp.j0; j < sp.j0 + sp.h; j++) {
      const a = cellToScreen(sp.i0, j);
      const b = cellToScreen(sp.i0 + sp.w - 1, j);
      put('tape_j', a.x - 8, a.y + 4, sp.i0 + j - 0.8);
      put('tape_j', b.x + 8, b.y + 12, sp.i0 + sp.w + j - 0.8);
    }
    const c = cellCentre(sp.i0 + sp.w - 2, sp.j0 + sp.h - 2);
    put('cone', c.x, c.y + 4, sp.i0 + sp.w + sp.j0 + sp.h - 3, 0.55);
  };
  const s = (TOWER_SLOT - 0.5) / 6; // the tower fills its slot
  if (A && o.built(A.room)) {
    if (floors === 0) pad(A);
    else {
      const t = towerAt(A.i0 + A.w, A.j0 + A.h, floors, s, tint, '');
      // the glass elevator up the front edge
      if (has('glass_elevator')) {
        const f = atlas.frame('world:glass_elevator');
        const want = Math.min(t.base - t.top - 30 * s, f.h * 3 * s);
        put('glass_elevator', t.x, t.base + 4, t.d + 0.5, Math.max(0.6, want / f.h), false, 0xffffff, 'elevator');
      }
      crown = { x: t.x, y: t.top - (on('helipad') ? 190 : 100) * s };
      focus.set('elevator', { x: t.x, y: (t.base + t.top) / 2 - 10 * s, h: t.base - t.top + 90 * s });
      label('elevator', t.x + 70 * s, (t.base + t.top) / 2);
      // the helipad and the CEO's helicopter on the roof
      if (on('helipad')) {
        const roofY = t.top - 48 * s;
        put('helipad', t.x, roofY + 40 * s, t.d + 0.6, fit('helipad', 5.2) * s, false, 0xffffff, 'helipad');
        put('helicopter', t.x + 6 * s, roofY + 30 * s, t.d + 0.7, fit('helicopter', 3.2) * s, false, 0xffffff, 'helipad');
        focus.set('helipad', { x: t.x, y: roofY + 10 * s, h: 190 * s });
        label('helipad', t.x, roofY - 50 * s);
      }
      if (B && o.built(B.room)) {
        if (!on('pool') && stage < 4) pad(B);
        else {
          const n2 = Math.max(4, floors - 10);
          const t2 = towerAt(B.i0 + B.w, B.j0 + B.h, n2, s, tint, '');
          // the sky bridge: from A's side along i to above B's column, then along j to B, high up
          const hb = (22 + 12 * (Math.min(n2, floors) - 3)) * s;
          const bj = A.j0 + Math.floor(A.h / 2);
          const bi = B.i0 + Math.floor(B.w / 2);
          for (let i = A.i0 - 1; i > bi; i--) {
            const p = cellToScreen(i, bj);
            put('bridge_i', p.x, p.y - hb, i + bj + 0.9, s, false, tint);
          }
          for (let j = bj; j < B.j0; j++) {
            const p = cellToScreen(bi, j);
            put('bridge_j', p.x, p.y - hb, bi + j + 0.9, s, false, tint);
          }
          if (on('pool')) {
            const roofY = t2.top - 48 * s;
            put('rooftop_pool', t2.x, roofY + 44 * s, t2.d + 0.6, fit('rooftop_pool', 5) * s, false, 0xffffff, 'pool');
            let k = 0;
            for (const kind of ['flamingo', 'dj_booth', 'lounge_chair', 'umbrella']) {
              put(kind, t2.x + (k - 1.5) * 26 * s, roofY + 56 * s - (k % 2) * 22 * s, t2.d + 0.7 + k * 0.01, 0.7 * s, k % 2 === 1, 0xffffff, 'pool');
              k++;
            }
            focus.set('pool', { x: t2.x, y: roofY + 20 * s, h: 170 * s });
            label('pool', t2.x, roofY - 40 * s);
          }
        }
      }
    }
  }

  // the annex across the avenue (from the corporate floor on): our second building, joined by a sky bridge that
  // leaves from a pylon at the office's front door and crosses over the traffic
  const annex = o.city.lots.find((l) => l.use === 'annex');
  if (annex && o.scene.standing.has('annex')) {
    const along = annex.j0 > ring.j1; // across the avenue along j (else along i)
    const as = Math.max(0.5, Math.min(1 + Math.max(0, stage - 3) * 0.25, (Math.min(annex.w, annex.h) - 1) / 6));
    const fp = Math.round(6 * as);
    const fi = annex.i0 + Math.floor((annex.w - fp) / 2);
    const fj = annex.j0 + Math.floor((annex.h - fp) / 2);
    const t = towerAt(fi + fp, fj + fp, 6 + (stage - 3) * 5, as, tint, '');
    const bh = 22 + 12; // level with the pylon roof, into the annex over its first floor
    const piece = (kind: string, i: number, j: number, y: number, d: number): void => {
      const p = cellToScreen(i, j);
      put(kind, p.x, p.y - y, d, 1, false, tint);
    };
    if (along && o.scene.pylon) {
      const bi = o.scene.pylon.i;
      const pj = o.scene.pylon.j; // the pylon on the apron, cells (bi-1..bi, pj..pj+1), claimed by the scene
      piece('pylon_base', bi + 1, pj + 2, 0, bi + pj + 2);
      piece('pylon_floor', bi + 1, pj + 2, 22, bi + pj + 2.01);
      piece('pylon_roof', bi + 1, pj + 2, 34 - 1, bi + pj + 2.2);
      for (let j = pj + 2; j < fj; j++) piece('bridge_j', bi, j, bh, bi + j + 0.9);
    }
    const s = new Sprite(o.sign('WALL STREET RATS ANNEX', 0x9fd3ff));
    s.anchor.set(0.5, 1);
    s.position.set(t.x, t.top - 100 * as);
    o.signs.addChild(s);
    signs.push(s);
    focus.set('annex', { x: t.x, y: (t.base + t.top) / 2, h: t.base - t.top + 120 });
    // a couple of rats on the plaza out front
    o.posed('associate.brown', 'idle_se', annex.i0 + 1, annex.j0 + annex.h - 1, false);
    o.posed('analyst.white', 'cheer', annex.i0 + annex.w - 2, annex.j0 + annex.h - 1, true);
  }

  // the basement gym and nap pods: a pit dug into the back of the full floor's lobby (its slot in plan.ts)
  const G = plan.landmarkSpots.gym;
  if (G && o.built(G.room)) {
    if (!on('gym')) pad(G);
    else {
      for (let i = G.i0; i < G.i0 + G.w; i++) {
        for (let j = G.j0; j < G.j0 + G.h; j++) {
          const p = cellToScreen(i, j);
          const t = makeParticle(atlas.frame(`world:fl_raised_${(i + j) & 3}`), p.x, p.y + 10);
          t.tint = 0x8090b8;
          main.add(t, i + j - 0.9);
        }
      }
      for (let i = G.i0; i < G.i0 + G.w; i++) {
        const p = cellToScreen(i, G.j0 - 1);
        const w = makeParticle(atlas.frame('world:wf_i_low'), p.x, p.y + 10);
        w.tint = 0x505870;
        main.add(w, i + G.j0 - 0.5);
      }
      for (let j = G.j0; j < G.j0 + G.h; j++) {
        const p = cellToScreen(G.i0 - 1, j);
        const w = makeParticle(atlas.frame('world:wf_j_low'), p.x, p.y + 10);
        w.tint = 0x444c64;
        main.add(w, G.i0 + j - 0.5);
      }
      const kinds = ['treadmill', 'weight_rack', 'bench_press', 'punching_bag', 'rowing', 'nap_pod', 'nap_pod_closed', 'bed_a'].filter(has);
      kinds.forEach((kind, k) => {
        const i = G.i0 + 1 + (k % Math.max(1, G.w - 2));
        const j = G.j0 + 1 + Math.floor(k / Math.max(1, G.w - 2)) * 2;
        const p = cellCentre(i, j);
        put(kind, p.x, p.y + 12, i + j + 1, 0.8, k % 2 === 1, 0xffffff, 'gym');
      });
      o.posed('associate.brown', 'cheer', G.i0 + 1, G.j0 + G.h - 2, false);
      const c = cellCentre(G.i0 + G.w / 2 - 0.5, G.j0 + G.h / 2 - 0.5);
      focus.set('gym', { x: c.x, y: c.y, h: (G.w + G.h) * 8 + 60 });
      label('gym', c.x, c.y - 50);
    }
  }
  // the rocket on its launchpad, in a lot of its own across the cross street
  for (const l of o.city.lots) {
    if (l.use !== 'rocket' || !o.scene.standing.has('rocket')) continue;
    const ci = l.i0 + l.w / 2 - 0.5;
    const cj = l.j0 + l.h / 2 - 0.5;
    const c = cellCentre(ci, cj);
    if (!on('rocket')) {
      put('fence_orange', c.x, c.y, ci + cj + 1, 0.8);
      put('cone', c.x - 20, c.y + 8, ci + cj + 1.2, 0.5);
      continue;
    }
    put('launchpad', c.x, c.y + 20, ci + cj + 1, fit('launchpad', Math.min(l.w, l.h) - 1), false, 0xffffff, 'rocket');
    const rk = put('rocket', c.x, c.y - 6, ci + cj + 1.5, 1.6 + stage * 0.2, false, 0xffffff, 'rocket');
    const rh = rk ? rk.p.scaleY * atlas.frame('world:rocket').h : 120;
    focus.set('rocket', { x: c.x, y: c.y - rh / 2, h: rh + 90 });
    label('rocket', c.x, c.y - rh - 10);
  }
  // steam from the espresso machine: soft puffs that rise, swell and fade
  const puffs = steam.map((q) => {
    const s = new Sprite(steamTexture());
    s.anchor.set(0.5);
    s.position.set(q.x, q.y);
    o.lights.addChild(s);
    return { s, ...q };
  });
  return {
    focus,
    signs,
    crown,
    update(dt: number): void {
      for (const p of puffs) {
        p.t = (p.t + dt) % 1.8;
        const u = p.t / 1.8;
        p.s.position.set(p.x + Math.sin(u * 6 + p.x) * 3, p.y - u * 34);
        p.s.scale.set(0.6 + u * 1.2);
        p.s.alpha = 0.75 * (1 - u);
      }
    },
  };
}

export type { Frame };
