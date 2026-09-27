import { randomBytes } from 'node:crypto';
import { FakeClock, LIVE_CONFIRM_PHRASE, SETTINGS, TOKEN_2022_PROGRAM, loadConfig } from '@rat/core';
import { SimChain, SimChainReader, SimTxSender } from '@rat/chain/sim';
import { type DbHandle, Store, openMemoryDatabase } from '@rat/db';
import { DbKeyStore, MasterKeyRing, encryptRoleKey } from '@rat/keys';
import { DbKillSwitch, GuardedSender } from '@rat/safety';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dryRunResetCommand } from './commands/dry-run';
import { keysImportRoleCommand, keysRotateCommand } from './commands/keys';
import { killCommand, resumeCommand } from './commands/kill';
import { statusCommand } from './commands/status';
import { stocksSyncCommand } from './commands/stocks';
import { sweepCommand, sweepPhrase } from './commands/sweep';
import type { CliContext } from './context';

let handle: DbHandle;
let lines: string[];
const clock = new FakeClock('2026-10-01T12:00:00Z');
const ring = new MasterKeyRing({ version: 1, base64: randomBytes(32).toString('base64') });

function ctxFor(env: Record<string, string> = {}, mode: 'paper' | 'live' = 'paper'): CliContext {
  const config = loadConfig(env);
  return { config, store: new Store(handle.db, mode, clock), clock, out: (l) => lines.push(l) };
}

beforeEach(async () => {
  handle = await openMemoryDatabase();
  lines = [];
});
afterEach(async () => handle.close());

describe('kill / resume / status', () => {
  it('toggles the database kill switch; env kill cannot be resumed from the CLI', async () => {
    const ctx = ctxFor();
    await killCommand(ctx, 'testing');
    expect(await ctx.store.settings.get(SETTINGS.killSwitch)).toBe('on');
    await statusCommand(ctx);
    expect(lines.some((l) => l.includes('ON (db: testing)'))).toBe(true);
    await resumeCommand(ctx);
    expect(await ctx.store.settings.get(SETTINGS.killSwitch)).toBe('off');
    const envKilled = ctxFor({ KILL_SWITCH: 'true' });
    await resumeCommand(envKilled);
    expect(lines.at(-1)).toMatch(/env var is true/);
  });
});

describe('keys import', () => {
  it('requires the configured public key and stores the key encrypted', async () => {
    const kp = Keypair.generate();
    const secret = bs58.encode(kp.secretKey);
    await expect(keysImportRoleCommand(ctxFor(), ring, 'creator', secret)).rejects.toThrow(/CREATOR_PUBKEY must be set/);
    await expect(keysImportRoleCommand(ctxFor({ CREATOR_PUBKEY: Keypair.generate().publicKey.toBase58() }), ring, 'creator', secret)).rejects.toThrow(/but CREATOR_PUBKEY is/);
    const ctx = ctxFor({ CREATOR_PUBKEY: kp.publicKey.toBase58() });
    await keysImportRoleCommand(ctx, ring, 'creator', secret);
    const stored = await ctx.store.keys.getRole('creator');
    expect(stored?.pubkey).toBe(kp.publicKey.toBase58());
    expect(stored?.secretEnc).not.toContain(secret);
    expect(lines.join('\n')).not.toContain(secret);
  });
});

describe('dry-run reset and stocks sync', () => {
  it('reset needs --yes; stocks sync loads the repo stock list', async () => {
    const ctx = ctxFor();
    await dryRunResetCommand(ctx, false);
    expect(lines.at(-1)).toMatch(/Re-run with --yes/);
    await dryRunResetCommand(ctx, true);
    expect(lines.at(-1)).toMatch(/paper data reset/);
    await stocksSyncCommand(ctx, new URL('../../..', import.meta.url).pathname);
    const list = await ctx.store.stocks.list();
    expect(list.length).toBeGreaterThanOrEqual(10);
    expect(list.every((s) => s.approved === false)).toBe(true);
  });
});

describe('emergency sweep (SimChain, in-memory)', () => {
  async function world(env: Record<string, string>) {
    const chain = new SimChain();
    const reader = new SimChainReader(chain);
    const sim = new SimTxSender(chain);
    const creator = Keypair.generate();
    const cold = Keypair.generate().publicKey.toBase58();
    const ctx = ctxFor({ ...env, CREATOR_PUBKEY: creator.publicKey.toBase58() }, env.DRY_RUN === 'false' ? 'live' : 'paper');
    const live = ctx.store.forMode('live');
    await ctx.store.keys.setRoleKey(encryptRoleKey(creator, ring, 'creator'));
    chain.fundAccount(creator.publicKey.toBase58(), 1_000_000_000n);
    const mint = Keypair.generate().publicKey.toBase58();
    chain.createMint({ mint, decimals: 8, tokenProgram: TOKEN_2022_PROGRAM, supply: 10_000_000n });
    await ctx.store.stocks.syncConfig([{ symbol: 'TSTx', name: 'Test', mint, group: 'volatile', enabled: true, approved: true }]);
    await ctx.store.stocks.setMintFacts(mint, { decimals: 8, tokenProgram: TOKEN_2022_PROGRAM, mintAuthority: null, uiMultiplier: 1 });
    const keys = new DbKeyStore(ctx.store.keys, ring);
    const ratWallets: string[] = [];
    for (let i = 0; i < 3; i++) {
      const wallet = await keys.newRatKey();
      ratWallets.push(wallet);
      const r = await live.rats.create({ wallet, stockMint: mint, salaryLamports: 30_000_000n, avatarSeed: 'aaaaaaaa' });
      await live.rats.update(r.id, { status: 'active' });
      chain.setTokenBalance(wallet, mint, 1_000_000n, TOKEN_2022_PROGRAM);
      chain.fundAccount(wallet, 3_000_000n);
    }
    const sender = new GuardedSender(sim, { attempts: ctx.store.attempts, killSwitch: new DbKillSwitch(ctx.store.settings, false), dryRun: ctx.config.dryRun });
    return { chain, reader, sim, ctx, live, cold, mint, ratWallets, deps: { chain: reader, keys, sender } };
  }

  it('prints the plan and refuses without the exact typed phrase', async () => {
    const w = await world({});
    expect((await sweepCommand(w.ctx, w.deps, { to: w.cold })).executed).toBe(false);
    expect((await sweepCommand(w.ctx, w.deps, { to: w.cold, confirm: 'yes' })).executed).toBe(false);
    expect(lines.some((l) => l.includes('SWEEP PLAN: 3 live rats'))).toBe(true);
    expect(w.sim.submitted + w.sim.simulated).toBe(0);
  });

  it('DRY RUN: simulates every sweep tx and moves nothing', async () => {
    const w = await world({});
    const r = await sweepCommand(w.ctx, w.deps, { to: w.cold, confirm: sweepPhrase(w.cold) });
    expect(r).toMatchObject({ executed: true, ok: 3, failed: 0 });
    expect(w.sim.submitted).toBe(0);
    expect(w.chain.tokenBalance(w.cold, w.mint, TOKEN_2022_PROGRAM)).toBe(0n);
  });

  it('live against SimChain: moves all tokens and SOL, marks rats swept, reports paused stocks', async () => {
    const w = await world({ DRY_RUN: 'false', LIVE_CONFIRM: LIVE_CONFIRM_PHRASE });
    const r = await sweepCommand(w.ctx, w.deps, { to: w.cold, confirm: sweepPhrase(w.cold), limit: 2 });
    expect(r).toMatchObject({ executed: true, ok: 2, failed: 0 });
    expect(w.chain.tokenBalance(w.cold, w.mint, TOKEN_2022_PROGRAM)).toBe(2_000_000n);
    expect(w.chain.sol(w.ratWallets[0]!)).toBe(0n);
    expect((await w.live.rats.listByStatus(['frozen'])).length).toBe(2);
    w.chain.updateMint(w.mint, { paused: true });
    const r2 = await sweepCommand(w.ctx, w.deps, { to: w.cold, confirm: sweepPhrase(w.cold) });
    expect(r2.failed).toBe(1);
  });
});

describe('keys rotate', () => {
  it('re-encrypts every key under the new master key; old key no longer needed', async () => {
    const ctx = ctxFor();
    const oldB64 = randomBytes(32).toString('base64');
    const newB64 = randomBytes(32).toString('base64');
    const oldRing = new MasterKeyRing({ version: 1, base64: oldB64 });
    const oldStore = new DbKeyStore(ctx.store.keys, oldRing);
    const kps = [];
    for (let i = 0; i < 3; i++) kps.push(await oldStore.ratSigner(await oldStore.newRatKey()));
    const both = new MasterKeyRing({ version: 2, base64: newB64 }, [{ version: 1, base64: oldB64 }]);
    expect(await keysRotateCommand(ctx, both)).toEqual({ rotated: 3, skipped: 0 });
    expect(await keysRotateCommand(ctx, both)).toEqual({ rotated: 0, skipped: 3 });
    const onlyNew = new DbKeyStore(ctx.store.keys, new MasterKeyRing({ version: 2, base64: newB64 }));
    for (const kp of kps) expect((await onlyNew.ratSigner(kp.publicKey.toBase58())).publicKey.equals(kp.publicKey)).toBe(true);
    expect(lines.join('\n')).not.toContain(bs58.encode(kps[0]!.secretKey));
  });
});
