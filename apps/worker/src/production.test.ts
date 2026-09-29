// A fresh setup starts the worker before the creator key is imported: it must wait, not crash-loop.
import { randomBytes } from 'node:crypto';
import { FakeClock, createLogger } from '@rat/core';
import { Store, openMemoryDatabase } from '@rat/db';
import { DbKeyStore, MasterKeyRing, encryptRoleKey } from '@rat/keys';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { checkStoredKeys, waitForCreatorKey } from './production';

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

describe('worker startup after the master key changed', () => {
  it('refuses to start when stored rat keys do not decrypt with KEY_ENCRYPTION_KEY (same KEY_VERSION)', async () => {
    const handle = await openMemoryDatabase();
    const store = new Store(handle.db, 'live', new FakeClock());
    const old = new MasterKeyRing({ version: 1, base64: randomBytes(32).toString('base64') });
    const creator = Keypair.generate();
    await new DbKeyStore(store.keys, old).newRatKey();
    // the creator re-imported under a new key, same version: the creator decrypts, the rat key does not
    const changed = new MasterKeyRing({ version: 1, base64: randomBytes(32).toString('base64') });
    await store.keys.setRoleKey(encryptRoleKey(creator, changed, 'creator'));
    await expect(checkStoredKeys(store, changed)).rejects.toThrow(/do not decrypt with KEY_ENCRYPTION_KEY/);
    await expect(checkStoredKeys(store, old)).rejects.toThrow(/1 stored keys/); // the creator row fails the old key
    // a new KEY_VERSION for the new key: old rows are labelled 1 and cannot be confused
    const v2 = new MasterKeyRing({ version: 2, base64: randomBytes(32).toString('base64') });
    await expect(checkStoredKeys(store, v2)).resolves.toBeUndefined();
    await handle.close();
  });
});
