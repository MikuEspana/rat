// Opens Postgres (production, via node-postgres) or PGlite (tests / local dev, in-process).
//   memory://            in-memory PGlite
//   pglite://./data/dir  PGlite persisted to a folder
//   postgres://...       real Postgres (Supabase). Use a DIRECT connection for the worker.
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
export type Database = PgDatabase<PgQueryResultHKT, Schema>;

export interface DbHandle {
  db: Database;
  kind: 'pglite' | 'postgres';
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

export async function openDatabase(url: string, opts: { maxConnections?: number } = {}): Promise<DbHandle> {
  if (url === 'memory://' || url.startsWith('pglite://')) {
    const path = url === 'memory://' ? undefined : url.slice('pglite://'.length);
    const client = path ? new PGlite(path) : new PGlite();
    await client.waitReady;
    const db = drizzlePglite(client, { schema });
    return {
      db: db as unknown as Database,
      kind: 'pglite',
      migrate: () => migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER }),
      close: () => client.close(),
    };
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error('DATABASE_URL must start with postgres://, postgresql://, pglite:// or be memory://');
  }
  const pool = new pg.Pool({ connectionString: url, max: opts.maxConnections ?? 5 });
  const db = drizzlePg(pool, { schema });
  return {
    db: db as unknown as Database,
    kind: 'postgres',
    migrate: () => migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: () => pool.end(),
  };
}

/** In-memory database with migrations applied. For tests and simulations. */
export async function openMemoryDatabase(): Promise<DbHandle> {
  const handle = await openDatabase('memory://');
  await handle.migrate();
  return handle;
}
