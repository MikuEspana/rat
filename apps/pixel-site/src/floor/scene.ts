// What stands where, decided before anything is drawn: the office claims its walls and furniture, then the Vault and
// the landmarks their slots, the city its lots and sidewalks, the building sites their dirt. Every placement goes
// through the zoning (zones.ts); what does not fit is skipped. The world draws exactly this, and the tests check it.
import type { Cell } from '../iso';
import type { City } from './city';
import { LANDMARKS } from './landmarks';
import { type SewerPart, sewerParts, spawnStageOf } from './sewer';
import { idx, T, type FloorLayout, type Room } from './types';
import { type Openness, rectCells, Zoning } from './zones';

export interface SiteProp {
  kind: string;
  i: number;
  j: number;
  scale: number;
  mirror: boolean;
}

export interface SiteRat {
  look: string;
  anim: string;
  i: number;
  j: number;
  mirror: boolean;
  acc?: string;
}

export interface Scene {
  zoning: Zoning;
  /** city items and street-scene extras that fit (by index into city.items / city.extras) */
  keepItem: boolean[];
  keepExtra: boolean[];
  /** building sites (rooms still to come, shut wings): material, cones, cranes and a crew */
  siteProps: SiteProp[];
  cranes: SiteProp[];
  crew: SiteRat[];
  /** rats kneeling round the espresso machine */
  kneelers: SiteRat[];
  /** the annex's bridge pylon found room on the apron */
  pylon: { i: number; j: number } | null;
  /** landmarks standing in their slots (or lots) */
  standing: Set<string>;
  /** the sewer parts that fit in front of the lobby (floor/sewer.ts) */
  sewer: SewerPart[];
  /** the job-fair line, head first: outdoor, free tiles only (the apron round the office, then sidewalks) */
  line: Cell[];
}

const hash = (n: number): number => (((n * 2654435761) >>> 0) % 10007) / 10007;
const STUFF = ['cone', 'cone', 'cement', 'pallets', 'box_pile', 'barrier', 'cone', 'pallets'];
const CREW = ['intern', 'associate.brown', 'analyst.white', 'intern.black'];

export function layoutScene(plan: FloorLayout, open: Openness, city: City, count: number): Scene {
  const z = new Zoning(plan, open, city);
  const { stage, built } = open;
  const ring = plan.rings[stage]!;
  const on = (id: string): boolean => count >= (LANDMARKS.find((l) => l.id === id)?.at ?? Infinity);
  z.claimOffice();

  // the Vault's plaza, then every landmark slot whose room stands (a slot is kept clear even before its landmark)
  z.claim({ what: 'vault', cat: 'vault', cells: rectCells(plan.vault.i - 3, plan.vault.j - 3, 6, 6) }, ['slot'], 'vault');
  const standing = new Set<string>();
  for (const [id, sp] of Object.entries(plan.landmarkSpots)) {
    if (sp.room >= 0 && !built(sp.room)) continue;
    if (plan.rooms[sp.room]!.ring > stage) continue;
    // tower B stands from megacorp on (its pool party comes later); every other landmark from its milestone
    const up = id === 'pool' ? stage >= 4 && on('elevator') : on(id);
    if (!up) continue;
    if (z.claim({ what: id, cat: 'landmark', cells: rectCells(sp.i0, sp.j0, sp.w, sp.h) }, ['slot'], id)) standing.add(id);
  }

  // the sewer rats come out of, in front of the lobby: before the city's street furniture takes the sidewalk
  const sewer = sewerParts(spawnStageOf(count), ring.spawn).filter((p) =>
    z.claim({ what: `sewer ${p.kind}`, cat: 'spawn', cells: rectCells(p.i0, p.j0, p.w, p.h) }, ['spawn', 'apron', 'sidewalk']),
  );

  // landmarks in lots of their own: the rocket, the annex (and the annex's pylon on the office apron)
  let pylon: Scene['pylon'] = null;
  for (const l of city.lots) {
    if (l.use !== 'rocket' && l.use !== 'annex') continue;
    if (!z.claim({ what: l.use, cat: 'landmark', cells: rectCells(l.i0, l.j0, l.w, l.h) }, ['lot'])) continue;
    standing.add(l.use);
    if (l.use === 'annex' && l.j0 > ring.j1) {
      const bi = l.i0 + Math.floor(l.w / 2);
      const pj = ring.j1 + 1;
      if (z.claim({ what: 'pylon', cat: 'landmark', cells: rectCells(bi - 1, pj, 2, 2) }, ['apron'])) pylon = { i: bi, j: pj };
    }
  }

  // the city: each lot's building on its lot, then furniture on sidewalks and in lots, then the street scenes
  const keepItem = city.items.map(() => false);
  city.items.forEach((it, n) => {
    if (it.flat) {
      keepItem[n] = true; // road marks lie flat on the street
      return;
    }
    if (it.lot !== undefined) {
      const l = city.lots[it.lot]!;
      keepItem[n] = z.claim({ what: it.kind, cat: 'building', cells: rectCells(l.i0, l.j0, l.w, l.h) }, ['lot']);
    }
  });
  city.items.forEach((it, n) => {
    if (it.flat || it.lot !== undefined) return;
    const c: [number, number] = [Math.round(it.i), Math.round(it.j)];
    keepItem[n] = z.claim({ what: it.kind, cat: 'prop', cells: [c] }, ['sidewalk', 'lot']);
  });
  const keepExtra = city.extras.map((x) => z.claim({ what: `${x.look}/${x.anim}`, cat: 'extra', cells: [[Math.round(x.i), Math.round(x.j)]] }, ['sidewalk', 'lot']));

  // building sites: the rooms of the current ring still to come in open wings, and the shut wings
  const siteProps: SiteProp[] = [];
  const cranes: SiteProp[] = [];
  const crew: SiteRat[] = [];
  const lots = plan.rooms.filter((r) => r.ring === stage && !built(r.id) && open.openStrip.has(`${r.ring}:${r.strip}`));
  const next = new Set(
    [
      ...lots.filter((r) => r.unlockAt !== null).sort((a, b) => a.unlockAt! - b.unlockAt!).slice(0, 4),
      ...lots.filter((r) => r.unlockAt === null).sort((a, b) => a.order - b.order).slice(0, 2),
    ].map((r) => r.id),
  );
  const dress = (key: number, i0: number, j0: number, w: number, h: number, busy: boolean, wing = false): void => {
    if (w < 3 || h < 3) return;
    const n = wing ? Math.min(14, 2 + Math.floor((w * h) / 45)) : Math.min(busy ? 6 : 4, 1 + Math.floor((w * h) / (busy ? 24 : 60)));
    for (let q = 0; q < n; q++) {
      const i = i0 + 1 + Math.floor(hash(key * 31 + q) * (w - 2));
      const j = j0 + 1 + Math.floor(hash(key * 57 + q * 7 + 3) * (h - 2));
      const kind = STUFF[Math.floor(hash(key * 13 + q) * STUFF.length)]!;
      if (z.claim({ what: kind, cat: 'site', cells: [[i, j]] }, ['office', 'site'])) siteProps.push({ kind, i, j, scale: kind === 'cone' ? 0.55 : 0.7, mirror: hash(key + q) < 0.5 });
    }
    if (!busy) return;
    if (cranes.length < 3) {
      const i = i0 + 1;
      const j = j0 + h - 2;
      if (z.claim({ what: 'crane', cat: 'site', cells: [[i, j]] }, ['office', 'site'])) cranes.push({ kind: 'crane', i, j, scale: 0.62, mirror: false });
    }
    for (let q = 0; q < 2; q++) {
      const i = i0 + 1 + ((key + q * 3) % Math.max(1, w - 2));
      const j = j0 + h - 2 - q;
      if (z.claim({ what: 'crew', cat: 'extra', cells: [[i, j]] }, ['office', 'site'])) crew.push({ look: CREW[(key + q) % CREW.length]!, anim: q === 0 ? 'idle_se' : 'cheer', i, j, mirror: q === 1, acc: 'hat_hard' });
    }
  };
  for (const r of lots) dress(r.id, r.i0, r.j0, r.w, r.h, next.has(r.id));
  // shut wings: the next one to open gets a crane and a crew, the others material and cones
  const wingRank = (r: { i0: number; j0: number }): number => {
    const st = plan.rings[stage]!.strips.findIndex((x) => x.i0 === r.i0 && x.j0 === r.j0);
    return plan.rings[stage]!.wingOrder.indexOf(st);
  };
  const shut = [...open.closedRects].sort((a, b) => wingRank(a) - wingRank(b));
  shut.forEach((r, n) => dress(10_000 + n, r.i0, r.j0, r.w, r.h, n === 0, true));

  // rats kneeling round the espresso machine, on free floor next to its slot
  const kneelers: SiteRat[] = [];
  const e = plan.landmarkSpots.espresso;
  if (e && standing.has('espresso')) {
    const looks = ['intern.brown', 'analyst.white', 'associate', 'intern.black'];
    for (const [i, j, m] of [[e.i0 + e.w, e.j0 + 1, true], [e.i0 + 1, e.j0 + e.h, false], [e.i0 + e.w, e.j0 + e.h, false], [e.i0 + e.w + 1, e.j0 + 2, true]] as const) {
      if (walkable(plan, i, j) && z.claim({ what: 'kneeler', cat: 'extra', cells: [[i, j]] }, ['office'])) kneelers.push({ look: looks[kneelers.length % looks.length]!, anim: 'kneel', i, j, mirror: m });
    }
  }
  const line = jobFairLine(plan, stage, z);
  return { zoning: z, keepItem, keepExtra, siteProps, cranes, crew, kneelers, pylon, standing, sewer, line };
}

/** Enough places for every applicant the page draws (rats.ts APPLICANT_CAP) and the hires waiting for a desk. */
const LINE_WANT = 2200;
const LINE_LANES = 10;

/**
 * The job-fair line: rats with no desk yet wait outside, never inside the office and never on the road. It starts by
 * the lobby door and runs round the office lane by lane (lane d is d tiles out from the outer wall), each lane back
 * the other way, like a queue folded round the block. Only apron and sidewalk tiles nothing else stands on; the
 * walkway from the sewer to the door stays clear. Claimed like everything else, so nothing overlaps it.
 */
function jobFairLine(plan: FloorLayout, stage: number, z: Zoning): Cell[] {
  const ring = plan.rings[stage]!;
  const [e0, e1] = [ring.entrance[0]!, ring.entrance[1]!];
  // the door is on the +i face or the +j face; u runs along that face, the walkway goes straight out of it
  const onI = e0.i === ring.i1 && e1.i === ring.i1;
  const uLo = Math.min(onI ? e0.j : e0.i, onI ? e1.j : e1.i);
  const uHi = Math.max(onI ? e0.j : e0.i, onI ? e1.j : e1.i);
  const out = onI ? ring.spawn.i - ring.i1 : ring.spawn.j - ring.j1;
  const walkway = (c: Cell, d: number): boolean => {
    const u = onI ? c.j : c.i;
    return d <= out + 1 && u >= uLo - 1 && u <= uHi + 1 && (onI ? c.i > ring.i1 : c.j > ring.j1);
  };
  for (let d = 1; d <= out; d++) {
    for (let u = uLo; u <= uHi; u++) {
      const c: [number, number] = onI ? [ring.i1 + d, u] : [u, ring.j1 + d];
      if (!z.takenBy(c[0], c[1])) z.claim({ what: 'walkway', cat: 'spawn', cells: [c] }, ['apron', 'sidewalk', 'spawn', 'street']);
    }
  }
  const eu = (uLo + uHi) / 2;
  const line: Cell[] = [];
  for (let d = 1; d <= LINE_LANES && line.length < LINE_WANT; d++) {
    // the loop d tiles out, clockwise in i/j, from just beside the door
    const a0 = ring.i0 - d;
    const a1 = ring.i1 + d;
    const b0 = ring.j0 - d;
    const b1 = ring.j1 + d;
    const loop: Cell[] = [];
    for (let i = a0; i < a1; i++) loop.push({ i, j: b0 });
    for (let j = b0; j < b1; j++) loop.push({ i: a1, j });
    for (let i = a1; i > a0; i--) loop.push({ i, j: b1 });
    for (let j = b1; j > b0; j--) loop.push({ i: a0, j });
    const start = loop.findIndex((c) => (onI ? c.i === a1 && c.j === Math.round(eu) : c.j === b1 && c.i === Math.round(eu)));
    let lane = [...loop.slice(start), ...loop.slice(0, start)];
    if (d % 2 === 0) lane = [lane[0]!, ...lane.slice(1).reverse()];
    for (const c of lane) {
      if (walkway(c, d)) continue;
      if (z.claim({ what: 'line', cat: 'line', cells: [[c.i, c.j]] }, ['apron', 'sidewalk'])) line.push(c);
    }
  }
  return line;
}

function walkable(plan: FloorLayout, i: number, j: number): boolean {
  const k = idx(plan.W, i, j);
  return plan.tile[k] !== T.WALL && !plan.blocked[k];
}

/** Rooms a scene treats as building sites (exported for the world's floor). */
export function siteRooms(plan: FloorLayout, open: Openness): Room[] {
  return plan.rooms.filter((r) => r.ring === open.stage && !open.built(r.id) && open.openStrip.has(`${r.ring}:${r.strip}`));
}
