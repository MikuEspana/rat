// The city round the office, drawn fresh for each stage (the company buys the blocks round it as it grows).
// Pure and deterministic, like the master plan.
//
// Street hierarchy, not a ring road: one avenue past the front (the lobby side, the subway on its near sidewalk),
// one cross street beside the building, one alley behind it. The land between them is cut into irregular blocks,
// and each block is split recursively into lots of mixed sizes (a quarter of the splits break the rules: a lot left
// big, or cut off-centre). Every lot has a purpose: a building, a park, a parking lot, a building site or a fenced
// vacant lot. Taller buildings near the office, houses, parks and empty lots towards the edge, and the edge itself
// dithers out into the night. The office sits on a thirds point; the tallest neighbour stands on the opposite
// diagonal. Street furniture is spread with Poisson-disk sampling, and a few small street scenes are set up.
import type { Cell } from '../iso';
import { Rng } from './rng';
import type { FloorLayout } from './types';

export type LotUse = 'building' | 'park' | 'parking' | 'site' | 'vacant' | 'shell' | 'rocket' | 'annex';

export interface Lot {
  i0: number;
  j0: number;
  w: number;
  h: number;
  use: LotUse;
  /** building sprite, its scale and height on screen (px) */
  sprite?: string;
  scale?: number;
  height?: number;
  /** converted this stage (house to shop to office) */
  converted?: boolean;
  label?: string;
  /** 0 at the office, 1 at the edge of the city */
  far: number;
}

export interface CityItem {
  kind: string;
  i: number;
  j: number;
  mirror: boolean;
  scale: number;
  tint?: number;
  flat?: boolean;
  dx?: number;
  dy?: number;
  /** a lot's building: it stands on the whole lot (index into lots) */
  lot?: number;
}

export interface CityExtra {
  look: string;
  anim: string;
  i: number;
  j: number;
  mirror: boolean;
  acc?: string;
  carry?: string;
}

export interface Mover {
  /** the sprite: a car's front view, or its rear view (`<car>_rear`) when it drives away from the camera */
  kind: string;
  axis: 'i' | 'j';
  /** +1 drives towards the camera (down the screen), -1 away from it */
  dir: 1 | -1;
  fixed: number;
  from: number;
  to: number;
  speed: number;
  mirror: boolean;
  phase: number;
}

/** Which way each car sprite points: front views nose down-right (+i) or down-left (+j); rear views nose up-left
 *  (-i) or up-right (-j). Mirroring swaps left and right. */
const FRONT_PLUS_I = new Set(['car_red', 'car_blue', 'taxi']);
const REAR_MINUS_I = new Set(['car_red', 'car_blue', 'taxi', 'van', 'police']);

/** The sprite and mirroring for a car driving along an axis, towards (+1) or away from (-1) the camera. */
export function carSprite(car: string, axis: 'i' | 'j', dir: 1 | -1): { kind: string; mirror: boolean } {
  if (dir > 0) return { kind: car, mirror: axis === 'i' ? !FRONT_PLUS_I.has(car) : FRONT_PLUS_I.has(car) };
  return { kind: `${car}_rear`, mirror: axis === 'i' ? !REAR_MINUS_I.has(car) : REAR_MINUS_I.has(car) };
}

export interface City {
  stage: number;
  /** cells the city covers (street, lots), with the floor look; the office and its apron are not in here */
  ground: Map<number, { style: string; tint: number; fade: number }>;
  lots: Lot[];
  items: CityItem[];
  extras: CityExtra[];
  movers: Mover[];
  /** where the tallest neighbour stands (composition: the opposite diagonal of the office) */
  landmark: Cell | null;
  /** bounding square of everything */
  i0: number;
  j0: number;
  i1: number;
  j1: number;
  /** street cells a visitor can walk on, from the edge of the city to the subway */
  visitorPath: Cell[];
}

export const CITY_KEY = (i: number, j: number): number => (i + 4096) * 8192 + (j + 4096);

/** Building sprites by development level, with how tall they read. */
const LEVELS: string[][] = [
  ['house_a', 'house_b', 'cottage', 'townhouses'],
  ['shop', 'diner', 'corner_store', 'townhouses', 'gas_station', 'warehouse', 'house_b'],
  ['brick_block', 'office_low', 'shop', 'parking_garage', 'corner_store', 'warehouse'],
  ['office_mid', 'glass_tower', 'brick_block', 'office_low', 'apartment_tower', 'parking_garage'],
  ['glass_tower', 'deco_tower', 'office_mid', 'apartment_tower', 'glass_tower'],
  ['evil_tower', 'evil_office', 'evil_rat_tower', 'glass_tower', 'deco_tower'],
];
const STAGE_LEVEL = [0.35, 1.1, 1.8, 2.6, 3.3, 4.2];
const TALLEST = ['brick_block', 'brick_block', 'glass_tower', 'deco_tower', 'deco_tower', 'evil_tower'];

/**
 * closed: the office's wings that have not opened yet (world cells). They are still city: lots and sidewalk, until
 * the office absorbs them.
 */
export function buildCity(
  plan: FloorLayout,
  stage: number,
  has: (kind: string) => boolean,
  size: (kind: string) => { w: number; h: number },
  closed: ReadonlyArray<{ i0: number; j0: number; w: number; h: number }> = [],
): City {
  const ring = plan.rings[stage]!;
  const rng = new Rng(`city:${stage}`);
  const s0 = ring.i0;
  const s1 = ring.i1;
  const S = s1 - s0;
  const c = (s0 + s1) / 2;
  // canonical frame: the front (lobby, subway) is +b; a runs along the avenue. Map back to (i, j).
  const frontJ = ring.spawn.j > s1;
  const M = (a: number, b: number): Cell => (frontJ ? { i: a, j: b } : { i: b, j: a });
  const R = Math.round(S / 2 + 20 + S * (stage >= 3 ? 0.32 : 0.22) + stage * 2);
  const E0 = Math.floor(c - R - 4);
  const E1 = Math.ceil(c + R + 4);
  const wobble = [rng.next(), rng.next(), rng.next(), rng.next()];
  /** 0 inside, 1 at the city edge (irregular, not a square) */
  const edge = (a: number, b: number): number => {
    const da = a - c;
    const db = b - c;
    const ang = Math.atan2(db, da);
    const r = R * (1 + 0.1 * Math.sin(ang * 3 + wobble[0]! * 6) + 0.06 * Math.sin(ang * 5 + wobble[1]! * 6));
    return Math.hypot(da, db) / r;
  };
  const inside = (a: number, b: number): boolean => edge(a, b) <= 1.02;
  const ground = new Map<number, { style: string; tint: number; fade: number }>();
  // closed wings in the canonical frame
  const shut = closed.map((r) => (frontJ ? { a0: r.i0, b0: r.j0, a1: r.i0 + r.w - 1, b1: r.j0 + r.h - 1 } : { a0: r.j0, b0: r.i0, a1: r.j0 + r.h - 1, b1: r.i0 + r.w - 1 }));
  const inShut = (a: number, b: number): boolean => shut.some((r) => a >= r.a0 && a <= r.a1 && b >= r.b0 && b <= r.b1);
  const setG = (a: number, b: number, style: string, tint = 0xffffff): void => {
    const e = edge(a, b);
    if (e > 1.02) return;
    const d = Math.max(s0 - 2 - a, a - s1 - 2, s0 - 2 - b, b - s1 - 2);
    if (d <= 0 && !inShut(a, b)) return; // the office and its apron
    const p = M(a, b);
    ground.set(CITY_KEY(p.i, p.j), { style, tint, fade: Math.max(0, Math.min(1, (e - 0.8) / 0.22)) });
  };
  const fill = (a0: number, a1: number, b0: number, b1: number, style: string, tint = 0xffffff): void => {
    for (let a = a0; a <= a1; a++) for (let b = b0; b <= b1; b++) setG(a, b, style, tint);
  };

  // streets: the avenue past the front, the cross street beside the office, the alley behind it
  const av0 = s1 + 5; // avenue road rows av0..av0+2, sidewalks either side
  const off = 2 + rng.int(5);
  const x0 = s1 + 6 + off; // cross street road columns x0..x0+2
  const al0 = s0 - 9; // alley rows al0..al0+1
  fill(E0, E1, s1 + 3, s1 + 4, 'sidewalk');
  fill(E0, E1, av0, av0 + 2, 'asphalt');
  fill(E0, E1, av0 + 3, av0 + 3, 'sidewalk');
  fill(x0 - 1, x0 - 1, E0, E1, 'sidewalk');
  fill(x0, x0 + 2, E0, E1, 'asphalt');
  fill(x0 + 3, x0 + 3, E0, E1, 'sidewalk');
  fill(E0, x0 - 2, al0, al0 + 1, 'concrete', 0x9a98a4);
  // crossing stripes where the avenue meets the cross street
  const items: CityItem[] = [];
  const extras: CityExtra[] = [];
  for (let b = av0; b <= av0 + 2; b++) {
    const p = M(x0 - 1, b);
    items.push({ kind: frontJ ? 'zebra_j' : 'zebra_i', i: p.i, j: p.j, mirror: false, scale: 1, flat: true });
  }
  for (let a = x0; a <= x0 + 2; a++) {
    const p = M(a, s1 + 4);
    items.push({ kind: frontJ ? 'zebra_i' : 'zebra_j', i: p.i, j: p.j, mirror: false, scale: 1, flat: true });
  }
  // lane dashes
  for (let a = E0; a <= E1; a += 3) {
    if (a >= x0 - 1 && a <= x0 + 3) continue;
    const p = M(a, av0 + 1);
    if (inside(a, av0 + 1)) items.push({ kind: frontJ ? 'lane_i' : 'lane_j', i: p.i, j: p.j, mirror: false, scale: 1, flat: true });
  }
  for (let b = E0; b <= E1; b += 3) {
    if (b >= s1 + 3 && b <= av0 + 3) continue;
    const p = M(x0 + 1, b);
    if (inside(x0 + 1, b)) items.push({ kind: frontJ ? 'lane_j' : 'lane_i', i: p.i, j: p.j, mirror: false, scale: 1, flat: true });
  }

  // blocks, some cut again by a footpath so each side gets 2 or 3
  type Rect = { a0: number; a1: number; b0: number; b1: number };
  // closed wings: a sidewalk round the edge, lots inside
  for (const r of shut) {
    fill(r.a0, r.a1, r.b0, r.b1, 'sidewalk');
  }
  const blocks: Rect[] = [
    ...shut.filter((r) => r.a1 - r.a0 >= 4 && r.b1 - r.b0 >= 4).map((r) => ({ a0: r.a0 + 1, a1: r.a1 - 1, b0: r.b0 + 1, b1: r.b1 - 1 })),
    { a0: E0, a1: s0 - 3, b0: al0 + 2, b1: s1 + 2 }, // left of the office
    { a0: s0 - 2, a1: x0 - 2, b0: al0 + 2, b1: s0 - 3 }, // behind the office, up to the alley
    { a0: s1 + 3, a1: x0 - 2, b0: s0 - 2, b1: s1 + 2 }, // between the office and the cross street
  ];
  const big: Rect[] = [
    { a0: E0, a1: x0 - 2, b0: E0, b1: al0 - 1 }, // beyond the alley
    { a0: x0 + 4, a1: E1, b0: E0, b1: s1 + 2 }, // across the cross street
    { a0: E0, a1: x0 - 2, b0: av0 + 4, b1: E1 }, // across the avenue
    { a0: x0 + 4, a1: E1, b0: av0 + 4, b1: E1 }, // the far corner
  ];
  for (const r of big) {
    // a footpath splits big blocks, off-centre
    const alongA = r.a1 - r.a0 >= r.b1 - r.b0;
    const span = alongA ? r.a1 - r.a0 : r.b1 - r.b0;
    if (span < 16) {
      blocks.push(r);
      continue;
    }
    const cut = Math.round((alongA ? r.a0 : r.b0) + span * (0.3 + rng.next() * 0.4));
    if (alongA) {
      fill(cut, cut, r.b0, r.b1, 'sidewalk', 0xd8d8e0);
      blocks.push({ ...r, a1: cut - 1 }, { ...r, a0: cut + 1 });
    } else {
      fill(r.a0, r.a1, cut, cut, 'sidewalk', 0xd8d8e0);
      blocks.push({ ...r, b1: cut - 1 }, { ...r, b0: cut + 1 });
    }
  }

  // lots: recursive splits, mixed sizes, a quarter of the decisions break the rules
  const lots: Lot[] = [];
  const split = (r: Rect, depth: number): void => {
    const w = r.a1 - r.a0 + 1;
    const h = r.b1 - r.b0 + 1;
    if (w < 3 || h < 3) return;
    const ca = (r.a0 + r.a1) / 2;
    const cb = (r.b0 + r.b1) / 2;
    if (edge(ca, cb) > 1.05) return;
    const far = Math.min(1, Math.max(0, (Math.hypot(ca - c, cb - c) - S / 2) / (R - S / 2)));
    const maxSide = 5 + Math.round(far * 5) + rng.int(3);
    const rebel = rng.chance(0.25);
    const tooBig = Math.max(w, h) > maxSide;
    if ((tooBig && !(rebel && depth > 1 && Math.max(w, h) < maxSide * 1.8)) || (rebel && Math.max(w, h) >= 8 && depth < 2)) {
      const alongA = w >= h ? true : w * 1.3 < h ? false : rng.chance(0.5);
      const len = alongA ? w : h;
      if (len >= 6) {
        const t = rebel ? (rng.chance(0.5) ? 0.25 : 0.75) : 0.38 + rng.next() * 0.24;
        const cut = Math.max(3, Math.min(len - 3, Math.round(len * t)));
        if (alongA) {
          split({ ...r, a1: r.a0 + cut - 1 }, depth + 1);
          split({ ...r, a0: r.a0 + cut }, depth + 1);
        } else {
          split({ ...r, b1: r.b0 + cut - 1 }, depth + 1);
          split({ ...r, b0: r.b0 + cut }, depth + 1);
        }
        return;
      }
    }
    lots.push({ i0: r.a0, j0: r.b0, w, h, use: 'building', far });
  };
  for (const b of blocks) split(b, 0);

  // what each lot is for: buildings thin out towards the edge, parks and empty lots take over
  const nextRing = plan.rings[stage + 1];
  const nextDepth = nextRing ? s0 - nextRing.i0 : 0;
  const adjacent = (l: Lot): boolean => {
    const d = Math.max(s0 - 2 - (l.i0 + l.w - 1), l.i0 - s1 - 2, s0 - 2 - (l.j0 + l.h - 1), l.j0 - s1 - 2);
    return d <= 1 && d >= 0; // outside the office (lots in its unopened wings are taken with the wing, not later)
  };
  let sites = 0;
  const shells = rng.shuffle(lots.filter((l) => nextRing && adjacent(l) && l.w >= 3 && l.h >= 3)).slice(0, 2 + rng.int(3));
  for (const l of lots) {
    if (shells.includes(l)) {
      l.use = 'shell';
      continue;
    }
    const r = rng.next();
    const small = Math.min(l.w, l.h);
    if (small >= 4 && sites < 1 + (stage >= 2 ? 1 : 0) && l.far < 0.6 && r < 0.12) {
      l.use = 'site';
      sites++;
    } else if (r < 0.1 + l.far * 0.18) l.use = 'park';
    else if (small >= 4 && r < 0.2 + l.far * 0.2) l.use = 'parking';
    else if (r < 0.26 + l.far * 0.25) l.use = 'vacant';
  }
  if (!sites) {
    const l = lots.filter((x) => x.use === 'building' && Math.min(x.w, x.h) >= 4).sort((x, y) => x.far - y.far)[1];
    if (l) l.use = 'site';
  }
  void nextDepth;

  // landmark lots (the only landmarks outside the building, each in a lot of its own): the rocket launchpad (from
  // megacorp on) on a big lot across the cross street, and the annex across the avenue
  const near = (l: Lot, a: number, b: number): number => Math.hypot(l.i0 + l.w / 2 - a, l.j0 + l.h / 2 - b);
  if (stage >= 4) {
    const l = lots.filter((x) => x.use !== 'shell' && Math.min(x.w, x.h) >= 7 && x.i0 > x0).sort((x, y) => near(x, x0 + 8, s1) - near(y, x0 + 8, s1))[0];
    if (l) l.use = 'rocket';
  }
  // the annex (from the corporate floor on): our second building across the avenue, a sky bridge over the traffic
  if (stage >= 3) {
    // right across the avenue (the first row of lots), left of the lobby so the bridge clears the subway
    const cost = (x: Lot): number => Math.abs(x.i0 + x.w / 2 - (c - S * 0.18)) + 4 * (x.j0 - av0 - 4);
    const l = lots
      .filter((x) => (x.use === 'building' || x.use === 'park' || x.use === 'vacant' || x.use === 'parking') && Math.min(x.w, x.h) >= 7 && x.j0 >= av0 + 4 && x.i0 + x.w <= x0 - 1)
      .sort((x, y) => cost(x) - cost(y))[0];
    if (l) l.use = 'annex';
  }

  // buildings: level by stage and distance, 2 to 4 near the office converted up a level this stage,
  // and a reroll when a neighbour has the same sprite or reads the same height
  const conversions = stage === 0 ? 0 : 2 + rng.int(3);
  lots
    .filter((l) => l.use === 'building' && !shells.includes(l))
    .sort((x, y) => x.far - y.far)
    .slice(0, conversions)
    .forEach((l) => (l.converted = true));
  const touches = (x: Lot, y: Lot): boolean =>
    x.i0 <= y.i0 + y.w + 1 && y.i0 <= x.i0 + x.w + 1 && x.j0 <= y.j0 + y.h + 1 && y.j0 <= x.j0 + x.h + 1;
  const placed: Lot[] = [];
  for (const l of lots.filter((x) => x.use === 'building').sort((x, y) => x.far - y.far)) {
    const level = Math.max(0, Math.min(LEVELS.length - 1, Math.round(STAGE_LEVEL[stage]! - l.far * 2.2 + (rng.next() - 0.5) * 0.9 + (l.converted ? 1 : 0))));
    const pool = LEVELS[level]!.filter(has);
    if (!pool.length) {
      l.use = 'park';
      continue;
    }
    const b = Math.max(2, Math.min(l.w, l.h) - 1);
    let choice = '';
    for (let t = 0; t < 6; t++) {
      const k = rng.pick(pool);
      const sz = size(k);
      const sc = Math.max(0.55, Math.min(3.2, (b * 32) / sz.w));
      const hgt = sz.h * sc;
      const clash = placed.some((o) => touches(o, l) && (o.sprite === k || Math.abs((o.height ?? 0) - hgt) < 18));
      choice = k;
      l.sprite = k;
      l.scale = sc;
      l.height = hgt;
      if (!clash) break;
    }
    void choice;
    placed.push(l);
  }

  // the landmark: the tallest thing in town, on the diagonal opposite the office (up and to the right on screen)
  let landmark: Cell | null = null;
  const target = { a: c + S * 0.1, b: s0 - 6 - S * 0.25 };
  const lm = lots
    .filter((l) => (l.use === 'building' || l.use === 'vacant' || l.use === 'park') && Math.min(l.w, l.h) >= 4 && l.j0 + l.h < s0 - 2)
    .sort((x, y) => Math.hypot(x.i0 + x.w / 2 - target.a, x.j0 + x.h / 2 - target.b) - Math.hypot(y.i0 + y.w / 2 - target.a, y.j0 + y.h / 2 - target.b))[0];
  if (lm && has(TALLEST[stage]!)) {
    const k = TALLEST[stage]!;
    const sz = size(k);
    lm.use = 'building';
    lm.sprite = k;
    lm.scale = Math.max(1.2, Math.min(4, ((Math.min(lm.w, lm.h) - 1) * 32) / sz.w) * (1.3 + stage * 0.15));
    lm.height = sz.h * lm.scale;
    landmark = M(lm.i0 + lm.w / 2, lm.j0 + lm.h / 2);
  }

  // lot ground and dressing
  const put = (kind: string, a: number, b: number, mirror = false, scale = 1, extra: Partial<CityItem> = {}): void => {
    if (!has(kind) || !inside(a, b)) return;
    const p = M(a, b);
    items.push({ kind, i: p.i, j: p.j, mirror, scale, ...extra });
  };
  const fence = (l: Lot, kind: string): void => {
    // posts of fence round the lot, every other cell, with a gap for a gate
    for (let a = l.i0; a < l.i0 + l.w; a += 2) {
      put(kind, a, l.j0 + l.h - 1, !frontJ, 0.5);
      if (a > l.i0 + 1) put(kind, a, l.j0, !frontJ, 0.5);
    }
    for (let b = l.j0 + 1; b < l.j0 + l.h - 1; b += 2) {
      put(kind, l.i0 + l.w - 1, b, frontJ, 0.5);
      put(kind, l.i0, b, frontJ, 0.5);
    }
  };
  const suburb = stage === 0;
  for (const l of lots) {
    const a1 = l.i0 + l.w - 1;
    const b1 = l.j0 + l.h - 1;
    if (l.use === 'building') {
      fill(l.i0, a1, l.j0, b1, suburb || (l.sprite ?? '').startsWith('house') || l.sprite === 'cottage' ? 'grass' : 'concrete', stage >= 5 ? 0xd0a0a0 : 0xffffff);
      const b = Math.min(l.w, l.h) - 1;
      const ca = l.i0 + l.w / 2;
      const cb = l.j0 + l.h / 2;
      // stand the sprite with its front corner on the lot's front corner, centred
      put(l.sprite!, ca + b / 2 - 1, cb + b / 2 - 1, rng.chance(0.5), l.scale ?? 1, { dx: 0, dy: 8, lot: lots.indexOf(l) });
    } else if (l.use === 'park') {
      fill(l.i0, a1, l.j0, b1, 'grass');
      const n = Math.max(1, Math.round((l.w * l.h) / 10));
      for (const p of poisson(rng, l.i0, l.j0, l.w, l.h, 2.4, n)) put(rng.pick(['tree_round', 'tree_bushy', 'tree_pine', 'tree_round']), p.a, p.b, rng.chance(0.5), 0.8);
      if (l.w * l.h >= 16) put(has('fountain') ? 'fountain' : 'bench', Math.floor(l.i0 + l.w / 2), Math.floor(l.j0 + l.h / 2), false, 0.8);
      put('bench', l.i0 + 1, b1, rng.chance(0.5), 0.8);
    } else if (l.use === 'parking') {
      fill(l.i0, a1, l.j0, b1, 'asphalt', 0xc8c8d4);
      const cars = ['car_red', 'car_blue', 'car_white', 'taxi', 'van', 'car_gold', 'police'];
      for (let a = l.i0; a <= a1; a += 2) {
        const p = M(a, l.j0 + 1);
        items.push({ kind: frontJ ? 'pline_j' : 'pline_i', i: p.i, j: p.j, mirror: false, scale: 1, flat: true });
        if (rng.chance(0.6)) put(rng.pick(cars), a + 0.5, l.j0 + 1, frontJ ? false : true, 0.85);
      }
    } else if (l.use === 'site') {
      fill(l.i0, a1, l.j0, b1, 'dirt');
      fence(l, has('fence_orange') ? 'fence_orange' : 'barrier');
      put('scaffold', l.i0 + 1, l.j0 + 1, false, 0.9);
      if (Math.min(l.w, l.h) >= 5) put('crane', a1 - 1, l.j0 + 1, rng.chance(0.5), 0.9 + stage * 0.12);
      put('cement', a1 - 1, b1 - 1, false, 0.7);
      put('cone', l.i0 + 1, b1 - 1, false, 0.5);
      put('portaloo', a1, b1 - 2, false, 0.6);
      // the crew
      extras.push({ ...look(rng), anim: 'idle_se', ...M(l.i0 + 2, b1 - 1), mirror: false, acc: 'hat_hard' });
      extras.push({ ...look(rng), anim: 'cheer', ...M(l.i0 + 3, l.j0 + 2), mirror: true, acc: 'hat_hard' });
      extras.push({ ...look(rng), anim: 'idle_ne', ...M(a1 - 2, b1 - 1), mirror: true, acc: 'hat_hard', carry: 'box_s' });
    } else if (l.use === 'vacant') {
      fill(l.i0, a1, l.j0, b1, 'dirt', 0xb0a898);
      fence(l, has('fence_chain') ? 'fence_chain' : 'barrier');
      if (rng.chance(0.5)) put(has('hoarding') ? 'hoarding' : 'sign_post', l.i0 + 1, b1, false, 0.6);
      if (rng.chance(0.5)) put(rng.pick(['tree_bushy', 'box_s', 'garbage']), l.i0 + 1 + rng.int(Math.max(1, l.w - 2)), l.j0 + 1 + rng.int(Math.max(1, l.h - 2)), rng.chance(0.5), 0.6);
    } else if (l.use === 'rocket') {
      fill(l.i0, a1, l.j0, b1, 'concrete', 0xb8bcc8);
    } else if (l.use === 'annex') {
      fill(l.i0, a1, l.j0, b1, 'marble', 0xd8dce8);
    } else {
      fill(l.i0, a1, l.j0, b1, 'blueprint', 0xb4c0dc);
      const next = plan.rings[stage + 1] ? STAGE_NAMES[stage + 1] : '';
      l.label = next;
    }
  }

  // street furniture, Poisson-disk along the sidewalks
  const walks: Array<{ a: number; b: number }> = [];
  for (let a = E0; a <= E1; a++) {
    walks.push({ a, b: s1 + 3 }, { a, b: av0 + 3 });
  }
  for (let b = E0; b <= E1; b++) {
    walks.push({ a: x0 - 1, b }, { a: x0 + 3, b });
  }
  const spawnC = frontJ ? { a: ring.spawn.i, b: ring.spawn.j } : { a: ring.spawn.j, b: ring.spawn.i };
  const taken: Array<{ a: number; b: number; r: number }> = [];
  const free = (a: number, b: number, r: number): boolean =>
    inside(a, b) && Math.hypot(a - spawnC.a, b - spawnC.b) > 3 && taken.every((t) => Math.hypot(t.a - a, t.b - b) >= Math.max(r, t.r)) &&
    !(a >= x0 - 1 && a <= x0 + 3 && b >= s1 + 3 && b <= av0 + 3);
  const scatter = (kinds: string[], r: number, n: number, near?: (p: { a: number; b: number }) => boolean): void => {
    const cand = rng.shuffle(walks.filter((p) => !near || near(p)));
    let got = 0;
    for (const p of cand) {
      if (got >= n) break;
      if (!free(p.a, p.b, r)) continue;
      taken.push({ ...p, r });
      put(rng.pick(kinds), p.a, p.b, rng.chance(0.5), kinds[0] === 'street_lamp' ? 1 : 0.8, kinds[0] === 'street_lamp' ? { dy: 4 } : {});
      got++;
    }
  };
  const perim = Math.round((E1 - E0) / 7);
  scatter(['street_lamp'], 7, perim * 2);
  scatter(stage === 0 ? ['tree_round', 'tree_bushy'] : ['tree_square', 'planter'], 5, perim);
  scatter(['news_box', 'kiosk', 'dumpster'], 9, Math.round(perim / 2));
  scatter(['hydrant', 'trash_can', 'bench', 'mailbox', 'news_box', 'parking_meter'], 4, perim);

  // small street scenes (3 to 5): a food truck with a queue, a smoker, a delivery, (the crew is on the site)
  const truckA = Math.round(c - S * 0.1 - 4);
  if (has('food_truck')) {
    put('food_truck', truckA, av0 + 2, !frontJ, 1);
    for (let k = 0; k < 3; k++) extras.push({ ...look(rng), anim: 'idle_ne', ...M(truckA - 2 - k, av0 + 3), mirror: !frontJ });
  }
  const shop = lots.find((l) => l.use === 'building' && l.far < 0.5 && ['shop', 'diner', 'corner_store', 'office_low', 'brick_block', 'warehouse'].includes(l.sprite ?? ''));
  if (shop) extras.push({ ...look(rng), anim: 'idle_se', ...M(shop.i0 + shop.w - 1, shop.j0 + shop.h), mirror: false, carry: 'smoke' });
  put('van', x0 + 2, s1 - 4, frontJ, 1);
  extras.push({ ...look(rng), anim: 'walk_se', ...M(x0 - 1, s1 - 6), mirror: frontJ, carry: 'box_s' });

  // traffic, both ways: on each street one lane drives towards the camera (front views) and the other away from it
  // (rear views), every car nose first
  const movers: Mover[] = [];
  const cars = stage >= 5 ? ['limo', 'car_gold', 'police'] : stage >= 3 ? ['taxi', 'limo', 'car_white', 'taxi'] : ['car_red', 'car_blue', 'taxi', 'van', 'car_white'];
  const n = 4 + stage * 2;
  for (let k = 0; k < n; k++) {
    const car = cars[k % cars.length]!;
    const onAvenue = k % 3 !== 2;
    const dir: 1 | -1 = k % 2 === 0 ? 1 : -1;
    // avenue runs along a: in (i, j) terms along i when the front is +j
    const axis: 'i' | 'j' = onAvenue === frontJ ? 'i' : 'j';
    // towards the camera on the near lane, away on the far lane (the middle row carries the lane dashes)
    const lane = onAvenue ? (dir > 0 ? av0 + 2 : av0) : dir > 0 ? x0 + 2 : x0;
    const look = carSprite(car, axis, dir);
    movers.push({ kind: look.kind, axis, dir, fixed: lane + 0.1, from: E0, to: E1, speed: 2.5 + rng.next() * 2.5, mirror: look.mirror, phase: rng.next() });
  }

  // a visitor's way in: along the avenue sidewalk from the edge to the subway
  const visitorPath: Cell[] = [M(E0 + 6, av0 + 3), M(spawnC.a - 1, av0 + 3), M(spawnC.a - 1, spawnC.b)];

  let bi0 = Infinity;
  let bj0 = Infinity;
  let bi1 = -Infinity;
  let bj1 = -Infinity;
  for (const k of ground.keys()) {
    const i = Math.floor(k / 8192) - 4096;
    const j = (k % 8192) - 4096;
    if (i < bi0) bi0 = i;
    if (j < bj0) bj0 = j;
    if (i > bi1) bi1 = i;
    if (j > bj1) bj1 = j;
  }
  return {
    stage,
    ground,
    lots: lots.map((l) => ({ ...l, ...remapLot(l, frontJ) })),
    items,
    extras,
    movers,
    landmark,
    i0: bi0,
    j0: bj0,
    i1: bi1,
    j1: bj1,
    visitorPath,
  };
}

const STAGE_NAMES = ['GARAGE STARTUP', 'SMALL OFFICE', 'FULL FLOOR', 'CORPORATE FLOOR', 'MEGACORP', 'WALL STREET'];
const TIERS = ['intern', 'analyst', 'associate', 'vp', 'intern', 'analyst'];
const FURS = ['', '', '.brown', '.white', '.black'];

function look(rng: Rng): { look: string } {
  return { look: `${rng.pick(TIERS)}${rng.pick(FURS)}` };
}

function remapLot(l: Lot, frontJ: boolean): Pick<Lot, 'i0' | 'j0' | 'w' | 'h'> {
  return frontJ ? { i0: l.i0, j0: l.j0, w: l.w, h: l.h } : { i0: l.j0, j0: l.i0, w: l.h, h: l.w };
}

/** Poisson-disk points in a rectangle (dart throwing, min distance r). */
export function poisson(rng: Rng, a0: number, b0: number, w: number, h: number, r: number, n: number): Array<{ a: number; b: number }> {
  const out: Array<{ a: number; b: number }> = [];
  for (let t = 0; t < n * 30 && out.length < n; t++) {
    const a = a0 + 0.5 + rng.next() * (w - 1);
    const b = b0 + 0.5 + rng.next() * (h - 1);
    if (out.every((p) => Math.hypot(p.a - a, p.b - b) >= r)) out.push({ a, b });
  }
  return out;
}
