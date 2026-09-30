import { randomBytes } from 'node:crypto';
import { FakeClock, LIVE_CONFIRM_PHRASE, loadConfig } from '@rat/core';
import { SimChain, SimChainReader } from '@rat/chain/sim';
import { type DbHandle, Store, openMemoryDatabase } from '@rat/db';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foundersPhrase, foundersSeedCommand } from './commands/founders';

let handle: DbHandle;
beforeEach(async () => {
  handle = await openMemoryDatabase();
});
afterEach(async () => handle.close());

const SOL = 1_000_000_000n;

function world(creatorLamports: bigint, env: Record<string, string> = {}) {
  const creator = Keypair.generate().publicKey.toBase58();
  const config = loadConfig({
    DATABASE_URL: 'memory://',
    KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    CREATOR_PUBKEY: creator,
    COIN_MINT: Keypair.generate().publicKey.toBase58(),
    DRY_RUN: 'false',
    LIVE_CONFIRM: LIVE_CONFIRM_PHRASE,
    ...env,
  });
  const store = new Store(handle.db, config.dryRun ? 'paper' : 'live', new FakeClock());
  const chain = new SimChain();
  chain.fundAccount(creator, creatorLamports);
  const lines: string[] = [];
  const ctx = { config, store, clock: new FakeClock(), out: (l: string) => lines.push(l) };
  return { ctx, store, chain: new SimChainReader(chain), lines };
}

describe('rat founders-seed (founding rats at launch)', () => {
  it('plans, then books N salaries as seed (never a claim), once', async () => {
    const w = world(SOL / 2n);
    expect((await foundersSeedCommand(w.ctx, { chain: w.chain }, { rats: '5' })).executed).toBe(false);
    expect(w.lines.at(-1)).toContain(`--confirm "${foundersPhrase(5)}"`);
    expect(await w.store.ledger.balance('hire')).toBe(0n);
    expect((await foundersSeedCommand(w.ctx, { chain: w.chain }, { rats: '5', confirm: 'FOUNDERS 5 RATS' })).executed).toBe(true);
    expect((await w.store.ledger.sumByReason()).get('hire:seed_credit')).toBe(5n * w.ctx.config.salaryLamports);
    expect((await w.store.claims.totals()).claimed).toBe(0n);
    await expect(foundersSeedCommand(w.ctx, { chain: w.chain }, { rats: '1', confirm: 'FOUNDERS 1 RATS' })).rejects.toThrow(/booked once/);
  });

  it('only while the bot runs LIVE with its coin', async () => {
    const w = world(SOL, { DRY_RUN: 'true', LIVE_CONFIRM: '' });
    await expect(foundersSeedCommand(w.ctx, { chain: w.chain }, { rats: '3', confirm: 'FOUNDERS 3 RATS' })).rejects.toThrow(/LIVE/);
  });

  it('1 to 5 rats, and never more than the creator wallet holds above its reserve', async () => {
    const w = world(SOL / 10n); // 0.1 SOL: 0.05 free above the reserve, one salary is 0.03
    await expect(foundersSeedCommand(w.ctx, { chain: w.chain }, { rats: '6', confirm: 'FOUNDERS 6 RATS' })).rejects.toThrow(/1 to 5/);
    await expect(foundersSeedCommand(w.ctx, { chain: w.chain }, { rats: '0' })).rejects.toThrow(/1 to 5/);
    await expect(foundersSeedCommand(w.ctx, { chain: w.chain }, { rats: '2', confirm: 'FOUNDERS 2 RATS' })).rejects.toThrow(/only 0.05 SOL is free/);
    expect((await foundersSeedCommand(w.ctx, { chain: w.chain }, { rats: '1', confirm: 'FOUNDERS 1 RATS' })).executed).toBe(true);
  });
});
