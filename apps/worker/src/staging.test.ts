// The one-shot crash test: only with STAGING, only for hires, exactly once per database (it survives the restart).
import { FakeClock, type PreparedTx, SETTINGS, type TxRequest } from '@rat/core';
import { type DbHandle, Store, openMemoryDatabase } from '@rat/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stagingCrashHook } from './staging';

let handle: DbHandle;
beforeEach(async () => {
  handle = await openMemoryDatabase();
});
afterEach(async () => handle.close());

const tx = (kind: TxRequest['kind'], n: number) => ({ signature: `sig${n}`, lastValidBlockHeight: 1, serialized: new Uint8Array(), request: { kind } as TxRequest }) as PreparedTx;

describe('STAGING crash test', () => {
  it('is off without STAGING or with a count of 0', () => {
    const store = new Store(handle.db, 'live', new FakeClock());
    expect(stagingCrashHook({ staging: false, stagingCrashAfterSend: 3 }, store)).toBeUndefined();
    expect(stagingCrashHook({ staging: true, stagingCrashAfterSend: 0 }, store)).toBeUndefined();
  });

  it('kills once, right after the Nth hire is broadcast, and never again after the restart', async () => {
    const store = new Store(handle.db, 'live', new FakeClock());
    let kills = 0;
    const hook = stagingCrashHook({ staging: true, stagingCrashAfterSend: 3 }, store, { kill: () => kills++ })!;
    await hook(tx('claim', 1));
    await hook(tx('hire', 2));
    await hook(tx('claim', 3));
    await hook(tx('hire', 4));
    expect(kills).toBe(0);
    await hook(tx('hire', 5));
    expect(kills).toBe(1);
    expect(await store.settings.get(SETTINGS.stagingCrashDone)).toMatch(/ sig5$/);
    // the restarted worker: a fresh hook, same database
    const again = stagingCrashHook({ staging: true, stagingCrashAfterSend: 1 }, store, { kill: () => kills++ })!;
    for (let i = 0; i < 5; i++) await again(tx('hire', 10 + i));
    expect(kills).toBe(1);
  });
});
