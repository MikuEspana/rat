// Domain types shared by every package.

/** base58 public key */
export type Pubkey = string;

/** Ledger buckets. Hires may only spend `hire`, burns may only spend `burn`. */
export type Bucket = 'hire' | 'burn';
export const BUCKETS: readonly Bucket[] = ['hire', 'burn'];

/** `paper` rows come from DRY RUN, `live` rows from real transactions. They never mix. */
export type Mode = 'live' | 'paper';

export type RatStatus = 'hiring' | 'active' | 'frozen';
export type FreezeReason = 'stock_paused' | 'account_frozen' | 'balance_mismatch';
export type UnfreezeReason = 'stock_resumed' | 'account_thawed' | 'balance_restored';
export type StockStatus = 'active' | 'paused';

export type TxKind = 'claim' | 'hire' | 'burn' | 'sweep';
/** Kinds that spend a ledger bucket and therefore need a spend reservation. */
export const SPENDING_TX_KINDS: readonly TxKind[] = ['hire', 'burn'];

export type TxStatus = 'pending' | 'confirmed' | 'failed' | 'expired' | 'unknown' | 'simulated' | 'blocked';

export type EventType = 'claim' | 'hire' | 'burn' | 'freeze' | 'unfreeze';

export type LedgerReason =
  | 'claim_credit' // our claim or an external pump.fun claim of our vault
  | 'hire_reserve' // reserved before a hire tx (negative)
  | 'hire_settle' // actual cost minus reservation (signed)
  | 'hire_release' // reservation returned because the hire definitely did not land (positive)
  | 'burn_reserve'
  | 'burn_settle'
  | 'burn_release'
  | 'claim_fee'; // claim tx fee, paid from the hire bucket (negative)

export type KeyRole = 'rat' | 'creator' | 'fund';

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
