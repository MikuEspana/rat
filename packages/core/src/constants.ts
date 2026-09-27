// Well-known Solana addresses (base58). Program ids are public constants.
export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const WSOL_MINT = NATIVE_SOL_MINT;
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** Exact phrase that must be in LIVE_CONFIRM (together with DRY_RUN=false) before anything is sent. */
export const LIVE_CONFIRM_PHRASE = 'I_UNDERSTAND_THIS_SENDS_MAINNET_TRANSACTIONS';

/** Settings keys stored in the database. */
export const SETTINGS = {
  killSwitch: 'kill_switch',
  killReason: 'kill_reason',
  paperClaimWatermark: 'paper_claim_watermark',
  creatorWatchCursor: 'creator_watch_cursor',
  fundWatchCursor: 'fund_watch_cursor',
  lastBurnAt: 'last_burn_at',
  lastClaimAt: 'last_claim_at',
  lastBurnRunAt: 'last_burn_run_at',
  /** earliest time the next burn round can start (the exact time is random and never published) */
  burnWindowOpensAt: 'burn_window_opens_at',
  /** JSON { usd, change24hPct, at } */
  priceSol: 'price_sol',
  priceCoin: 'price_coin',
  /** JSON { mint, decimals, supplyRaw, tokenProgram } */
  coinInfo: 'coin_info',
  expectedMintAuthority: 'expected_mint_authority',
} as const;

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function isBase58Pubkey(value: string): boolean {
  return BASE58_RE.test(value);
}
