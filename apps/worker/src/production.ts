// Production wiring (RPC, Jupiter, Postgres, encrypted keys, Telegram). Shared by main.ts and the smoke test.
import { RpcChainReader, RpcTxSender, createConnection } from '@rat/chain';
import { type AppConfig, type Logger, loadStocksFile, requireConfig, systemClock, systemRng } from '@rat/core';
import { type DbHandle, Store, openDatabase } from '@rat/db';
import { JupiterHttp, JupiterPriceSource, JupiterSwapBuilder, SlidingWindowLimiter } from '@rat/jupiter';
import { DbKeyStore, KeyPoolRefiller, MasterKeyRing } from '@rat/keys';
import { PumpDirectBuyBuilder, PumpFunClient, sdkBuyApi } from '@rat/pump';
import { DbKillSwitch, GuardedSender, SpendGuard, ThrottledAlerts, fanOut, logSink, telegramSink } from '@rat/safety';
import type { WorkerDeps } from './deps';

export const REPO_ROOT = new URL('../../..', import.meta.url).pathname;

export async function createProductionDeps(cfg: AppConfig, log: Logger): Promise<{ deps: WorkerDeps; handle: DbHandle }> {
  requireConfig(cfg, ['databaseUrl', 'keyEncryptionKey', 'rpcUrl', 'creatorPubkey', 'fundPubkey']);
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

  const kp = cfg.keypool;
  const keyRefiller = new KeyPoolRefiller(
    {
      pool: store.keys,
      ring,
      log,
      onResult: async (r) => {
        if (r.error) await alerts.send('warn', 'keypool_grinder_error', `Key grinder (${r.grinder}) failed: ${r.error}`);
      },
    },
    {
      suffix: cfg.vanitySuffix,
      refillBelow: kp.refillBelow,
      target: kp.target,
      batch: kp.refillBatch,
      grinder: kp.grinder,
      threads: kp.grindThreads,
      timeoutMs: kp.grindTimeoutSec * 1000,
      keygenPath: kp.keygenPath,
    },
  );
  const grinder = keyRefiller.grinderKind();
  log.info({ grinder, threads: kp.grindThreads || 'auto', solanaKeygen: kp.grinder === 'solana-keygen' ? keyRefiller.keygenInfo() : 'not used' }, 'key pool grinder');
  if (kp.grinder === 'solana-keygen' && grinder === 'js') {
    await alerts.send('warn', 'keypool_keygen_missing', `KEYPOOL_GRINDER=solana-keygen but "${kp.keygenPath}" does not work: the worker refills with the built-in grinder.`);
  }

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
    keyRefiller,
  };
  return { deps, handle };
}
