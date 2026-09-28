// Isometric math. A cell is 32 x 16 px on screen (2:1). Cell (i, j) maps to the top apex of its tile.
// +i runs down-right on screen, +j runs down-left.

export const TILE_W = 32;
export const TILE_H = 16;

export interface Cell {
  i: number;
  j: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Top apex of cell (i, j). */
export function cellToScreen(i: number, j: number): Point {
  return { x: (i - j) * (TILE_W / 2), y: (i + j) * (TILE_H / 2) };
}

/** Centre of cell (i, j): where standing sprites put their feet. */
export function cellCentre(i: number, j: number): Point {
  return cellToScreen(i + 0.5, j + 0.5);
}

export function screenToCell(x: number, y: number): Cell {
  const a = x / (TILE_W / 2);
  const b = y / (TILE_H / 2);
  return { i: (a + b) / 2, j: (b - a) / 2 };
}

/** Painter's order: larger i + j is closer to the camera. */
export function depthOf(i: number, j: number): number {
  return i + j;
}
