import { describe, expect, it } from 'vitest';
import { LeaseGate, LeaseLostError, STORE_READS, fenceWrites } from './fenced-store';
import { createSimWorld } from './sim-world';

describe('fenced store: a worker that lost the lease writes nothing', () => {
  it('every read it lets through exists (a typo would silently fence a read, never unfence a write)', async () => {
    const w = await createSimWorld({ dryRun: false });
    for (const [repo, reads] of Object.entries(STORE_READS)) {
      const r = (w.store as unknown as Record<string, Record<string, unknown>>)[repo];
      expect(r, repo).toBeDefined();
      for (const m of reads) expect(typeof r![m], `${repo}.${m}`).toBe('function');
    }
  });

  it('reads pass without a lease check; writes check it first and are refused once the lease is gone', async () => {
    const w = await createSimWorld({ dryRun: false });
    let holds = true;
    let checks = 0;
    const store = fenceWrites(w.store, async () => {
      checks++;
      return holds;
    });
    await store.ledger.balance('hire');
    await store.rats.listByStatus(['hiring']);
    expect(checks).toBe(0);
    await store.settings.set('fence_test', '1');
    expect(checks).toBe(1);
    holds = false;
    await expect(store.settings.set('fence_test', '2')).rejects.toBeInstanceOf(LeaseLostError);
    await expect(store.ledger.append({ bucket: 'hire', deltaLamports: 1n, reason: 'hire_seed_credit' as never })).rejects.toBeInstanceOf(LeaseLostError);
    await expect(store.transaction(async () => 1)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(store.forMode('paper').settings.set('fence_test', '3')).rejects.toBeInstanceOf(LeaseLostError);
    expect(await w.store.settings.get('fence_test')).toBe('1');
    // the lease itself is never fenced (the runner renews and releases it through the same store)
    expect(await store.locks.acquire('worker', 'A', w.clock.now(), 120)).toBe(true);
    expect(await store.settings.get('fence_test')).toBe('1');
  });

  it('the gate is open until bound (startup writes), then asks the runner', async () => {
    const gate = new LeaseGate();
    expect(await gate.holds()).toBe(true);
    gate.bind(async () => false);
    expect(await gate.holds()).toBe(false);
  });
});
