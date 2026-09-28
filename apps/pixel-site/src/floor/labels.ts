// Label layout: signs never overlap. The most important go first (landmarks, then the company name, then "next"
// signs, then room names); a sign that would overlap one already placed moves up a step or two if it may, otherwise
// it is hidden for this zoom. Pure, so it is tested on its own.
export interface LabelBox {
  /** anchor: bottom centre, world px */
  x: number;
  y: number;
  /** size at the current zoom, world px */
  w: number;
  h: number;
  /** lower goes first */
  prio: number;
  /** how many steps up it may move to get clear */
  steps: number;
}

export interface LabelSpot {
  visible: boolean;
  /** how far it moved up (world px) */
  dy: number;
}

const GAP = 2;

export function layoutLabels(boxes: readonly LabelBox[]): LabelSpot[] {
  const order = boxes.map((_, n) => n).sort((a, b) => boxes[a]!.prio - boxes[b]!.prio || boxes[b]!.y - boxes[a]!.y);
  const out: LabelSpot[] = boxes.map(() => ({ visible: false, dy: 0 }));
  // placed rectangles in a coarse grid so big label sets stay quick
  const CELL = 128;
  const grid = new Map<string, Array<[number, number, number, number]>>();
  const keys = (x0: number, y0: number, x1: number, y1: number): string[] => {
    const ks: string[] = [];
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) ks.push(`${gx},${gy}`);
    return ks;
  };
  const clear = (x0: number, y0: number, x1: number, y1: number): boolean => {
    for (const k of keys(x0, y0, x1, y1)) {
      for (const [a0, b0, a1, b1] of grid.get(k) ?? []) if (x0 < a1 && x1 > a0 && y0 < b1 && y1 > b0) return false;
    }
    return true;
  };
  for (const n of order) {
    const b = boxes[n]!;
    for (let s = 0; s <= b.steps; s++) {
      const dy = s * (b.h + GAP);
      const x0 = b.x - b.w / 2 - GAP;
      const x1 = b.x + b.w / 2 + GAP;
      const y0 = b.y - dy - b.h - GAP;
      const y1 = b.y - dy + GAP;
      if (!clear(x0, y0, x1, y1)) continue;
      for (const k of keys(x0, y0, x1, y1)) {
        const list = grid.get(k) ?? [];
        list.push([x0, y0, x1, y1]);
        grid.set(k, list);
      }
      out[n] = { visible: true, dy };
      break;
    }
  }
  return out;
}

/** Do any two of these (visible, moved) labels overlap? For the tests. */
export function overlaps(boxes: readonly LabelBox[], spots: readonly LabelSpot[]): number {
  let n = 0;
  const rects = boxes.map((b, k) => ({ v: spots[k]!.visible, x0: b.x - b.w / 2, x1: b.x + b.w / 2, y0: b.y - spots[k]!.dy - b.h, y1: b.y - spots[k]!.dy }));
  for (let a = 0; a < rects.length; a++) {
    for (let b = a + 1; b < rects.length; b++) {
      const p = rects[a]!;
      const q = rects[b]!;
      if (p.v && q.v && p.x0 < q.x1 && p.x1 > q.x0 && p.y0 < q.y1 && p.y1 > q.y0) n++;
    }
  }
  return n;
}
