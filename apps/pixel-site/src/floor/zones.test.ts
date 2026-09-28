// The zoning test: for the company at 1, 25, 100, 500, 1,500, 3,000 and 5,000 rats, nothing overlaps anything and
// nothing sits outside its zone: city buildings only in city lots, landmarks only in their slots (or their own lots),
// building-site props only on free floor of the office or a shut wing, street props on sidewalks and lots.
import { describe, expect, it } from 'vitest';
import { buildCity, CITY_KEY } from './city';
import { Growth } from './growth';
import { layoutLabels, overlaps, type LabelBox } from './labels';
import { LANDMARKS } from './landmarks';
import { buildMaster } from './plan';
import { layoutScene } from './scene';
import { idx, T } from './types';
import { openness } from './zones';

const SYMBOLS = ['TSLAx', 'MSTRx', 'COINx', 'AMDx', 'NVDAx', 'AAPLx', 'METAx', 'AMZNx', 'GOOGLx', 'SPYx'];
const plan = buildMaster();
const COUNTS = [1, 25, 100, 500, 1500, 3000, 5000];

function sceneAt(n: number) {
  const g = new Growth(plan);
  for (let id = 1; id <= n; id++) g.add(id, SYMBOLS[(id * 7 + (id >> 3)) % SYMBOLS.length]!);
  const open = openness(plan, g.stage, (id) => g.built[id] === 1);
  const city = buildCity(plan, g.stage, () => true, () => ({ w: 200, h: 240 }));
  return { g, open, city, scene: layoutScene(plan, open, city, n) };
}

describe('zoning', () => {
  for (const n of COUNTS) {
    it(`${n.toLocaleString('en-US')} rats: nothing overlaps, nothing sits outside its zone`, () => {
      const { g, open, city, scene } = sceneAt(n);
      const z = scene.zoning;
      const ring = plan.rings[g.stage]!;

      // no two things on one tile
      const seen = new Map<number, string>();
      let clashes = 0;
      for (const c of z.claims) {
        for (const [i, j] of c.cells) {
          const k = CITY_KEY(i, j);
          if (seen.has(k)) clashes++;
          seen.set(k, c.what);
        }
      }
      expect(clashes).toBe(0);

      // every thing in its zone
      for (const c of z.claims) {
        for (const [i, j] of c.cells) {
          const zone = z.zoneAt(i, j);
          if (c.cat === 'building') expect(zone, `${c.what} at ${i},${j}`).toBe('lot');
          else if (c.cat === 'vault') expect(z.slotAt(i, j)).toBe('vault');
          else if (c.cat === 'landmark') {
            if (c.what === 'rocket' || c.what === 'annex') expect(zone).toBe('lot');
            else if (c.what === 'pylon') expect(zone).toBe('apron');
            else expect(z.slotAt(i, j), `${c.what} at ${i},${j}`).toBe(c.what);
          } else if (c.cat === 'site') {
            expect(['office', 'site']).toContain(zone);
            expect(plan.tile[idx(plan.W, i, j)]).not.toBe(T.WALL);
          } else if (c.cat === 'prop') expect(['sidewalk', 'lot']).toContain(zone);
          else if (c.cat === 'extra') expect(['sidewalk', 'lot', 'office', 'site']).toContain(zone);
        }
      }

      // the city stays out of the office and its apron (the office's shut wings are building sites, not city)
      for (const l of city.lots) {
        const clear = l.i0 + l.w - 1 < ring.i0 - 2 || l.i0 > ring.i1 + 2 || l.j0 + l.h - 1 < ring.j0 - 2 || l.j0 > ring.j1 + 2;
        expect(clear, `lot ${l.use} at ${l.i0},${l.j0}`).toBe(true);
      }
      city.items.forEach((it, k) => {
        if (!scene.keepItem[k] || it.flat) return;
        const inside = it.i >= ring.i0 - 2 && it.i <= ring.i1 + 2 && it.j >= ring.j0 - 2 && it.j <= ring.j1 + 2;
        expect(inside, `${it.kind} at ${it.i},${it.j}`).toBe(false);
      });

      // every landmark unlocked by now stands in its slot (the helipad on tower A, the pool party on tower B)
      const slotOf: Record<string, string> = { helipad: 'elevator' };
      for (const l of LANDMARKS) {
        if (n < l.at) continue;
        const id = slotOf[l.id] ?? l.id;
        expect(scene.standing.has(id), `${l.name} at ${n} rats`).toBe(true);
      }
      // shut wings exist only in the current ring
      for (const r of open.closedRects) expect(r.i0 >= ring.i0 - 1 && r.i0 + r.w <= ring.i1 + 2).toBe(true);
    });
  }
});

describe('labels', () => {
  it('never overlap: the first come, the rest move up or hide', () => {
    let seed = 7;
    const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const boxes: LabelBox[] = [];
    for (let k = 0; k < 400; k++) boxes.push({ x: rnd() * 2000, y: rnd() * 1200, w: 60 + rnd() * 140, h: 18 + rnd() * 10, prio: Math.floor(rnd() * 4), steps: Math.floor(rnd() * 3) });
    const spots = layoutLabels(boxes);
    expect(overlaps(boxes, spots)).toBe(0);
    expect(spots.filter((s) => s.visible).length).toBeGreaterThan(50);
  });

  it('keeps every landmark name when landmarks are spread out, stacking the ones that would collide', () => {
    const boxes: LabelBox[] = [
      { x: 0, y: 0, w: 160, h: 20, prio: 0, steps: 3 },
      { x: 20, y: 5, w: 180, h: 20, prio: 0, steps: 3 },
      { x: 40, y: 10, w: 140, h: 20, prio: 0, steps: 3 },
      { x: 10, y: 0, w: 200, h: 24, prio: 1, steps: 2 },
      { x: 30, y: 2, w: 100, h: 16, prio: 3, steps: 0 },
    ];
    const spots = layoutLabels(boxes);
    expect(overlaps(boxes, spots)).toBe(0);
    expect(spots.slice(0, 3).every((s) => s.visible)).toBe(true);
    expect(spots[4]!.visible).toBe(false);
  });
});
