// The site's stage source: seeded SOL counts only on a STAGING API with a staging database. The public claimed
// figure never includes it, and a production API never sends the field.
import { StateResponseSchema } from '@rat/contract';
import { PRODUCTION_CREATOR_PUBKEY, loadConfig } from '@rat/core';
import { markStagingDatabase } from '@rat/db';
import { SOL, type SimWorld, createSimWorld } from '@rat/worker';
import { afterEach, describe, expect, it } from 'vitest';
import { StateService } from './state-service';

let world: SimWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

describe('treasury.stageSol', () => {
  it('staging: claimed plus seeded; totalClaimedSol stays claimed fees only', async () => {
    world = await createSimWorld({ env: { STAGING: 'true' } });
    await markStagingDatabase(world.store, world.deps.config);
    world.accrue({ bondingLamports: SOL / 2n });
    await world.worker.tick();
    const claimed = (await world.store.claims.totals()).claimed;
    expect(claimed).toBeGreaterThan(0n);
    await world.store.ledger.append({ bucket: 'hire', deltaLamports: SOL, reason: 'seed_credit', refType: 'staging_seed' });
    const st = await new StateService(world.store, world.deps.config, world.clock).stateResponse();
    expect(StateResponseSchema.parse(st)).toBeTruthy();
    expect(st.treasury.totalClaimedSol).toBeCloseTo(Number(claimed) / 1e9, 9);
    expect(st.treasury.stageSol).toBeCloseTo(Number(claimed + SOL) / 1e9, 9);
  });

  it('STAGING_STAGE_SCALE multiplies the stage source only; the public claimed figure stays exact', async () => {
    world = await createSimWorld({ env: { STAGING: 'true', STAGING_STAGE_SCALE: '20' } });
    await markStagingDatabase(world.store, world.deps.config);
    world.accrue({ bondingLamports: SOL / 2n });
    await world.worker.tick();
    const claimed = (await world.store.claims.totals()).claimed;
    await world.store.ledger.append({ bucket: 'hire', deltaLamports: SOL / 10n, reason: 'seed_credit', refType: 'staging_seed' });
    const st = await new StateService(world.store, world.deps.config, world.clock).stateResponse();
    expect(st.treasury.totalClaimedSol).toBeCloseTo(Number(claimed) / 1e9, 9);
    expect(st.treasury.stageSol).toBeCloseTo((20 * Number(claimed + SOL / 10n)) / 1e9, 9);
  });

  it('production settings never send it, even if the database had seed entries', async () => {
    world = await createSimWorld();
    world.accrue({ bondingLamports: SOL / 2n });
    await world.worker.tick();
    await world.store.ledger.append({ bucket: 'hire', deltaLamports: SOL, reason: 'seed_credit', refType: 'staging_seed' });
    for (const cfg of [world.deps.config, loadConfig({ ...process.env, CREATOR_PUBKEY: PRODUCTION_CREATOR_PUBKEY, DRY_RUN: 'true' })]) {
      const st = await new StateService(world.store, cfg, world.clock).stateResponse();
      expect(st.treasury).not.toHaveProperty('stageSol');
      expect(st.treasury.totalClaimedSol).toBeCloseTo(Number((await world.store.claims.totals()).claimed) / 1e9, 9);
    }
  });

  it('STAGING on an unmarked database does not send it either (scaled or not)', async () => {
    world = await createSimWorld({ env: { STAGING: 'true', STAGING_STAGE_SCALE: '20' } });
    const st = await new StateService(world.store, world.deps.config, world.clock).stateResponse();
    expect(st.treasury).not.toHaveProperty('stageSol');
  });
});
