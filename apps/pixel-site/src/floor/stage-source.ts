// What the building's stage goes by: SOL claimed (plan.ts STAGES). Every stage decision on the site reads it through
// this one function, so the source can change in one place.
import type { StateResponse } from '@rat/contract';

/** SOL the stage goes by: the creator fees claimed so far (public, CONTRACT.md `treasury.totalClaimedSol`). */
export function stageSourceSol(treasury: StateResponse['treasury']): number {
  return treasury.totalClaimedSol;
}
