import { randomBytes } from 'node:crypto';
import { ARMED_KILL_REASON, FakeClock, LIVE_CONFIRM_PHRASE, SETTINGS, loadConfig } from '@rat/core';
import { SimChain, SimChainReader } from '@rat/chain/sim';
import { type DbHandle, Store, openMemoryDatabase } from '@rat/db';
import { PUMP_PROGRAM_ID, bondingCurveAddress, encodeBondingCurve } from '@rat/pump';
import { engageKillSwitch } from '@rat/safety';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foundersSeedCommand } from './commands/founders';
import { launchArmCommand, launchRegisterCommand } from './commands/launch';

let handle: DbHandle;
beforeEach(async () => {
  handle = await openMemoryDatabase();
});
afterEach(async () => handle.close());

const sig = () => bs58.encode(randomBytes(64));

function setup(env: Record<string, string> = {}) {
  const chain = new SimChain();
  const creator = Keypair.generate().publicKey.toBase58();
  const coin = Keypair.generate().publicKey.toBase58();
  chain.setAccountData(bondingCurveAddress(coin), PUMP_PROGRAM_ID, encodeBondingCurve({ creator }));
  const config = loadConfig({
    DATABASE_URL: 'memory://',
    KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    CREATOR_PUBKEY: creator,
    DRY_RUN: 'false',
    LIVE_CONFIRM: LIVE_CONFIRM_PHRASE,
    ...env,
  });
  const clock = new FakeClock('2026-10-01T12:00:00Z');
  const store = new Store(handle.db, config.dryRun ? 'paper' : 'live', clock);
  const lines: string[] = [];
  const ctx = { config, store, clock, out: (l: string) => lines.push(l) };
  return { chain, reader: new SimChainReader(chain), creator, coin, store, ctx, lines };
}

const get = (s: ReturnType<typeof setup>, key: string) => s.store.settings.get(key);

describe('rat launch-arm', () => {
  it('kill switch ON with the armed reason + launch pending for 30 minutes; idempotent', async () => {
    const s = setup();
    expect(await launchArmCommand(s.ctx)).toBe(true);
    expect(await get(s, SETTINGS.killSwitch)).toBe('on');
    expect(await get(s, SETTINGS.killReason)).toBe(ARMED_KILL_REASON);
    expect(await get(s, SETTINGS.launchPendingUntil)).toBe('2026-10-01T12:30:00.000Z');
    expect(s.lines).toHaveLength(1);
    s.ctx.clock.advanceSeconds(60);
    expect(await launchArmCommand(s.ctx)).toBe(true);
    expect(await get(s, SETTINGS.killReason)).toBe(ARMED_KILL_REASON);
    expect(await get(s, SETTINGS.launchPendingUntil)).toBe('2026-10-01T12:31:00.000Z');
  });

  it('refused with COIN_MINT set, without CREATOR_PUBKEY, or with the kill switch on for another reason', async () => {
    const withCoin = setup({ COIN_MINT: Keypair.generate().publicKey.toBase58() });
    expect(await launchArmCommand(withCoin.ctx)).toBe(false);
    expect(withCoin.lines.join()).toMatch(/already launched/);
    expect(await get(withCoin, SETTINGS.killSwitch)).toBeNull();
    expect(await get(withCoin, SETTINGS.launchPendingUntil)).toBeNull();

    const noCreator = setup({ CREATOR_PUBKEY: '' });
    expect(await launchArmCommand(noCreator.ctx)).toBe(false);

    const killed = setup();
    await engageKillSwitch(killed.store.settings, 'manual');
    expect(await launchArmCommand(killed.ctx)).toBe(false);
    expect(killed.lines.join()).toMatch(/another reason \(manual\)/);
    expect(await get(killed, SETTINGS.killReason)).toBe('manual');
    expect(await get(killed, SETTINGS.launchPendingUntil)).toBeNull();
  });
});

describe('rat launch-register', () => {
  it('writes the mint + sigs (dedup), clears pending, releases the armed kill switch', async () => {
    const s = setup();
    await launchArmCommand(s.ctx);
    const [a, b] = [sig(), sig()];
    await s.store.settings.set(SETTINGS.knownOwnerTxSigs, a);
    expect(await launchRegisterCommand(s.ctx, s.reader, s.coin, { sigs: `${a}, ${b}` })).toBe(true);
    expect(await get(s, SETTINGS.announcedCoinMint)).toBe(s.coin);
    expect(await get(s, SETTINGS.knownOwnerTxSigs)).toBe(`${a},${b}`);
    expect(await get(s, SETTINGS.launchPendingUntil)).toBeNull();
    expect(await get(s, SETTINGS.killSwitch)).toBe('off');
    expect(s.lines.at(-1)).toMatch(/registered.*kill switch released/);
  });

  it('never releases a kill switch engaged for another reason', async () => {
    const s = setup();
    await launchArmCommand(s.ctx);
    await engageKillSwitch(s.store.settings, 'unknown transaction signed by the creator wallet: x');
    expect(await launchRegisterCommand(s.ctx, s.reader, s.coin, { sigs: sig() })).toBe(true);
    expect(await get(s, SETTINGS.killSwitch)).toBe('on');
    expect(s.lines.at(-1)).toMatch(/kill switch left ON/);
  });

  it("refuses another creator's coin, another coin than COIN_MINT, and bad or missing signatures: nothing written", async () => {
    const s = setup();
    await launchArmCommand(s.ctx);
    const other = Keypair.generate().publicKey.toBase58();
    s.chain.setAccountData(bondingCurveAddress(other), PUMP_PROGRAM_ID, encodeBondingCurve({ creator: Keypair.generate().publicKey.toBase58() }));
    expect(await launchRegisterCommand(s.ctx, s.reader, other, { sigs: sig() })).toBe(false);
    expect(s.lines.at(-1)).toMatch(/^launch-register: refused: .*not to CREATOR_PUBKEY/);
    expect(await launchRegisterCommand(s.ctx, s.reader, s.coin, { sigs: '' })).toBe(false);
    expect(await launchRegisterCommand(s.ctx, s.reader, s.coin, { sigs: 'abc' })).toBe(false);
    expect(await launchRegisterCommand(s.ctx, s.reader, s.coin, { sigs: `${sig()},${'1'.repeat(89)}` })).toBe(false);
    const running = setup({ COIN_MINT: Keypair.generate().publicKey.toBase58() });
    expect(await launchRegisterCommand({ ...s.ctx, config: running.ctx.config }, s.reader, s.coin, { sigs: sig() })).toBe(false);
    expect(s.lines.at(-1)).toMatch(/the bot runs coin/);
    expect(await get(s, SETTINGS.announcedCoinMint)).toBeNull();
    expect(await get(s, SETTINGS.knownOwnerTxSigs)).toBeNull();
    expect(await get(s, SETTINGS.launchPendingUntil)).not.toBeNull();
    expect(await get(s, SETTINGS.killReason)).toBe(ARMED_KILL_REASON);
    expect(await get(s, SETTINGS.killSwitch)).toBe('on');
  });
});

describe('rat founders-seed while armed', () => {
  it('works LIVE without COIN_MINT', async () => {
    const s = setup();
    const chain = new SimChain();
    chain.fundAccount(s.creator, 1_000_000_000n);
    await launchArmCommand(s.ctx);
    expect((await foundersSeedCommand(s.ctx, { chain: new SimChainReader(chain) }, { rats: '3', confirm: 'FOUNDERS 3 RATS' })).executed).toBe(true);
    expect((await s.store.ledger.sumByReason()).get('hire:seed_credit')).toBe(3n * s.ctx.config.salaryLamports);
  });
});
