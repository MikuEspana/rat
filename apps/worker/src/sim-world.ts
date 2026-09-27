// A complete in-memory world for tests and simulations: PGlite database, SimChain (with the real pump.fun
// claim handlers and a mock Jupiter swap), mock prices, test keypairs, and the real worker steps, safety,
// ledger and key store on top. No network, nothing can reach mainnet.
import { randomBytes } from 'node:crypto';
import {
  FakeClock,
  LIVE_CONFIRM_PHRASE,
  NATIVE_SOL_MINT,
  SeededRng,
  type StockConfigEntry,
  TOKEN_2022_PROGRAM,
  loadConfig,
  silentLogger,
} from '@rat/core';
import { SimChain, SimChainReader, SimTxSender } from '@rat/chain/sim';
import { type DbHandle, Store, openMemoryDatabase } from '@rat/db';
import { MockPriceSource, MockSwapBuilder, registerMockSwapProgram } from '@rat/jupiter/mock';
import { DbKeyStore, MasterKeyRing, encryptRoleKey, storeRatKeys } from '@rat/keys';
import { PumpFunClient } from '@rat/pump';
import { accrueCreatorFees, registerPumpSimPrograms } from '@rat/pump/sim';
import { DbKillSwitch, GuardedSender, RecordingAlerts, SpendGuard } from '@rat/safety';
import { Keypair } from '@solana/web3.js';
import type { WorkerDeps } from './deps';
import { type Worker, createWorker } from './worker';

export const SOL = 1_000_000_000n;

export interface SimStockSpec {
  symbol: string;
  priceUsd: number;
  change24hPct: number;
  vol?: number;
  approved?: boolean;
  /** give this mint a different mint authority (fails verification) */
  foreignAuthority?: boolean;
  /** SPL Token instead of Token-2022 (fails verification) */
  legacyProgram?: boolean;
}

export const DEFAULT_STOCKS: SimStockSpec[] = [
  { symbol: 'TSLAx', priceUsd: 412.33, change24hPct: 6.2, vol: 0.004 },
  { symbol: 'MSTRx', priceUsd: 338.1, change24hPct: -4.8, vol: 0.005 },
  { symbol: 'COINx', priceUsd: 291.55, change24hPct: 3.1, vol: 0.004 },
  { symbol: 'AMDx', priceUsd: 164.2, change24hPct: 2.4, vol: 0.003 },
  { symbol: 'NVDAx', priceUsd: 181.75, change24hPct: 1.7, vol: 0.003 },
  { symbol: 'AAPLx', priceUsd: 238.9, change24hPct: 0.4, vol: 0.001 },
  { symbol: 'METAx', priceUsd: 742.15, change24hPct: -0.9, vol: 0.0015 },
  { symbol: 'AMZNx', priceUsd: 228.4, change24hPct: 0.8, vol: 0.0015 },
  { symbol: 'GOOGLx', priceUsd: 251.6, change24hPct: -0.3, vol: 0.0015 },
  { symbol: 'SPYx', priceUsd: 663.05, change24hPct: 0.2, vol: 0.0008 },
];

export interface SimWorldOptions {
  dryRun?: boolean;
  env?: Record<string, string>;
  stocks?: SimStockSpec[];
  solUsd?: number;
  coinUsd?: number;
  ratKeys?: number;
  seed?: number;
  /** starting SOL of the creator and fund wallets (their own money, never spent by the bot) */
  creatorSol?: bigint;
  fundSol?: bigint;
  spreadBps?: number;
}

export interface SimWorld {
  handle: DbHandle;
  clock: FakeClock;
  rng: SeededRng;
  chain: SimChain;
  reader: SimChainReader;
  simSender: SimTxSender;
  store: Store;
  deps: WorkerDeps;
  worker: Worker;
  alerts: RecordingAlerts;
  prices: MockPriceSource;
  swap: MockSwapBuilder;
  creator: Keypair;
  fund: Keypair;
  xstocksAuthority: Keypair;
  stockMints: Map<string, string>;
  coinMint: string;
  /** trading volume paying creator fees into our vaults */
  accrue(fees: { bondingLamports?: bigint; ammLamports?: bigint }): void;
  /** advances time by `seconds` in `stepSec` ticks, walking prices and running the worker each tick */
  run(seconds: number, opts?: { stepSec?: number; onTick?: (t: number) => void | Promise<void> }): Promise<void>;
  close(): Promise<void>;
}

export async function createSimWorld(opts: SimWorldOptions = {}): Promise<SimWorld> {
  const dryRun = opts.dryRun ?? true;
  const handle = await openMemoryDatabase();
  const clock = new FakeClock('2026-10-01T12:00:00Z');
  const rng = new SeededRng(opts.seed ?? 42);
  const chain = new SimChain();
  registerPumpSimPrograms(chain);
  registerMockSwapProgram(chain);
  const reader = new SimChainReader(chain);
  const simSender = new SimTxSender(chain);

  const creator = Keypair.generate();
  const fund = Keypair.generate();
  const xstocksAuthority = Keypair.generate();
  const coinMint = Keypair.generate().publicKey.toBase58();
  const masterKey = randomBytes(32).toString('base64');

  const config = loadConfig({
    DRY_RUN: dryRun ? 'true' : 'false',
    LIVE_CONFIRM: dryRun ? '' : LIVE_CONFIRM_PHRASE,
    COIN_MINT: coinMint,
    CREATOR_PUBKEY: creator.publicKey.toBase58(),
    FUND_PUBKEY: fund.publicKey.toBase58(),
    KEY_ENCRYPTION_KEY: masterKey,
    VANITY_SUFFIX: '',
    KEYPOOL_MIN: '0',
    KEYPOOL_TARGET: '0',
    ...opts.env,
  });

  const store = new Store(handle.db, dryRun ? 'paper' : 'live', clock);
  const ring = new MasterKeyRing({ version: 1, base64: masterKey });
  await store.keys.setRoleKey(encryptRoleKey(creator, ring, 'creator'));
  await store.keys.setRoleKey(encryptRoleKey(fund, ring, 'fund'));
  await storeRatKeys(store.keys, ring, Array.from({ length: opts.ratKeys ?? 200 }, () => Keypair.generate()));
  chain.fundAccount(creator.publicKey.toBase58(), opts.creatorSol ?? SOL / 10n);
  chain.fundAccount(fund.publicKey.toBase58(), opts.fundSol ?? SOL / 50n);

  const prices = new MockPriceSource();
  prices.set(NATIVE_SOL_MINT, opts.solUsd ?? 185.4, { vol: 0.002, change24hPct: 1.2 });
  const tokens = new Map<string, { decimals: number; program: string }>();
  const stockMints = new Map<string, string>();
  const entries: StockConfigEntry[] = [];
  for (const spec of opts.stocks ?? DEFAULT_STOCKS) {
    const mint = Keypair.generate().publicKey.toBase58();
    const program = spec.legacyProgram ? 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' : TOKEN_2022_PROGRAM;
    chain.createMint({
      mint,
      decimals: 8,
      tokenProgram: program,
      mintAuthority: spec.foreignAuthority ? Keypair.generate().publicKey.toBase58() : xstocksAuthority.publicKey.toBase58(),
      hasPermanentDelegate: true,
      supply: 1_000_000_000_000n,
    });
    tokens.set(mint, { decimals: 8, program });
    stockMints.set(spec.symbol, mint);
    prices.set(mint, spec.priceUsd, { vol: spec.vol ?? 0.002, change24hPct: spec.change24hPct });
    entries.push({ symbol: spec.symbol, name: spec.symbol, mint, group: 'volatile', enabled: true, approved: spec.approved ?? true });
  }
  chain.createMint({ mint: coinMint, decimals: 6, tokenProgram: TOKEN_2022_PROGRAM, supply: 1_000_000_000_000_000n });
  tokens.set(coinMint, { decimals: 6, program: TOKEN_2022_PROGRAM });
  prices.set(coinMint, opts.coinUsd ?? 0.00182, { vol: 0.01, change24hPct: 12 });
  await store.stocks.syncConfig(entries);

  const swap = new MockSwapBuilder(prices, { tokens, spreadBps: opts.spreadBps ?? 50 });
  const alerts = new RecordingAlerts();
  const killSwitch = new DbKillSwitch(store.settings, config.killSwitch);
  const sender = new GuardedSender(simSender, { attempts: store.attempts, killSwitch, dryRun: config.dryRun });
  const guard = new SpendGuard(
    { ledger: store.ledger, killSwitch, alerts, clock, chain: reader, pendingFundTransfer: () => store.claims.pendingFundTransfer() },
    {
      capPerHour: config.spendCapLamportsPerHour,
      alertPct: config.spendAlertPct,
      wallets: { hire: creator.publicKey.toBase58(), burn: fund.publicKey.toBase58() },
      reserves: { hire: config.creatorReserveLamports, burn: config.fundReserveLamports },
      smokeMode: config.smokeMode,
      smokeCap: config.smokeCapLamports,
      checkWallets: !config.dryRun,
    },
  );
  const deps: WorkerDeps = {
    config,
    store,
    clock,
    rng,
    log: silentLogger(),
    chain: reader,
    sender,
    guard,
    keys: new DbKeyStore(store.keys, ring, { expectedCreator: config.creatorPubkey, expectedFund: config.fundPubkey }),
    pump: new PumpFunClient(reader),
    prices,
    swap,
    alerts,
    killSwitch,
    stocks: entries,
    creator: creator.publicKey.toBase58(),
    fund: fund.publicKey.toBase58(),
  };
  const worker = createWorker(deps);

  return {
    handle,
    clock,
    rng,
    chain,
    reader,
    simSender,
    store,
    deps,
    worker,
    alerts,
    prices,
    swap,
    creator,
    fund,
    xstocksAuthority,
    stockMints,
    coinMint,
    accrue: (fees) => accrueCreatorFees(chain, creator.publicKey.toBase58(), fees),
    async run(seconds, o = {}) {
      const step = o.stepSec ?? 5;
      for (let t = 0; t < seconds; t += step) {
        await worker.tick();
        await o.onTick?.(t);
        clock.advanceSeconds(step);
        prices.step(rng);
      }
    },
    close: () => handle.close(),
  };
}
