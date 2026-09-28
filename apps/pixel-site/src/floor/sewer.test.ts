import { describe, expect, it } from 'vitest';
import { sewerParts, SPAWN_STAGES, spawnStageOf } from './sewer';

describe('the sewer (where new rats come up)', () => {
  it('grows with the hires: one manhole, two, a steaming grate, a big sewer entrance', () => {
    expect(SPAWN_STAGES.map((s) => s.min)).toEqual([0, 50, 250, 1000]);
    expect([0, 49, 50, 249, 250, 999, 1000, 9000].map(spawnStageOf)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    const at = { i: 100, j: 100 };
    const kinds = (stage: number): string[] => sewerParts(stage, at).map((p) => `${p.kind}${p.main ? '*' : ''}`).sort();
    expect(kinds(0)).toEqual(['manhole*']);
    expect(kinds(1)).toEqual(['manhole', 'manhole*']);
    expect(kinds(2)).toEqual(['grate*', 'vent', 'vent']);
    expect(kinds(3)).toEqual(['tunnel*', 'vent', 'vent']);
  });

  it('keeps every part apart, with the way out on the spawn row', () => {
    const at = { i: 100, j: 100 };
    for (let stage = 0; stage < SPAWN_STAGES.length; stage++) {
      const parts = sewerParts(stage, at);
      const seen = new Set<string>();
      for (const p of parts) {
        for (let i = p.i0; i < p.i0 + p.w; i++) {
          for (let j = p.j0; j < p.j0 + p.h; j++) {
            expect(seen.has(`${i},${j}`)).toBe(false);
            seen.add(`${i},${j}`);
          }
        }
      }
      const main = parts.find((p) => p.main)!;
      expect(main.j0 + main.h - 1).toBe(at.j);
    }
  });
});
