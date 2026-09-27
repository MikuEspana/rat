import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { createLogger } from '@rat/core';
import { type DbHandle, Store, openMemoryDatabase } from '@rat/db';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { grindVanityKeys } from './grinder';
import { DbKeyStore, encryptRoleKey, refillKeyPool, storeRatKeys } from './keystore';
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

describe('grinder', () => {
  it('finds keys ending with the suffix whose secret matches', async () => {
    const res = await grindVanityKeys({ suffix: 'Ra', count: 4, threads: 2, timeoutMs: 60_000 });
    expect(res.keys.length).toBe(4);
    for (const kp of res.keys) {
      expect(kp.publicKey.toBase58().endsWith('Ra')).toBe(true);
      expect(Keypair.fromSecretKey(kp.secretKey).publicKey.equals(kp.publicKey)).toBe(true);
    }
  });

  it('is case-sensitive: every suffix variant is matched exactly (verified with full base58)', async () => {
    for (const suffix of ['AT', 'aT', 'At', 'TR']) {
      const res = await grindVanityKeys({ suffix, count: 2, threads: 2, timeoutMs: 120_000 });
      expect(res.keys.length).toBe(2);
      for (const kp of res.keys) expect(kp.publicKey.toBase58().endsWith(suffix)).toBe(true);
    }
  });

  // ~195k tries on average (about 20s on 2 threads, longer under CPU load): opt-in so CI never flakes on timing.
  it.runIf(process.env.RUN_SLOW_GRIND === '1')('finds a real RAT key and reports speed (RUN_SLOW_GRIND=1)', { timeout: 600_000 }, async () => {
    const res = await grindVanityKeys({ suffix: 'RAT', count: 1, threads: 2, timeoutMs: 600_000 });
    expect(res.keys.length).toBe(1);
    const addr = res.keys[0]!.publicKey.toBase58();
    expect(addr.endsWith('RAT')).toBe(true);
    console.log(`ground ${addr} in ${res.elapsedMs}ms (${res.tries} tries, ${Math.round(res.tries / (res.elapsedMs / 1000))}/s on 2 threads)`);
  });

  it('rejects invalid suffixes', async () => {
    await expect(grindVanityKeys({ suffix: 'R0T', count: 1 })).rejects.toThrow(/invalid/);
    await expect(grindVanityKeys({ suffix: 'lIO', count: 1 })).rejects.toThrow(/invalid/);
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

  it('refills the pool, hands out rat keys, and signs with them', async () => {
    const r = await refillKeyPool(store.keys, ring, { min: 3, target: 5, suffix: 'R', threads: 2 });
    expect(r.added).toBe(5);
    const ks = new DbKeyStore(store.keys, ring);
    expect(await ks.availableRatKeys()).toBe(5);
    const pub = await ks.takeRatKey();
    expect(pub).toMatch(/R$/);
    const signer = await ks.ratSigner(pub!);
    expect(signer.publicKey.toBase58()).toBe(pub);
    expect(await ks.availableRatKeys()).toBe(4);
    const again = await refillKeyPool(store.keys, ring, { min: 3, target: 5, suffix: 'R', threads: 2 });
    expect(again.added).toBe(0);
  });

  it('never stores or logs plaintext secrets', async () => {
    const keys = [Keypair.generate(), Keypair.generate()];
    await storeRatKeys(store.keys, ring, keys);
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

  it('checks creator/fund keys against the configured public keys', async () => {
    const creator = Keypair.generate();
    const fund = Keypair.generate();
    await store.keys.setRoleKey(encryptRoleKey(creator, ring, 'creator'));
    await store.keys.setRoleKey(encryptRoleKey(fund, ring, 'fund'));
    const ok = new DbKeyStore(store.keys, ring, {
      expectedCreator: creator.publicKey.toBase58(),
      expectedFund: fund.publicKey.toBase58(),
    });
    expect((await ok.creator()).publicKey.equals(creator.publicKey)).toBe(true);
    expect((await ok.fund()).publicKey.equals(fund.publicKey)).toBe(true);
    const bad = new DbKeyStore(store.keys, ring, { expectedCreator: Keypair.generate().publicKey.toBase58() });
    await expect(bad.creator()).rejects.toThrow(/does not match/);
  });

  it('reads keys encrypted under an older master key version', async () => {
    const old = new MasterKeyRing({ version: 1, base64: master() });
    const kp = Keypair.generate();
    await storeRatKeys(store.keys, old, [kp]);
    const newer = new MasterKeyRing({ version: 2, base64: master() }, [{ version: 1, base64: old.current().toString('base64') }]);
    const ks = new DbKeyStore(store.keys, newer);
    expect((await ks.ratSigner(kp.publicKey.toBase58())).publicKey.equals(kp.publicKey)).toBe(true);
  });
});

describe('importKeypairFiles', () => {
  it('imports solana-keygen style files, skips wrong suffixes, and shreds imported files', async () => {
    const { mkdtempSync, writeFileSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { importKeypairFiles } = await import('./import-files');
    const handle = await openMemoryDatabase();
    try {
      const store = new Store(handle.db, 'live');
      const ring = new MasterKeyRing({ version: 1, base64: master() });
      const dir = mkdtempSync(join(tmpdir(), 'grind-'));
      const good = (await grindVanityKeys({ suffix: 'Q', count: 2, threads: 1 })).keys;
      for (const kp of good) writeFileSync(join(dir, `${kp.publicKey.toBase58()}.json`), JSON.stringify(Array.from(kp.secretKey)));
      let other = Keypair.generate();
      while (other.publicKey.toBase58().endsWith('Q')) other = Keypair.generate();
      writeFileSync(join(dir, 'other.json'), JSON.stringify(Array.from(other.secretKey)));
      const res = await importKeypairFiles(dir, store.keys, ring, { suffix: 'Q' });
      expect(res.imported).toBe(2);
      expect(res.skipped.map((s) => s.file)).toEqual(['other.json']);
      expect(readdirSync(dir)).toEqual(['other.json']);
      expect(await store.keys.countAvailableRats()).toBe(2);
    } finally {
      await handle.close();
    }
  });
});
