// Private admin page service. Needs ADMIN_PASSWORD (at least 16 characters) and the same DATABASE_URL as the worker
// (the kill switch is a database setting). Serve it over HTTPS only (Railway does by default).
import { serve } from '@hono/node-server';
import { createLogger, loadConfig, requireConfig, systemClock } from '@rat/core';
import { Store, openDatabase } from '@rat/db';
import { createAdminApp } from './app';

const cfg = loadConfig();
const log = createLogger({ level: cfg.logLevel, name: 'rat-admin' });
requireConfig(cfg, ['databaseUrl']);
const password = process.env.ADMIN_PASSWORD ?? '';
const handle = await openDatabase(cfg.databaseUrl!, { maxConnections: 3 });
const store = new Store(handle.db, cfg.dryRun ? 'paper' : 'live', systemClock);
const app = createAdminApp({ store, config: cfg, clock: systemClock, password });
const port = Number(process.env.PORT) || Number(process.env.ADMIN_PORT) || 8790;
serve({ fetch: app.fetch, port }, (info) => log.info({ port: info.port, mode: store.mode }, 'rat admin listening'));
