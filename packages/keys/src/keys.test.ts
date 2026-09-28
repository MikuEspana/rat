import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { createLogger } from '@rat/core';
import { type DbHandle, Store, openMemoryDatabase } from '@rat/db';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeyPoolRecord, KeyPoolStore } from '@rat/core';
import { DbKeyStore, encryptRoleKey } from './keystore';
import { parseSecretKey } from './secret-input';
import { MasterKeyRing, decryptSecret, encryptSecret, parseMasterKey } from './vault';

const master = () => randomBytes(32).toString('base64');

describe('vault', () => {
  it('round trips and binds the ciphertext to the public key', () => {
    const key = parseMasterKey(master());
    const kp = Keypair.generate();
    const pub = kp.publicKey.toBase58();
    const enc = encryptSecret(kp.secretKey, key, pub);
    expect(Buffer.from(decryptSecret(enc, key, pub))).toEqual(Buffer.from(kp.secretKey));
    expect(() => decryptSecret(enc, key, Keypair.generate().publicKey.toBase58())).toThrow();
  });

  it('fails on tampering and on the wrong master key', () => {
    const key = parseMasterKey(master());
    const kp = Keypair.generate();
    const pub = kp.publicKey.toBase58();
    const enc = Buffer.from(encryptSecret(kp.secretKey, key, pub), 'base64');
    enc[enc.length - 1] = enc[enc.length - 1]! ^ 0xff;
    expect(() => decryptSecret(enc.toString('base64'), key, pub)).toThrow();
    const good = encryptSecret(kp.secretKey, key, pub);
    expect(() => decryptSecret(good, parseMasterKey(master()), pub)).toThrow();
    expect(() => parseMasterKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('uses a fresh IV every time', () => {
    const key = parseMasterKey(master());
    const kp = Keypair.generate();
    const pub = kp.publicKey.toBase58();
    expect(encryptSecret(kp.secretKey, key, pub)).not.toBe(encryptSecret(kp.secretKey, key, pub));
  });
});

describe('parseSecretKey', () => {
  it('accepts base58 and JSON array exports', () => {
    const kp = Keypair.generate();
    expect(parseSecretKey(bs58.encode(kp.secretKey)).publicKey.equals(kp.publicKey)).toBe(true);
    expect(parseSecretKey(JSON.stringify(Array.from(kp.secretKey))).publicKey.equals(kp.publicKey)).toBe(true);
    expect(() => parseSecretKey('[1,2,3]')).toThrow(/64 bytes/);
  });
});

describe('DbKeyStore', () => {
  let handle: DbHandle;
  let store: Store;
  let ring: MasterKeyRing;

  beforeEach(async () => {
    handle = await openMemoryDatabase();
    store = new Store(handle.db, 'live');
    ring = new MasterKeyRing({ version: 1, base64: master() });
  });
  afterEach(async () => handle.close());

  it('makes a fresh rat key per hire: stored encrypted and decryptable BEFORE it is returned, never reused', async () => {
    const ks = new DbKeyStore(store.keys, ring);
    const a = await ks.newRatKey();
    const b = await ks.newRatKey();
    expect(a).not.toBe(b);
    // already in the database when newRatKey returns: a crash right after sending cannot lose the key
    const rec = await store.keys.get(a);
    expect(rec?.role).toBe('rat');
    const fresh = new DbKeyStore(store.keys, ring); // a restarted worker, empty cache
    expect((await fresh.ratSigner(a)).publicKey.toBase58()).toBe(a);
    // an abandoned hire (nothing sent) retires the key; the next hire gets a new one
    await ks.discardRatKey(b);
    expect(await store.keys.counts()).toEqual({ assigned: 1, unused: 1 });
    expect(await ks.newRatKey()).not.toBe(b);
  });

  it('refuses to hand out a key it cannot read back (a broken store never gets a funded wallet)', async () => {
    const lossy: KeyPoolStore = {
      insertRatKey: async () => {},
      markUnused: async () => {},
      get: async () => null,
      getRole: async () => null,
    };
    await expect(new DbKeyStore(lossy, ring).newRatKey()).rejects.toThrow(/no stored key/);
    const corrupt: KeyPoolStore = {
      ...lossy,
      insertRatKey: async (r: KeyPoolRecord) => {
        saved = { ...r, secretEnc: Buffer.from('garbage-garbage-garbage-garbage-garbage').toString('base64') };
      },
      get: async () => saved,
    };
    let saved: KeyPoolRecord | null = null;
    await expect(new DbKeyStore(corrupt, ring).newRatKey()).rejects.toThrow();
  });

  it('never stores or logs plaintext secrets', async () => {
    const ks = new DbKeyStore(store.keys, ring);
    const keys = [await ks.ratSigner(await ks.newRatKey()), await ks.ratSigner(await ks.newRatKey())];
    const rows = await store.keys.all();
    const lines: string[] = [];
    const log = createLogger({
      destination: new Writable({
        write(c, _e, cb) {
          lines.push(c.toString());
          cb();
        },
      }),
    });
    log.info({ rows }, 'dump');
    const dbText = JSON.stringify(rows);
    for (const kp of keys) {
      const b58 = bs58.encode(kp.secretKey);
      const b64 = Buffer.from(kp.secretKey).toString('base64');
      expect(dbText).not.toContain(b58);
      expect(dbText).not.toContain(b64);
      expect(lines.join('')).not.toContain(b58);
    }
    expect(lines.join('')).toContain('[REDACTED]');
  });

  it('checks the creator key against the configured public key', async () => {
    const creator = Keypair.generate();
    await store.keys.setRoleKey(encryptRoleKey(creator, ring, 'creator'));
    const ok = new DbKeyStore(store.keys, ring, { expectedCreator: creator.publicKey.toBase58() });
    expect((await ok.creator()).publicKey.equals(creator.publicKey)).toBe(true);
    const bad = new DbKeyStore(store.keys, ring, { expectedCreator: Keypair.generate().publicKey.toBase58() });
    await expect(bad.creator()).rejects.toThrow(/does not match/);
  });

  it('reads keys encrypted under an older master key version', async () => {
    const old = new MasterKeyRing({ version: 1, base64: master() });
    const oldStore = new DbKeyStore(store.keys, old);
    const kp = await oldStore.ratSigner(await oldStore.newRatKey());
    const newer = new MasterKeyRing({ version: 2, base64: master() }, [{ version: 1, base64: old.current().toString('base64') }]);
    const ks = new DbKeyStore(store.keys, newer);
    expect((await ks.ratSigner(kp.publicKey.toBase58())).publicKey.equals(kp.publicKey)).toBe(true);
  });
});
