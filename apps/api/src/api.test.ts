import { EventsResponseSchema, HealthResponseSchema, RatsResponseSchema, StateResponseSchema } from '@rat/contract';
import { SETTINGS } from '@rat/core';
import { schema } from '@rat/db';
import { SOL, type SimWorld, createSimWorld } from '@rat/worker';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { StateService } from './state-service';

let w: SimWorld;
afterEach(async () => w?.close());

function appFor(world: SimWorld, cacheSec = 3) {
  const service = new StateService(world.store, world.deps.config, world.clock);
  return createApp({ service, clock: world.clock, cacheSec, corsOrigin: '*' });
}

async function getJson(app: ReturnType<typeof createApp>, path: string, ip = '1.2.3.4') {
  const res = await app.request(path, { headers: { 'x-forwarded-for': ip } });
  return { status: res.status, headers: res.headers, body: (await res.json()) as unknown };
}

function expectValid<T>(schemaObj: { safeParse: (v: unknown) => { success: boolean; error?: { issues: unknown[] } } }, body: T) {
  const r = schemaObj.safeParse(body);
  if (!r.success) console.error(JSON.stringify(r.error?.issues.slice(0, 5), null, 2));
  expect(r.success).toBe(true);
}

describe('state API on a running paper world', () => {
  it('every endpoint matches the contract exactly (strict schemas)', async () => {
    w = await createSimWorld({ dryRun: true, env: { DRY_RUN_FAKE_CLAIM_SOL_PER_HOUR: '5' } });
    w.accrue({ bondingLamports: SOL });
    await w.run(15 * 60, { stepSec: 5 });
    const app = appFor(w);

    const state = await getJson(app, '/api/state');
    expect(state.status).toBe(200);
    expect(state.headers.get('cache-control')).toContain('max-age=3');
    expectValid(StateResponseSchema, state.body);
    const s = StateResponseSchema.parse(state.body);
    expect(s.bot.mode).toBe('dry_run');
    expect(s.portfolio.ratCount).toBeGreaterThan(10);
    expect(s.events.every((e) => e.dryRun)).toBe(true);
    expect(s.stocks.length).toBe(10);
    expect(s.stocks.reduce((a, x) => a + x.hireWeightPct, 0)).toBeCloseTo(100, 0);
    expect(s.treasury.totalClaimedSol).toBeGreaterThan(1);
    // every claimed SOL is either spent on hires or still waiting (claim fees are the only other cost)
    expect(s.treasury.totalHiredSol).toBeGreaterThan(0);
    expect(s.treasury.totalHiredSol + s.treasury.waitingSol).toBeLessThanOrEqual(s.treasury.totalClaimedSol + 1e-9);
    expect(s.treasury.totalHiredSol + s.treasury.waitingSol).toBeGreaterThan(s.treasury.totalClaimedSol - 0.01);
    expect(s.portfolio.positionCount).toBeGreaterThan(1);
    expect(s.coin.mint).toBe(w.coinMint);
    expect(s.coin.priceUsd).toBeGreaterThan(0);

    const rats = await getJson(app, '/api/rats');
    expectValid(RatsResponseSchema, rats.body);
    const r = RatsResponseSchema.parse(rats.body);
    expect(r.total).toBe(s.portfolio.ratCount);
    expect(r.rats.every((x) => x.wallet.length > 30 && x.solscanUrl.endsWith(x.wallet))).toBe(true);
    const after = RatsResponseSchema.parse((await getJson(app, `/api/rats?afterId=${r.rats[4]!.id}`)).body);
    expect(after.total).toBe(r.total);
    expect(after.rats.length).toBe(r.rats.length - 5);

    const events = await getJson(app, '/api/events?afterId=0&limit=5');
    expectValid(EventsResponseSchema, events.body);
    const e = EventsResponseSchema.parse(events.body);
    expect(e.events.length).toBe(5);
    const next = EventsResponseSchema.parse((await getJson(app, `/api/events?afterId=${e.lastId}&limit=500`)).body);
    expect(next.events[0]!.id).toBeGreaterThan(e.lastId);

    const health = await getJson(app, '/health');
    expectValid(HealthResponseSchema, health.body);
    expect(HealthResponseSchema.parse(health.body).ok).toBe(true);
  });
});

describe('state API on a live SimChain world', () => {
  it('live mode, events not flagged dry run, kill switch shows paused', async () => {
    w = await createSimWorld({ dryRun: false });
    w.accrue({ bondingLamports: SOL, ammLamports: SOL / 2n });
    await w.run(11 * 60, { stepSec: 5 });
    const app = appFor(w, 0);
    const s = StateResponseSchema.parse((await getJson(app, '/api/state')).body);
    expect(s.bot.mode).toBe('live');
    expect(s.events.length).toBeGreaterThan(0);
    expect(s.events.every((e) => !e.dryRun)).toBe(true);
    expect(s.treasury.totalClaimedSol).toBe(1.5);
    // each rat costs the real transfer + rent + fees: at most the 0.03 salary, at least the swapped part
    expect(s.treasury.totalHiredSol).toBeLessThanOrEqual(s.portfolio.ratCount * 0.03);
    expect(s.treasury.totalHiredSol).toBeGreaterThan(s.portfolio.ratCount * 0.021);
    expect(s.treasury.totalHiredSol + s.treasury.waitingSol).toBeLessThanOrEqual(1.5);
    expect(s.treasury.totalHiredSol + s.treasury.waitingSol).toBeGreaterThan(1.49);
    await w.store.settings.set(SETTINGS.killSwitch, 'on');
    expect(StateResponseSchema.parse((await getJson(app, '/api/state')).body).bot.mode).toBe('paused');
  });
});

describe('scale, cache and rate limit', () => {
  it('serves 6,000 rats, cached responses are fast', async () => {
    w = await createSimWorld({ dryRun: true });
    await w.worker.tick();
    const stocks = await w.store.stocks.list();
    const now = w.clock.now();
    const rows = Array.from({ length: 6000 }, (_, i) => ({
      mode: 'paper',
      wallet: `W${String(i).padStart(40, 'x')}RAT`,
      stockMint: stocks[i % stocks.length]!.mint,
      status: i % 97 === 0 ? 'frozen' : 'active',
      avatarSeed: 'abcdef12',
      salaryLamports: 30_000_000n,
      tokenAmountRaw: 1_234_567n,
      tokenDecimals: 8,
      costUsd: 4.5,
      hireSig: 'sig',
      createdAt: now,
      hiredAt: now,
    }));
    for (let i = 0; i < rows.length; i += 1000) await w.handle.db.insert(schema.rats).values(rows.slice(i, i + 1000));
    const app = appFor(w, 3);
    let t0 = performance.now();
    const cold = await getJson(app, '/api/rats');
    const coldMs = performance.now() - t0;
    expect(RatsResponseSchema.parse(cold.body).total).toBe(6000);
    t0 = performance.now();
    await getJson(app, '/api/rats');
    const warmMs = performance.now() - t0;
    t0 = performance.now();
    const st = await getJson(app, '/api/state');
    const stateMs = performance.now() - t0;
    expectValid(StateResponseSchema, st.body);
    console.log(`6,000 rats: /api/rats cold ${coldMs.toFixed(0)}ms, warm ${warmMs.toFixed(0)}ms; /api/state cold ${stateMs.toFixed(0)}ms`);
    expect(warmMs).toBeLessThan(300);
    const { gzipSync } = await import('node:zlib');
    const raw = Buffer.from(JSON.stringify(cold.body));
    console.log(`/api/rats payload: ${(raw.length / 1024).toFixed(0)} KB raw, ${(gzipSync(raw).length / 1024).toFixed(0)} KB gzipped`);
    const res = await app.request('/api/rats', { headers: { 'accept-encoding': 'gzip', 'x-forwarded-for': '5.5.5.5' } });
    expect(res.headers.get('content-encoding')).toBe('gzip');
  });

  it('rate limits per IP', async () => {
    w = await createSimWorld({ dryRun: true });
    const service = new StateService(w.store, w.deps.config, w.clock);
    const app = createApp({ service, clock: w.clock, cacheSec: 3, corsOrigin: '*', rateLimitPerMinute: 5 });
    for (let i = 0; i < 5; i++) expect((await getJson(app, '/api/events', '9.9.9.9')).status).toBe(200);
    expect((await getJson(app, '/api/events', '9.9.9.9')).status).toBe(429);
    expect((await getJson(app, '/api/events', '8.8.8.8')).status).toBe(200);
    w.clock.advanceSeconds(61);
    expect((await getJson(app, '/api/events', '9.9.9.9')).status).toBe(200);
  });
});

describe('the coin right after the launch (rat announce-ca)', () => {
  it('before the bot runs a coin, the API shows the announced CA, without a price', async () => {
    w = await createSimWorld({ dryRun: true });
    const cfg = { ...w.deps.config, coinMint: undefined };
    const app = createApp({ service: new StateService(w.store, cfg, w.clock), clock: w.clock, cacheSec: 0, corsOrigin: '*' });
    let s = StateResponseSchema.parse((await getJson(app, '/api/state')).body);
    expect(s.coin.mint).toBeNull();
    await w.store.settings.set(SETTINGS.announcedCoinMint, 'CoinAnnounced1111111111111111111111111pump');
    s = StateResponseSchema.parse((await getJson(app, '/api/state', '5.6.7.8')).body);
    expect(s.coin.mint).toBe('CoinAnnounced1111111111111111111111111pump');
    expect(s.coin.priceUsd).toBeNull();
    expect(s.coin.marketCapUsd).toBeNull();
  });

  it('once the bot runs its coin (COIN_MINT), that coin wins', async () => {
    w = await createSimWorld({ dryRun: true });
    await w.store.settings.set(SETTINGS.announcedCoinMint, 'CoinAnnounced1111111111111111111111111pump');
    const s = StateResponseSchema.parse((await getJson(appFor(w, 0), '/api/state')).body);
    expect(s.coin.mint).toBe(w.deps.config.coinMint);
  });
});
