// Public read-only state API (CONTRACT.md). Use a read-only database user (DATABASE_URL_READONLY).
import { serve } from '@hono/node-server';
import { createLogger, loadConfig, systemClock } from '@rat/core';
import { Store, openDatabase } from '@rat/db';
import { createApp } from './app';
import { StateService } from './state-service';

const cfg = loadConfig();
const log = createLogger({ level: cfg.logLevel, name: 'rat-api' });
const url = cfg.databaseUrlReadonly ?? cfg.databaseUrl;
if (!url) throw new Error('DATABASE_URL_READONLY (or DATABASE_URL) is required');
const handle = await openDatabase(url, { maxConnections: 10 });
const store = new Store(handle.db, cfg.dryRun ? 'paper' : 'live', systemClock);
const app = createApp({ service: new StateService(store, cfg, systemClock), clock: systemClock, cacheSec: cfg.api.cacheSec, corsOrigin: cfg.api.corsOrigin });
serve({ fetch: app.fetch, port: cfg.api.port }, (info) => log.info({ port: info.port, mode: store.mode }, 'rat api listening'));
