// Smoke test preflight: every condition must hold or the smoke script refuses to start.
import { type AppConfig, solToLamports } from '@rat/core';
import type { Store } from '@rat/db';

const SMOKE_MAX_CAP = solToLamports('0.1');

export async function smokePreflight(cfg: AppConfig, store: Store | null): Promise<string[]> {
  const problems: string[] = [];
  if (!cfg.smokeMode) problems.push('SMOKE_MODE must be true');
  if (cfg.smokeCapLamports > SMOKE_MAX_CAP) problems.push('SMOKE_CAP_SOL must be 0.1 or less');
  if (cfg.dryRun || !cfg.liveConfirmed) problems.push('the smoke test sends real transactions: set DRY_RUN=false and LIVE_CONFIRM');
  if (!cfg.coinMint) problems.push('COIN_MINT must be your THROWAWAY test coin');
  if (!cfg.creatorPubkey || !cfg.fundPubkey) problems.push('CREATOR_PUBKEY and FUND_PUBKEY must be the throwaway test wallets');
  if (cfg.maxHiresPerLoop > 2) problems.push('MAX_HIRES_PER_LOOP must be 2 or less');
  if (store) {
    const rats = await store.forMode('live').rats.countByStatus();
    const any = Object.values(rats).reduce((a, b) => a + b, 0);
    if (any > 0) problems.push(`the database already has ${any} live rats: use a fresh smoke-test database`);
  }
  return problems;
}
