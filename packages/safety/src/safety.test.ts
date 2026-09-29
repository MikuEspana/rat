import { BlockedError, FakeClock, type MintState, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type TxRequest } from '@rat/core';
import { SimChain, SimChainReader, SimTxSender } from '@rat/chain/sim';
import { type DbHandle, Store, openMemoryDatabase } from '@rat/db';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecordingAlerts, ThrottledAlerts } from './alerts';
import { limitViolations } from './effects';
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
      capPerHour: { hire: 1n * SOL },
      alertPct: 50,
      wallets: { hire: undefined },
      reserves: { hire: SOL / 20n },
      smokeMode: false,
      smokeCap: SOL / 10n,
      checkWallets: false,
      ...over,
    },
  );
}

const credit = (bucket: 'hire', lamports: bigint) => store.ledger.append({ bucket, deltaLamports: lamports, reason: 'claim_credit' });

describe('SpendGuard', () => {
  it('only spends claimed fees: the wallet balance never counts', async () => {
    const chain = new SimChain();
    const creator = Keypair.generate().publicKey.toBase58();
    chain.fundAccount(creator, 1_000n * SOL);
    const g = guard({ checkWallets: true, wallets: { hire: creator } }, { chain: new SimChainReader(chain) });
    const r = await g.authorize({ bucket: 'hire', lamports: SOL / 100n, refType: 'rat', refId: '1' });
    expect(r).toMatchObject({ ok: false, reason: 'insufficient_budget' });
    await credit('hire', SOL / 100n);
    expect((await g.authorize({ bucket: 'hire', lamports: SOL / 100n, refType: 'rat', refId: '1' })).ok).toBe(true);
    expect(await store.ledger.balance('hire')).toBe(0n);
  });

  it('enforces the hourly hire cap exactly, on a rolling window', async () => {
    await credit('hire', 10n * SOL);
    const g = guard();
    expect((await g.authorize({ bucket: 'hire', lamports: (6n * SOL) / 10n, refType: 'rat', refId: '1' })).ok).toBe(true);
    expect((await g.authorize({ bucket: 'hire', lamports: (4n * SOL) / 10n, refType: 'rat', refId: '2' })).ok).toBe(true);
    const over = await g.authorize({ bucket: 'hire', lamports: 1n, refType: 'rat', refId: '3' });
    expect(over).toMatchObject({ ok: false, reason: 'hourly_cap' });
    expect(alerts.keys()).toContain('cap_reached_hire');
    // the refused request reserved nothing: the budget still holds everything but the 1 SOL spent
    expect(await store.ledger.balance('hire')).toBe(9n * SOL);
    // an hour later the window has rolled
    clock.advanceSeconds(3601);
    expect((await g.authorize({ bucket: 'hire', lamports: SOL, refType: 'rat', refId: '4' })).ok).toBe(true);
  });

  it('reports the room left under the cap', async () => {
    await credit('hire', 5n * SOL);
    const g = guard();
    expect(await g.remainingCap('hire')).toBe(SOL);
    await g.authorize({ bucket: 'hire', lamports: (SOL * 3n) / 10n, refType: 'rat', refId: '1' });
    expect(await g.remainingCap('hire')).toBe((SOL * 7n) / 10n);
    clock.advanceSeconds(3601);
    expect(await g.remainingCap('hire')).toBe(SOL);
  });

  it('alerts once when hiring crosses 50% of the cap', async () => {
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

  it('live wallet check keeps the creator reserve', async () => {
    const chain = new SimChain();
    const creator = Keypair.generate().publicKey.toBase58();
    chain.fundAccount(creator, SOL / 10n);
    await credit('hire', SOL);
    const g = guard({ checkWallets: true, wallets: { hire: creator }, reserves: { hire: SOL / 20n } }, { chain: new SimChainReader(chain) });
    // 0.1 SOL wallet: 0.051 + 0.05 reserve = 0.101 -> not; 0.05 + 0.05 reserve = 0.1 -> ok
    expect(await g.authorize({ bucket: 'hire', lamports: (SOL * 51n) / 1000n, refType: 'rat', refId: '1' })).toMatchObject({ ok: false, reason: 'wallet_low' });
    expect(alerts.keys()).toContain('wallet_low_hire');
    expect((await g.authorize({ bucket: 'hire', lamports: SOL / 20n, refType: 'rat', refId: '2' })).ok).toBe(true);
    // no wallet configured: refuse instead of spending blind
    const blind = guard({ checkWallets: true, wallets: { hire: undefined } }, { chain: new SimChainReader(chain) });
    expect(await blind.authorize({ bucket: 'hire', lamports: 1n, refType: 'rat', refId: '3' })).toMatchObject({ ok: false, reason: 'wallet_unknown' });
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
      limits: { solOut: [{ account: payer.publicKey.toBase58(), maxLamports: 20_000_000n }] },
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
      {
        prepare: async () => { throw new Error('boom'); },
        submit: async () => { throw new Error('x'); },
        simulate: async () => { throw new Error('x'); },
        status: async () => { throw new Error('x'); },
        simulateEffects: async () => { throw new Error('x'); },
      },
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

describe('red team: GuardedSender live checks', () => {
  const setup = (opts: { fence?: () => Promise<boolean> } = {}) => {
    const chain = new SimChain();
    const sim = new SimTxSender(chain);
    const payer = Keypair.generate();
    const thief = Keypair.generate().publicKey;
    chain.fundAccount(payer.publicKey.toBase58(), SOL);
    const gs = new GuardedSender(sim, { attempts: store.attempts, killSwitch: new DbKillSwitch(store.settings, false), dryRun: false, alerts, fence: opts.fence });
    const limits = { solOut: [{ account: payer.publicKey.toBase58(), maxLamports: 20_000_000n }] };
    const pay = (lamports: number, to = Keypair.generate().publicKey) => SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports });
    const req = (over: Partial<TxRequest> = {}): TxRequest => ({ kind: 'claim', label: 'claim', feePayer: payer, signers: [], instructions: [pay(10_000_000)], computeUnitLimit: 200_000, limits, ...over });
    return { chain, sim, payer, thief, gs, req, pay };
  };
  const ref = { type: 'claim', id: '1' };

  it('an extra instruction draining the signer is refused before sending: no attempt, no tx, critical alert', async () => {
    const { chain, sim, payer, thief, gs, req, pay } = setup();
    const r = await gs.execute({ request: req({ instructions: [pay(10_000_000), pay(500_000_000, thief)] }), ref });
    expect(r).toMatchObject({ status: 'blocked' });
    expect(r.status === 'blocked' && r.reason).toMatch(/effects_check: .* would lose 0\.51/);
    expect(sim.submitted).toBe(0);
    expect(chain.sol(thief.toBase58())).toBe(0n);
    expect(chain.sol(payer.publicKey.toBase58())).toBe(SOL);
    expect(await store.attempts.latestForRef('claim', '1')).toBeNull();
    expect(alerts.sent.find((a) => a.key === 'effects_claim')?.level).toBe('critical');
  });

  it('a kill switch engaged while the tx is being prepared and simulated stops it before the send', async () => {
    // the effects simulation can take up to ~30 s under 429 retries: `rat kill` in that window must still win
    const { sim, gs, req } = setup();
    const simulateEffects = sim.simulateEffects.bind(sim);
    sim.simulateEffects = async (p, l) => {
      await engageKillSwitch(store.settings, 'operator pressed KILL mid-send');
      return simulateEffects(p, l);
    };
    const r = await gs.execute({ request: req(), ref });
    expect(r).toMatchObject({ status: 'blocked', reason: expect.stringMatching(/kill_switch/) });
    expect(sim.submitted).toBe(0);
    expect(await store.attempts.latestForRef('claim', '1')).toBeNull();
  });

  it('within its limits the tx is sent (after one effects simulation)', async () => {
    const { sim, gs, req } = setup();
    const r = await gs.execute({ request: req(), ref });
    expect(r.status === 'done' && r.outcome.status).toBe('confirmed');
    expect(sim.effectsChecked).toBe(1);
    expect(sim.submitted).toBe(1);
  });

  it('a live claim or hire without limits is refused (fail closed); sweep needs none', async () => {
    const { sim, gs, req } = setup();
    expect(await gs.execute({ request: req({ limits: undefined }), ref })).toMatchObject({ status: 'blocked', reason: expect.stringMatching(/needs spend limits/) });
    const reservation = { ledgerId: 0, bucket: 'hire' as const, lamports: 10_000_000n, refType: 'rat', refId: '1' };
    expect(await gs.execute({ request: req({ kind: 'hire', label: 'hire', limits: undefined }), reservation, ref: { type: 'rat', id: '1' } })).toMatchObject({
      status: 'blocked',
      reason: expect.stringMatching(/live hire transaction needs spend limits/),
    });
    expect((await gs.execute({ request: req({ kind: 'sweep', limits: undefined }), ref: { type: 'sweep', id: '1' } })).status).toBe('done');
    expect(sim.submitted).toBe(1);
  });

  it('a token minimum that the tx does not deliver is refused', async () => {
    const { chain, sim, payer, gs, req } = setup();
    const mint = Keypair.generate().publicKey.toBase58();
    chain.createMint({ mint, decimals: 6, tokenProgram: TOKEN_2022_PROGRAM, supply: 1n });
    const tokens = [{ owner: payer.publicKey.toBase58(), mint, tokenProgram: TOKEN_2022_PROGRAM, minDelta: 1n }];
    const r = await gs.execute({ request: req({ limits: { solOut: [], tokens } }), ref });
    expect(r.status === 'blocked' && r.reason).toMatch(/would get 0 raw/);
    expect(sim.submitted).toBe(0);
  });

  it('a simulation that fails, or cannot run, is refused without sending', async () => {
    const { sim, gs, req, pay } = setup();
    expect(await gs.execute({ request: req({ instructions: [pay(2_000_000_000)] }), ref })).toMatchObject({ status: 'blocked', reason: expect.stringMatching(/simulation failed/) });
    const broken = new GuardedSender(
      { prepare: (q) => sim.prepare(q), submit: (p) => sim.submit(p), simulate: (p) => sim.simulate(p), status: (a, b) => sim.status(a, b), simulateEffects: async () => { throw new Error('rpc down'); } },
      { attempts: store.attempts, killSwitch: new DbKillSwitch(store.settings, false), dryRun: false },
    );
    expect(await broken.execute({ request: req(), ref })).toMatchObject({ status: 'blocked', reason: expect.stringMatching(/simulation unavailable: rpc down/) });
    expect(sim.submitted).toBe(0);
  });

  it('DRY RUN never runs the live effects check (it only simulates)', async () => {
    const chain = new SimChain();
    const sim = new SimTxSender(chain);
    const payer = Keypair.generate();
    chain.fundAccount(payer.publicKey.toBase58(), SOL);
    const gs = new GuardedSender(sim, { attempts: store.attempts, killSwitch: new DbKillSwitch(store.settings, false), dryRun: true });
    const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
    await gs.execute({ request: { kind: 'claim', label: 'x', feePayer: payer, signers: [], instructions: [ix], computeUnitLimit: 1 }, ref });
    expect(sim.effectsChecked).toBe(0);
    expect(sim.submitted).toBe(0);
  });

  it('a worker that lost the lease sends nothing (fence)', async () => {
    let holding = true;
    const { sim, gs, req } = setup({ fence: async () => holding });
    expect((await gs.execute({ request: req(), ref })).status).toBe('done');
    holding = false;
    expect(await gs.execute({ request: req(), ref: { type: 'claim', id: '2' } })).toMatchObject({ status: 'blocked', reason: expect.stringMatching(/lease_lost/) });
    expect(sim.submitted).toBe(1);
    expect(await store.attempts.latestForRef('claim', '2')).toBeNull();
  });

  it('a send that throws after broadcast is `unknown` (may still land), never "not sent"', async () => {
    const { sim, gs, req } = setup();
    const inner = sim.submit.bind(sim);
    sim.submit = async (p) => {
      await inner(p); // it landed...
      throw new Error('RPC 503 while polling'); // ...but we never heard back
    };
    const r = await gs.execute({ request: req(), ref });
    expect(r.status === 'done' && r.outcome.status).toBe('unknown');
    expect((await store.attempts.latestForRef('claim', '1'))?.status).toBe('unknown');
  });

  it('a sender that refuses before broadcasting (BlockedError) is a plain error', async () => {
    const { sim, gs, req } = setup();
    sim.submit = async () => {
      throw new BlockedError('not live', 'not_live');
    };
    expect(await gs.execute({ request: req(), ref })).toMatchObject({ status: 'error' });
    expect((await store.attempts.latestForRef('claim', '1'))?.status).toBe('failed');
  });
});

describe('red team: SpendGuard races and overspend', () => {
  it('five parallel authorizations with budget for one: exactly one passes', async () => {
    await store.ledger.append({ bucket: 'hire', deltaLamports: 30_000_000n, reason: 'claim_credit' });
    const g = guard();
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => g.authorize({ bucket: 'hire', lamports: 30_000_000n, refType: 'rat', refId: String(i) })),
    );
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(await store.ledger.balance('hire')).toBe(0n);
  });

  it('a spend that cost more than reserved is booked in full and raises a critical alert', async () => {
    await store.ledger.append({ bucket: 'hire', deltaLamports: SOL, reason: 'claim_credit' });
    const g = guard();
    const r = await g.authorize({ bucket: 'hire', lamports: SOL / 10n, refType: 'rat', refId: '1' });
    if (!r.ok) throw new Error(r.reason);
    await g.settle(r.reservation, SOL / 10n + 7_000n);
    expect(await store.ledger.balance('hire')).toBe(SOL - SOL / 10n - 7_000n);
    expect(alerts.sent.find((a) => a.key === 'overspend_hire')?.level).toBe('critical');
    await g.settle(r.reservation, SOL / 20n); // a second settle of the same reservation books nothing, no alert
    expect(await store.ledger.balance('hire')).toBe(SOL - SOL / 10n - 7_000n);
    expect(alerts.sent.filter((a) => a.key === 'overspend_hire').length).toBe(1);
  });
});

describe('secrets never reach a chat or the attempt log', () => {
  it('alert texts and stored send errors are redacted', async () => {
    const sent: string[] = [];
    const a = new ThrottledAlerts(async (_l, t) => void sent.push(t), clock, 0);
    await a.send('warn', 'task_failing_claim', 'claim failed 3 times: request to https://rpc.example/?api-key=TOPSECRET failed');
    expect(sent[0]).toBe('claim failed 3 times: request to https://rpc.example/?api-key=[redacted] failed');
    const chain = new SimChain();
    const sim = new SimTxSender(chain);
    const payer = Keypair.generate();
    chain.fundAccount(payer.publicKey.toBase58(), SOL);
    sim.submit = async () => {
      throw new Error('request to https://rpc.example/?api-key=TOPSECRET failed');
    };
    const gs = new GuardedSender(sim, { attempts: store.attempts, killSwitch: new DbKillSwitch(store.settings, false), dryRun: false });
    const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
    await gs.execute({ request: { kind: 'sweep', label: 's', feePayer: payer, signers: [], instructions: [ix], computeUnitLimit: 1 }, ref: { type: 'sweep', id: '1' } });
    expect((await store.attempts.latestForRef('sweep', '1'))?.error).not.toContain('TOPSECRET');
  });
});

describe('limitViolations', () => {
  it('flags every broken limit and a simulation that did not report all accounts', () => {
    const limits = { solOut: [{ account: 'A', maxLamports: 100n }], tokens: [{ owner: 'R', mint: 'M', tokenProgram: TOKEN_2022_PROGRAM, minDelta: 5n }] };
    expect(limitViolations(limits, { solDelta: [-100n], tokenDelta: [5n] })).toEqual([]);
    expect(limitViolations(limits, { solDelta: [50n], tokenDelta: [9n] })).toEqual([]);
    expect(limitViolations(limits, { solDelta: [-101n], tokenDelta: [4n] })).toHaveLength(2);
    expect(limitViolations(limits, { solDelta: [], tokenDelta: [] })).toEqual(['simulation did not report every limited account']);
  });
});
