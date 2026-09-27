import { FakeClock, type MintState, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type TxRequest } from '@rat/core';
import { SimChain, SimChainReader, SimTxSender } from '@rat/chain/sim';
import { type DbHandle, Store, openMemoryDatabase } from '@rat/db';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecordingAlerts, ThrottledAlerts } from './alerts';
import { GuardedSender } from './guarded-sender';
import { DbKillSwitch, engageKillSwitch, releaseKillSwitch } from './kill-switch';
import { verifyStockMints } from './mint-verifier';
import { SpendGuard, type SpendGuardConfig } from './spend-guard';

const SOL = 1_000_000_000n;
let handle: DbHandle;
let store: Store;
let clock: FakeClock;
let alerts: RecordingAlerts;

beforeEach(async () => {
  handle = await openMemoryDatabase();
  clock = new FakeClock('2026-10-01T12:00:00Z');
  store = new Store(handle.db, 'live', clock);
  alerts = new RecordingAlerts();
});
afterEach(async () => handle.close());

function guard(over: Partial<SpendGuardConfig> = {}, deps: Partial<ConstructorParameters<typeof SpendGuard>[0]> = {}) {
  return new SpendGuard(
    { ledger: store.ledger, killSwitch: new DbKillSwitch(store.settings, false), alerts, clock, ...deps },
    {
      capPerHour: { hire: 1n * SOL, burn: 1n * SOL },
      alertPct: 50,
      wallets: { hire: undefined, burn: undefined },
      reserves: { hire: SOL / 20n, burn: SOL / 100n },
      smokeMode: false,
      smokeCap: SOL / 10n,
      checkWallets: false,
      ...over,
    },
  );
}

const credit = (bucket: 'hire' | 'burn', lamports: bigint) => store.ledger.append({ bucket, deltaLamports: lamports, reason: 'claim_credit' });

describe('SpendGuard', () => {
  it('only spends claimed fees: the wallet balance never counts', async () => {
    const chain = new SimChain();
    const creator = Keypair.generate().publicKey.toBase58();
    chain.fundAccount(creator, 1_000n * SOL);
    const g = guard({ checkWallets: true, wallets: { hire: creator, burn: undefined } }, { chain: new SimChainReader(chain) });
    const r = await g.authorize({ bucket: 'hire', lamports: SOL / 100n, refType: 'rat', refId: '1' });
    expect(r).toMatchObject({ ok: false, reason: 'insufficient_budget' });
    await credit('hire', SOL / 100n);
    expect((await g.authorize({ bucket: 'hire', lamports: SOL / 100n, refType: 'rat', refId: '1' })).ok).toBe(true);
    expect(await store.ledger.balance('hire')).toBe(0n);
  });

  it('enforces the hourly cap exactly, per bucket, on a rolling window', async () => {
    await credit('hire', 10n * SOL);
    await credit('burn', 10n * SOL);
    const g = guard();
    expect((await g.authorize({ bucket: 'hire', lamports: (6n * SOL) / 10n, refType: 'rat', refId: '1' })).ok).toBe(true);
    expect((await g.authorize({ bucket: 'hire', lamports: (4n * SOL) / 10n, refType: 'rat', refId: '2' })).ok).toBe(true);
    const over = await g.authorize({ bucket: 'hire', lamports: 1n, refType: 'rat', refId: '3' });
    expect(over).toMatchObject({ ok: false, reason: 'hourly_cap' });
    expect(alerts.keys()).toContain('cap_reached_hire');
    // the burn bucket has its own cap
    expect((await g.authorize({ bucket: 'burn', lamports: SOL, refType: 'burn', refId: '1' })).ok).toBe(true);
    // an hour later the window has rolled
    clock.advanceSeconds(3601);
    expect((await g.authorize({ bucket: 'hire', lamports: SOL, refType: 'rat', refId: '4' })).ok).toBe(true);
  });

  it('reports the room left under the cap', async () => {
    await credit('burn', 5n * SOL);
    const g = guard();
    expect(await g.remainingCap('burn')).toBe(SOL);
    await g.authorize({ bucket: 'burn', lamports: (SOL * 3n) / 10n, refType: 'burn', refId: '1' });
    expect(await g.remainingCap('burn')).toBe((SOL * 7n) / 10n);
    clock.advanceSeconds(3601);
    expect(await g.remainingCap('burn')).toBe(SOL);
  });

  it('alerts once when a bucket crosses 50% of its cap', async () => {
    await credit('hire', 10n * SOL);
    const g = guard();
    for (let i = 0; i < 10; i++) await g.authorize({ bucket: 'hire', lamports: SOL / 10n, refType: 'rat', refId: String(i) });
    expect(alerts.keys().filter((k) => k === 'cap_alert_hire').length).toBe(1);
  });

  it('released and settled reservations free budget and cap room', async () => {
    await credit('hire', SOL);
    const g = guard();
    const r = await g.authorize({ bucket: 'hire', lamports: SOL, refType: 'rat', refId: '1' });
    if (!r.ok) throw new Error('expected ok');
    expect(await store.ledger.balance('hire')).toBe(0n);
    await g.release(r.reservation, 'did not land');
    expect(await store.ledger.balance('hire')).toBe(SOL);
    const r2 = await g.authorize({ bucket: 'hire', lamports: SOL, refType: 'rat', refId: '2' });
    if (!r2.ok) throw new Error('expected ok');
    await g.settle(r2.reservation, (SOL * 9n) / 10n);
    expect(await store.ledger.balance('hire')).toBe(SOL / 10n);
    expect(await store.ledger.netOutflowSince('hire', new Date(0))).toBe((SOL * 9n) / 10n);
  });

  it('kill switch and smoke cap block spending', async () => {
    await credit('hire', SOL);
    await engageKillSwitch(store.settings, 'test');
    expect(await guard().authorize({ bucket: 'hire', lamports: 1n, refType: 'rat', refId: '1' })).toMatchObject({ ok: false, reason: 'kill_switch' });
    await releaseKillSwitch(store.settings);
    const smoke = guard({ smokeMode: true, smokeCap: SOL / 10n });
    expect((await smoke.authorize({ bucket: 'hire', lamports: (SOL * 6n) / 100n, refType: 'rat', refId: '1' })).ok).toBe(true);
    expect(await smoke.authorize({ bucket: 'hire', lamports: (SOL * 6n) / 100n, refType: 'rat', refId: '2' })).toMatchObject({ ok: false, reason: 'smoke_cap' });
    const envKilled = new SpendGuard({ ledger: store.ledger, killSwitch: new DbKillSwitch(store.settings, true), alerts, clock }, (guard() as unknown as { cfg: SpendGuardConfig }).cfg);
    expect(await envKilled.authorize({ bucket: 'hire', lamports: 1n, refType: 'rat', refId: '3' })).toMatchObject({ ok: false, reason: 'kill_switch' });
  });

  it('live wallet check keeps the reserve and the fund share owed', async () => {
    const chain = new SimChain();
    const creator = Keypair.generate().publicKey.toBase58();
    chain.fundAccount(creator, SOL / 10n);
    await credit('hire', SOL);
    const g = guard(
      { checkWallets: true, wallets: { hire: creator, burn: undefined }, reserves: { hire: SOL / 20n, burn: 0n } },
      { chain: new SimChainReader(chain), pendingFundTransfer: async () => SOL / 50n },
    );
    // 0.1 SOL wallet: 0.03 + 0.05 reserve + 0.02 owed = 0.1 -> ok; 0.031 -> not
    expect((await g.authorize({ bucket: 'hire', lamports: (SOL * 3n) / 100n, refType: 'rat', refId: '1' })).ok).toBe(true);
    expect(await g.authorize({ bucket: 'hire', lamports: (SOL * 31n) / 1000n, refType: 'rat', refId: '2' })).toMatchObject({ ok: false, reason: 'wallet_low' });
  });
});

describe('GuardedSender', () => {
  const setup = (dryRun: boolean) => {
    const chain = new SimChain();
    const sim = new SimTxSender(chain);
    const payer = Keypair.generate();
    chain.fundAccount(payer.publicKey.toBase58(), SOL);
    const gs = new GuardedSender(sim, { attempts: store.attempts, killSwitch: new DbKillSwitch(store.settings, false), dryRun });
    const req = (kind: TxRequest['kind']): TxRequest => ({
      kind,
      label: kind,
      feePayer: payer,
      signers: [],
      instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 10_000_000 })],
      computeUnitLimit: 200_000,
    });
    return { chain, sim, payer, gs, req };
  };

  it('DRY RUN simulates, records the attempt, never submits', async () => {
    const { sim, payer, chain, gs, req } = setup(true);
    const r = await gs.execute({ request: req('claim'), ref: { type: 'claim', id: '1' } });
    expect(r.status).toBe('done');
    if (r.status !== 'done') return;
    expect(r.outcome.status).toBe('simulated');
    expect(sim.submitted).toBe(0);
    expect(chain.sol(payer.publicKey.toBase58())).toBe(SOL);
    expect((await store.attempts.bySignature(r.outcome.signature))?.status).toBe('simulated');
  });

  it('live (in-memory SimChain only) submits and records the attempt before sending', async () => {
    const { sim, gs, req } = setup(false);
    const r = await gs.execute({ request: req('claim'), ref: { type: 'claim', id: '1' } });
    expect(r.status === 'done' && r.outcome.status).toBe('confirmed');
    expect(sim.submitted).toBe(1);
  });

  it('kill switch blocks everything except the emergency sweep; spends need a reservation', async () => {
    const { sim, gs, req } = setup(true);
    expect(await gs.execute({ request: req('hire'), ref: { type: 'rat', id: '1' } })).toMatchObject({ status: 'blocked' });
    await engageKillSwitch(store.settings, 'test');
    expect(await gs.execute({ request: req('claim'), ref: { type: 'claim', id: '1' } })).toMatchObject({ status: 'blocked' });
    expect((await gs.execute({ request: req('sweep'), ref: { type: 'sweep', id: '1' } })).status).toBe('done');
    expect(sim.simulated).toBe(1);
  });

  it('prepare errors do not create attempts', async () => {
    const { gs, req } = setup(true);
    const bad = req('claim');
    bad.signers = [];
    bad.instructions = [SystemProgram.transfer({ fromPubkey: Keypair.generate().publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })];
    const failing = new GuardedSender(
      { prepare: async () => { throw new Error('boom'); }, submit: async () => { throw new Error('x'); }, simulate: async () => { throw new Error('x'); }, status: async () => { throw new Error('x'); } },
      { attempts: store.attempts, killSwitch: new DbKillSwitch(store.settings, false), dryRun: true },
    );
    expect(await failing.execute({ request: bad, ref: { type: 'claim', id: '9' } })).toMatchObject({ status: 'error' });
    expect(await store.attempts.latestForRef('claim', '9')).toBeNull();
    expect(gs.dryRun).toBe(true);
  });
});

describe('verifyStockMints', () => {
  const auth = Keypair.generate().publicKey.toBase58();
  const other = Keypair.generate().publicKey.toBase58();
  const mint = (over: Partial<MintState> = {}): MintState => ({
    mint: Keypair.generate().publicKey.toBase58(),
    exists: true,
    tokenProgram: TOKEN_2022_PROGRAM,
    decimals: 8,
    supply: 1n,
    mintAuthority: auth,
    freezeAuthority: auth,
    paused: false,
    uiMultiplier: 1,
    hasPermanentDelegate: true,
    ...over,
  });
  const map = (list: MintState[]) => new Map(list.map((m) => [m.mint, m]));

  it('majority authority: matching Token-2022 mints pass, others are rejected with a reason', () => {
    const good = [mint(), mint(), mint(), mint()];
    const legacy = mint({ tokenProgram: TOKEN_PROGRAM });
    const imposter = mint({ mintAuthority: other });
    const missing = mint({ exists: false, tokenProgram: null });
    const v = verifyStockMints(map([...good, legacy, imposter, missing]));
    expect(v).toMatchObject({ expectedAuthority: auth, source: 'majority' });
    for (const g of good) expect(v.checks.get(g.mint)?.ok).toBe(true);
    expect(v.checks.get(legacy.mint)?.reason).toMatch(/not a Token-2022/);
    expect(v.checks.get(imposter.mint)?.reason).toMatch(/does not match/);
    expect(v.checks.get(missing.mint)?.reason).toMatch(/not found/);
  });

  it('no clear majority rejects everything; the configured authority wins', () => {
    const split = [mint(), mint(), mint({ mintAuthority: other }), mint({ mintAuthority: other })];
    const v = verifyStockMints(map(split));
    expect(v.expectedAuthority).toBeNull();
    expect([...v.checks.values()].every((c) => !c.ok)).toBe(true);
    const cfg = verifyStockMints(map(split), other);
    expect(cfg.source).toBe('config');
    expect([...cfg.checks.values()].filter((c) => c.ok).length).toBe(2);
    expect(verifyStockMints(map([mint(), mint()])).expectedAuthority).toBeNull();
  });
});

describe('ThrottledAlerts', () => {
  it('sends the same key at most once per window', async () => {
    const sent: string[] = [];
    const a = new ThrottledAlerts(async (_l, t) => { sent.push(t); }, clock, 600_000);
    await a.send('warn', 'k', 'one');
    await a.send('warn', 'k', 'two');
    await a.send('warn', 'other', 'three');
    clock.advanceSeconds(601);
    await a.send('warn', 'k', 'four');
    expect(sent).toEqual(['one', 'three', 'four']);
  });
});
