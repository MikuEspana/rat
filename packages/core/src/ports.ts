// Ports: the interfaces every package codes against. Real implementations live in
// @rat/chain, @rat/pump, @rat/jupiter, @rat/keys, @rat/db, @rat/safety. Mocks and the
// in-memory SimChain implement the same interfaces for tests.
import type { AddressLookupTableAccount, Keypair, TransactionInstruction } from '@solana/web3.js';
import type { Bucket, KeyRole, LedgerReason, Mode, Pubkey, TxKind, TxStatus } from './types';

// ---------- time and randomness ----------

export interface Clock {
  now(): Date;
}

/** Returns a float in [0, 1). Seeded in tests. */
export interface Rng {
  next(): number;
}

// ---------- prices ----------

export interface PriceQuote {
  mint: Pubkey;
  usdPrice: number;
  /** percent, e.g. 1.29 = +1.29% */
  change24hPct: number | null;
}

/** The worker's shared budget of Jupiter calls: a hard cap per rolling minute (Free tier safe). */
export interface CallBudget {
  /** calls that can be made right now (0 while backing off after a 429) */
  available(): number;
}

export interface PriceSource {
  /** Mints missing from the result have no reliable price right now (treat as stale, never zero). */
  getPrices(mints: Pubkey[]): Promise<Map<Pubkey, PriceQuote>>;
}

// ---------- swaps ----------

export interface SwapBuildRequest {
  inputMint: Pubkey;
  outputMint: Pubkey;
  /** raw input amount (lamports for SOL) */
  amount: bigint;
  /** wallet that owns the input and receives the output */
  taker: Pubkey;
  /** optional wallet that pays tx fees and token account rent */
  payer?: Pubkey;
  slippageBps: number;
}

export interface SwapBuild {
  /** setup + swap + cleanup + other instructions, in execution order. No compute budget instructions. */
  instructions: TransactionInstruction[];
  lookupTables: AddressLookupTableAccount[];
  inAmount: bigint;
  outAmount: bigint;
  /** worst case output after slippage */
  minOutAmount: bigint;
  priceImpactPct: number;
}

export interface SwapBuilder {
  build(req: SwapBuildRequest): Promise<SwapBuild>;
}

// ---------- pump.fun ----------

export interface Claimable {
  /** bonding curve creator vault, lamports above rent */
  bondingLamports: bigint;
  /** PumpSwap coin creator vault, WSOL */
  ammLamports: bigint;
  totalLamports: bigint;
}

export interface CoinInfo {
  mint: Pubkey;
  decimals: number;
  /** SPL Token or Token-2022, detected at runtime */
  tokenProgram: Pubkey;
  supply: bigint;
}

export interface PumpClient {
  getClaimable(creator: Pubkey): Promise<Claimable>;
  /** Claim (+ WSOL unwrap) instructions for what is claimable. */
  buildClaimInstructions(args: { creator: Pubkey; claimable: Claimable }): TransactionInstruction[];
  getCoinInfo(mint: Pubkey): Promise<CoinInfo>;
}

// ---------- chain reads ----------

export interface MintState {
  mint: Pubkey;
  exists: boolean;
  /** owner program of the mint account (SPL Token or Token-2022) */
  tokenProgram: Pubkey | null;
  decimals: number;
  supply: bigint;
  mintAuthority: Pubkey | null;
  freezeAuthority: Pubkey | null;
  /** Token-2022 Pausable extension: paused flag */
  paused: boolean;
  /** Token-2022 Scaled UI Amount multiplier currently in effect (1 when absent) */
  uiMultiplier: number;
  hasPermanentDelegate: boolean;
}

export interface TokenAccountQuery {
  owner: Pubkey;
  mint: Pubkey;
  tokenProgram: Pubkey;
}

export interface TokenAccountState {
  /** associated token account address */
  address: Pubkey;
  owner: Pubkey;
  mint: Pubkey;
  exists: boolean;
  amount: bigint;
  frozen: boolean;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown | null;
  blockTime: number | null;
}

export interface TxInstructionRecord {
  programId: Pubkey;
  accounts: Pubkey[];
  data: Uint8Array;
  /** true for CPI (inner) instructions */
  inner: boolean;
}

export interface TxTokenBalanceRecord {
  accountIndex: number;
  account: Pubkey;
  owner: Pubkey | null;
  mint: Pubkey;
  amount: bigint;
}

/** Normalized view of a landed transaction (real RPC or SimChain). */
export interface TxRecord {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown | null;
  feePayer: Pubkey;
  signers: Pubkey[];
  feeLamports: bigint;
  /** static keys then loaded writable then loaded readonly, same order as balances */
  accountKeys: Pubkey[];
  preBalances: bigint[];
  postBalances: bigint[];
  preTokenBalances: TxTokenBalanceRecord[];
  postTokenBalances: TxTokenBalanceRecord[];
  /** outer and inner instructions */
  instructions: TxInstructionRecord[];
  logs: string[];
}

export interface ChainReader {
  getSolBalances(pubkeys: Pubkey[]): Promise<Map<Pubkey, bigint>>;
  getMintStates(mints: Pubkey[]): Promise<Map<Pubkey, MintState>>;
  /** One result per query, same order. Missing accounts come back with exists=false, amount=0. */
  getTokenAccounts(queries: TokenAccountQuery[]): Promise<TokenAccountState[]>;
  /** Newest first, stopping before `untilSignature` (exclusive). */
  getSignaturesSince(address: Pubkey, untilSignature: string | null, limit?: number): Promise<SignatureInfo[]>;
  getTransactionRecord(signature: string): Promise<TxRecord | null>;
  /** current slot (confirmed) */
  getSlot(): Promise<number>;
}

// ---------- sending ----------

export interface TxRequest {
  kind: TxKind;
  /** human readable label for logs */
  label: string;
  feePayer: Keypair;
  /** additional signers (not the fee payer) */
  signers: Keypair[];
  instructions: TransactionInstruction[];
  lookupTables?: AddressLookupTableAccount[];
  computeUnitLimit: number;
  /** if omitted the sender estimates a priority fee (capped by config) */
  computeUnitPriceMicroLamports?: number;
  /**
   * Spend limits. Live mode: the GuardedSender simulates the signed transaction first and refuses to send it
   * if any limit is broken (required for claim and hire). Instructions from an outside API (Jupiter)
   * can therefore never move more than the reserved amount out of our wallets.
   */
  limits?: TxLimits;
}

export interface TxLimits {
  /** each account may lose at most `maxLamports` (transfers, rent and fees included) */
  solOut: { account: Pubkey; maxLamports: bigint }[];
  /** the owner's associated token account of `mint` must change by at least `minDelta` (0 = must not drop) */
  tokens?: { owner: Pubkey; mint: Pubkey; tokenProgram: Pubkey; minDelta: bigint }[];
}

/** What a simulated transaction would do to the accounts named in its TxLimits. */
export interface TxEffects {
  /** set when the simulation failed (the transaction would fail on-chain) */
  error?: string;
  /** lamport change of each `limits.solOut` account, same order */
  solDelta: bigint[];
  /** raw token change of each `limits.tokens` entry, same order */
  tokenDelta: bigint[];
}

export interface PreparedTx {
  signature: string;
  lastValidBlockHeight: number;
  request: TxRequest;
  serialized: Uint8Array;
}

export type TxOutcomeStatus = 'confirmed' | 'failed' | 'expired' | 'unknown' | 'simulated';

export interface TxOutcome {
  status: TxOutcomeStatus;
  signature: string;
  feeLamports: bigint;
  error?: string;
  /** present when the tx landed (confirmed or failed on-chain), and for SimChain simulations */
  record?: TxRecord;
  logs?: string[];
}

export interface TxSender {
  /** Adds compute budget, fetches a blockhash, signs. Does not send. */
  prepare(req: TxRequest): Promise<PreparedTx>;
  /** Sends and waits until confirmed, failed, or the blockhash expired. */
  submit(tx: PreparedTx): Promise<TxOutcome>;
  /** Simulates without sending. Never mutates chain state. */
  simulate(tx: PreparedTx): Promise<TxOutcome>;
  /** Re-checks a previously sent signature. `unknown` = may still land. */
  status(signature: string, lastValidBlockHeight: number): Promise<TxOutcome>;
  /** Simulates the signed tx and reports the balance changes of the accounts named in `limits`. Never sends. */
  simulateEffects(tx: PreparedTx, limits: TxLimits): Promise<TxEffects>;
}

// ---------- keys ----------

export interface KeyStore {
  creator(): Promise<Keypair>;
  /**
   * A brand new rat wallet: a fresh keypair, encrypted and stored (and read back) BEFORE its public key is
   * returned, so the key always exists before any SOL can be sent to it. Keys are never reused.
   */
  newRatKey(): Promise<Pubkey>;
  ratSigner(pubkey: Pubkey): Promise<Keypair>;
  /** The hire was abandoned before any transaction was sent: the key is kept but never handed out again. */
  discardRatKey(pubkey: Pubkey): Promise<void>;
}

// ---------- stores (implemented by @rat/db) ----------

export interface LedgerEntryInput {
  bucket: Bucket;
  /** signed lamports: positive = credit, negative = debit */
  deltaLamports: bigint;
  reason: LedgerReason;
  refType?: string;
  refId?: string;
  note?: string;
}

export interface LedgerStore {
  readonly mode: Mode;
  append(entry: LedgerEntryInput): Promise<number>;
  balance(bucket: Bucket): Promise<bigint>;
  /** Net spend (reserve + settle + release, sign flipped) of one bucket since `since`. */
  netOutflowSince(bucket: Bucket, since: Date): Promise<bigint>;
  /** Net spend of both buckets since the beginning (smoke cap). */
  lifetimeNetOutflow(): Promise<bigint>;
  /**
   * Books the settle or release of reservation `closesId`, exactly once (a zero delta still records the close).
   * Returns false, booking nothing, if that reservation was already closed (a retry after a crash).
   */
  close(entry: LedgerEntryInput & { closesId: number }): Promise<boolean>;
  /** Whether reservation `id` is still open (reserved, not yet settled or released). */
  isOpen(id: number): Promise<boolean>;
  /** Reservations of `bucket` that were never settled or released. */
  openReservations(bucket: Bucket): Promise<OpenReservation[]>;
}

export interface OpenReservation {
  id: number;
  lamports: bigint;
  refType: string | null;
  refId: string | null;
}

export interface AttemptInput {
  kind: TxKind;
  refType: string;
  refId: string;
  signature: string;
  lastValidBlockHeight: number;
}

export interface AttemptStore {
  readonly mode: Mode;
  create(input: AttemptInput): Promise<number>;
  finish(id: number, result: { status: TxStatus; error?: string; feeLamports?: bigint }): Promise<void>;
}

export interface SettingsStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface KeyPoolRecord {
  pubkey: Pubkey;
  /** base64 of iv | tag | ciphertext */
  secretEnc: string;
  keyVersion: number;
  role: KeyRole;
}

export interface KeyPoolStore {
  /** Inserts one new rat key (status assigned). Throws if the public key already exists. */
  insertRatKey(record: KeyPoolRecord): Promise<void>;
  /** Marks a rat key as never used (never funded); it is never handed out again. */
  markUnused(pubkey: Pubkey): Promise<void>;
  get(pubkey: Pubkey): Promise<KeyPoolRecord | null>;
  getRole(role: 'creator'): Promise<KeyPoolRecord | null>;
}

// ---------- safety ----------

export type AlertLevel = 'info' | 'warn' | 'critical';

export interface Alerts {
  /** `key` dedupes repeated alerts (same key is throttled). */
  send(level: AlertLevel, key: string, text: string): Promise<void>;
}

export interface KillSwitch {
  status(): Promise<{ on: boolean; reason: string | null }>;
}
