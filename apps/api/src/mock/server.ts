// pnpm mock:api : the public API with live-changing mock data, for building and animating the site.
// Same endpoints and JSON as the real API (CONTRACT.md, schemaVersion 2). No database, no chain, no keys.
//   MOCK_API_PORT (default 8787), MOCK_SPEED (2 = twice as busy), MOCK_SEED (repeatable run)
import { serve } from '@hono/node-server';
import { SeededRng, systemClock, systemRng } from '@rat/core';
import { createApp } from '../app';
import { LiveMock } from './live-mock';

const port = Number(process.env.MOCK_API_PORT) || 8787;
const speed = Number(process.env.MOCK_SPEED) || 1;
const seed = process.env.MOCK_SEED ? Number(process.env.MOCK_SEED) : null;

const mock = new LiveMock({ clock: systemClock, rng: seed === null ? systemRng : new SeededRng(seed), speed });
const app = createApp({ service: mock, clock: systemClock, cacheSec: 1, corsOrigin: '*', rateLimitPerMinute: 100_000 });

serve({ fetch: app.fetch, port }, (info) => {
  const base = `http://localhost:${info.port}`;
  console.log(`THE INUVESTORS mock API (live-changing mock data, nothing real) on ${base}`);
  console.log(`  ${base}/api/state   ${base}/api/rats   ${base}/api/events?afterId=0   ${base}/health`);
  console.log(`  new rat every 2-6s, prices drift every 1s, claim every 35s, COINx pauses/resumes; speed x${speed}`);
});
