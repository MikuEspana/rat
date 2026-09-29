import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, LIVE_CONFIRM_PHRASE, SETTINGS, TOKEN_2022_PROGRAM, loadConfig } from '@rat/core';
import { SimChain, SimChainReader, SimTxSender } from '@rat/chain/sim';
import { type DbHandle, Store, openMemoryDatabase } from '@rat/db';
import { DbKeyStore, MasterKeyRing, encryptRoleKey } from '@rat/keys';
import { DbKillSwitch, GuardedSender } from '@rat/safety';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dryRunResetCommand } from './commands/dry-run';
import { keysBackupCommand, keysImportRoleCommand, keysRestoreCommand, keysRotateCommand, verifyKeyRecords } from './commands/keys';
import { killCommand, resumeCommand } from './commands/kill';
import { statusCommand, statusJson } from './commands/status';
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

  it('stocks sync approves the APPROVED_STOCKS symbols, and unapproves them once removed', async () => {
    const root = new URL('../../..', import.meta.url).pathname;
    await stocksSyncCommand(ctxFor({ APPROVED_STOCKS: 'TSLAx,AAPLx' }), root);
    const approved = (await ctxFor().store.stocks.list()).filter((s) => s.approved).map((s) => s.symbol);
    expect(approved.sort()).toEqual(['AAPLx', 'TSLAx']);
    await stocksSyncCommand(ctxFor(), root);
    expect((await ctxFor().store.stocks.list()).some((s) => s.approved)).toBe(false);
    await expect(stocksSyncCommand(ctxFor({ APPROVED_STOCKS: 'TSLA' }), root)).rejects.toThrow(/not in the stocks file/);
  });
});

describe('status --json', () => {
  it('prints one JSON line with the numbers scripts need, and no secret', async () => {
    const creator = Keypair.generate();
    const ctx = ctxFor({ CREATOR_PUBKEY: creator.publicKey.toBase58(), TELEGRAM_BOT_TOKEN: 'tg-secret-token', DATABASE_URL: 'postgres://u:pw-secret@h/db' });
    await keysImportRoleCommand(ctx, ring, 'creator', bs58.encode(creator.secretKey));
    await killCommand(ctx, 'rehearsal');
    lines = [];
    await statusCommand(ctx, { json: true });
    expect(lines).toHaveLength(1);
    const st = JSON.parse(lines[0]!) as Awaited<ReturnType<typeof statusJson>>;
    expect(st).toMatchObject({ mode: 'dry_run', staging: false, killSwitch: { on: true, reason: 'rehearsal' }, creatorKey: creator.publicKey.toBase58(), openReservations: 0, seededSol: '0' });
    expect(typeof st.hourCapSol).toBe('string');
    for (const secret of ['tg-secret-token', 'pw-secret', bs58.encode(creator.secretKey)]) expect(lines[0]).not.toContain(secret);
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
    const killSwitch = new DbKillSwitch(ctx.store.settings, false);
    const sender = new GuardedSender(sim, { attempts: ctx.store.attempts, killSwitch, dryRun: ctx.config.dryRun });
    return { chain, reader, sim, ctx, live, cold, mint, ratWallets, creator, deps: { chain: reader, keys, sender, killSwitch } };
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
    // a paused stock's tokens cannot move, but its SOL still goes, and the result says tokens were left
    expect(r2).toMatchObject({ ok: 1, failed: 0, tokensLeft: 1 }); // the first two were swept above
    expect(w.chain.sol(w.ratWallets[2]!)).toBe(0n);
    expect(lines.some((l) => /tokens stay \(stock paused\)/.test(l))).toBe(true);
  });

  it('red team: a token account frozen by the issuer keeps its tokens, but its SOL is still swept', async () => {
    const w = await world({ DRY_RUN: 'false', LIVE_CONFIRM: LIVE_CONFIRM_PHRASE });
    const { ataAddress } = await import('@rat/chain/sim');
    w.chain.setFrozen(ataAddress(w.ratWallets[0]!, w.mint, TOKEN_2022_PROGRAM), true);
    const r = await sweepCommand(w.ctx, w.deps, { to: w.cold, confirm: sweepPhrase(w.cold) });
    expect(r).toMatchObject({ ok: 3, failed: 0, tokensLeft: 1 });
    expect(w.chain.sol(w.ratWallets[0]!)).toBe(0n);
    expect(w.chain.tokenBalance(w.cold, w.mint, TOKEN_2022_PROGRAM)).toBe(2_000_000n);
  });

  it('red team: the creator was drained after a key leak: each rat pays its own fee, everything still reaches the cold wallet', async () => {
    const w = await world({ DRY_RUN: 'false', LIVE_CONFIRM: LIVE_CONFIRM_PHRASE });
    w.chain.setSol(w.creator.publicKey.toBase58(), 0n);
    const r = await sweepCommand(w.ctx, w.deps, { to: w.cold, confirm: sweepPhrase(w.cold) });
    expect(r).toMatchObject({ executed: true, ok: 3, failed: 0 });
    expect(w.chain.tokenBalance(w.cold, w.mint, TOKEN_2022_PROGRAM)).toBe(3_000_000n);
    for (const wallet of w.ratWallets) expect(w.chain.sol(wallet)).toBe(0n);
    expect(w.chain.sol(w.creator.publicKey.toBase58())).toBe(0n);
    // the cold wallet got every rat's SOL and token account rent, minus the fees and its own token account's rent
    expect(w.chain.sol(w.cold)).toBeGreaterThan(3n * 3_000_000n);
  });

  it('red team: rats still being hired are only swept with the kill switch on; the plan says how many hold anything', async () => {
    const w = await world({ DRY_RUN: 'false', LIVE_CONFIRM: LIVE_CONFIRM_PHRASE });
    const wallet = await w.deps.keys.newRatKey();
    await w.live.rats.create({ wallet, stockMint: w.mint, salaryLamports: 30_000_000n, avatarSeed: 'cccccccc' });
    w.chain.fundAccount(wallet, 29_000_000n); // funded, swap not landed yet
    const r = await sweepCommand(w.ctx, w.deps, { to: w.cold, confirm: sweepPhrase(w.cold) });
    expect(r).toMatchObject({ ok: 3, skippedHiring: 1 });
    expect(w.chain.sol(wallet)).toBe(29_000_000n);
    lines.length = 0;
    await sweepCommand(w.ctx, w.deps, { to: w.cold });
    expect(lines).toContain('  wallets holding anything: 0');
    const { engageKillSwitch } = await import('@rat/safety');
    await engageKillSwitch(w.ctx.store.settings, 'teardown');
    expect(await sweepCommand(w.ctx, w.deps, { to: w.cold, confirm: sweepPhrase(w.cold) })).toMatchObject({ ok: 1, skippedHiring: 0 });
    expect(w.chain.sol(wallet)).toBe(0n);
  });

  it('red team: refuses the bot\'s own wallets and program addresses as destination', async () => {
    const w = await world({ DRY_RUN: 'false', LIVE_CONFIRM: LIVE_CONFIRM_PHRASE });
    for (const to of [w.ctx.config.creatorPubkey!, w.ratWallets[0]!]) {
      await expect(sweepCommand(w.ctx, w.deps, { to, confirm: sweepPhrase(to) })).rejects.toThrow(/own wallets/);
    }
    const pda = PublicKey.findProgramAddressSync([Buffer.from('vault')], SystemProgram.programId)[0].toBase58();
    await expect(sweepCommand(w.ctx, w.deps, { to: pda, confirm: sweepPhrase(pda) })).rejects.toThrow(/off-curve/);
    expect(w.sim.submitted + w.sim.simulated).toBe(0);
  });

  it('red team: a failed rat still holding SOL (two-step hire that never bought) is swept too', async () => {
    const w = await world({ DRY_RUN: 'false', LIVE_CONFIRM: LIVE_CONFIRM_PHRASE });
    const wallet = await w.deps.keys.newRatKey();
    const r = await w.live.rats.create({ wallet, stockMint: w.mint, salaryLamports: 30_000_000n, avatarSeed: 'bbbbbbbb' });
    await w.live.rats.update(r.id, { status: 'failed' });
    w.chain.fundAccount(wallet, 29_000_000n);
    const res = await sweepCommand(w.ctx, w.deps, { to: w.cold, confirm: sweepPhrase(w.cold) });
    expect(res).toMatchObject({ executed: true, failed: 0 });
    expect(w.chain.sol(wallet)).toBe(0n);
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

describe('keys backup / restore (the rat wallet keys exist nowhere else)', () => {
  it('backs up still encrypted, restores into an empty database, and the restored keys sign', async () => {
    const ctx = ctxFor();
    const store = new DbKeyStore(ctx.store.keys, ring);
    const creator = Keypair.generate();
    await ctx.store.keys.setRoleKey(encryptRoleKey(creator, ring, 'creator'));
    const wallets = [];
    for (let i = 0; i < 5; i++) wallets.push(await store.newRatKey());
    const secrets = await Promise.all(wallets.map(async (w) => bs58.encode((await store.ratSigner(w)).secretKey)));
    const dir = mkdtempSync(join(tmpdir(), 'rat-backup-'));
    const file = join(dir, 'keys.json');
    expect(await keysBackupCommand(ctx, ring, file)).toEqual({ keys: 6 });
    const text = readFileSync(file, 'utf8');
    for (const secret of [...secrets, bs58.encode(creator.secretKey)]) expect(text).not.toContain(secret);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await expect(keysBackupCommand(ctx, ring, file)).rejects.toThrow(/EEXIST/); // never overwrites by accident

    // the database is lost: a fresh one, same master key
    const fresh = await openMemoryDatabase();
    try {
      const ctx2 = { ...ctx, store: new Store(fresh.db, 'paper', clock) };
      expect(await keysRestoreCommand(ctx2, ring, file)).toEqual({ restored: 6, skipped: 0 });
      expect(await keysRestoreCommand(ctx2, ring, file)).toEqual({ restored: 0, skipped: 6 });
      const restored = new DbKeyStore(ctx2.store.keys, ring);
      for (let i = 0; i < wallets.length; i++) expect(bs58.encode((await restored.ratSigner(wallets[i]!)).secretKey)).toBe(secrets[i]);
      expect((await ctx2.store.keys.getRole('creator'))?.pubkey).toBe(creator.publicKey.toBase58());
    } finally {
      await fresh.close();
    }
    expect(lines.join('\n')).not.toContain(secrets[0]!);
  });

  it('--out - (run inside the Railway worker): the backup goes to stdout between markers, never to the container disk', async () => {
    const ctx = ctxFor();
    const notes: string[] = [];
    const store = new DbKeyStore(ctx.store.keys, ring);
    await ctx.store.keys.setRoleKey(encryptRoleKey(Keypair.generate(), ring, 'creator'));
    const wallets = [await store.newRatKey(), await store.newRatKey()];
    expect(await keysBackupCommand({ ...ctx, err: (l) => notes.push(l) }, ring, '-')).toEqual({ keys: 3 });
    expect(lines[0]).toBe('-----BEGIN RAT KEY BACKUP-----');
    expect(lines[2]).toBe('-----END RAT KEY BACKUP-----');
    expect(lines.length).toBe(3);
    expect(notes.join('\n')).toMatch(/3 keys \(2 rat wallets, 1 creator\) to stdout/);
    // what the Mac saves restores into an empty database
    const dir = mkdtempSync(join(tmpdir(), 'rat-backup-'));
    writeFileSync(join(dir, 'k.json'), lines[1]!);
    const fresh = await openMemoryDatabase();
    try {
      const ctx2 = { ...ctx, store: new Store(fresh.db, 'paper', clock) };
      expect(await keysRestoreCommand(ctx2, ring, join(dir, 'k.json'))).toEqual({ restored: 3, skipped: 0 });
      // `--in -`: the same backup piped in from the Mac
      expect(await keysRestoreCommand(ctx2, ring, '-', lines[1]!)).toEqual({ restored: 0, skipped: 3 });
      expect((await new DbKeyStore(ctx2.store.keys, ring).ratSigner(wallets[1]!)).publicKey.toBase58()).toBe(wallets[1]);
    } finally {
      await fresh.close();
    }
  });

  it('refuses to back up or restore with the wrong master key, and names keys that do not decrypt', async () => {
    const ctx = ctxFor();
    const store = new DbKeyStore(ctx.store.keys, ring);
    const wallet = await store.newRatKey();
    const other = new MasterKeyRing({ version: 1, base64: randomBytes(32).toString('base64') });
    const dir = mkdtempSync(join(tmpdir(), 'rat-backup-'));
    await expect(keysBackupCommand(ctx, other, join(dir, 'a.json'))).rejects.toThrow(/do not decrypt/);
    await keysBackupCommand(ctx, ring, join(dir, 'b.json'));
    await expect(keysRestoreCommand(ctx, other, join(dir, 'b.json'))).rejects.toThrow(/nothing restored/);
    const records = await ctx.store.keys.all();
    expect(verifyKeyRecords(records, ring)).toEqual({ ok: 1, bad: [] });
    expect(verifyKeyRecords(records, other).bad[0]?.pubkey).toBe(wallet);
  });
});
