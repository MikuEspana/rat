// Loads and validates every variable in .env.example. Safety relevant rules:
// - DRY_RUN defaults to true.
// - Live sending needs DRY_RUN=false AND LIVE_CONFIRM set to the exact phrase, otherwise loading fails.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { LIVE_CONFIRM_PHRASE, isBase58Pubkey } from './constants';
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

  DATABASE_URL: optStr,
  DATABASE_URL_READONLY: optStr,

  KEY_ENCRYPTION_KEY: optStr.refine((v) => v === undefined || Buffer.from(v, 'base64').length === 32, {
    message: 'must be 32 bytes, base64 encoded',
  }),
  KEY_VERSION: intStr(1, 1),
  CREATOR_PUBKEY: optPubkey,
  FUND_PUBKEY: optPubkey,
  VANITY_SUFFIX: z
    .string()
    .trim()
    .default('RAT')
    .refine((v) => /^[1-9A-HJ-NP-Za-km-z]{0,5}$/.test(v), { message: 'base58 characters only, max 5' }),
  // Key pool: the worker grinds in the background while available keys < KEYPOOL_REFILL_BELOW, up to KEYPOOL_TARGET.
  KEYPOOL_REFILL_BELOW: intStr(9000),
  KEYPOOL_TARGET: intStr(10000),
  KEYPOOL_LOW_ALERT: intStr(500),
  KEYPOOL_RUNWAY_ALERT_HOURS: numStr(2),
  KEYPOOL_REFILL_BATCH: intStr(200, 1, 100_000),
  KEYPOOL_GRINDER: z.enum(['auto', 'solana-keygen', 'js', 'off']).default('auto'),
  KEYPOOL_GRIND_THREADS: intStr(0, 0, 256),
  KEYPOOL_GRIND_TIMEOUT_SEC: intStr(900, 10, 86_400),
  SOLANA_KEYGEN_PATH: z.string().trim().default('solana-keygen'),

  RPC_URL: optStr,
  RPC_URL_BACKUP: optStr,
  COIN_MINT: optPubkey,
  PRIORITY_FEE_MICROLAMPORTS_MAX: intStr(200_000),
  COMPUTE_UNIT_LIMIT_SWAP: intStr(400_000, 1, 1_400_000),
  COMPUTE_UNIT_LIMIT_CLAIM: intStr(200_000, 1, 1_400_000),
  XSTOCKS_MINT_AUTHORITY: optPubkey,

  JUPITER_API_KEY: optStr,
  JUPITER_BASE_URL: z.string().trim().url().default('https://api.jup.ag'),
  JUPITER_MAX_RPM: intStr(55, 1, 100_000),

  HIRE_SPLIT_BPS: intStr(5000, 0, 10_000),
  SALARY_SOL: solStr('0.03'),
  HIRE_OVERHEAD_EST_SOL: solStr('0.0025'),
  RAT_BUFFER_SOL: solStr('0.003'),
  HIRE_MODE: z.enum(['single', 'two_step']).default('single'),
  MIN_CLAIM_SOL: solStr('0.005'),
  MIN_BURN_SOL: solStr('0.01'),
  CREATOR_RESERVE_SOL: solStr('0.05'),
  FUND_RESERVE_SOL: solStr('0.01'),
  MAX_HIRES_PER_LOOP: intStr(20, 0, 200),
  MIN_STOCK_WEIGHT_BPS: intStr(500, 0, 10_000),
  SLIPPAGE_BPS_STOCK: intStr(100, 1, 5_000),
  SLIPPAGE_BPS_COIN: intStr(150, 1, 5_000),
  MAX_PRICE_IMPACT_PCT: numStr(2),
  SPEND_CAP_SOL_PER_HOUR_HIRE: solStr('30'),
  SPEND_CAP_SOL_PER_HOUR_BURN: solStr('30'),
  SPEND_ALERT_PCT: intStr(50, 1, 100),

  CLAIM_INTERVAL_SEC: intStr(35, 1),
  // Burns: a random time 8 to 12 minutes after the last round (never a fixed public schedule), split into
  // chunks of at most BURN_CHUNK_MAX_SOL sent 3 to 8 seconds apart.
  BURN_INTERVAL_MIN_SEC: intStr(480, 1),
  BURN_INTERVAL_MAX_SEC: intStr(720, 1),
  BURN_CHUNK_MAX_SOL: solStr('1'),
  BURN_CHUNK_GAP_MIN_SEC: intStr(3, 1, 3600),
  BURN_CHUNK_GAP_MAX_SEC: intStr(8, 1, 3600),
  // rpc = normal send. jito = burns go to the Jito block engine as bundle-only transactions with a tip.
  BURN_SEND_VIA: z.enum(['rpc', 'jito']).default('rpc'),
  JITO_BLOCK_ENGINE_URL: z.string().trim().url().default('https://mainnet.block-engine.jito.wtf/api/v1'),
  JITO_TIP_SOL: solStr('0.0001'),
  PRICE_INTERVAL_SEC: intStr(15, 1),
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

  databaseUrl?: string;
  databaseUrlReadonly?: string;

  keyEncryptionKey?: string;
  keyVersion: number;
  creatorPubkey?: string;
  fundPubkey?: string;
  vanitySuffix: string;
  keypool: KeypoolConfig;

  rpcUrl?: string;
  rpcUrlBackup?: string;
  coinMint?: string;
  priorityFeeMicroLamportsMax: number;
  computeUnitLimitSwap: number;
  computeUnitLimitClaim: number;
  xstocksMintAuthority?: string;

  jupiter: { apiKey?: string; baseUrl: string; maxRpm: number };

  hireSplitBps: number;
  salaryLamports: bigint;
  hireOverheadEstLamports: bigint;
  ratBufferLamports: bigint;
  hireMode: HireMode;
  minClaimLamports: bigint;
  minBurnLamports: bigint;
  creatorReserveLamports: bigint;
  fundReserveLamports: bigint;
  maxHiresPerLoop: number;
  minStockWeightBps: number;
  slippageBpsStock: number;
  slippageBpsCoin: number;
  maxPriceImpactPct: number;
  spendCapLamportsPerHour: { hire: bigint; burn: bigint };
  spendAlertPct: number;

  /** burnMinSec..burnMaxSec: random delay between burn rounds */
  intervals: { claimSec: number; burnMinSec: number; burnMaxSec: number; priceSec: number; freezeSec: number };
  burn: BurnConfig;
  priceStaleSec: number;
  reconcileBatch: number;
  dryRunFakeClaimLamportsPerHour: bigint;

  telegram: { botToken?: string; chatId?: string };
  api: { port: number; cacheSec: number; corsOrigin: string };
  stocksFile: string;
}

export interface BurnConfig {
  /** burns above this are split into chunks of (almost) equal size */
  chunkMaxLamports: bigint;
  chunkGapMinSec: number;
  chunkGapMaxSec: number;
  sendVia: 'rpc' | 'jito';
  jitoUrl: string;
  /** Jito tip per burn transaction, paid from the burn budget (0 when sendVia = rpc) */
  jitoTipLamports: bigint;
}

export type GrinderChoice = 'auto' | 'solana-keygen' | 'js' | 'off';

export interface KeypoolConfig {
  /** background grinding starts while available keys are below this */
  refillBelow: number;
  /** ... and stops at this many available keys */
  target: number;
  /** alert when fewer keys than this are left */
  lowAlert: number;
  /** alert when the pool lasts less than this many hours at the current hire rate (0 = off) */
  runwayAlertHours: number;
  /** keys per grinder run */
  refillBatch: number;
  /** auto = solana-keygen when installed, else the built-in JS grinder */
  grinder: GrinderChoice;
  /** 0 = CPU count minus one */
  grindThreads: number;
  grindTimeoutSec: number;
  keygenPath: string;
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
  if (e.BURN_INTERVAL_MIN_SEC > e.BURN_INTERVAL_MAX_SEC) {
    throw new ConfigError('BURN_INTERVAL_MIN_SEC must be <= BURN_INTERVAL_MAX_SEC');
  }
  if (e.BURN_CHUNK_GAP_MIN_SEC > e.BURN_CHUNK_GAP_MAX_SEC) {
    throw new ConfigError('BURN_CHUNK_GAP_MIN_SEC must be <= BURN_CHUNK_GAP_MAX_SEC');
  }
  if (e.BURN_CHUNK_MAX_SOL < e.MIN_BURN_SOL) {
    throw new ConfigError('BURN_CHUNK_MAX_SOL must be >= MIN_BURN_SOL');
  }
  const jitoTip = e.BURN_SEND_VIA === 'jito' ? e.JITO_TIP_SOL : 0n;
  if (e.BURN_SEND_VIA === 'jito' && (jitoTip <= 0n || jitoTip > solToLamports('0.01'))) {
    throw new ConfigError('JITO_TIP_SOL must be above 0 and at most 0.01 when BURN_SEND_VIA=jito');
  }
  if (e.MIN_BURN_SOL <= e.HIRE_OVERHEAD_EST_SOL + jitoTip) {
    throw new ConfigError('MIN_BURN_SOL must be larger than HIRE_OVERHEAD_EST_SOL (+ JITO_TIP_SOL)');
  }
  if (e.KEYPOOL_TARGET < e.KEYPOOL_REFILL_BELOW) {
    throw new ConfigError('KEYPOOL_TARGET must be >= KEYPOOL_REFILL_BELOW');
  }

  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    dryRun: e.DRY_RUN,
    liveConfirmed: !e.DRY_RUN && e.LIVE_CONFIRM === LIVE_CONFIRM_PHRASE,
    killSwitch: e.KILL_SWITCH,
    smokeMode: e.SMOKE_MODE,
    smokeCapLamports: e.SMOKE_CAP_SOL,
    databaseUrl: e.DATABASE_URL,
    databaseUrlReadonly: e.DATABASE_URL_READONLY,
    keyEncryptionKey: e.KEY_ENCRYPTION_KEY,
    keyVersion: e.KEY_VERSION,
    creatorPubkey: e.CREATOR_PUBKEY,
    fundPubkey: e.FUND_PUBKEY,
    vanitySuffix: e.VANITY_SUFFIX,
    keypool: {
      refillBelow: e.KEYPOOL_REFILL_BELOW,
      target: e.KEYPOOL_TARGET,
      lowAlert: e.KEYPOOL_LOW_ALERT,
      runwayAlertHours: e.KEYPOOL_RUNWAY_ALERT_HOURS,
      refillBatch: e.KEYPOOL_REFILL_BATCH,
      grinder: e.KEYPOOL_GRINDER,
      grindThreads: e.KEYPOOL_GRIND_THREADS,
      grindTimeoutSec: e.KEYPOOL_GRIND_TIMEOUT_SEC,
      keygenPath: e.SOLANA_KEYGEN_PATH,
    },
    rpcUrl: e.RPC_URL,
    rpcUrlBackup: e.RPC_URL_BACKUP,
    coinMint: e.COIN_MINT,
    priorityFeeMicroLamportsMax: e.PRIORITY_FEE_MICROLAMPORTS_MAX,
    computeUnitLimitSwap: e.COMPUTE_UNIT_LIMIT_SWAP,
    computeUnitLimitClaim: e.COMPUTE_UNIT_LIMIT_CLAIM,
    xstocksMintAuthority: e.XSTOCKS_MINT_AUTHORITY,
    jupiter: { apiKey: e.JUPITER_API_KEY, baseUrl: e.JUPITER_BASE_URL.replace(/\/+$/, ''), maxRpm: e.JUPITER_MAX_RPM },
    hireSplitBps: e.HIRE_SPLIT_BPS,
    salaryLamports: e.SALARY_SOL,
    hireOverheadEstLamports: e.HIRE_OVERHEAD_EST_SOL,
    ratBufferLamports: e.RAT_BUFFER_SOL,
    hireMode: e.HIRE_MODE,
    minClaimLamports: e.MIN_CLAIM_SOL,
    minBurnLamports: e.MIN_BURN_SOL,
    creatorReserveLamports: e.CREATOR_RESERVE_SOL,
    fundReserveLamports: e.FUND_RESERVE_SOL,
    maxHiresPerLoop: e.MAX_HIRES_PER_LOOP,
    minStockWeightBps: e.MIN_STOCK_WEIGHT_BPS,
    slippageBpsStock: e.SLIPPAGE_BPS_STOCK,
    slippageBpsCoin: e.SLIPPAGE_BPS_COIN,
    maxPriceImpactPct: e.MAX_PRICE_IMPACT_PCT,
    spendCapLamportsPerHour: { hire: e.SPEND_CAP_SOL_PER_HOUR_HIRE, burn: e.SPEND_CAP_SOL_PER_HOUR_BURN },
    spendAlertPct: e.SPEND_ALERT_PCT,
    intervals: {
      claimSec: e.CLAIM_INTERVAL_SEC,
      burnMinSec: e.BURN_INTERVAL_MIN_SEC,
      burnMaxSec: e.BURN_INTERVAL_MAX_SEC,
      priceSec: e.PRICE_INTERVAL_SEC,
      freezeSec: e.FREEZE_INTERVAL_SEC,
    },
    burn: {
      chunkMaxLamports: e.BURN_CHUNK_MAX_SOL,
      chunkGapMinSec: e.BURN_CHUNK_GAP_MIN_SEC,
      chunkGapMaxSec: e.BURN_CHUNK_GAP_MAX_SEC,
      sendVia: e.BURN_SEND_VIA,
      jitoUrl: e.JITO_BLOCK_ENGINE_URL.replace(/\/+$/, ''),
      jitoTipLamports: jitoTip,
    },
    priceStaleSec: e.PRICE_STALE_SEC,
    reconcileBatch: e.RECONCILE_BATCH,
    dryRunFakeClaimLamportsPerHour: e.DRY_RUN ? e.DRY_RUN_FAKE_CLAIM_SOL_PER_HOUR : 0n,
    telegram: { botToken: e.TELEGRAM_BOT_TOKEN, chatId: e.TELEGRAM_CHAT_ID },
    api: { port: e.API_PORT, cacheSec: e.API_CACHE_SEC, corsOrigin: e.CORS_ORIGIN },
    stocksFile: e.STOCKS_FILE,
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
    coinMint: cfg.coinMint ?? null,
    creatorPubkey: cfg.creatorPubkey ?? null,
    fundPubkey: cfg.fundPubkey ?? null,
    hireMode: cfg.hireMode,
    salarySol: cfg.salaryLamports.toString(),
    hireSplitBps: cfg.hireSplitBps,
    spendCapLamportsPerHour: {
      hire: cfg.spendCapLamportsPerHour.hire.toString(),
      burn: cfg.spendCapLamportsPerHour.burn.toString(),
    },
    maxHiresPerLoop: cfg.maxHiresPerLoop,
    burnSendVia: cfg.burn.sendVia,
    keypool: { refillBelow: cfg.keypool.refillBelow, target: cfg.keypool.target, grinder: cfg.keypool.grinder },
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
export function loadStocksFile(path: string, cwd = process.cwd()): StockConfigEntry[] {
  const raw = JSON.parse(readFileSync(resolve(cwd, path), 'utf8')) as unknown;
  return parseStocks(raw);
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
