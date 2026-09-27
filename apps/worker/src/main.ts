// Production entrypoint. DRY_RUN=true by default: every transaction is built, signed and SIMULATED, never sent.
// Sending needs DRY_RUN=false AND LIVE_CONFIRM=<exact phrase> (enforced by config and again by the sender).
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { RpcChainReader, RpcTxSender, createConnection } from '@rat/chain';
import {
  createLogger,
  loadConfig,
  loadStocksFile,
  publicConfigSummary,
  requireConfig,
  sleep,
  systemClock,
  systemRng,
} from '@rat/core';
import { Store, openDatabase } from '@rat/db';
import { JupiterHttp, JupiterPriceSource, JupiterSwapBuilder, SlidingWindowLimiter } from '@rat/jupiter';
import { DbKeyStore, MasterKeyRing, refillKeyPool } from '@rat/keys';
import { PumpDirectBuyBuilder, PumpFunClient, sdkBuyApi } from '@rat/pump';
import { DbKillSwitch, GuardedSender, SpendGuard, ThrottledAlerts, fanOut, logSink, telegramSink } from '@rat/safety';
import type { WorkerDeps } from './deps';
import { LockedRunner, createWorker } from './worker';

const REPO_ROOT = new URL('../../..', import.meta.url).pathname;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger({ level: cfg.logLevel, name: 'rat-worker' });
  requireConfig(cfg, ['databaseUrl', 'keyEncryptionKey', 'rpcUrl', 'creatorPubkey', 'fundPubkey']);
  if (!cfg.jupiter.apiKey) throw new Error('JUPITER_API_KEY is required (free key at portal.jup.ag)');
  log.info(publicConfigSummary(cfg), cfg.dryRun ? 'starting in DRY RUN: nothing will be sent' : 'starting LIVE: transactions will be sent');

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
    new RpcTxSender(conn, { dryRun: cfg.dryRun, liveConfirmed: cfg.liveConfirmed, priorityFeeMaxMicroLamports: cfg.priorityFeeMicroLamportsMax, log }),
    { attempts: store.attempts, killSwitch, dryRun: cfg.dryRun, log },
  );
  const guard = new SpendGuard(
    { ledger: store.ledger, killSwitch, alerts, clock: systemClock, chain, pendingFundTransfer: () => store.claims.pendingFundTransfer() },
    {
      capPerHour: cfg.spendCapLamportsPerHour,
      alertPct: cfg.spendAlertPct,
      wallets: { hire: cfg.creatorPubkey, burn: cfg.fundPubkey },
      reserves: { hire: cfg.creatorReserveLamports, burn: cfg.fundReserveLamports },
      smokeMode: cfg.smokeMode,
      smokeCap: cfg.smokeCapLamports,
      checkWallets: !cfg.dryRun,
    },
  );
  const ring = new MasterKeyRing({ version: cfg.keyVersion, base64: cfg.keyEncryptionKey! });
  const keys = new DbKeyStore(store.keys, ring, { expectedCreator: cfg.creatorPubkey, expectedFund: cfg.fundPubkey });
  await keys.creator();
  await keys.fund();

  const http = new JupiterHttp({ baseUrl: cfg.jupiter.baseUrl, apiKey: cfg.jupiter.apiKey, limiter: new SlidingWindowLimiter(cfg.jupiter.maxRpm) });
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
    prices: new JupiterPriceSource(http),
    swap: new JupiterSwapBuilder(http),
    fallbackSwap: (coin) => new PumpDirectBuyBuilder(sdkBuyApi(conn), coin),
    alerts,
    killSwitch,
    stocks,
    creator: cfg.creatorPubkey!,
    fund: cfg.fundPubkey!,
    refillKeys: cfg.vanitySuffix
      ? () => refillKeyPool(store.keys, ring, { min: cfg.keypoolMin, target: cfg.keypoolTarget, suffix: cfg.vanitySuffix, maxBatch: 20, timeoutMs: 20_000 })
      : undefined,
  };
  const runner = new LockedRunner(createWorker(deps), {
    store,
    clock: systemClock,
    holder: `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`,
  });

  let stopping = false;
  const stop = () => {
    stopping = true;
    log.info('stopping after the current tick');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  let waitingLogged = false;
  while (!stopping) {
    const ran = await runner.tryTick().catch((err) => {
      log.error({ err }, 'tick failed');
      return true;
    });
    if (!ran && !waitingLogged) {
      log.warn('another worker holds the lock; waiting');
      waitingLogged = true;
    }
    if (ran) waitingLogged = false;
    await sleep(1_000);
  }
  await runner.release();
  await handle.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
