// Domain types shared by every package.

/** base58 public key */
export type Pubkey = string;

/** Ledger bucket. Every claimed lamport is credited to `hire` and may only be spent on rats. */
export type Bucket = 'hire';
export const BUCKETS: readonly Bucket[] = ['hire'];

/** `paper` rows come from DRY RUN, `live` rows from real transactions. They never mix. */
export type Mode = 'live' | 'paper';

export type RatStatus = 'hiring' | 'active' | 'frozen';
export type FreezeReason = 'stock_paused' | 'account_frozen' | 'balance_mismatch';
export type UnfreezeReason = 'stock_resumed' | 'account_thawed' | 'balance_restored';
export type StockStatus = 'active' | 'paused';

export type TxKind = 'claim' | 'hire' | 'sweep';
/** Kinds that spend a ledger bucket and therefore need a spend reservation. */
export const SPENDING_TX_KINDS: readonly TxKind[] = ['hire'];

export type TxStatus = 'pending' | 'confirmed' | 'failed' | 'expired' | 'unknown' | 'simulated' | 'blocked';

export type EventType = 'claim' | 'hire' | 'freeze' | 'unfreeze';

export type LedgerReason =
  | 'claim_credit' // our claim or an external pump.fun claim of our vault
  | 'hire_reserve' // reserved before a hire tx (negative)
  | 'hire_settle' // actual cost minus reservation (signed)
  | 'hire_release' // reservation returned because the hire definitely did not land (positive)
  | 'claim_fee' // claim tx fee, paid from the hire bucket (negative)
  | 'seed_credit'; // the owner's own SOL booked as hire budget, never a creator fee: `rat staging-seed` (rehearsal) or `rat founders-seed` (founding rats at launch)

export type KeyRole = 'rat' | 'creator';

export type StockGroup = 'volatile' | 'steady' | 'reserve';

/** One entry of config/stocks.json */
export interface StockConfigEntry {
  symbol: string;
  name: string;
  mint: Pubkey;
  group: StockGroup;
  enabled: boolean;
  approved: boolean;
}

export type HireMode = 'single' | 'two_step';
