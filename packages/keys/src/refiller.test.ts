// The solana-keygen wrapper and the background refiller, against a test double of the Agave CLI
// (test-fixtures/fake-solana-keygen.mjs). The real binary is exercised in CI inside the Docker image.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { getPriority, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DbHandle, Store, openMemoryDatabase } from '@rat/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbKeyStore } from './keystore';
import { KeyPoolRefiller, grindIntoPool } from './refiller';
import { grindVanityKeys } from './grinder';
import { detectSolanaKeygen, runSolanaKeygenGrind } from './solana-keygen';
import { MasterKeyRing } from './vault';

const FIXTURE = new URL('../test-fixtures/fake-solana-keygen.mjs', import.meta.url).pathname;

let handle: DbHandle;
let store: Store;
let ring: MasterKeyRing;
let tmp: string;

/** A `solana-keygen` on disk that runs the fake in `mode` and records its argv. */
function fakeKeygen(mode: 'normal' | 'hang' | 'fail' | 'junk' | 'slow' = 'normal'): { bin: string; argsFile: string } {
  const bin = join(tmp, `solana-keygen-${mode}`);
  const argsFile = join(tmp, `args-${mode}.txt`);
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${argsFile}"\nFAKE_MODE=${mode} exec node "${FIXTURE}" "$@"\n`);
  chmodSync(bin, 0o755);
  return { bin, argsFile };
}

beforeEach(async () => {
  handle = await openMemoryDatabase();
  store = new Store(handle.db, 'live');
  ring = new MasterKeyRing({ version: 1, base64: randomBytes(32).toString('base64') });
  tmp = mkdtempSync(join(tmpdir(), 'keygen-test-'));
});
afterEach(async () => {
  await handle.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('solana-keygen detection', () => {
  it('detects a working binary and reports a missing one without throwing', () => {
    expect(detectSolanaKeygen(fakeKeygen().bin)).toMatchObject({ ok: true });
    const missing = detectSolanaKeygen(join(tmp, 'does-not-exist'));
    expect(missing.ok).toBe(false);
    expect(missing.error).toBeTruthy();
  });
});

describe('grindIntoPool with solana-keygen', () => {
  it('passes the verified flags, imports every key encrypted, and leaves no plaintext file behind', async () => {
    const { bin, argsFile } = fakeKeygen();
    const root = mkdtempSync(join(tmp, 'root-'));
    const r = await grindIntoPool(store.keys, ring, { kind: 'solana-keygen', suffix: 'A', count: 5, threads: 3, timeoutMs: 30_000, keygenPath: bin, workDirRoot: root });
    expect(r).toMatchObject({ grinder: 'solana-keygen', requested: 5, added: 5, skipped: 0, timedOut: false });
    expect(r.error).toBeUndefined();
    const argv = readFileSync(argsFile, 'utf8').trim();
    expect(argv).toBe('grind --ends-with A:5 --num-threads 3');
    // the private grind folder was removed with everything in it
    expect(readdirSync(root)).toEqual([]);
    const ks = new DbKeyStore(store.keys, ring);
    expect(await ks.availableRatKeys()).toBe(5);
    const pub = await ks.takeRatKey();
    expect(pub).toMatch(/A$/);
    expect((await ks.ratSigner(pub!)).publicKey.toBase58()).toBe(pub);
  });

  it('kills the process once enough keys were reported (never relies on it stopping by itself)', async () => {
    const { bin } = fakeKeygen('hang');
    const root = mkdtempSync(join(tmp, 'root-'));
    const r = await grindIntoPool(store.keys, ring, { kind: 'solana-keygen', suffix: 'B', count: 3, threads: 1, timeoutMs: 30_000, keygenPath: bin, workDirRoot: root });
    expect(r.timedOut).toBe(false);
    expect(r.added).toBeGreaterThanOrEqual(3);
    expect(r.added).toBeLessThanOrEqual(4); // one more may have been written just before the kill
    expect(readdirSync(root)).toEqual([]);
  });

  it('stops at the timeout and keeps the keys found so far', async () => {
    const { bin } = fakeKeygen('slow');
    const root = mkdtempSync(join(tmp, 'root-'));
    const r = await grindIntoPool(store.keys, ring, { kind: 'solana-keygen', suffix: 'C', count: 1000, threads: 1, timeoutMs: 1_500, keygenPath: bin, workDirRoot: root });
    expect(r.timedOut).toBe(true);
    expect(r.added).toBeLessThan(1000);
    expect(await store.keys.countAvailableRats()).toBe(r.added);
    expect(readdirSync(root)).toEqual([]);
  });

  it('never imports a file with the wrong suffix and still shreds it', async () => {
    const { bin } = fakeKeygen('junk');
    const root = mkdtempSync(join(tmp, 'root-'));
    const r = await grindIntoPool(store.keys, ring, { kind: 'solana-keygen', suffix: 'D', count: 2, threads: 1, timeoutMs: 30_000, keygenPath: bin, workDirRoot: root });
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(1);
    expect(readdirSync(root)).toEqual([]);
    const all = await store.keys.all();
    expect(all.every((k) => k.pubkey.endsWith('D'))).toBe(true);
  });

  it('reports a failing binary as an error', async () => {
    const { bin } = fakeKeygen('fail');
    const r = await grindIntoPool(store.keys, ring, { kind: 'solana-keygen', suffix: 'E', count: 2, threads: 1, timeoutMs: 30_000, keygenPath: bin, workDirRoot: mkdtempSync(join(tmp, 'root-')) });
    expect(r.added).toBe(0);
    expect(r.error).toMatch(/exited with 1/);
  });

  it('the child process never sees our secrets', async () => {
    const spy = join(tmp, 'solana-keygen-envspy');
    const envFile = join(tmp, 'env.txt');
    writeFileSync(spy, `#!/bin/sh\nenv > "${envFile}"\nexit 1\n`);
    chmodSync(spy, 0o755);
    process.env.KEY_ENCRYPTION_KEY_TEST_ONLY = 'must-not-leak';
    try {
      const dir = mkdtempSync(join(tmp, 'd-'));
      await runSolanaKeygenGrind({ bin: spy, suffix: 'F', count: 1, threads: 1, timeoutMs: 10_000, dir, nice: false, onKeyFile: async () => {} });
      const env = readFileSync(envFile, 'utf8');
      expect(env).not.toContain('must-not-leak');
      expect(env).not.toMatch(/DATABASE_URL|KEY_ENCRYPTION_KEY/);
    } finally {
      delete process.env.KEY_ENCRYPTION_KEY_TEST_ONLY;
    }
  });

  it('rejects an empty or non-base58 suffix before starting anything', async () => {
    const dir = mkdtempSync(join(tmp, 'd-'));
    const base = { bin: fakeKeygen().bin, count: 1, threads: 1, timeoutMs: 10_000, dir, onKeyFile: async () => {} };
    await expect(runSolanaKeygenGrind({ ...base, suffix: '' })).rejects.toThrow(/suffix/);
    await expect(runSolanaKeygenGrind({ ...base, suffix: 'R0T' })).rejects.toThrow(/suffix/);
  });
});

describe('KeyPoolRefiller', () => {
  const opts = (bin: string, over: Partial<ConstructorParameters<typeof KeyPoolRefiller>[1]> = {}) => ({
    suffix: 'G',
    refillBelow: 10,
    target: 12,
    batch: 5,
    grinder: 'auto' as const,
    threads: 1,
    timeoutMs: 30_000,
    keygenPath: bin,
    workDirRoot: mkdtempSync(join(tmp, 'root-')),
    ...over,
  });

  it('KEYPOOL_GRINDER=solana-keygen grinds in the background, one batch at a time', async () => {
    const refiller = new KeyPoolRefiller({ pool: store.keys, ring }, opts(fakeKeygen('slow').bin, { grinder: 'solana-keygen' }));
    const first = refiller.maybeStart(0);
    // returns immediately: batch capped by KEYPOOL_REFILL_BATCH, grinding continues in the background
    expect(first).toMatchObject({ started: true, count: 5, grinder: 'solana-keygen' });
    expect(refiller.busy).toBe(true);
    expect(refiller.maybeStart(0)).toMatchObject({ started: false, reason: 'already grinding' });
    const r = await refiller.wait();
    expect(r?.added).toBe(5);
    expect(refiller.busy).toBe(false);
    expect(refiller.maybeStart(await store.keys.countAvailableRats())).toMatchObject({ started: true, count: 5 });
    await refiller.wait();
    // 10 keys >= KEYPOOL_REFILL_BELOW: nothing more to do
    expect(refiller.maybeStart(await store.keys.countAvailableRats())).toMatchObject({ started: false, reason: 'pool above refill threshold' });
  });

  it('auto uses the built-in grinder (faster for suffixes) even when solana-keygen is installed', () => {
    const refiller = new KeyPoolRefiller({ pool: store.keys, ring }, opts(fakeKeygen().bin));
    expect(refiller.grinderKind()).toBe('js');
  });

  it('solana-keygen requested but missing: falls back to the built-in grinder', async () => {
    const results: string[] = [];
    const refiller = new KeyPoolRefiller(
      { pool: store.keys, ring, onResult: (r) => void results.push(r.grinder) },
      opts(join(tmp, 'no-such-keygen'), { batch: 2, grinder: 'solana-keygen' }),
    );
    expect(refiller.grinderKind()).toBe('js');
    expect(refiller.maybeStart(0)).toMatchObject({ started: true, grinder: 'js', count: 2 });
    expect((await refiller.wait())?.added).toBe(2);
    expect(results).toEqual(['js']);
  });

  it('off never grinds; stop() kills a running batch and cleans up', async () => {
    const off = new KeyPoolRefiller({ pool: store.keys, ring }, opts(fakeKeygen().bin, { grinder: 'off' }));
    expect(off.maybeStart(0)).toMatchObject({ started: false, reason: 'grinder off' });

    const o = opts(fakeKeygen('slow').bin, { batch: 500, target: 1000, refillBelow: 1000, grinder: 'solana-keygen' });
    const refiller = new KeyPoolRefiller({ pool: store.keys, ring }, o);
    refiller.maybeStart(0);
    await new Promise((r) => setTimeout(r, 300));
    await refiller.stop();
    expect(refiller.busy).toBe(false);
    expect(existsSync(o.workDirRoot) && readdirSync(o.workDirRoot)).toEqual([]);
  });
});

describe('built-in grinder priority', () => {
  it.runIf(process.platform === 'linux')('lowers only the grinder threads, never the main (bot loop) thread', async () => {
    const before = getPriority();
    const r = await grindVanityKeys({ suffix: 'H', count: 3, threads: 2, timeoutMs: 60_000, lowPriority: true });
    expect(r.keys.length).toBe(3);
    expect(getPriority()).toBe(before);
  });
});
