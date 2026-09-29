// Rehearsal (STAGING) database rules. `rat staging-init` marks a staging database once, naming its test creator.
// Every test-only feature needs that marker, a staging setup refuses a database that holds the production creator
// key, and a production setup refuses a marked database. Together with the config rule (STAGING=true is refused with
// the production creator wallet) no test-only feature can run on production.
import { type AppConfig, PRODUCTION_CREATOR_PUBKEY, SETTINGS } from '@rat/core';
import type { Store } from './store';

type StagingConfig = Pick<AppConfig, 'staging' | 'creatorPubkey'>;

export function stagingMarkerFor(creator: string): string {
  return `staging:${creator}`;
}

/**
 * Why this database and this config must not run together ([] = fine). The worker, the API and every CLI command
 * check it before doing anything.
 */
export async function stagingProblems(store: Store, cfg: StagingConfig): Promise<string[]> {
  const marker = await store.settings.get(SETTINGS.stagingMarker);
  if (!cfg.staging) {
    return marker
      ? [`this is a STAGING database (${marker}). A production setup never runs on it: check DATABASE_URL, or set STAGING=true in the staging project.`]
      : [];
  }
  const problems: string[] = [];
  const creatorKey = await store.keys.getRole('creator');
  if (creatorKey?.pubkey === PRODUCTION_CREATOR_PUBKEY) {
    problems.push('STAGING refused: this database holds the production creator key. Staging runs on its own database only.');
  }
  if (marker && marker !== stagingMarkerFor(cfg.creatorPubkey ?? '')) {
    problems.push(`STAGING refused: this database is marked for another test creator (${marker}).`);
  }
  return problems;
}

/** Test-only features (seed, crash test, the staging stage source) run only on a database marked for this creator. */
export async function isStagingDatabase(store: Store, cfg: StagingConfig): Promise<boolean> {
  if (!cfg.staging || !cfg.creatorPubkey) return false;
  if ((await stagingProblems(store, cfg)).length > 0) return false;
  return (await store.settings.get(SETTINGS.stagingMarker)) === stagingMarkerFor(cfg.creatorPubkey);
}

export async function requireStagingDatabase(store: Store, cfg: StagingConfig): Promise<void> {
  if (!cfg.staging) throw new Error('refused: STAGING is off. Test-only commands run in the staging project only.');
  const problems = await stagingProblems(store, cfg);
  if (problems.length > 0) throw new Error(problems.join(' '));
  if (!(await isStagingDatabase(store, cfg))) throw new Error('refused: this database is not marked as staging. Run: rat staging-init');
}

/**
 * Marks the database as this test creator's staging database. Only with STAGING on, only on a database with no
 * rats, claims or ledger entries yet, never next to the production creator key. Safe to run again.
 */
export async function markStagingDatabase(store: Store, cfg: StagingConfig): Promise<'marked' | 'already'> {
  if (!cfg.staging || !cfg.creatorPubkey) throw new Error('refused: staging-init needs STAGING=true and the test CREATOR_PUBKEY.');
  const problems = await stagingProblems(store, cfg);
  if (problems.length > 0) throw new Error(problems.join(' '));
  const want = stagingMarkerFor(cfg.creatorPubkey);
  if ((await store.settings.get(SETTINGS.stagingMarker)) === want) return 'already';
  const rats = Object.values(await store.rats.countByStatus()).reduce((a, n) => a + n, 0);
  const claims = (await store.claims.totals()).count;
  const ledger = (await store.ledger.list(1)).length;
  if (rats + claims + ledger > 0) {
    throw new Error(`refused: this database already has data (${rats} rats, ${claims} claims, ${ledger > 0 ? 'ledger entries' : 'no ledger'}). A staging database starts empty.`);
  }
  await store.settings.set(SETTINGS.stagingMarker, want);
  return 'marked';
}
