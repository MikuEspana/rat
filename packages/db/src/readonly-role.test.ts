// infra/readonly-role.sql (and the same SQL in scripts/setup-mac.sh): the public API's database user reads what the
// site shows, never the encrypted keys.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DbHandle, openMemoryDatabase } from './index';

const file = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
let handle: DbHandle;
beforeEach(async () => {
  handle = await openMemoryDatabase();
});
afterEach(async () => handle.close());

/** the SQL of a psql script without its meta-commands and comments */
function plainSql(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => !l.trim().startsWith('\\') && !l.trim().startsWith('--'))
    .map((l) => l.replace(/\s*\\gset\s*$/, ';')) // \gset ends a statement in psql
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('read-only API database user', () => {
  for (const [name, text] of [
    ['infra/readonly-role.sql', () => file('../../../infra/readonly-role.sql')],
    ['scripts/setup-mac.sh', () => /<<'SQL' \|\|\n([\s\S]*?)\nSQL\n/.exec(file('../../../scripts/setup-mac.sh').slice(file('../../../scripts/setup-mac.sh').indexOf('read-only user, api, admin')))![1]!],
  ] as const) {
    it(`${name}: rat_api reads the rats, never key_pool`, async () => {
      for (const stmt of plainSql(text())) {
        if (/PASSWORD :'rat_pw'/.test(stmt)) continue; // psql variable, not SQL
        await handle.db.execute(sql.raw(stmt));
      }
      await handle.db.execute(sql.raw('SET ROLE rat_api'));
      await expect(handle.db.execute(sql.raw('SELECT count(*) FROM rats'))).resolves.toBeDefined();
      const denied = await handle.db.execute(sql.raw('SELECT secret_enc FROM key_pool')).then(
        () => 'allowed',
        (err: Error & { cause?: Error }) => err.cause?.message ?? err.message,
      );
      expect(denied).toMatch(/permission denied/);
      await handle.db.execute(sql.raw('RESET ROLE'));
    });
  }
});
