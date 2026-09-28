// The simulator must run the backend's rules: compare every number with the worker's real default config.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../../packages/core/src/config';
import { RULES } from './rules';

const sol = (lamports: bigint): number => Number(lamports) / 1e9;

describe('launch simulator rules', () => {
  it('match the worker defaults exactly', () => {
    const c = loadConfig({});
    expect(RULES.loopSec).toBe(c.intervals.claimSec);
    expect(RULES.salarySol).toBe(sol(c.salaryLamports));
    expect(RULES.hireOverheadSol).toBe(sol(c.hireOverheadEstLamports));
    expect(RULES.ratBufferSol).toBe(sol(c.ratBufferLamports));
    expect(RULES.maxHiresPerLoop).toBe(c.maxHiresPerLoop);
    expect(RULES.minClaimSol).toBe(sol(c.minClaimLamports));
    expect(RULES.minStockWeightBps).toBe(c.minStockWeightBps);
    expect(RULES.capHireSolPerHour).toBe(sol(c.spendCapLamportsPerHour.hire));
    expect(RULES.priceSec).toBe(c.intervals.priceSec);
  });
});
