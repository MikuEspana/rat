// Where every sign goes, decided before anything is drawn (as scene.ts does for sprites): each landmark's name at a
// fixed spot over its set piece, the company name on the building (or on the tower's roof), a name over every room,
// a padlock sign over the next rooms and lots to come, the JOB FAIR sign over the head of the line. The world draws
// exactly these spots, and the label layout (labels.ts) moves or hides the less important ones so no two overlap at
// any zoom. Pure, so the tests check the same spots the page shows.
import { cellCentre, cellToScreen, type Cell } from '../iso';
import { textWidth } from '../gfx/pixelfont';
import type { City } from './city';
import type { LabelBox } from './labels';
import { LANDMARKS, TOWER_SLOT, towerFloors } from './landmarks';
import { ROOM_LOOK, STAGES } from './plan';
import type { Scene } from './scene';
import type { FloorLayout, Room } from './types';

export type SignKind = 'landmark' | 'name' | 'fair' | 'lock' | 'room';

export interface SignSpot {
  /** what it names: a landmark id, 'name', 'fair', 'lock:<room>', 'shell:<lot>', 'room:<room>' */
  key: string;
  kind: SignKind;
  text: string;
  /** second line (padlock signs) */
  sub?: string;
  /** anchor: bottom centre, world px */
  x: number;
  y: number;
  /** texture size at scale 1 */
  w: number;
  h: number;
}

/** A sign's texture size: pixel text on a plate with a 2 px frame (build.ts draws it). */
export function signSize(text: string, scale: number): { w: number; h: number } {
  const pad = 3 * scale;
  return { w: textWidth(text, scale) + pad * 2 + 4, h: 7 * scale + pad * 2 + 4 };
}

/** A padlock sign's texture size: two lines of small text and the padlock. */
export function lockSize(what: string, when: string): { w: number; h: number } {
  return { w: Math.max(textWidth(what, 1), textWidth(when, 1)) + 22, h: 26 };
}

/** Sprite sizes of the atlas (world: frames), for the set pieces whose height sets where their name goes. */
export type FrameSize = (kind: string) => { w: number; h: number } | null;

export interface SignInput {
  plan: FloorLayout;
  stage: number;
  count: number;
  built: (roomId: number) => boolean;
  /** stock rooms show their symbol */
  symbolOf: ReadonlyArray<string | null | undefined>;
  city: City;
  scene: Scene;
  frames: FrameSize;
  /** the head of the job-fair line, when anyone is waiting */
  fair?: { head: Cell; count: number } | null;
}

/** A tower storey stack with its front vertex at cell (fi, fj): where its roof and base are on screen. */
export function towerTop(fi: number, fj: number, floors: number, scale: number): { x: number; base: number; top: number } {
  const b = cellToScreen(fi, fj);
  return { x: b.x, base: b.y, top: b.y - 22 * scale - 12 * scale * floors };
}

export const TOWER_SCALE = (TOWER_SLOT - 0.5) / 6;

/** The annex's size and footprint in its lot (landmarks.ts draws it from the same numbers). */
export function annexGeometry(lot: { i0: number; j0: number; w: number; h: number }, stage: number): { scale: number; fp: number; fi: number; fj: number; floors: number } {
  const scale = Math.max(0.5, Math.min(1 + Math.max(0, stage - 3) * 0.25, (Math.min(lot.w, lot.h) - 1) / 6));
  const fp = Math.round(6 * scale);
  return { scale, fp, fi: lot.i0 + Math.floor((lot.w - fp) / 2), fj: lot.j0 + Math.floor((lot.h - fp) / 2), floors: 6 + (stage - 3) * 5 };
}

/** How big a set piece is drawn to fill `cells` cells across. */
const fitScale = (frames: FrameSize, kind: string, cells: number): number => {
  const f = frames(kind);
  return f ? (cells * 32) / f.w : 1;
};

/** The landmarks' name signs, at fixed spots over their set pieces (landmarks.ts puts them exactly here). */
export function landmarkSigns(o: SignInput): SignSpot[] {
  const { plan, stage, count, frames, scene } = o;
  const on = (id: string): boolean => count >= (LANDMARKS.find((l) => l.id === id)?.at ?? Infinity);
  const out: SignSpot[] = [];
  const add = (key: string, text: string, x: number, y: number): void => {
    out.push({ key, kind: 'landmark', text, x, y, ...signSize(text, 2) });
  };
  const named = (id: string): string => LANDMARKS.find((l) => l.id === id)!.name;

  // interior set pieces in their slots
  for (const [id, sp] of Object.entries(plan.landmarkSpots)) {
    if (id === 'elevator' || id === 'pool' || id === 'gym') continue;
    if (!on(id) || !o.built(sp.room) || !scene.standing.has(id)) continue;
    const c = cellCentre(sp.i0 + sp.w / 2 - 0.5, sp.j0 + sp.h / 2 - 0.5);
    let top = c.y - 70;
    if (id === 'espresso') {
      const kind = frames('espresso_giant') ? 'espresso_giant' : 'espresso_shrine';
      const f = frames(kind);
      top = Math.min(top, c.y - (f ? fitScale(frames, kind, 3.4) * f.h : 90));
    } else if (id === 'statue') {
      const big = frames('giant_rat_statue');
      const small = frames('rat_statue');
      const sh = big ? fitScale(frames, 'giant_rat_statue', 3.2) * big.h : small ? 2.6 * small.h : 120;
      top = Math.min(top, c.y - sh);
    }
    add(id, named(id), c.x, top);
  }

  // the towers: the glass elevator and the helipad on tower A, the pool party on tower B
  const floors = towerFloors(count);
  const s = TOWER_SCALE;
  const A = plan.landmarkSpots.elevator;
  const B = plan.landmarkSpots.pool;
  if (A && o.built(A.room) && floors > 0) {
    const t = towerTop(A.i0 + A.w, A.j0 + A.h, floors, s);
    add('elevator', named('elevator'), t.x + 70 * s, (t.base + t.top) / 2);
    if (on('helipad')) add('helipad', named('helipad'), t.x, t.top - 48 * s - 50 * s);
    if (B && o.built(B.room) && on('pool')) {
      const t2 = towerTop(B.i0 + B.w, B.j0 + B.h, Math.max(4, floors - 10), s);
      add('pool', named('pool'), t2.x, t2.top - 48 * s - 40 * s);
    }
  }

  // the annex across the avenue
  const annex = o.city.lots.find((l) => l.use === 'annex');
  if (annex && scene.standing.has('annex')) {
    const g = annexGeometry(annex, stage);
    const t = towerTop(g.fi + g.fp, g.fj + g.fp, g.floors, g.scale);
    add('annex', 'WALL STREET RATS ANNEX', t.x, t.top - 100 * g.scale);
  }

  // the basement gym in its pit
  const G = plan.landmarkSpots.gym;
  if (G && o.built(G.room) && on('gym')) {
    const c = cellCentre(G.i0 + G.w / 2 - 0.5, G.j0 + G.h / 2 - 0.5);
    add('gym', named('gym'), c.x, c.y - 50);
  }

  // the rocket on its launchpad
  for (const l of o.city.lots) {
    if (l.use !== 'rocket' || !scene.standing.has('rocket') || !on('rocket')) continue;
    const c = cellCentre(l.i0 + l.w / 2 - 0.5, l.j0 + l.h / 2 - 0.5);
    const f = frames('rocket');
    const rh = f ? (1.6 + stage * 0.2) * f.h : 120;
    add('rocket', named('rocket'), c.x, c.y - rh - 10);
  }
  return out;
}

/** Where the company name goes: over the building's back corner, or on tower A's roof once it stands. */
export function nameSign(o: SignInput): SignSpot {
  const { plan, stage, count } = o;
  const text = `WALL STREET RATS: ${STAGES[stage]!.name}`;
  const ring = plan.rings[stage]!;
  let at = cellToScreen(ring.i0, ring.j0);
  let y = at.y - 70;
  const A = plan.landmarkSpots.elevator;
  const floors = towerFloors(count);
  if (A && o.built(A.room) && floors > 0) {
    const t = towerTop(A.i0 + A.w, A.j0 + A.h, floors, TOWER_SCALE);
    const helipad = count >= (LANDMARKS.find((l) => l.id === 'helipad')?.at ?? Infinity);
    at = { x: t.x, y: t.top };
    y = t.top - (helipad ? 190 : 100) * TOWER_SCALE;
  }
  return { key: 'name', kind: 'name', text, x: at.x, y, ...signSize(text, 3) };
}

/** The rooms of this stage's ring still to come in open wings (building sites). */
function openSites(plan: FloorLayout, stage: number, built: (id: number) => boolean): Room[] {
  const open = new Set<string>();
  for (const r of plan.rooms) if (r.ring >= 1 && r.ring <= stage && built(r.id)) open.add(`${r.ring}:${r.strip}`);
  return plan.rooms.filter((r) => r.ring === stage && !built(r.id) && open.has(`${r.ring}:${r.strip}`));
}

/** Every sign of the world. */
export function planSigns(o: SignInput): SignSpot[] {
  const { plan, stage, city } = o;
  const out: SignSpot[] = [...landmarkSigns(o), nameSign(o)];
  if (o.fair && o.fair.count > 0) {
    const text = `JOB FAIR: ${o.fair.count.toLocaleString('en-US')} IN LINE`;
    const c = cellCentre(o.fair.head.i, o.fair.head.j);
    out.push({ key: 'fair', kind: 'fair', text, x: c.x, y: c.y - 56, ...signSize(text, 2) });
  }
  // padlock signs over the next rooms to come (4 amenities, 2 desk rooms) and the lots the office takes next
  const sites = openSites(plan, stage, o.built);
  const next = [
    ...sites.filter((r) => r.unlockAt !== null).sort((a, b) => a.unlockAt! - b.unlockAt!).slice(0, 4),
    ...sites.filter((r) => r.unlockAt === null).sort((a, b) => a.order - b.order).slice(0, 2),
  ];
  for (const r of next) {
    const what = r.kind === 'stock' || r.kind === 'open' ? 'DESKS' : ROOM_LOOK[r.kind].label;
    const when = r.unlockAt !== null ? `${r.unlockAt.toLocaleString('en-US')} RATS` : 'NEXT HIRES';
    const c = cellToScreen(r.i0 + r.w / 2, r.j0 + r.h / 2);
    out.push({ key: `lock:${r.id}`, kind: 'lock', text: what, sub: when, x: c.x, y: c.y - 4, ...lockSize(what, when) });
  }
  const nextStage = STAGES[stage + 1];
  if (nextStage) {
    city.lots.forEach((l, n) => {
      if (l.use !== 'shell') return;
      const what = 'NEXT FLOOR';
      const when = `AT ${nextStage.min.toLocaleString('en-US')} RATS`;
      const c = cellToScreen(l.i0 + l.w / 2, l.j0 + l.h / 2);
      out.push({ key: `shell:${n}`, kind: 'lock', text: what, sub: when, x: c.x, y: c.y - 34 - 4, ...lockSize(what, when) });
    });
  }
  // a name over every room that stands (stock rooms show their symbol; the garage has the Vault instead)
  for (const r of plan.rooms) {
    if (!o.built(r.id)) continue;
    const text = r.kind === 'stock' ? o.symbolOf[r.id] ?? '' : r.kind === 'garage' ? '' : ROOM_LOOK[r.kind].label;
    if (!text) continue;
    const c = cellToScreen(r.i0 + r.w / 2, r.j0 + r.h / 2);
    out.push({ key: `room:${r.id}`, kind: 'room', text, x: c.x, y: c.y - 24, ...signSize(text, 2) });
  }
  return out;
}

/** How big each kind of sign is drawn at zoom z: names you read from afar grow as you zoom out. */
export function signScale(kind: SignKind, z: number): number {
  if (kind === 'landmark') return Math.max(0.45, Math.min(6, 0.9 / z));
  if (kind === 'name') return Math.max(0.4, Math.min(4, 0.6 / z));
  if (kind === 'fair') return Math.max(1, Math.min(4, 0.6 / z));
  return 1;
}

/** How visible each kind is at zoom z (0 to 1): room names only at mid zoom, padlock signs from mid zoom in. */
export function signAlpha(kind: SignKind, z: number): number {
  if (kind === 'room') return z >= 1.2 ? 0 : z >= 0.95 ? (1.2 - z) / 0.25 : z >= 0.72 ? 1 : z <= 0.62 ? 0 : (z - 0.62) / 0.1;
  if (kind === 'lock') return z >= 0.6 ? 1 : 0;
  return 1;
}

/** Landmarks first (may stack 3 steps up), then the company name and the job fair, padlocks, room names. */
export const SIGN_PRIO: Record<SignKind, { prio: number; steps: number }> = {
  landmark: { prio: 0, steps: 3 },
  name: { prio: 1, steps: 2 },
  fair: { prio: 1, steps: 2 },
  lock: { prio: 2, steps: 1 },
  room: { prio: 3, steps: 0 },
};

/** The label boxes the layout sees at zoom z (only the signs showing at that zoom), with their sign indexes. */
export function signBoxes(spots: readonly SignSpot[], z: number): { boxes: LabelBox[]; index: number[] } {
  const boxes: LabelBox[] = [];
  const index: number[] = [];
  spots.forEach((s, n) => {
    if (signAlpha(s.kind, z) <= 0.01) return;
    const k = signScale(s.kind, z);
    boxes.push({ x: s.x, y: s.y, w: s.w * k, h: s.h * k, ...SIGN_PRIO[s.kind] });
    index.push(n);
  });
  return { boxes, index };
}
