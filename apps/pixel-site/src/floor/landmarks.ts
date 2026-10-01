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
  { id: 'statue', name: 'GIANT GOLDEN SHIBA', at: 1000 },
  { id: 'pool', name: 'ROOFTOP POOL PARTY', at: 1500 },
  { id: 'rocket', name: 'INU ROCKET LAUNCHPAD', at: 2000 },
  { id: 'throne', name: 'EVIL THRONE ROOM', at: 3000 },
];

/** Side of the slot each tower stands in (cells). */
export const TOWER_SLOT = 8;

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

/** Tower floors: the tower goes up with the glass elevator (6 floors) and gains a floor every 25 rats (capped), so
 *  its slot in the core stays the same size while it towers higher over an office that grows every stage. */
export function towerFloors(count: number): number {
  if (count < 100) return 0;
  return Math.min(120, 6 + Math.floor((count - 100) / 25));
}
