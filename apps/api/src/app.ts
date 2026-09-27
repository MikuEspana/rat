// Hono app: read-only, cached (API_CACHE_SEC), gzip, CORS, per-IP rate limit.
import type { Clock } from '@rat/core';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import type { StateService } from './state-service';

class TtlCache {
  private readonly entries = new Map<string, { expires: number; body: string }>();
  constructor(
    private readonly ttlMs: number,
    private readonly clock: Clock,
  ) {}
  async get(key: string, build: () => Promise<unknown>): Promise<string> {
    const now = this.clock.now().getTime();
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) return hit.body;
    const body = JSON.stringify(await build());
    this.entries.set(key, { expires: now + this.ttlMs, body });
    if (this.entries.size > 500) this.entries.clear();
    return body;
  }
}

class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  constructor(
    private readonly perMinute: number,
    private readonly clock: Clock,
  ) {}
  allow(ip: string): boolean {
    const now = this.clock.now().getTime();
    const h = this.hits.get(ip);
    if (!h || now - h.windowStart >= 60_000) {
      this.hits.set(ip, { windowStart: now, count: 1 });
      if (this.hits.size > 50_000) this.hits.clear();
      return true;
    }
    h.count++;
    return h.count <= this.perMinute;
  }
}

export interface AppOptions {
  service: StateService;
  clock: Clock;
  cacheSec: number;
  corsOrigin: string;
  rateLimitPerMinute?: number;
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();
  const cache = new TtlCache(opts.cacheSec * 1000, opts.clock);
  const limiter = new RateLimiter(opts.rateLimitPerMinute ?? 240, opts.clock);
  const cacheHeader = `public, max-age=${opts.cacheSec}, s-maxage=${opts.cacheSec}`;

  app.use('*', cors({ origin: opts.corsOrigin === '*' ? '*' : opts.corsOrigin.split(',').map((s) => s.trim()), allowMethods: ['GET'] }));
  app.use('*', compress());
  app.use('/api/*', async (c, next) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';
    if (!limiter.allow(ip)) return c.json({ error: 'rate limited' }, 429);
    await next();
  });

  const json = (body: string) =>
    new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cacheHeader } });

  app.get('/api/state', async () => json(await cache.get('state', () => opts.service.stateResponse())));

  app.get('/api/rats', async (c) => {
    const afterId = Math.max(0, Number(c.req.query('afterId') ?? 0) || 0);
    return json(await cache.get(`rats:${afterId}`, () => opts.service.ratsResponse(afterId)));
  });

  app.get('/api/events', async (c) => {
    const afterId = Math.max(0, Number(c.req.query('afterId') ?? 0) || 0);
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 100) || 100));
    return json(await cache.get(`events:${afterId}:${limit}`, () => opts.service.eventsResponse(afterId, limit)));
  });

  // Always 200 so the platform health check does not depend on the worker; `ok` says whether the bot loop is fresh.
  app.get('/health', async (c) => c.json(await opts.service.health()));

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });
  return app;
}
