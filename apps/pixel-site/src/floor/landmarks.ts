// Landmark unlocks: one unique set piece per milestone, each with its own place in the world. Interior ones get a
// space kept clear in their room when the plan is furnished (plan.ts); the tower, the basement, the rocket lot and
// the rooftops are placed by the world build. main.ts flies the camera to each one when it unlocks.
export interface LandmarkDef {
  id: string;
  name: string;
  /** rat count that unlocks it */
  at: number;
}

export const LANDMARKS: LandmarkDef[] = [
  { id: 'espresso', name: 'ESPRESSO SHRINE', at: 10 },
  { id: 'pingpong', name: 'PING PONG TABLE', at: 25 },
  { id: 'pit', name: 'CRYPTO TRADING PIT', at: 50 },
  { id: 'elevator', name: 'GLASS ELEVATOR', at: 100 },
  { id: 'gym', name: 'BASEMENT GYM AND NAP PODS', at: 250 },
  { id: 'helipad', name: 'ROOFTOP HELIPAD', at: 500 },
  { id: 'statue', name: 'GIANT GOLDEN RAT', at: 1000 },
  { id: 'pool', name: 'ROOFTOP POOL PARTY', at: 1500 },
  { id: 'rocket', name: 'RAT ROCKET LAUNCHPAD', at: 2000 },
  { id: 'throne', name: 'EVIL THRONE ROOM', at: 3000 },
];

/** A space kept clear in a room for an interior landmark (cells, inclusive start, w x h). */
export interface LandmarkSpot {
  i0: number;
  j0: number;
  w: number;
  h: number;
}

export function unlocked(count: number): Set<string> {
  return new Set(LANDMARKS.filter((l) => count >= l.at).map((l) => l.id));
}

/** Tower floors: the tower goes up with the glass elevator (6 floors) and gains a floor every 30 rats (capped). */
export function towerFloors(count: number): number {
  if (count < 100) return 0;
  return Math.min(60, 6 + Math.floor((count - 100) / 30));
}

/** How big the towers are drawn per stage, so they keep towering over an office that grows every stage. */
const TOWER_SCALE = [1, 1, 1.4, 2, 2.6, 3.2];
export function towerScale(stage: number): number {
  return TOWER_SCALE[Math.max(0, Math.min(TOWER_SCALE.length - 1, stage))]!;
}

/** A tower's footprint: its front vertex (the corner nearest the viewer) and its side in cells. */
export interface TowerSpot {
  /** front vertex, in cells */
  fi: number;
  fj: number;
  /** footprint side, cells: it covers fi-n..fi-1 by fj-n..fj-1 */
  n: number;
}

/** Where the towers stand for a ring: tower A behind the back corner (from the glass elevator on), tower B behind
 *  the middle of the back-left side (from megacorp on). The city keeps their ground clear. */
export function towerSpots(ring: { i0: number; j0: number; j1: number }, stage: number): { a: TowerSpot; b: TowerSpot | null } {
  const n = Math.round(6 * towerScale(stage));
  return {
    a: { fi: ring.i0 - 4, fj: ring.j0 - 4, n },
    b: stage >= 4 ? { fi: ring.i0 - 4, fj: Math.round((ring.j0 + ring.j1) / 2) + 3, n } : null,
  };
}
