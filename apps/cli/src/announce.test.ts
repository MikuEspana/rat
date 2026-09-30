import { randomBytes } from 'node:crypto';
import { FakeClock, SETTINGS, loadConfig } from '@rat/core';
import { SimChain, SimChainReader } from '@rat/chain/sim';
import { type DbHandle, Store, openMemoryDatabase } from '@rat/db';
import { PUMP_PROGRAM_ID, bondingCurveAddress, encodeBondingCurve } from '@rat/pump';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { announceCaCommand } from './commands/announce';

let handle: DbHandle;
beforeEach(async () => {
  handle = await openMemoryDatabase();
});
afterEach(async () => handle.close());

function setup(env: Record<string, string> = {}) {
  const chain = new SimChain();
  const creator = Keypair.generate().publicKey.toBase58();
  const coin = Keypair.generate().publicKey.toBase58();
  chain.setAccountData(bondingCurveAddress(coin), PUMP_PROGRAM_ID, encodeBondingCurve({ creator }));
  const config = loadConfig({ DATABASE_URL: 'memory://', KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'), CREATOR_PUBKEY: creator, ...env });
  const store = new Store(handle.db, 'paper', new FakeClock('2026-10-01T12:00:00Z'));
  const lines: string[] = [];
  const ctx = { config, store, clock: new FakeClock('2026-10-01T12:00:00Z'), out: (l: string) => lines.push(l) };
  return { chain, reader: new SimChainReader(chain), creator, coin, store, ctx, lines };
}

describe('rat announce-ca', () => {
  it('a pump.fun coin created by the creator wallet: the site shows it', async () => {
    const s = setup();
    expect(await announceCaCommand(s.ctx, s.reader, s.coin)).toBe(true);
    expect(await s.store.settings.get(SETTINGS.announcedCoinMint)).toBe(s.coin);
  });

  it('a coin from another wallet, no pump.fun coin, or not an address: refused, nothing written', async () => {
    const s = setup();
    const other = Keypair.generate().publicKey.toBase58();
    s.chain.setAccountData(bondingCurveAddress(other), PUMP_PROGRAM_ID, encodeBondingCurve({ creator: Keypair.generate().publicKey.toBase58() }));
    expect(await announceCaCommand(s.ctx, s.reader, other)).toBe(false);
    expect(s.lines.join()).toMatch(/creator fees go to .* not to CREATOR_PUBKEY/);
    expect(await announceCaCommand(s.ctx, s.reader, Keypair.generate().publicKey.toBase58())).toBe(false);
    expect(await announceCaCommand(s.ctx, s.reader, 'not-a-mint')).toBe(false);
    expect(await s.store.settings.get(SETTINGS.announcedCoinMint)).toBeNull();
  });

  it('never another coin than the one the bot runs', async () => {
    const s = setup();
    const running = setup({});
    const cfg = loadConfig({ DATABASE_URL: 'memory://', KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'), CREATOR_PUBKEY: s.creator, COIN_MINT: running.coin });
    expect(await announceCaCommand({ ...s.ctx, config: cfg }, s.reader, s.coin)).toBe(false);
    expect(s.lines.join()).toMatch(/the bot runs coin/);
  });
});
