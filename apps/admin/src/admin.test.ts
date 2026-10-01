import { SETTINGS } from '@rat/core';
import { SOL, type SimWorld, createSimWorld, runClaimStep, runHireStep, runMintStep, runPriceStep } from '@rat/worker';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdminApp } from './app';
import { Watchdog } from './watchdog';

const PASSWORD = 'correct horse battery staple';
let w: SimWorld;
afterEach(async () => w?.close());

const auth = (password = PASSWORD) => ({ authorization: `Basic ${Buffer.from(`miguel:${password}`).toString('base64')}` });

async function world(env: Record<string, string> = {}) {
  w = await createSimWorld({ dryRun: true, env });
  return createAdminApp({ store: w.store, config: w.deps.config, clock: w.clock, password: PASSWORD });
}

async function page(app: ReturnType<typeof createAdminApp>) {
  const res = await app.request('/', { headers: auth() });
  return { res, html: await res.text() };
}

const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;

function post(app: ReturnType<typeof createAdminApp>, path: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  return app.request(path, { method: 'POST', headers: { ...auth(), 'content-type': 'application/x-www-form-urlencoded', host: 'admin.local', ...headers }, body: new URLSearchParams(form).toString() });
}

describe('admin page', () => {
  it('refuses a short password at startup', async () => {
    w = await createSimWorld({ dryRun: true });
    expect(() => createAdminApp({ store: w.store, config: w.deps.config, clock: w.clock, password: 'short' })).toThrow(/at least 16/);
  });

  it('needs the password; health does not; hardened headers on every answer', async () => {
    const app = await world();
    expect((await app.request('/health')).status).toBe(200);
    const none = await app.request('/');
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/Basic/);
    expect((await app.request('/', { headers: auth('wrong password, long enough') })).status).toBe(401);
    const { res } = await page(app);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
  });

  it('locks an IP out after 10 wrong passwords (even the right one is refused for 15 minutes)', async () => {
    const app = await world();
    const ip = { 'x-forwarded-for': '6.6.6.6' };
    for (let i = 0; i < 10; i++) expect((await app.request('/', { headers: { ...auth(`guess number ${i} is wrong`), ...ip } })).status).toBe(401);
    expect((await app.request('/', { headers: { ...auth(), ...ip } })).status).toBe(429);
    expect((await app.request('/', { headers: { ...auth(), 'x-forwarded-for': '7.7.7.7' } })).status).toBe(200);
    w.clock.advanceSeconds(16 * 60);
    expect((await app.request('/', { headers: { ...auth(), ...ip } })).status).toBe(200);
  });

  it('shows mode, buckets, caps used, rats and the last transactions', async () => {
    const app = await world({ DRY_RUN_FAKE_CLAIM_SOL_PER_HOUR: '0' });
    await runPriceStep(w.deps, w.worker.state);
    await runMintStep(w.deps);
    w.accrue({ bondingLamports: SOL });
    await runClaimStep(w.deps, w.worker.state);
    await runHireStep(w.deps, w.worker.state);
    const { html } = await page(app);
    expect(html).toContain('DRY RUN');
    expect(html).toContain('Kill switch off');
    expect(html).toMatch(/Claimed<b>1 SOL<\/b>/);
    expect(html).toMatch(/<td>hire<\/td><td>0\.\d+ SOL<\/td>/);
    expect(html).toMatch(/Cap used/);
    expect(html).toMatch(/solscan\.io\/tx\//);
    expect(html).toMatch(/Inus<b>\d+<\/b>/);
  });

  it('KILL runs the CLI kill logic; RESUME needs the typed confirmation', async () => {
    const app = await world();
    const csrf = csrfOf((await page(app)).html);
    const killed = await post(app, '/kill', { csrf, reason: 'price looks wrong' });
    expect(killed.status).toBe(303);
    expect(await w.store.settings.get(SETTINGS.killSwitch)).toBe('on');
    expect(await w.store.settings.get(SETTINGS.killReason)).toBe('admin page: price looks wrong');
    expect((await page(app)).html).toContain('KILL SWITCH ON');
    expect((await post(app, '/resume', { csrf, confirm: 'yes' })).headers.get('location')).toMatch(/type%20RESUME/);
    expect(await w.store.settings.get(SETTINGS.killSwitch)).toBe('on');
    await post(app, '/resume', { csrf, confirm: 'RESUME' });
    expect(await w.store.settings.get(SETTINGS.killSwitch)).toBe('off');
  });

  it('the env kill switch cannot be resumed from the page', async () => {
    const app = await world({ KILL_SWITCH: 'true' });
    const csrf = csrfOf((await page(app)).html);
    const res = await post(app, '/resume', { csrf, confirm: 'RESUME' });
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toMatch(/KILL_SWITCH env var is true/);
  });

  it('refuses a POST without a valid CSRF token or from another site', async () => {
    const app = await world();
    const csrf = csrfOf((await page(app)).html);
    expect((await post(app, '/kill', { reason: 'x' })).status).toBe(403);
    expect((await post(app, '/kill', { csrf: 'f'.repeat(64) })).status).toBe(403);
    expect((await post(app, '/kill', { csrf }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(await w.store.settings.get(SETTINGS.killSwitch)).not.toBe('on');
    // the token expires after two hours
    w.clock.advanceSeconds(2 * 3600 + 1);
    expect((await post(app, '/kill', { csrf })).status).toBe(403);
  });

  it('escapes everything it shows (an error message cannot inject HTML)', async () => {
    const app = await world();
    const id = await w.store.attempts.create({ kind: 'hire', refType: 'rat', refId: '1', signature: '5'.repeat(88), lastValidBlockHeight: 1 });
    await w.store.attempts.finish(id, { status: 'failed', error: '<script>alert(1)</script>' });
    const csrf = csrfOf((await page(app)).html);
    const { html } = await page(app);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    const notice = await app.request(`/?notice=${encodeURIComponent('<img src=x onerror=alert(1)>')}`, { headers: auth() });
    expect(await notice.text()).not.toContain('<img');
    expect(csrf).toHaveLength(64);
  });
});

describe('worker-down watchdog', () => {
  it('alerts once when the loops stop, repeats every 30 minutes, says when the worker is back; the page shows it', async () => {
    const app = await world();
    const sent: string[] = [];
    const dog = new Watchdog({ store: w.store, clock: w.clock, alert: async (t) => void sent.push(t) });
    expect(await dog.check()).toBe('never_ran');
    await w.worker.tick();
    expect(await dog.check()).toBe('ok');
    expect(sent).toEqual([]);
    w.clock.advanceSeconds(4 * 60); // the worker died
    expect(await dog.check()).toBe('down');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/WORKER DOWN: no loop has run for 4 min/);
    expect((await page(app)).html).toContain('WORKER DOWN');
    w.clock.advanceSeconds(60);
    await dog.check();
    expect(sent).toHaveLength(1); // not every minute
    w.clock.advanceSeconds(30 * 60);
    await dog.check();
    expect(sent).toHaveLength(2); // but again while it stays down
    await w.worker.tick(); // restarted
    expect(await dog.check()).toBe('ok');
    expect(sent[2]).toMatch(/Worker is back/);
    expect((await page(app)).html).not.toContain('WORKER DOWN');
  });
});
