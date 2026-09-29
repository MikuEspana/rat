// Rehearsal (STAGING) guards: every test-only feature is impossible with the production creator wallet, on a
// production database, or with production settings.
import { randomBytes } from 'node:crypto';
import { FakeClock, PRODUCTION_CREATOR_PUBKEY, SETTINGS, loadConfig } from '@rat/core';
import { SimChain, SimChainReader } from '@rat/chain/sim';
import { type DbHandle, Store, markStagingDatabase, openMemoryDatabase, requireStagingDatabase, stagingProblems } from '@rat/db';
import { MasterKeyRing, encryptRoleKey } from '@rat/keys';
import { telegramSink } from '@rat/safety';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedPhrase, stagingInitCommand, stagingSeedCommand } from './commands/staging';
import type { CliContext } from './context';

let handle: DbHandle;
beforeEach(async () => {
  handle = await openMemoryDatabase();
});
afterEach(async () => handle.close());

const SOL = 1_000_000_000n;
const master = randomBytes(32).toString('base64');
const ring = new MasterKeyRing({ version: 1, base64: master });

function cfg(env: Record<string, string>) {
  return loadConfig({ DATABASE_URL: 'memory://', KEY_ENCRYPTION_KEY: master, RPC_URL: 'http://localhost:8899', ...env });
}

async function world(env: Record<string, string> = {}, creatorSol = SOL) {
  const creator = Keypair.generate();
  const config = cfg({ STAGING: 'true', CREATOR_PUBKEY: creator.publicKey.toBase58(), ...env });
  const store = new Store(handle.db, config.dryRun ? 'paper' : 'live', new FakeClock());
  await store.keys.setRoleKey(encryptRoleKey(creator, ring, 'creator'));
  const chain = new SimChain();
  chain.fundAccount(creator.publicKey.toBase58(), creatorSol);
  const lines: string[] = [];
  const ctx: CliContext = { config, store, clock: new FakeClock(), out: (l) => lines.push(l) };
  return { ctx, config, store, chain: new SimChainReader(chain), creator: creator.publicKey.toBase58(), lines };
}

/** a record for the production creator key (the secret is a dummy: only the public key is ever looked at here) */
function productionCreatorRecord() {
  return { ...encryptRoleKey(Keypair.generate(), ring, 'creator'), pubkey: PRODUCTION_CREATOR_PUBKEY };
}

describe('STAGING config', () => {
  it('is refused with the production creator wallet', () => {
    expect(() => cfg({ STAGING: 'true', CREATOR_PUBKEY: PRODUCTION_CREATOR_PUBKEY })).toThrow(/refused with the production creator/);
    expect(() => cfg({ STAGING: 'true', CREATOR_PUBKEY: PRODUCTION_CREATOR_PUBKEY, DRY_RUN: 'true' })).toThrow(/production creator/);
  });

  it('needs a test creator, and the crash test needs STAGING', () => {
    expect(() => cfg({ STAGING: 'true' })).toThrow(/needs CREATOR_PUBKEY/);
    expect(() => cfg({ STAGING_CRASH_AFTER_SEND: '3', CREATOR_PUBKEY: PRODUCTION_CREATOR_PUBKEY })).toThrow(/only works with STAGING=true/);
    expect(() => cfg({ STAGING_CRASH_AFTER_SEND: '1' })).toThrow(/only works with STAGING=true/);
    expect(() => cfg({ STAGING_STAGE_SCALE: '20', CREATOR_PUBKEY: PRODUCTION_CREATOR_PUBKEY })).toThrow(/STAGING_STAGE_SCALE only works with STAGING=true/);
    expect(() => cfg({ STAGING_STAGE_SCALE: '2' })).toThrow(/only works with STAGING=true/);
    expect(() => cfg({ STAGING: 'true', CREATOR_PUBKEY: PRODUCTION_CREATOR_PUBKEY, STAGING_STAGE_SCALE: '20' })).toThrow(/production creator/);
  });

  it('is off by default, and the production creator loads normally without it', () => {
    const c = cfg({ CREATOR_PUBKEY: PRODUCTION_CREATOR_PUBKEY });
    expect(c.staging).toBe(false);
    expect(c.stagingCrashAfterSend).toBe(0);
    expect(c.stagingStageScale).toBe(1);
    expect(cfg({ CREATOR_PUBKEY: PRODUCTION_CREATOR_PUBKEY, STAGING_STAGE_SCALE: '1' }).stagingStageScale).toBe(1);
    const s = cfg({ STAGING: 'true', CREATOR_PUBKEY: Keypair.generate().publicKey.toBase58(), STAGING_CRASH_AFTER_SEND: '6' });
    expect(s.staging).toBe(true);
    expect(s.stagingCrashAfterSend).toBe(6);
  });
});

describe('staging database', () => {
  it('staging-init marks an empty database once; running it again changes nothing', async () => {
    const w = await world();
    await stagingInitCommand(w.ctx);
    expect(await w.store.settings.get(SETTINGS.stagingMarker)).toBe(`staging:${w.creator}`);
    await stagingInitCommand(w.ctx);
    expect(w.lines).toEqual([expect.stringMatching(/marked for the test creator/), expect.stringMatching(/Already a staging database/)]);
    await expect(requireStagingDatabase(w.store, w.config)).resolves.toBeUndefined();
  });

  it('staging-init refuses production settings, a database with data, and a database holding the production key', async () => {
    const w = await world();
    const prod = cfg({ CREATOR_PUBKEY: PRODUCTION_CREATOR_PUBKEY });
    await expect(markStagingDatabase(w.store, prod)).rejects.toThrow(/needs STAGING=true/);
    await w.store.ledger.append({ bucket: 'hire', deltaLamports: 5n, reason: 'claim_credit' });
    await expect(markStagingDatabase(w.store, w.config)).rejects.toThrow(/already has data/);

    await handle.close();
    handle = await openMemoryDatabase();
    const store = new Store(handle.db, 'paper', new FakeClock());
    await store.keys.setRoleKey(productionCreatorRecord());
    await expect(markStagingDatabase(store, w.config)).rejects.toThrow(/holds the production creator key/);
    expect(await store.settings.get(SETTINGS.stagingMarker)).toBeNull();
  });

  it('a marked database refuses production settings, and another test creator', async () => {
    const w = await world();
    await stagingInitCommand(w.ctx);
    expect(await stagingProblems(w.store, cfg({ CREATOR_PUBKEY: PRODUCTION_CREATOR_PUBKEY }))).toEqual([expect.stringMatching(/STAGING database/)]);
    expect(await stagingProblems(w.store, cfg({ CREATOR_PUBKEY: w.creator }))).toEqual([expect.stringMatching(/STAGING database/)]);
    const other = cfg({ STAGING: 'true', CREATOR_PUBKEY: Keypair.generate().publicKey.toBase58() });
    expect(await stagingProblems(w.store, other)).toEqual([expect.stringMatching(/another test creator/)]);
    // an unmarked production-like database has no problem with production settings
    await handle.close();
    handle = await openMemoryDatabase();
    const store = new Store(handle.db, 'paper', new FakeClock());
    await store.keys.setRoleKey(productionCreatorRecord());
    expect(await stagingProblems(store, cfg({ CREATOR_PUBKEY: PRODUCTION_CREATOR_PUBKEY }))).toEqual([]);
  });
});

describe('rat staging-seed', () => {
  it('books SOL as hire:seed_credit, never as a claim, only with the exact phrase', async () => {
    const w = await world();
    await stagingInitCommand(w.ctx);
    const r1 = await stagingSeedCommand(w.ctx, { chain: w.chain }, { sol: '0.15' });
    expect(r1.executed).toBe(false);
    expect(w.lines.at(-1)).toContain(`--confirm "${seedPhrase(150_000_000n)}"`);
    expect(await w.store.ledger.balance('hire')).toBe(0n);

    const r2 = await stagingSeedCommand(w.ctx, { chain: w.chain }, { sol: '0.15', confirm: 'SEED 0.15 SOL' });
    expect(r2.executed).toBe(true);
    expect((await w.store.ledger.sumByReason()).get('hire:seed_credit')).toBe(150_000_000n);
    expect(await w.store.ledger.balance('hire')).toBe(150_000_000n);
    // the public claimed figure comes from the claims table: untouched
    expect((await w.store.claims.totals()).claimed).toBe(0n);
  });

  it('is refused with production settings, even on a database that has the marker', async () => {
    const w = await world();
    await stagingInitCommand(w.ctx);
    const prodCtx = { ...w.ctx, config: cfg({ CREATOR_PUBKEY: PRODUCTION_CREATOR_PUBKEY }) };
    await expect(stagingSeedCommand(prodCtx, { chain: w.chain }, { sol: '0.1', confirm: 'SEED 0.1 SOL' })).rejects.toThrow(/STAGING is off/);
    const plainCtx = { ...w.ctx, config: cfg({ CREATOR_PUBKEY: w.creator }) };
    await expect(stagingSeedCommand(plainCtx, { chain: w.chain }, { sol: '0.1', confirm: 'SEED 0.1 SOL' })).rejects.toThrow(/STAGING is off/);
    expect(await w.store.ledger.balance('hire')).toBe(0n);
  });

  it('is refused on an unmarked database', async () => {
    const w = await world();
    await expect(stagingSeedCommand(w.ctx, { chain: w.chain }, { sol: '0.1', confirm: 'SEED 0.1 SOL' })).rejects.toThrow(/not marked as staging/);
  });

  it('never seeds more than 0.5 SOL at once, 1 SOL in total, or more than the test creator really holds', async () => {
    const w = await world({}, 2n * SOL);
    await stagingInitCommand(w.ctx);
    await expect(stagingSeedCommand(w.ctx, { chain: w.chain }, { sol: '0.6', confirm: 'SEED 0.6 SOL' })).rejects.toThrow(/at most 0.5 SOL per seed/);
    await stagingSeedCommand(w.ctx, { chain: w.chain }, { sol: '0.5', confirm: 'SEED 0.5 SOL' });
    await stagingSeedCommand(w.ctx, { chain: w.chain }, { sol: '0.5', confirm: 'SEED 0.5 SOL' });
    // 2 SOL on chain - 0.05 reserve - 1 already booked = 0.95 free, but the total cap is 1 SOL
    await expect(stagingSeedCommand(w.ctx, { chain: w.chain }, { sol: '0.01', confirm: 'SEED 0.01 SOL' })).rejects.toThrow(/may not pass 1 SOL/);
    expect(await w.store.ledger.balance('hire')).toBe(SOL);

    const poor = await (async () => {
      await handle.close();
      handle = await openMemoryDatabase();
      return world({}, SOL / 5n); // 0.2 SOL: 0.15 free after the reserve
    })();
    await stagingInitCommand(poor.ctx);
    await expect(stagingSeedCommand(poor.ctx, { chain: poor.chain }, { sol: '0.16', confirm: 'SEED 0.16 SOL' })).rejects.toThrow(/only 0.15 SOL can be seeded/);
    await stagingSeedCommand(poor.ctx, { chain: poor.chain }, { sol: '0.15', confirm: 'SEED 0.15 SOL' });
    await expect(stagingSeedCommand(poor.ctx, { chain: poor.chain }, { sol: '0.01', confirm: 'SEED 0.01 SOL' })).rejects.toThrow(/only 0 SOL can be seeded/);
  });
});

describe('alerts', () => {
  it('a staging Telegram alert says STAGING; production ones do not', async () => {
    const sent: string[] = [];
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body).text);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await telegramSink({ botToken: 't', chatId: 'c', fetchImpl, staging: true })('critical', 'kill switch');
    await telegramSink({ botToken: 't', chatId: 'c', fetchImpl })('critical', 'kill switch');
    expect(sent[0]).toMatch(/^\[RAT RACE STAGING .* critical\] kill switch$/);
    expect(sent[1]).not.toContain('STAGING');
  });
});
