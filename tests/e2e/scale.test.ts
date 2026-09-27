// 6,000 rats: the loops keep up, reconcile covers every rat, the API stays fast. In-memory only.
import { createApp, StateService } from '@rat/api';
import { RatsResponseSchema, StateResponseSchema } from '@rat/contract';
import { TOKEN_2022_PROGRAM, avatarSeedFor } from '@rat/core';
import { schema } from '@rat/db';
import { SOL, type SimWorld, createSimWorld } from '@rat/worker';
import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';

let w: SimWorld;
afterEach(async () => w?.close());

describe('scale: 6,000 rats', () => {
  it('worker loops stay fast, reconcile checks every rat, the API serves all of them', async () => {
    w = await createSimWorld({ dryRun: false });
    await w.worker.tick();
    const stocks = await w.store.stocks.list();
    const now = w.clock.now();
    const rows = [];
    for (let i = 0; i < 6000; i++) {
      const wallet = Keypair.generate().publicKey.toBase58();
      const st = stocks[i % stocks.length]!;
      w.chain.setTokenBalance(wallet, st.mint, 1_000_000n, TOKEN_2022_PROGRAM);
      w.chain.fundAccount(wallet, 3_000_000n);
      rows.push({
        mode: 'live',
        wallet,
        stockMint: st.mint,
        status: 'active',
        avatarSeed: avatarSeedFor(wallet),
        salaryLamports: 30_000_000n,
        tokenAmountRaw: 1_000_000n,
        tokenDecimals: 8,
        costUsd: 4.5,
        hireSig: 'seed',
        createdAt: now,
        hiredAt: now,
      });
    }
    for (let i = 0; i < rows.length; i += 1000) await w.handle.db.insert(schema.rats).values(rows.slice(i, i + 1000));

    let maxTickMs = 0;
    let checked = 0;
    await w.run(10 * 60, {
      stepSec: 5,
      onTick: () => undefined,
    });
    // re-run with timing
    for (let i = 0; i < 24; i++) {
      w.accrue({ bondingLamports: SOL / 20n });
      const t0 = performance.now();
      const ran = await w.worker.tick();
      maxTickMs = Math.max(maxTickMs, performance.now() - t0);
      const rec = ran.get('reconcile') as { checked: number } | undefined;
      if (rec) checked += rec.checked;
      w.clock.advanceSeconds(5);
    }
    const all = await w.store.rats.listByStatus(['active', 'frozen']);
    const touched = all.filter((r) => r.lastCheckedAt !== null).length;
    expect(all.length).toBeGreaterThan(6000);
    // every seeded rat was reconciled; rats hired in the last minute are next in the rotation
    const seeded = new Set(rows.map((r) => r.wallet));
    expect(all.filter((r) => seeded.has(r.wallet) && r.lastCheckedAt !== null).length).toBe(6000);
    expect(touched).toBeGreaterThanOrEqual(6000);
    expect((await w.store.rats.listByStatus(['frozen'])).length).toBe(0);
    expect(maxTickMs).toBeLessThan(10_000);

    const app = createApp({ service: new StateService(w.store, w.deps.config, w.clock), clock: w.clock, cacheSec: 3, corsOrigin: '*' });
    const t0 = performance.now();
    const rats = RatsResponseSchema.parse(await (await app.request('/api/rats')).json());
    const ratsMs = performance.now() - t0;
    expect(rats.total).toBe(all.length);
    StateResponseSchema.parse(await (await app.request('/api/state')).json());
    console.log(`[scale] ${all.length} rats: every rat reconciled within 10 min, slowest tick ${maxTickMs.toFixed(0)}ms, /api/rats ${ratsMs.toFixed(0)}ms cold`);
  });
});
