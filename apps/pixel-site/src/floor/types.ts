// Shared types for the office floor. Cells are (i, j): +i runs down-right on screen, +j down-left.
import type { Cell } from '../iso';

export type RoomKind =
  | 'garage' | 'open' | 'stock' | 'hq' | 'ceo' | 'lobby' | 'break' | 'bath' | 'server' | 'copy' | 'meeting' | 'storage' | 'war' | 'vault';

/** Screen facing: se = +i, sw = +j, ne = -j, nw = -i. */
export type Face = 'se' | 'sw' | 'ne' | 'nw';

/** What a cell is. Everything outside the street ring is VOID (night sky). */
export const T = { VOID: 0, STREET: 1, ROOM: 2, CORRIDOR: 3, WALL: 4, DOOR: 5 } as const;
export type TileType = (typeof T)[keyof typeof T];

export type FloorStyle =
  | 'carpet' | 'vinyl' | 'wood_i' | 'wood_j' | 'bath' | 'checker' | 'raised' | 'concrete' | 'marble' | 'asphalt' | 'sidewalk'
  | 'driveway' | 'lot' | 'blueprint' | 'grass' | 'platform';

export interface Seat {
  id: number;
  room: number;
  /** stock symbol for stock desks, null for the CEO office */
  symbol: string | null;
  /** the cell the chair stands on (blocked for walking) */
  cell: Cell;
  /** the desk's long side: 'j' (sprites as drawn) or 'i' (mirrored) */
  axis: 'i' | 'j';
  /** 'front': the rat sits behind its desk facing the camera; 'back': in front of it, back to the camera */
  view: 'front' | 'back';
  /** centre of the desk's 2-cell footprint (fractional cell, like pos) */
  deskAt: Cell;
  /** where the seated rat goes (fractional cell) */
  pos: Cell;
  /** desks come in pods (2 to 4 facing each other, or a row along a wall); a pod shows once one of its rats is in */
  pod: number;
  /** cells the desk and chair take (blocked) */
  cells: Cell[];
  /** free cell next to the chair where walks start and end */
  access: Cell;
  /** screen-pixel nudge shared by desk, chair and rat, so rows are not ruler-straight */
  dx: number;
  dy: number;
  /** 0 clutter desk, 1 clean desk, 2 dark wood (CEO) */
  variant: number;
}

export type SpotKind =
  | 'coffee' | 'cooler' | 'vending' | 'fridge' | 'chat' | 'sink' | 'toilet' | 'server' | 'copier' | 'filing'
  | 'whiteboard' | 'meeting' | 'shelf' | 'furnace' | 'smoke' | 'boxes' | 'queue' | 'lobby';

export interface Spot {
  id: number;
  kind: SpotKind;
  room: number;
  /** walkable cell the rat walks to */
  cell: Cell;
  /** exact stand or sit position (fractional) */
  pos: Cell;
  face: Face;
  pose: 'stand' | 'sit';
  /** street spots: the stage whose street they stand on */
  ring?: number;
}

export interface Prop {
  kind: string;
  /** anchor cell: the sprite's bottom centre sits on this cell's centre (plus dx, dy) */
  i: number;
  j: number;
  mirror: boolean;
  /** flat props (cables, rugs) go in the floor layer and never block */
  flat?: boolean;
  dx?: number;
  dy?: number;
  tint?: number;
  /** extra painter's-order bias */
  bias?: number;
  /** props that are lights: glow colour */
  glow?: number;
  /** hung on a wall: the wall cell (i, j) and the way the wall runs ('i' back-right wall, 'j' back-left wall) */
  wall?: 'i' | 'j';
  /** street props: the stage whose street they stand on */
  ring?: number;
  /** sprite scale (server racks are drawn smaller than their art) */
  scale?: number;
  /** props of a desk pod (drawn only while the pod stands) */
  pod?: number;
}

/** A posed rat that belongs to the set, not the roster (vignettes). */
export interface Actor {
  room: number;
  /** atlas look: tier, or tier.fur */
  look: string;
  anim: string;
  mirror: boolean;
  i: number;
  j: number;
  dx: number;
  dy: number;
  tears: boolean;
  zzz: boolean;
  story: string;
}

export interface Room {
  id: number;
  kind: RoomKind;
  symbol: string | null;
  /** interior rectangle (walls are the ring of cells just outside it) */
  i0: number;
  j0: number;
  w: number;
  h: number;
  floor: FloorStyle;
  tint: number;
  doors: Cell[];
  /** wall ticker: first wall cell and the axis the wall runs along ('i': back-right wall, 'j': back-left wall) */
  ticker: { i: number; j: number; axis: 'i' | 'j' } | null;
  seats: Seat[];
  spots: Spot[];
  /** growth: the ring (stage) the room belongs to, 0 = the garage */
  ring: number;
  /** growth: the room it opens into (-1: the ring corridor); it can only be built after that one */
  parent: number;
  /** growth: amenities are built at this rat count; null = built on demand (desks) or at stage start (lobby) */
  unlockAt: number | null;
  /** growth: fixed build order among the ring's demand-built rooms */
  order: number;
}

export interface Ring {
  index: number;
  /** outer wall square of the building once this ring stands (inclusive) */
  i0: number;
  j0: number;
  i1: number;
  j1: number;
  lobby: number;
  /** the subway stairs while this is the outermost ring */
  spawn: Cell;
  entrance: Cell[];
}

export interface FloorLayout {
  /** grid size in cells (street ring included) */
  W: number;
  H: number;
  tile: Uint8Array;
  /** room id per cell, -1 outside rooms */
  roomOf: Int16Array;
  /** 1 = cannot walk here (walls, furniture, chairs, void) */
  blocked: Uint8Array;
  /** wall height in blocks per cell (0 = no wall) */
  wallH: Uint8Array;
  /** floor look per cell (index into FLOOR_STYLES) and its tint */
  floorOf: Uint8Array;
  floorTint: Uint32Array;
  rooms: Room[];
  seats: Seat[];
  spots: Spot[];
  props: Prop[];
  /** stock rooms by symbol (a big stock gets several rooms) */
  bySymbol: Map<string, Room[]>;
  hq: Room;
  ceo: Room;
  lobby: Room;
  /** top of the subway stairs, on the street: new hires appear here */
  spawn: Cell;
  furnace: Cell;
  /** building rectangle (outer walls included) */
  building: { i0: number; j0: number; i1: number; j1: number };
  /** corridor cells, for rats out for a stroll */
  corridor: Cell[];
  /** growth: rings from the garage outwards, and which ring each cell belongs to (rings.length = outside) */
  rings: Ring[];
  ringOf: Uint8Array;
  /** growth: the two regions a door joins (room id, or CORRIDOR_REGION + ring) */
  doorSides: Map<number, [number, number]>;
  garage: Room;
  /** vignette extras */
  actors: Actor[];
}

export const CORRIDOR_REGION = 10000;

export const FLOOR_STYLES: FloorStyle[] = [
  'carpet', 'vinyl', 'wood_i', 'wood_j', 'bath', 'checker', 'raised', 'concrete', 'marble', 'asphalt', 'sidewalk', 'driveway', 'lot',
  'blueprint', 'grass', 'platform',
];

export function idx(W: number, i: number, j: number): number {
  return j * W + i;
}
