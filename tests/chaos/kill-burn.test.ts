// A. The worker is killed right before EVERY operation of a burn (database, RPC, Jupiter); a restarted worker
// must finish the burn with every lamport accounted for. Runs in the separate `chaos` CI job.
import { describe, expect, it } from 'vitest';
import { MATRIX, everyPoint, opsOf, scenario } from './scenario';

describe('A. worker killed before every operation of a burn', () => {
  for (const [mode, step, variant] of MATRIX.filter((m) => m[1] === 'burn')) {
    it(`burn (${mode}, ${variant}): killed at each step, a restarted worker finishes with every lamport accounted for`, async () => {
      const ops = await opsOf(mode, step, variant);
      expect(ops.length).toBeGreaterThan(10);
      await everyPoint(ops.length, (k) => `killed before op ${k} (${ops[k - 1]!.name})`, (k) => scenario(mode, step, (c) => (c.killAt = k), 'restart', variant));
    }, 900_000);
  }
});
