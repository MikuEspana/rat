// Loads and validates every variable in .env.example. Safety relevant rules:
// - DRY_RUN defaults to true.
// - Live sending needs DRY_RUN=false AND LIVE_CONFIRM set to the exact phrase, otherwise loading fails.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { LIVE_CONFIRM_PHRASE, PRODUCTION_CREATOR_PUBKEY, isBase58Pubkey } from './constants';
import { ConfigError } from './errors';
import { solToLamports } from './money';
import type { HireMode, StockConfigEntry } from './types';

const boolStr = (def: 'true' | 'false') =>
  z
    .string()
    .trim()
    .toLowerCase()
    .default(def)
    .transform((v, ctx) => {
      if (v === '') return def === 'true';
      if (['true', '1', 'yes'].includes(v)) return true;
      if (['false', '0', 'no'].includes(v)) return false;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected true/false, got "${v}"` });
      return z.NEVER;
    });

const solStr = (def: string) =>
  z
    .string()
    .trim()
    .default(def)
    .transform((v, ctx) => {
      const value = v === '' ? def : v;
      try {
        return solToLamports(value);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid SOL amount "${value}"` });
        return z.NEVER;
      }
    });

const intStr = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .trim()
    .default(String(def))
    .transform((v, ctx) => {
      const value = v === '' ? def : Number(v);
      if (!Number.isInteger(value) || value < min || value > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected integer in [${min}, ${max}], got "${v}"` });
        return z.NEVER;
      }
      return value;
    });

const numStr = (def: number, min = 0) =>
  z
    .string()
    .trim()
    .default(String(def))
    .transform((v, ctx) => {
      const value = v === '' ? def : Number(v);
      if (!Number.isFinite(value) || value < min) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected number >= ${min}, got "${v}"` });
        return z.NEVER;
      }
      return value;
    });

const optStr = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

const optPubkey = optStr.refine((v) => v === undefined || isBase58Pubkey(v), { message: 'expected a base58 public key' });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  DRY_RUN: boolStr('true'),
  LIVE_CONFIRM: optStr,
  KILL_SWITCH: boolStr('false'),
  SMOKE_MODE: boolStr('false'),
  SMOKE_CAP_SOL: solStr('0.1'),
  // Rehearsal only (docs/runbooks/rehearsal.md): turns on the test-only features (`rat staging-seed`, the crash test,
  // a stage source that counts seeded SOL). Refused with the production creator wallet and on a production database.
  STAGING: boolStr('false'),
  // STAGING only: the worker kills itself right after sending this many hires, once, to prove crash recovery.
  STAGING_CRASH_AFTER_SEND: intStr(0, 0, 1000),
  // STAGING only: the rehearsal API multiplies the stage source (claimed plus seeded SOL) by this, so a test of a few
  // hundredths of a SOL crosses a stage on the site. 1 = off. The public claimed figure is never scaled.
  STAGING_STAGE_SCALE: intStr(1, 1, 1000),

  DATABASE_URL: optStr,
  DATABASE_URL_READONLY: optStr,

  KEY_ENCRYPTION_KEY: optStr.refine((v) => v === undefined || Buffer.from(v, 'base64').length === 32, {
    message: 'must be 32 bytes, base64 encoded',
  }),
  KEY_VERSION: intStr(1, 1),
  // only while rotating the master key (docs/runbooks/keys.md): the old key, so the running worker can still read
  // what it encrypted. Removed once `rat keys rotate` re-encrypted everything.
  KEY_ENCRYPTION_KEY_PREVIOUS: optStr.refine((v) => v === undefined || Buffer.from(v, 'base64').length === 32, {
    message: 'must be 32 bytes, base64 encoded',
  }),
  KEY_VERSION_PREVIOUS: intStr(0, 0),
  CREATOR_PUBKEY: optPubkey,
  // Your cold wallet (a wallet the bot has no key for): the default target of `rat sweep`. Checked by preflight.
  COLD_WALLET: optPubkey,

  RPC_URL: optStr,
  RPC_URL_BACKUP: optStr,
  COIN_MINT: optPubkey,
  // Wallet watch: transactions of the creator wallet before this slot are never looked at (set it to the
  // slot right after the coin launch). 0 = the slot of the worker's first live run.
  WATCH_FROM_SLOT: intStr(0),
  // Comma-separated signatures of transactions YOU signed with the creator wallet (the coin launch, a
  // manual transfer). The wallet watch accepts them instead of engaging the kill switch.
  KNOWN_OWNER_TX_SIGS: z
    .string()
    .trim()
    .default('')
    .transform((v, ctx) => {
      const sigs = v.split(',').map((x) => x.trim()).filter(Boolean);
      for (const sig of sigs) {
        if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a transaction signature: "${sig.slice(0, 20)}"` });
          return z.NEVER;
        }
      }
      return sigs;
    }),
  PRIORITY_FEE_MICROLAMPORTS_MAX: intStr(200_000),
  COMPUTE_UNIT_LIMIT_SWAP: intStr(400_000, 1, 1_400_000),
  COMPUTE_UNIT_LIMIT_CLAIM: intStr(200_000, 1, 1_400_000),
  XSTOCKS_MINT_AUTHORITY: optPubkey,

  JUPITER_API_KEY: optStr,
  JUPITER_BASE_URL: z.string().trim().url().default('https://api.jup.ag'),
  // Hard cap on the worker's Jupiter calls per rolling minute (prices + builds + retries). We stay on the Free tier
  // (60 per minute per organisation): 40 at most, the rest is left for the CLI and scripts on the same key.
  JUPITER_MAX_RPM: intStr(40, 1, 40),

  SALARY_SOL: solStr('0.03'),
  HIRE_OVERHEAD_EST_SOL: solStr('0.0025'),
  RAT_BUFFER_SOL: solStr('0.003'),
  HIRE_MODE: z.enum(['single', 'two_step']).default('single'),
  MIN_CLAIM_SOL: solStr('0.005'),
  CREATOR_RESERVE_SOL: solStr('0.05'),
  // 20 per 35 s loop = about 34 rats a minute, just over the 60 SOL/h cap: steady hiring, no mid-launch pause
  MAX_HIRES_PER_LOOP: intStr(20, 0, 200),
  MIN_STOCK_WEIGHT_BPS: intStr(500, 0, 10_000),
  SLIPPAGE_BPS_STOCK: intStr(100, 1, 5_000),
  MAX_PRICE_IMPACT_PCT: numStr(2),
  // Alert when no rat was hired for HIRE_IDLE_ALERT_MIN minutes while more than HIRE_IDLE_ALERT_SOL waits in the hire budget.
  HIRE_IDLE_ALERT_MIN: intStr(30, 1),
  HIRE_IDLE_ALERT_SOL: solStr('0.1'),
  // Every claimed lamport hires rats (there is no other spending). 60 SOL/h = about 2,000 rats an hour.
  SPEND_CAP_SOL_PER_HOUR_HIRE: solStr('60'),
  SPEND_ALERT_PCT: intStr(50, 1, 100),

  CLAIM_INTERVAL_SEC: intStr(35, 1),
  // one batched Price API call for every mint; the site smooths the numbers between updates
  PRICE_INTERVAL_SEC: intStr(45, 1),
  FREEZE_INTERVAL_SEC: intStr(35, 1),
  PRICE_STALE_SEC: intStr(900, 1),
  RECONCILE_BATCH: intStr(500, 1, 10_000),
  DRY_RUN_FAKE_CLAIM_SOL_PER_HOUR: solStr('0'),

  TELEGRAM_BOT_TOKEN: optStr,
  TELEGRAM_CHAT_ID: optStr,

  API_PORT: intStr(8080, 1, 65_535),
  API_CACHE_SEC: intStr(3, 0, 3600),
  CORS_ORIGIN: z.string().trim().default('*'),

  STOCKS_FILE: z.string().trim().default('config/stocks.json'),
  // Comma-separated symbols the owner verified on xstocks.fi (for example "TSLAx,AAPLx"): approved on top of the
  // stocks file. Every approved stock must still pass the on-chain mint check before any rat is hired into it.
  APPROVED_STOCKS: z
    .string()
    .trim()
    .default('')
    .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean)),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  /** true = never send, only simulate */
  dryRun: boolean;
  /** true only when DRY_RUN=false AND LIVE_CONFIRM matches the phrase */
  liveConfirmed: boolean;
  killSwitch: boolean;
  smokeMode: boolean;
  smokeCapLamports: bigint;
  /** rehearsal only: test-only features on (never with the production creator, never on a production database) */
  staging: boolean;
  /** rehearsal only: kill the worker once, right after the Nth hire was sent (0 = off) */
  stagingCrashAfterSend: number;
  /** rehearsal only: the stage source is multiplied by this on a staging database (1 = off) */
  stagingStageScale: number;

  databaseUrl?: string;
  databaseUrlReadonly?: string;

  keyEncryptionKey?: string;
  keyVersion: number;
  /** during a master key rotation only: the old key and its version (0 = none) */
  keyEncryptionKeyPrevious?: string;
  keyVersionPrevious: number;
  creatorPubkey?: string;
  /** the owner's cold wallet: default target of `rat sweep` */
  coldWallet?: string;

  rpcUrl?: string;
  rpcUrlBackup?: string;
  coinMint?: string;
  /** wallet watch floor (0 = slot of the first live run) */
  watchFromSlot: number;
  /** owner-signed transactions the wallet watch accepts */
  knownOwnerTxSigs: string[];
  priorityFeeMicroLamportsMax: number;
  computeUnitLimitSwap: number;
  computeUnitLimitClaim: number;
  xstocksMintAuthority?: string;

  jupiter: { apiKey?: string; baseUrl: string; maxRpm: number };

  salaryLamports: bigint;
  hireOverheadEstLamports: bigint;
  ratBufferLamports: bigint;
  hireMode: HireMode;
  minClaimLamports: bigint;
  creatorReserveLamports: bigint;
  maxHiresPerLoop: number;
  minStockWeightBps: number;
  slippageBpsStock: number;
  maxPriceImpactPct: number;
  hireIdleAlert: { minutes: number; lamports: bigint };
  spendCapLamportsPerHour: { hire: bigint };
  spendAlertPct: number;

  intervals: { claimSec: number; priceSec: number; freezeSec: number };
  priceStaleSec: number;
  reconcileBatch: number;
  dryRunFakeClaimLamportsPerHour: bigint;

  telegram: { botToken?: string; chatId?: string };
  api: { port: number; cacheSec: number; corsOrigin: string };
  stocksFile: string;
  /** APPROVED_STOCKS: symbols the owner verified, approved on top of the stocks file */
  approvedStocks: string[];
}

export type ConfigKey = keyof AppConfig;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;

  if (!e.DRY_RUN && e.LIVE_CONFIRM !== LIVE_CONFIRM_PHRASE) {
    throw new ConfigError(
      `DRY_RUN=false requires LIVE_CONFIRM=${LIVE_CONFIRM_PHRASE}. Refusing to start in an ambiguous mode.`,
    );
  }
  if (e.SALARY_SOL <= e.HIRE_OVERHEAD_EST_SOL + e.RAT_BUFFER_SOL) {
    throw new ConfigError('SALARY_SOL must be larger than HIRE_OVERHEAD_EST_SOL + RAT_BUFFER_SOL');
  }
  if (Boolean(e.KEY_ENCRYPTION_KEY_PREVIOUS) !== e.KEY_VERSION_PREVIOUS > 0) {
    throw new ConfigError('KEY_ENCRYPTION_KEY_PREVIOUS and KEY_VERSION_PREVIOUS go together (only while rotating the master key).');
  }
  if (e.KEY_VERSION_PREVIOUS > 0 && e.KEY_VERSION_PREVIOUS === e.KEY_VERSION) {
    throw new ConfigError('KEY_VERSION must differ from KEY_VERSION_PREVIOUS (a new master key gets a new version).');
  }
  if (e.STAGING) {
    if (!e.CREATOR_PUBKEY) throw new ConfigError('STAGING=true needs CREATOR_PUBKEY (the throwaway test creator).');
    if (e.CREATOR_PUBKEY === PRODUCTION_CREATOR_PUBKEY) {
      throw new ConfigError('STAGING=true is refused with the production creator wallet. Staging runs with a throwaway test creator only.');
    }
  } else if (e.STAGING_CRASH_AFTER_SEND > 0) {
    throw new ConfigError('STAGING_CRASH_AFTER_SEND only works with STAGING=true (rehearsal only).');
  } else if (e.STAGING_STAGE_SCALE > 1) {
    throw new ConfigError('STAGING_STAGE_SCALE only works with STAGING=true (rehearsal only).');
  }
  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    dryRun: e.DRY_RUN,
    liveConfirmed: !e.DRY_RUN && e.LIVE_CONFIRM === LIVE_CONFIRM_PHRASE,
    killSwitch: e.KILL_SWITCH,
    smokeMode: e.SMOKE_MODE,
    smokeCapLamports: e.SMOKE_CAP_SOL,
    staging: e.STAGING,
    stagingCrashAfterSend: e.STAGING ? e.STAGING_CRASH_AFTER_SEND : 0,
    stagingStageScale: e.STAGING ? e.STAGING_STAGE_SCALE : 1,
    databaseUrl: e.DATABASE_URL,
    databaseUrlReadonly: e.DATABASE_URL_READONLY,
    keyEncryptionKey: e.KEY_ENCRYPTION_KEY,
    keyVersion: e.KEY_VERSION,
    keyEncryptionKeyPrevious: e.KEY_ENCRYPTION_KEY_PREVIOUS,
    keyVersionPrevious: e.KEY_VERSION_PREVIOUS,
    creatorPubkey: e.CREATOR_PUBKEY,
    coldWallet: e.COLD_WALLET,
    rpcUrl: e.RPC_URL,
    rpcUrlBackup: e.RPC_URL_BACKUP,
    coinMint: e.COIN_MINT,
    watchFromSlot: e.WATCH_FROM_SLOT,
    knownOwnerTxSigs: e.KNOWN_OWNER_TX_SIGS,
    priorityFeeMicroLamportsMax: e.PRIORITY_FEE_MICROLAMPORTS_MAX,
    computeUnitLimitSwap: e.COMPUTE_UNIT_LIMIT_SWAP,
    computeUnitLimitClaim: e.COMPUTE_UNIT_LIMIT_CLAIM,
    xstocksMintAuthority: e.XSTOCKS_MINT_AUTHORITY,
    jupiter: { apiKey: e.JUPITER_API_KEY, baseUrl: e.JUPITER_BASE_URL.replace(/\/+$/, ''), maxRpm: e.JUPITER_MAX_RPM },
    salaryLamports: e.SALARY_SOL,
    hireOverheadEstLamports: e.HIRE_OVERHEAD_EST_SOL,
    ratBufferLamports: e.RAT_BUFFER_SOL,
    hireMode: e.HIRE_MODE,
    minClaimLamports: e.MIN_CLAIM_SOL,
    creatorReserveLamports: e.CREATOR_RESERVE_SOL,
    maxHiresPerLoop: e.MAX_HIRES_PER_LOOP,
    minStockWeightBps: e.MIN_STOCK_WEIGHT_BPS,
    slippageBpsStock: e.SLIPPAGE_BPS_STOCK,
    maxPriceImpactPct: e.MAX_PRICE_IMPACT_PCT,
    hireIdleAlert: { minutes: e.HIRE_IDLE_ALERT_MIN, lamports: e.HIRE_IDLE_ALERT_SOL },
    spendCapLamportsPerHour: { hire: e.SPEND_CAP_SOL_PER_HOUR_HIRE },
    spendAlertPct: e.SPEND_ALERT_PCT,
    intervals: {
      claimSec: e.CLAIM_INTERVAL_SEC,
      priceSec: e.PRICE_INTERVAL_SEC,
      freezeSec: e.FREEZE_INTERVAL_SEC,
    },
    priceStaleSec: e.PRICE_STALE_SEC,
    reconcileBatch: e.RECONCILE_BATCH,
    dryRunFakeClaimLamportsPerHour: e.DRY_RUN ? e.DRY_RUN_FAKE_CLAIM_SOL_PER_HOUR : 0n,
    telegram: { botToken: e.TELEGRAM_BOT_TOKEN, chatId: e.TELEGRAM_CHAT_ID },
    api: { port: e.API_PORT, cacheSec: e.API_CACHE_SEC, corsOrigin: e.CORS_ORIGIN },
    stocksFile: e.STOCKS_FILE,
    approvedStocks: e.APPROVED_STOCKS,
  };
}

/** Throws a ConfigError listing every missing required value. */
export function requireConfig<K extends ConfigKey>(
  cfg: AppConfig,
  keys: K[],
): asserts cfg is AppConfig & Required<Pick<AppConfig, K>> {
  const missing = keys.filter((k) => cfg[k] === undefined || cfg[k] === '');
  if (missing.length > 0) throw new ConfigError(`Missing required configuration: ${missing.join(', ')}`);
}

/** Config without secrets, safe to log. */
export function publicConfigSummary(cfg: AppConfig): Record<string, unknown> {
  return {
    nodeEnv: cfg.nodeEnv,
    dryRun: cfg.dryRun,
    liveConfirmed: cfg.liveConfirmed,
    killSwitch: cfg.killSwitch,
    smokeMode: cfg.smokeMode,
    staging: cfg.staging,
    coinMint: cfg.coinMint ?? null,
    watchFromSlot: cfg.watchFromSlot || 'first live run',
    knownOwnerTxSigs: cfg.knownOwnerTxSigs.length,
    creatorPubkey: cfg.creatorPubkey ?? null,
    coldWallet: cfg.coldWallet ?? null,
    hireMode: cfg.hireMode,
    salarySol: cfg.salaryLamports.toString(),
    spendCapLamportsPerHour: { hire: cfg.spendCapLamportsPerHour.hire.toString() },
    maxHiresPerLoop: cfg.maxHiresPerLoop,
    jupiterMaxRpm: cfg.jupiter.maxRpm,
    hasRpc: Boolean(cfg.rpcUrl),
    hasJupiterKey: Boolean(cfg.jupiter.apiKey),
    hasTelegram: Boolean(cfg.telegram.botToken && cfg.telegram.chatId),
  };
}

const stockEntrySchema = z.object({
  symbol: z.string().min(1),
  name: z.string().min(1),
  mint: z.string().refine(isBase58Pubkey, { message: 'mint must be a base58 public key' }),
  group: z.enum(['volatile', 'steady', 'reserve']),
  enabled: z.boolean(),
  approved: z.boolean(),
});

const stocksFileSchema = z.object({ stocks: z.array(stockEntrySchema) });

/** Reads config/stocks.json. Symbols and mints must be unique. */
export function loadStocksFile(path: string, cwd = process.cwd(), approved: readonly string[] = []): StockConfigEntry[] {
  const raw = JSON.parse(readFileSync(resolve(cwd, path), 'utf8')) as unknown;
  return withApprovals(parseStocks(raw), approved);
}

/** APPROVED_STOCKS on top of the stocks file. A symbol that is not in the file is a configuration error (a typo). */
export function withApprovals(stocks: StockConfigEntry[], approved: readonly string[]): StockConfigEntry[] {
  const known = new Set(stocks.map((s) => s.symbol));
  const unknown = approved.filter((sym) => !known.has(sym));
  if (unknown.length > 0) throw new ConfigError(`APPROVED_STOCKS names ${unknown.join(', ')}, not in the stocks file (symbols are case sensitive, like TSLAx)`);
  const set = new Set(approved);
  return stocks.map((s) => (set.has(s.symbol) ? { ...s, approved: true } : s));
}

export function parseStocks(raw: unknown): StockConfigEntry[] {
  const parsed = stocksFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid stocks file: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const seenSymbols = new Set<string>();
  const seenMints = new Set<string>();
  for (const s of parsed.data.stocks) {
    if (seenSymbols.has(s.symbol)) throw new ConfigError(`Duplicate stock symbol ${s.symbol}`);
    if (seenMints.has(s.mint)) throw new ConfigError(`Duplicate stock mint ${s.mint}`);
    seenSymbols.add(s.symbol);
    seenMints.add(s.mint);
  }
  return parsed.data.stocks;
}
