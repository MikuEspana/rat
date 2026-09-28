// Film textures: the baked plates and frames (tools/film_build.py), and pixel text drawn at 1x. Everything is
// sampled nearest and scaled up by whole numbers, so a base pixel is always a square block on screen.
import { CanvasSource, ImageSource, Sprite, Texture } from 'pixi.js';
import meta from '../../assets/film/built/meta.json';

const urls = import.meta.glob('../../assets/film/built/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const T = new Map<string, Texture>();

export const META = meta as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`film texture ${url}`));
    img.src = url;
  });
}

export async function loadFilmTextures(): Promise<void> {
  await Promise.all(
    Object.entries(urls).map(async ([path, url]) => {
      const img = await loadImage(url);
      const name = path.split('/').pop()!.replace('.png', '');
      T.set(name, new Texture({ source: new ImageSource({ resource: img, scaleMode: 'nearest' }) }));
    }),
  );
}

export function tex(name: string): Texture {
  const t = T.get(name);
  if (!t) throw new Error(`film: no texture ${name}`);
  return t;
}

/** Frames baked as <prefix>_<i>. */
export function anim(prefix: string, count?: number): Texture[] {
  const n = count ?? (META[prefix] as number);
  return Array.from({ length: n }, (_, i) => tex(`${prefix}_${i}`));
}

export function has(name: string): boolean {
  return T.has(name);
}

/** A sprite at whole base pixels; anchor in base pixels from the texture's top-left. */
export function sprite(t: Texture, ax = 0, ay = 0): Sprite {
  const s = new Sprite(t);
  s.anchor.set(ax, ay);
  s.roundPixels = true;
  return s;
}

// ---------------------------------------------------------------- the bold 5x7 pixel font (strokes 2 px wide)
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
  ',': '....................##....#...#....', "'": '..#....#...#.......................',
  ' ': '...................................', ':': '.......##...##........##...##......',
  $: '..#...#####.#...###...#.#####...#..', '#': '.#.#..#.#.#####.#.#.#####.#.#..#.#.',
  '>': '#.....#.....#.....#...#...#...#....', '/': '....#...#....#...#...#....#...#....',
  '%': '##...##..#...#...#...#...#..##...##',
};

export const INK = '#16182c';
export const CREAM = '#fff4d6';
export const GOLD = '#f2c14e';
export const GREEN = '#3ecf6a';

export interface TextStyle {
  fill?: string;
  outline?: string | null;
  shadow?: boolean;
  bold?: boolean;
}

/** Width in base px of a line of text. */
export function textWidth(s: string, bold = true): number {
  return s.length * (bold ? 7 : 6) - 1;
}

/** Lines of pixel text as one texture (1 px per font pixel). */
export function textTexture(lines: string[], st: TextStyle = {}, gap = 3, align: 'center' | 'left' = 'center'): Texture {
  const bold = st.bold ?? true;
  const adv = bold ? 7 : 6;
  const pad = 2;
  const w = Math.max(...lines.map((l) => textWidth(l, bold))) + pad * 2 + 1;
  const h = lines.length * 7 + (lines.length - 1) * gap + pad * 2 + 1;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const glyphs = (fill: string, ox: number, oy: number, grow: number): void => {
    ctx.fillStyle = fill;
    lines.forEach((line, li) => {
      const lx = align === 'center' ? Math.floor((w - pad * 2 - 1 - textWidth(line, bold)) / 2) : 0;
      for (let i = 0; i < line.length; i++) {
        const g = G[line[i]!] ?? G[line[i]!.toUpperCase()] ?? G[' ']!;
        for (let k = 0; k < 35; k++) {
          if (g[k] !== '#') continue;
          const x = pad + lx + i * adv + (k % 5) + ox;
          const y = pad + li * (7 + gap) + Math.floor(k / 5) + oy;
          ctx.fillRect(x - grow, y - grow, (bold ? 2 : 1) + grow * 2, 1 + grow * 2);
        }
      }
    });
  };
  if (st.outline !== null) {
    if (st.shadow ?? true) glyphs(st.outline ?? INK, 0, 1, 1);
    glyphs(st.outline ?? INK, 0, 0, 1);
  }
  glyphs(st.fill ?? CREAM, 0, 0, 0);
  return new Texture({ source: new CanvasSource({ resource: c, scaleMode: 'nearest' }) });
}
