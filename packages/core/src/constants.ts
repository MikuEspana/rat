// Well-known Solana addresses (base58). Program ids are public constants.
export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** Exact phrase that must be in LIVE_CONFIRM (together with DRY_RUN=false) before anything is sent. */
export const LIVE_CONFIRM_PHRASE = 'I_UNDERSTAND_THIS_SENDS_MAINNET_TRANSACTIONS';

/**
 * The real launch's creator wallet. STAGING mode refuses it everywhere (config, database, seed), so no test-only
 * feature can ever run next to it. If the production creator ever changes, change it here too.
 */
export const PRODUCTION_CREATOR_PUBKEY = '4VYWcTTDYyMVic58AcUC7Nodt6vNQwjKhA9UphaAKiot';
/** `rat staging-seed` limits, hard-coded so no setting can raise them: per call, and in total per database. */
export const STAGING_SEED_MAX_LAMPORTS = 500_000_000n;
export const STAGING_SEED_TOTAL_MAX_LAMPORTS = 1_000_000_000n;

/** Settings keys stored in the database. */
export const SETTINGS = {
  killSwitch: 'kill_switch',
  killReason: 'kill_reason',
  paperClaimWatermark: 'paper_claim_watermark',
  creatorWatchCursor: 'creator_watch_cursor',
  /** slot of the first live wallet watch run: nothing older is ever looked at */
  watchFromSlot: 'watch_from_slot',
  lastClaimAt: 'last_claim_at',
  /** since when hires are skipped while the hire budget is above HIRE_IDLE_ALERT_SOL ('' = not idle) */
  hireIdleSince: 'hire_idle_since',
  /** JSON { usd, change24hPct, at } */
  priceSol: 'price_sol',
  priceCoin: 'price_coin',
  /** JSON { mint, decimals, supplyRaw, tokenProgram } */
  coinInfo: 'coin_info',
  /** the coin mint the public site shows before the bot runs it (rat announce-ca, right after the launch) */
  announcedCoinMint: 'announced_coin_mint',
  expectedMintAuthority: 'expected_mint_authority',
  /** STAGING only: "staging:<test creator pubkey>", written once by `rat staging-init` on an empty database */
  stagingMarker: 'staging_marker',
  /** STAGING only: set right before the one-shot crash test kills the worker, so it never fires twice */
  stagingCrashDone: 'staging_crash_done',
} as const;

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function isBase58Pubkey(value: string): boolean {
  return BASE58_RE.test(value);
}
