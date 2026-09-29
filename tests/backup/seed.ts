// Fills a real, empty Postgres database with a short simulated launch (SimChain, nothing real is sent), for the
// backup self-test (infra/backup/selftest.sh): it gets dumped, encrypted, uploaded, restored elsewhere and compared
// table by table.
//   pnpm --filter @rat/tests exec tsx backup/seed.ts postgres://.../rat_src
import { openDatabase, schema } from '@rat/db';
import { SOL, createSimWorld } from '@rat/worker';
import { runLaunch } from '../e2e/helpers';

const url = process.argv[2];
if (!url?.startsWith('postgres')) throw new Error('usage: tsx backup/seed.ts postgres://...');

// a 20 minute launch in memory (PGlite), then every row copied into the real database
const w = await createSimWorld({ dryRun: false });
await runLaunch(w, { seconds: 20 * 60, totalFees: 3n * SOL });

const dst = await openDatabase(url, { maxConnections: 1 });
await dst.migrate();
type Table = Parameters<typeof dst.db.insert>[0];
/** drizzle's table name symbol (the same one getTableName reads) */
const NAME = Symbol.for('drizzle:Name');
const counts: Record<string, number> = {};
for (const table of Object.values(schema) as unknown as Table[]) {
  const name = (table as unknown as Record<symbol, string | undefined>)[NAME];
  if (!name) continue;
  const rows = await w.handle.db.select().from(table);
  for (let k = 0; k < rows.length; k += 500) await dst.db.insert(table).values(rows.slice(k, k + 500));
  counts[name] = rows.length;
}
await dst.close();
await w.close();
console.log(JSON.stringify(counts));
