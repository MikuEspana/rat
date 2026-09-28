// The zoning test: for the company at 0, 10, 100, 1,000 and 2,000 rats (and more), nothing overlaps anything and
// nothing sits outside its zone: city buildings only in city lots, landmarks only in their slots (or their own lots),
// building-site props only on free floor of the office or a shut wing, street props on sidewalks and lots, the
// job-fair line outside on the apron and sidewalks. And no two signs overlap at any zoom, with every landmark's name
// kept.
import { describe, expect, it } from 'vitest';
import worldJson from '../../assets/world.json';
import props2Json from '../../assets/props2.json';
import genJson from '../../assets/gen.json';
import props3Json from '../../assets/props3.json';
import { buildCity, CITY_KEY } from './city';
import { Growth } from './growth';
import { layoutLabels, overlaps, type LabelBox } from './labels';
import { LANDMARKS } from './landmarks';
import { buildMaster } from './plan';
import { layoutScene } from './scene';
import { planSigns, ROOMS_FROM_ZOOM, signBoxes, vaultKeepOut, type FrameSize } from './signs';
import { idx, T } from './types';
import { LANDMARK_AREA, openness } from './zones';

const SYMBOLS = ['TSLAx', 'MSTRx', 'COINx', 'AMDx', 'NVDAx', 'AAPLx', 'METAx', 'AMZNx', 'GOOGLx', 'SPYx'];
const plan = buildMaster();
/** the counts the owner asked for, and the stage edges in between */
const COUNTS = [0, 10, 100, 1000, 2000, 1, 25, 500, 1500, 3000, 5000];
/** zoomed right out (the whole city), the default view, mid zoom (room names), close up */
const ZOOMS = [0.3, 0.45, 0.62, 0.8, 1, 1.3];

type AtlasJson = { frames: Record<string, { frame: { w: number; h: number } }> };
const FRAMES: FrameSize = (kind) => {
  for (const j of [props3Json, genJson, props2Json, worldJson] as AtlasJson[]) {
    const f = j.frames[kind];
    if (f) return { w: f.frame.w, h: f.frame.h };
  }
  return null;
};

function sceneAt(n: number) {
  const g = new Growth(plan);
  for (let id = 1; id <= n; id++) g.add(id, SYMBOLS[(id * 7 + (id >> 3)) % SYMBOLS.length]!);
  const built = (id: number): boolean => g.built[id] === 1;
  const open = openness(plan, g.stage, built);
  const city = buildCity(plan, g.stage, () => true, () => ({ w: 200, h: 240 }));
  const scene = layoutScene(plan, open, city, n);
  return { g, open, city, scene, built };
}

describe('zoning', () => {
  for (const n of COUNTS) {
    it(`${n.toLocaleString('en-US')} rats: no two things on one tile, everything in its zone, the job-fair line outside`, () => {
      const { g, open, city, scene } = sceneAt(n);
      const z = scene.zoning;
      const ring = plan.rings[g.stage]!;

      // no two things on one tile (sprites never stand on each other)
      const seen = new Map<number, string>();
      const clashes: string[] = [];
      for (const c of z.claims) {
        for (const [i, j] of c.cells) {
          const k = CITY_KEY(i, j);
          if (seen.has(k)) clashes.push(`${c.what} on ${seen.get(k)} at ${i},${j}`);
          seen.set(k, c.what);
        }
      }
      expect(clashes).toEqual([]);

      // every thing in its zone
      for (const c of z.claims) {
        for (const [i, j] of c.cells) {
          const zone = z.zoneAt(i, j);
          const at = `${c.what} at ${i},${j} (${zone})`;
          if (c.cat === 'building') expect(zone, at).toBe('lot');
          else if (c.cat === 'vault') expect(z.slotAt(i, j)).toBe('vault');
          else if (c.cat === 'landmark') {
            if (c.what === 'rocket' || c.what === 'annex') expect(zone, at).toBe('lot');
            else if (c.what === 'pylon') expect(zone, at).toBe('apron');
            else expect(z.slotAt(i, j), at).toBe(c.what);
            // indoor landmarks inside, outdoor ones outside
            expect(z.areaAt(i, j), at).toBe(LANDMARK_AREA[c.what]);
          } else if (c.cat === 'site') {
            expect(['office', 'site'], at).toContain(zone);
            expect(plan.tile[idx(plan.W, i, j)]).not.toBe(T.WALL);
          } else if (c.cat === 'prop') expect(['sidewalk', 'lot'], at).toContain(zone);
          else if (c.cat === 'extra') expect(['sidewalk', 'lot', 'office', 'site'], at).toContain(zone);
          else if (c.cat === 'spawn') expect(['spawn', 'apron', 'sidewalk', 'street'], at).toContain(zone);
          else if (c.cat === 'line') expect(['apron', 'sidewalk'], at).toContain(zone);
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
      // the sewer's way out always fits in front of the lobby
      expect(scene.sewer.some((p) => p.main)).toBe(true);
      // shut wings exist only in the current ring
      for (const r of open.closedRects) expect(r.i0 >= ring.i0 - 1 && r.i0 + r.w <= ring.i1 + 2).toBe(true);

      // the job-fair line: outside the office, head by the lobby door, room for the rats the page draws, a line
      const line = scene.line;
      const door = ring.entrance[1]!;
      // the garage's small town holds a shorter line (the rest are counted on the JOB FAIR sign, never stacked)
      expect(line.length).toBeGreaterThan([250, 550, 1200][g.stage] ?? 1500);
      expect(Math.abs(line[0]!.i - door.i) + Math.abs(line[0]!.j - door.j)).toBeLessThanOrEqual(6);
      for (const c of line) {
        expect(c.i < ring.i0 || c.i > ring.i1 || c.j < ring.j0 || c.j > ring.j1, `line at ${c.i},${c.j}`).toBe(true);
        expect(z.areaAt(c.i, c.j)).toBe('street');
      }
      let jumps = 0;
      for (let k = 1; k < line.length; k++) if (Math.abs(line[k]!.i - line[k - 1]!.i) + Math.abs(line[k]!.j - line[k - 1]!.j) > 3) jumps++;
      // a line, not a crowd: unbroken runs of a dozen rats or more on average (it hops a road or a lamp now and then)
      expect(jumps).toBeLessThan(line.length / 12);
    });
  }
});

describe('signs', () => {
  for (const n of COUNTS.slice(0, 5)) {
    it(`${n.toLocaleString('en-US')} rats: no two signs overlap at any zoom, and every landmark keeps its name`, () => {
      const { g, city, scene, built } = sceneAt(n);
      const spots = planSigns({
        plan, stage: g.stage, count: n, built, symbolOf: g.symbolOf, city, scene, frames: FRAMES,
        fair: scene.line.length ? { head: scene.line[0]!, count: 1234 } : null,
      });
      const landmarks = spots.filter((s) => s.kind === 'landmark' && s.key !== 'vault');
      const hiring = scene.sewer.some((p) => p.main && p.kind === 'tunnel') ? 1 : 0;
      expect(landmarks.length).toBe(LANDMARKS.filter((l) => n >= l.at).length + (scene.standing.has('annex') ? 1 : 0) + hiring);
      expect(spots.some((s) => s.key === 'vault')).toBe(true);
      const keepOut = [vaultKeepOut(plan, FRAMES)];
      for (const z of ZOOMS) {
        const { boxes, index } = signBoxes(spots, z, keepOut);
        const laid = layoutLabels(boxes);
        // nothing overlaps: no two signs, and no sign over the Vault's pile or its "+$X" (the keep-out box)
        expect(overlaps(boxes, laid), `zoom ${z}`).toBe(0);
        index.forEach((si, k) => {
          if (si < 0) return;
          const s = spots[si]!;
          // the landmarks (THE VAULT among them), the key rooms and the company keep their names at every zoom
          if (s.kind === 'landmark' || s.kind === 'key' || s.kind === 'name') expect(laid[k]!.visible, `${s.text} at zoom ${z}`).toBe(true);
          // zoomed out, no desk room, break room, open office, WC or lobby is named
          if (z < ROOMS_FROM_ZOOM - 0.1) expect(s.kind, `${s.text} at zoom ${z}`).not.toBe('room');
        });
      }
      // under the pointer a room is named whatever the zoom
      const room = spots.find((s) => s.kind === 'room');
      if (room) {
        const { index } = signBoxes(spots, 0.45, keepOut, new Set([room.key]));
        expect(index.map((k) => spots[k]?.key)).toContain(room.key);
      }
    });
  }

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
