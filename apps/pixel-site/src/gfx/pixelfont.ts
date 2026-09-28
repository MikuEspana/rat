// A 5x7 pixel font for the wall tickers, drawn into a canvas so text stays as crisp as the pixel art.
// '^' draws an up triangle, '_' a down triangle.

const G: Record<string, string> = {
  '0': '.###.#...##..###.#.###..##...#.###.', '1': '..#...##....#....#....#....#...###.',
  '2': '.###.#...#....#...#...#...#...#####', '3': '#####...#...#......#....##...#.###.',
  '4': '...#...##..#.#.#..#.#####...#....#.', '5': '######....####.....#....##...#.###.',
  '6': '..##..#...#....####.#...##...#.###.', '7': '#####....#...#...#...#....#....#...',
  '8': '.###.#...##...#.###.#...##...#.###.', '9': '.###.#...##...#.####....#...#..##..',
  A: '.###.#...##...#######...##...##...#', B: '####.#...##...#####.#...##...#####.',
  C: '.###.#...##....#....#....#...#.###.', D: '####.#...##...##...##...##...#####.',
  E: '######....#....####.#....#....#####', F: '######....#....####.#....#....#....',
  G: '.###.#...##....#.####...##...#.####', H: '#...##...##...#######...##...##...#',
  I: '.###...#....#....#....#....#...###.', J: '..###...#....#....#....##..#..##...',
  K: '#...##..#.#.#..##...#.#..#..#.#...#', L: '#....#....#....#....#....#....#####',
  M: '#...###.###.#.##...##...##...##...#', N: '#...###..##.#.##..###...##...##...#',
  O: '.###.#...##...##...##...##...#.###.', P: '####.#...##...#####.#....#....#....',
  Q: '.###.#...##...##...##.#.##..#..##.#', R: '####.#...##...#####.#.#..#..#.#...#',
  S: '.####.....#.....###.....#....#####.', T: '#####..#....#....#....#....#....#..',
  U: '#...##...##...##...##...##...#.###.', V: '#...##...##...##...##...#.#.#...#..',
  W: '#...##...##...##.#.##.#.##.#.#.#.#.', X: '#...##...#.#.#...#...#.#.#...##...#',
  Y: '#...##...#.#.#...#....#....#....#..', Z: '#####....#...#...#...#...#....#####',
  x: '..........#...#.#.#...#...#.#.#...#', '+': '.......#....#..#####..#....#.......',
  '-': '...............#####...............', '.': '..............................##...',
  '%': '##...##..#...#...#...#...#..##...##', ' ': '...................................',
  '^': '.........#....#...###..#####.......', _: '.......#####..###....#....#........',
  ':': '.......##...##........##...##......', $: '..#...#####.#...###...#.#####...#..',
};

export const GLYPH_W = 5;
export const GLYPH_H = 7;

export function textWidth(text: string, scale = 1): number {
  return text.length ? (text.length * (GLYPH_W + 1) - 1) * scale : 0;
}

export function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, scale = 1): void {
  ctx.fillStyle = color;
  let cx = x;
  for (const ch of text) {
    const g = G[ch] ?? G[ch.toUpperCase()] ?? G[' ']!;
    for (let k = 0; k < 35; k++) {
      if (g[k] === '#') ctx.fillRect(cx + (k % 5) * scale, y + Math.floor(k / 5) * scale, scale, scale);
    }
    cx += (GLYPH_W + 1) * scale;
  }
}

/** Shear a canvas 2:1 down-right (each column moves down x/2 px), like the wall ticker sprite. */
export function shearRightWall(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height + Math.floor(src.width / 2) + 1;
  const ctx = out.getContext('2d')!;
  for (let x = 0; x < src.width; x++) ctx.drawImage(src, x, 0, 1, src.height, x, Math.floor(x / 2), 1, src.height);
  return out;
}

/** Shear a canvas 2:1 down-left (each column moves down (w - 1 - x)/2 px): for a wall running down-left. */
export function shearLeftWall(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height + Math.floor(src.width / 2) + 1;
  const ctx = out.getContext('2d')!;
  for (let x = 0; x < src.width; x++) ctx.drawImage(src, x, 0, 1, src.height, x, Math.floor((src.width - 1 - x) / 2), 1, src.height);
  return out;
}
