// Zoning: every tile of the world gets a zone (office, building site, landmark slot, apron, street, sidewalk, city lot,
// spawn), and every placement claims the tiles it stands on. A claim only succeeds on tiles of the zones it is allowed
// on and not already taken by something else: city buildings only in city lots, landmarks only in their slots, props
// only on free tiles of their zones. What does not fit is skipped, never forced.
import { CITY_KEY, type City } from './city';
import { T, idx, type FloorLayout } from './types';

export type Zone = 'void' | 'office' | 'site' | 'slot' | 'apron' | 'street' | 'sidewalk' | 'lot' | 'spawn';

/**
 * The zone map a viewer reads: inside the office (its floors, building sites and landmark slots), the street round
 * it (apron, sidewalks, road, city lots), where new rats come up (spawn), and beyond the city the skyline, where
 * only the far backdrop is drawn and nothing stands on a tile.
 */
export type Area = 'interior' | 'street' | 'spawn' | 'skyline';

export function areaOf(zone: Zone): Area {
  if (zone === 'office' || zone === 'site' || zone === 'slot') return 'interior';
  if (zone === 'spawn') return 'spawn';
  if (zone === 'void') return 'skyline';
  return 'street';
}

/** Which area each landmark belongs to: set pieces inside the office, the rocket and the annex in lots of their own. */
export const LANDMARK_AREA: Record<string, Area> = {
  vault: 'interior',
  espresso: 'interior',
  pingpong: 'interior',
  pit: 'interior',
  elevator: 'interior',
  gym: 'interior',
  helipad: 'interior',
  statue: 'interior',
  pool: 'interior',
  throne: 'interior',
  rocket: 'street',
  annex: 'street',
  pylon: 'street',
};

export type ClaimCat = 'wall' | 'furniture' | 'landmark' | 'vault' | 'building' | 'prop' | 'site' | 'extra' | 'spawn' | 'line';

export interface Claim {
  what: string;
  cat: ClaimCat;
  cells: Array<[number, number]>;
}

/** Which rooms of a stage stand, and which wings (strips) of the current ring are open. */
export interface Openness {
  stage: number;
  built: (roomId: number) => boolean;
  openStrip: Set<string>;
  closedRects: Array<{ i0: number; j0: number; w: number; h: number }>;
}

/** Wings open one at a time: a strip of a ring is open once any of its rooms stands. */
export function openness(plan: FloorLayout, stage: number, built: (roomId: number) => boolean): Openness {
  const openStrip = new Set<string>();
  for (const r of plan.rooms) if (r.ring >= 1 && r.ring <= stage && built(r.id)) openStrip.add(`${r.ring}:${r.strip}`);
  const closedRects: Openness['closedRects'] = [];
  for (let k = 1; k <= stage; k++) plan.rings[k]!.strips.forEach((st, n) => !openStrip.has(`${k}:${n}`) && closedRects.push(st));
  return { stage, built, openStrip, closedRects };
}

export const APRON = 2;

export class Zoning {
  private readonly zone = new Map<number, Zone>();
  private readonly slot = new Map<number, string>();
  private readonly taken = new Map<number, Claim>();
  readonly claims: Claim[] = [];
  readonly skipped: Claim[] = [];

  constructor(
    readonly plan: FloorLayout,
    readonly open: Openness,
    readonly city: City,
  ) {
    const { stage } = open;
    const ring = plan.rings[stage]!;
    // the city: streets, sidewalks and lots
    for (const [k, g] of city.ground) this.zone.set(k, g.style === 'asphalt' ? 'street' : g.style === 'sidewalk' || g.style === 'crosswalk' ? 'sidewalk' : 'lot');
    for (const l of city.lots) for (let i = l.i0; i < l.i0 + l.w; i++) for (let j = l.j0; j < l.j0 + l.h; j++) this.zone.set(CITY_KEY(i, j), 'lot');
    // the apron round the office
    for (let i = ring.i0 - APRON; i <= ring.i1 + APRON; i++) for (let j = ring.j0 - APRON; j <= ring.j1 + APRON; j++) this.zone.set(CITY_KEY(i, j), 'apron');
    // the office itself: open wings are office, shut wings of the current ring are a building site
    const closed = (i: number, j: number): boolean => open.closedRects.some((r) => i >= r.i0 && i < r.i0 + r.w && j >= r.j0 && j < r.j0 + r.h);
    for (let i = ring.i0; i <= ring.i1; i++) {
      for (let j = ring.j0; j <= ring.j1; j++) {
        const k = idx(plan.W, i, j);
        if (plan.ringOf[k]! > stage) continue;
        this.zone.set(CITY_KEY(i, j), closed(i, j) ? 'site' : 'office');
      }
    }
    // landmark slots and the Vault's plaza
    for (const [id, sp] of Object.entries(plan.landmarkSpots)) if (plan.rooms[sp.room]!.ring <= stage) this.markSlot(id, sp.i0, sp.j0, sp.w, sp.h);
    this.markSlot('vault', plan.vault.i - 3, plan.vault.j - 3, 6, 6);
    // where new rats come in
    this.zone.set(CITY_KEY(ring.spawn.i, ring.spawn.j), 'spawn');
  }

  private markSlot(id: string, i0: number, j0: number, w: number, h: number): void {
    for (let i = i0; i < i0 + w; i++) {
      for (let j = j0; j < j0 + h; j++) {
        this.zone.set(CITY_KEY(i, j), 'slot');
        this.slot.set(CITY_KEY(i, j), id);
      }
    }
  }

  zoneAt(i: number, j: number): Zone {
    return this.zone.get(CITY_KEY(i, j)) ?? 'void';
  }

  areaAt(i: number, j: number): Area {
    return areaOf(this.zoneAt(i, j));
  }

  slotAt(i: number, j: number): string | null {
    return this.slot.get(CITY_KEY(i, j)) ?? null;
  }

  takenBy(i: number, j: number): Claim | null {
    return this.taken.get(CITY_KEY(i, j)) ?? null;
  }

  /** The cells a placement needs are all in its zones (and its own slot, for a landmark) and all free: take them. */
  claim(c: Claim, zones: readonly Zone[], slot?: string): boolean {
    for (const [i, j] of c.cells) {
      if (!zones.includes(this.zoneAt(i, j))) return this.skip(c);
      if (slot !== undefined && this.slotAt(i, j) !== slot) return this.skip(c);
      if (this.taken.has(CITY_KEY(i, j))) return this.skip(c);
    }
    for (const [i, j] of c.cells) this.taken.set(CITY_KEY(i, j), c);
    this.claims.push(c);
    return true;
  }

  private skip(c: Claim): false {
    this.skipped.push(c);
    return false;
  }

  /** The office as it stands: its walls and the furniture of built rooms take their tiles first. */
  claimOffice(): void {
    const { plan } = this;
    const { stage, built } = this.open;
    const ring = plan.rings[stage]!;
    for (let i = ring.i0; i <= ring.i1; i++) {
      for (let j = ring.j0; j <= ring.j1; j++) {
        const k = idx(plan.W, i, j);
        if (plan.ringOf[k]! > stage) continue;
        const t = plan.tile[k];
        if (t === T.WALL) this.force({ what: 'wall', cat: 'wall', cells: [[i, j]] });
        else if (plan.blocked[k] && t === T.ROOM && built(plan.roomOf[k]!)) this.force({ what: 'furniture', cat: 'furniture', cells: [[i, j]] });
      }
    }
  }

  private force(c: Claim): void {
    for (const [i, j] of c.cells) this.taken.set(CITY_KEY(i, j), c);
    this.claims.push(c);
  }
}

/** The cells of a w x h rectangle. */
export function rectCells(i0: number, j0: number, w: number, h: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = i0; i < i0 + w; i++) for (let j = j0; j < j0 + h; j++) out.push([i, j]);
  return out;
}
