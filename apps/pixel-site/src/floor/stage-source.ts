// What the building's stage goes by: SOL claimed (plan.ts STAGES). Every stage decision on the site reads it through
// this one function, so the source can change in one place.
import type { StateResponse } from '@rat/contract';

/**
 * SOL the stage goes by: the creator fees claimed so far (public, CONTRACT.md `treasury.totalClaimedSol`).
 *
 * Rehearsal only: a STAGING API also sends `treasury.stageSol` (claimed plus the rehearsal seed, so a small test can
 * show a stage-up). It counts only when the page was opened with `?api=<staging API>` (`rehearsal`). The production
 * API never sends it (apps/api/src/staging.test.ts), and the site as built for production ignores it even if it did.
 * The public "claimed" figure on the HUD is always `totalClaimedSol`.
 */
export function stageSourceSol(treasury: StateResponse['treasury'], opts: { rehearsal?: boolean } = {}): number {
  return opts.rehearsal && treasury.stageSol !== undefined ? treasury.stageSol : treasury.totalClaimedSol;
}
