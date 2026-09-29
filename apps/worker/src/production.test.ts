// A fresh setup starts the worker before the creator key is imported: it must wait, not crash-loop.
import { randomBytes } from 'node:crypto';
import { FakeClock, createLogger } from '@rat/core';
import { Store, openMemoryDatabase } from '@rat/db';
import { MasterKeyRing, encryptRoleKey } from '@rat/keys';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { waitForCreatorKey } from './production';

describe('worker startup without a creator key', () => {
  it('waits until the key is imported, then goes on', async () => {
    const handle = await openMemoryDatabase();
    const store = new Store(handle.db, 'paper', new FakeClock());
    const ring = new MasterKeyRing({ version: 1, base64: randomBytes(32).toString('base64') });
    let pauses = 0;
    await waitForCreatorKey(store, createLogger({ level: 'silent' }), async () => {
      pauses++;
      if (pauses === 3) await store.keys.setRoleKey(encryptRoleKey(Keypair.generate(), ring, 'creator'));
    });
    expect(pauses).toBe(3);
    // with the key there it does not wait at all
    await waitForCreatorKey(store, createLogger({ level: 'silent' }), async () => {
      throw new Error('should not wait');
    });
    await handle.close();
  });
});
