// Database schema. The database is the source of truth. Every money column is a bigint of lamports
// (or raw token units). `mode` separates DRY RUN paper rows from live rows: they never mix.
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const lamports = (name: string) => bigint(name, { mode: 'bigint' });

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: ts('updated_at').notNull().default(sql`now()`),
});

export const stocks = pgTable('stocks', {
  mint: text('mint').primaryKey(),
  symbol: text('symbol').notNull().unique(),
  name: text('name').notNull(),
  grp: text('grp').notNull(),
  enabled: boolean('enabled').notNull(),
  approved: boolean('approved').notNull(),
  decimals: integer('decimals'),
  tokenProgram: text('token_program'),
  mintAuthority: text('mint_authority'),
  /** passed the on-chain mint check (Token-2022 + expected mint authority) */
  verified: boolean('verified').notNull().default(false),
  verifyError: text('verify_error'),
  verifiedAt: ts('verified_at'),
  status: text('status').notNull().default('active'),
  uiMultiplier: doublePrecision('ui_multiplier').notNull().default(1),
  priceUsd: doublePrecision('price_usd'),
  change24hPct: doublePrecision('change_24h_pct'),
  priceAt: ts('price_at'),
  updatedAt: ts('updated_at').notNull().default(sql`now()`),
});

export const stockPrices = pgTable(
  'stock_prices',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    mint: text('mint').notNull(),
    priceUsd: doublePrecision('price_usd').notNull(),
    at: ts('at').notNull(),
  },
  (t) => [index('stock_prices_mint_at').on(t.mint, t.at)],
);

export const rats = pgTable(
  'rats',
  {
    id: serial('id').primaryKey(),
    mode: text('mode').notNull(),
    wallet: text('wallet').notNull().unique(),
    stockMint: text('stock_mint').notNull(),
    /** hiring | active | frozen */
    status: text('status').notNull(),
    freezeReason: text('freeze_reason'),
    avatarSeed: text('avatar_seed').notNull(),
    salaryLamports: lamports('salary_lamports').notNull(),
    /** ledger entry id of the hire reservation (settled or released later) */
    reserveLedgerId: bigint('reserve_ledger_id', { mode: 'number' }),
    /** two-step mode: salary transfer already landed */
    funded: boolean('funded').notNull().default(false),
    solSwappedLamports: lamports('sol_swapped_lamports'),
    tokenAmountRaw: lamports('token_amount_raw'),
    tokenDecimals: integer('token_decimals'),
    costUsd: doublePrecision('cost_usd'),
    solUsdAtHire: doublePrecision('sol_usd_at_hire'),
    hireSig: text('hire_sig'),
    hireAttempts: integer('hire_attempts').notNull().default(0),
    createdAt: ts('created_at').notNull(),
    hiredAt: ts('hired_at'),
    lastCheckedAt: ts('last_checked_at'),
  },
  (t) => [index('rats_mode_status').on(t.mode, t.status), index('rats_stock').on(t.stockMint)],
);

export const keyPool = pgTable(
  'key_pool',
  {
    pubkey: text('pubkey').primaryKey(),
    secretEnc: text('secret_enc').notNull(),
    keyVersion: integer('key_version').notNull(),
    /** rat | creator | fund */
    role: text('role').notNull(),
    /** available | assigned */
    status: text('status').notNull().default('available'),
    assignedAt: ts('assigned_at'),
    createdAt: ts('created_at').notNull().default(sql`now()`),
  },
  (t) => [index('key_pool_role_status').on(t.role, t.status)],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    mode: text('mode').notNull(),
    at: ts('at').notNull(),
    bucket: text('bucket').notNull(),
    deltaLamports: lamports('delta_lamports').notNull(),
    reason: text('reason').notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    note: text('note'),
  },
  (t) => [index('ledger_mode_bucket').on(t.mode, t.bucket), index('ledger_mode_at').on(t.mode, t.at)],
);

export const claims = pgTable(
  'claims',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    mode: text('mode').notNull(),
    at: ts('at').notNull(),
    /** bot | external */
    source: text('source').notNull(),
    /** pending | confirmed | failed | expired | simulated */
    status: text('status').notNull(),
    sig: text('sig'),
    claimableLamports: lamports('claimable_lamports').notNull(),
    claimedLamports: lamports('claimed_lamports').notNull().default(sql`0`),
    /** transfer to the fund wallet included in this tx */
    toFundLamports: lamports('to_fund_lamports').notNull().default(sql`0`),
    /** credited to the burn bucket */
    fundShareLamports: lamports('fund_share_lamports').notNull().default(sql`0`),
    hireShareLamports: lamports('hire_share_lamports').notNull().default(sql`0`),
    feeLamports: lamports('fee_lamports').notNull().default(sql`0`),
  },
  (t) => [index('claims_mode_at').on(t.mode, t.at), uniqueIndex('claims_sig').on(t.sig)],
);

export const burns = pgTable(
  'burns',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    mode: text('mode').notNull(),
    at: ts('at').notNull(),
    /** pending | confirmed | failed | expired | simulated | released */
    status: text('status').notNull(),
    sig: text('sig'),
    reservedLamports: lamports('reserved_lamports').notNull(),
    reserveLedgerId: bigint('reserve_ledger_id', { mode: 'number' }),
    solSpentLamports: lamports('sol_spent_lamports'),
    tokensBurnedRaw: lamports('tokens_burned_raw'),
    coinDecimals: integer('coin_decimals'),
  },
  (t) => [index('burns_mode_at').on(t.mode, t.at)],
);

export const txAttempts = pgTable(
  'tx_attempts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    mode: text('mode').notNull(),
    kind: text('kind').notNull(),
    refType: text('ref_type').notNull(),
    refId: text('ref_id').notNull(),
    signature: text('signature').notNull().unique(),
    lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'number' }).notNull(),
    status: text('status').notNull(),
    error: text('error'),
    feeLamports: lamports('fee_lamports'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('tx_attempts_ref').on(t.refType, t.refId), index('tx_attempts_mode_status').on(t.mode, t.status)],
);

export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    mode: text('mode').notNull(),
    at: ts('at').notNull(),
    type: text('type').notNull(),
    txSig: text('tx_sig'),
    data: jsonb('data').notNull(),
  },
  (t) => [index('events_mode_id').on(t.mode, t.id)],
);

export const heartbeats = pgTable('heartbeats', {
  loop: text('loop').primaryKey(),
  lastRunAt: ts('last_run_at').notNull(),
  lastOkAt: ts('last_ok_at'),
  lastError: text('last_error'),
  runs: integer('runs').notNull().default(0),
});

export const seenSignatures = pgTable('seen_signatures', {
  signature: text('signature').primaryKey(),
  address: text('address').notNull(),
  /** ours | external_claim | inflow | outflow_unknown | other */
  classification: text('classification').notNull(),
  at: ts('at').notNull(),
});

export const locks = pgTable('locks', {
  name: text('name').primaryKey(),
  holder: text('holder').notNull(),
  expiresAt: ts('expires_at').notNull(),
});
