// Private admin page: one password (ADMIN_PASSWORD, at least 16 characters), HTTP Basic auth over HTTPS.
//   GET  /        dashboard (ledger buckets, caps used, rats, last transactions, errors, worker loops)
//   POST /kill    the same logic as `rat kill` (always allowed)
//   POST /resume  the same logic as `rat resume` (type RESUME to confirm)
//   GET  /health  unauthenticated liveness for the host
// Hardening: constant-time password check, lockout after repeated failures per IP, CSRF token + same-origin check on
// every POST, no caching, no framing, a strict content security policy. The page never sends a transaction.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { type CliContext, killCommand, resumeCommand } from '@rat/cli';
import type { AppConfig, Clock } from '@rat/core';
import type { Store } from '@rat/db';
import { type Context, Hono } from 'hono';
import { loadDashboard, renderDashboard } from './dashboard';

const MIN_PASSWORD_LENGTH = 16;
const LOCKOUT_FAILURES = 10;
const LOCKOUT_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;

export interface AdminOptions {
  store: Store;
  config: AppConfig;
  clock: Clock;
  password: string;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

class Lockout {
  private readonly failures = new Map<string, { count: number; since: number }>();
  constructor(private readonly clock: Clock) {}
  blocked(ip: string): boolean {
    const f = this.failures.get(ip);
    if (!f) return false;
    if (this.clock.now().getTime() - f.since > LOCKOUT_MS) {
      this.failures.delete(ip);
      return false;
    }
    return f.count >= LOCKOUT_FAILURES;
  }
  fail(ip: string): void {
    const now = this.clock.now().getTime();
    const f = this.failures.get(ip);
    if (!f || now - f.since > LOCKOUT_MS) this.failures.set(ip, { count: 1, since: now });
    else f.count++;
    if (this.failures.size > 10_000) this.failures.clear();
  }
  reset(ip: string): void {
    this.failures.delete(ip);
  }
}

type Env = { Variables: { form: Record<string, unknown> } };

export function createAdminApp(opts: AdminOptions): Hono<Env> {
  if (opts.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const app = new Hono<Env>();
  const expected = sha256(opts.password);
  const csrfKey = sha256(`rat-admin-csrf:${opts.password}`);
  const lockout = new Lockout(opts.clock);
  const csrfFor = (hour: number) => createHmac('sha256', csrfKey).update(String(hour)).digest('hex');
  const hourNow = () => Math.floor(opts.clock.now().getTime() / HOUR_MS);
  const csrfOk = (token: unknown) => typeof token === 'string' && [hourNow(), hourNow() - 1].some((h) => token === csrfFor(h));
  const ipOf = (c: Context<Env>) => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';

  app.use('*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
    c.header('x-frame-options', 'DENY');
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  });

  app.get('/health', (c) => c.text('ok'));

  app.use('*', async (c, next) => {
    const ip = ipOf(c);
    if (lockout.blocked(ip)) return c.text('Too many failed logins. Try again in 15 minutes.', 429);
    const header = c.req.header('authorization') ?? '';
    const [scheme, encoded] = header.split(' ');
    let password = '';
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      password = decoded.slice(decoded.indexOf(':') + 1);
    }
    if (!password || !timingSafeEqual(sha256(password), expected)) {
      if (password) lockout.fail(ip);
      c.header('www-authenticate', 'Basic realm="RAT RACE admin", charset="UTF-8"');
      return c.text('Password required.', 401);
    }
    lockout.reset(ip);
    await next();
  });

  // Every POST: same origin (when the browser says where it comes from) and a valid CSRF token.
  app.use('*', async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const origin = c.req.header('origin');
    const host = c.req.header('host');
    if (origin && host && new URL(origin).host !== host) return c.text('Cross-site request refused.', 403);
    const body = await c.req.parseBody();
    if (!csrfOk(body.csrf)) return c.text('Form expired. Reload the page and try again.', 403);
    c.set('form', body);
    await next();
  });

  const run = async (fn: (ctx: CliContext) => Promise<void>): Promise<string> => {
    const lines: string[] = [];
    await fn({ config: opts.config, store: opts.store, clock: opts.clock, out: (l) => lines.push(l) });
    return lines.join(' ');
  };
  const back = (c: Context<Env>, notice: string) => c.redirect(`/?notice=${encodeURIComponent(notice)}`, 303);

  app.get('/', async (c) => {
    const d = await loadDashboard(opts.store, opts.config, opts.clock);
    const notice = c.req.query('notice')?.slice(0, 300) ?? null;
    return c.html(renderDashboard(d, csrfFor(hourNow()), notice));
  });

  app.post('/kill', async (c) => {
    const form = c.get('form');
    const reason = typeof form.reason === 'string' && form.reason.trim() ? form.reason.trim().slice(0, 200) : 'manual kill from the admin page';
    return back(c, await run((ctx) => killCommand(ctx, `admin page: ${reason}`)));
  });

  app.post('/resume', async (c) => {
    const form = c.get('form');
    if (form.confirm !== 'RESUME') return back(c, 'Not resumed: type RESUME in the box to confirm.');
    return back(c, await run((ctx) => resumeCommand(ctx)));
  });

  app.notFound((c) => c.text('not found', 404));
  app.onError((err, c) => {
    console.error(err);
    return c.text('internal error', 500);
  });
  return app;
}
