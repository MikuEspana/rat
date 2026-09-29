// Production wiring (RPC, Jupiter, Postgres, encrypted keys, Telegram). Shared by main.ts and the smoke test.
import { RpcChainReader, RpcTxSender, createConnection } from '@rat/chain';
import { type AppConfig, type Logger, loadStocksFile, requireConfig, sleep, systemClock, systemRng } from '@rat/core';
import { type DbHandle, Store, openDatabase } from '@rat/db';
import { BudgetedPriceSource, BudgetedSwapBuilder, JupiterHttp, JupiterPriceSource, JupiterSwapBuilder } from '@rat/jupiter';
import { DbKeyStore, MasterKeyRing } from '@rat/keys';
import { PumpFunClient } from '@rat/pump';
import { DbKillSwitch, GuardedSender, SpendGuard, ThrottledAlerts, creatorCoinTokens, fanOut, logSink, telegramSink } from '@rat/safety';
import type { WorkerDeps } from './deps';
import { createJupiterBudget } from './jupiter-budget';

export const REPO_ROOT = new URL('../../..', import.meta.url).pathname;

/**
 * A fresh setup starts the worker before the creator key exists (it is imported inside the running worker), so the
 * worker waits here, doing nothing, instead of crash-looping. Only the missing key waits: a wrong key still fails.
 */
export async function waitForCreatorKey(store: Store, log: Logger, pause: (ms: number) => Promise<void> = sleep): Promise<void> {
  if (await store.keys.getRole('creator')) return;
  log.warn('no creator key imported yet: waiting, nothing runs until then. Import it with: rat keys import --role creator');
  while (!(await store.keys.getRole('creator'))) await pause(10_000);
  log.info('creator key imported: starting');
}

export async function createProductionDeps(
  cfg: AppConfig,
  log: Logger,
  opts: {
    /** the long-running worker starts with its Jupiter budget spent (a restart loop never bursts); a one-shot run does not */
    jupiterStartEmpty?: boolean;
    /**
     * the long-running worker waits, doing nothing, until the creator key is imported (a fresh setup imports it
     * inside the running worker with `rat keys import`); a one-shot run fails right away instead
     */
    waitForCreatorKey?: boolean;
  } = {},
): Promise<{ deps: WorkerDeps; handle: DbHandle }> {
  requireConfig(cfg, ['databaseUrl', 'keyEncryptionKey', 'rpcUrl', 'creatorPubkey']);
  if (!cfg.jupiter.apiKey) throw new Error('JUPITER_API_KEY is required (free key at portal.jup.ag)');

  const handle = await openDatabase(cfg.databaseUrl!);
  await handle.migrate();
  const store = new Store(handle.db, cfg.dryRun ? 'paper' : 'live', systemClock);
  const stocks = loadStocksFile(cfg.stocksFile, REPO_ROOT);
  await store.stocks.syncConfig(stocks);

  const conn = createConnection(cfg.rpcUrl!);
  const chain = new RpcChainReader(conn, cfg.rpcUrlBackup ? createConnection(cfg.rpcUrlBackup) : undefined);
  const killSwitch = new DbKillSwitch(store.settings, cfg.killSwitch);
  const sinks = [logSink(log)];
  if (cfg.telegram.botToken && cfg.telegram.chatId) sinks.push(telegramSink({ botToken: cfg.telegram.botToken, chatId: cfg.telegram.chatId, log }));
  const alerts = new ThrottledAlerts(fanOut(...sinks), systemClock);
  const sender = new GuardedSender(
    new RpcTxSender(conn, {
      dryRun: cfg.dryRun,
      liveConfirmed: cfg.liveConfirmed,
      priorityFeeMaxMicroLamports: cfg.priorityFeeMicroLamportsMax,
      log,
    }),
    { attempts: store.attempts, killSwitch, dryRun: cfg.dryRun, log, alerts, protectedTokens: creatorCoinTokens(cfg.creatorPubkey, cfg.coinMint) },
  );
  const guard = new SpendGuard(
    { ledger: store.ledger, killSwitch, alerts, clock: systemClock, chain },
    {
      capPerHour: cfg.spendCapLamportsPerHour,
      alertPct: cfg.spendAlertPct,
      wallets: { hire: cfg.creatorPubkey },
      reserves: { hire: cfg.creatorReserveLamports },
      smokeMode: cfg.smokeMode,
      smokeCap: cfg.smokeCapLamports,
      checkWallets: !cfg.dryRun,
    },
  );
  const ring = new MasterKeyRing({ version: cfg.keyVersion, base64: cfg.keyEncryptionKey! });
  const keys = new DbKeyStore(store.keys, ring, { expectedCreator: cfg.creatorPubkey });
  if (opts.waitForCreatorKey) await waitForCreatorKey(store, log);
  await keys.creator(); // a missing, wrong or undecryptable key still stops the worker here

  // Every Jupiter request goes through the one budget (no limiter or retries inside the HTTP client): at most
  // JUPITER_MAX_RPM (40) a minute. For the worker it starts spent, so a restarting worker never bursts.
  const http = new JupiterHttp({ baseUrl: cfg.jupiter.baseUrl, apiKey: cfg.jupiter.apiKey, maxRetries: 0 });
  const jupiter = createJupiterBudget(cfg, () => Date.now(), alerts, { startEmpty: opts.jupiterStartEmpty ?? true });
  const deps: WorkerDeps = {
    config: cfg,
    store,
    clock: systemClock,
    rng: systemRng,
    log,
    chain,
    sender,
    guard,
    keys,
    pump: new PumpFunClient(chain),
    prices: new BudgetedPriceSource(new JupiterPriceSource(http), jupiter),
    swap: new BudgetedSwapBuilder(new JupiterSwapBuilder(http), jupiter),
    jupiter,
    alerts,
    killSwitch,
    stocks,
    creator: cfg.creatorPubkey!,
  };
  return { deps, handle };
}
