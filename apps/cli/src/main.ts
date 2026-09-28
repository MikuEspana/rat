#!/usr/bin/env -S npx tsx
// RAT RACE operator CLI. Every command reads config from the environment (see .env.example).
import { readFileSync } from 'node:fs';
import { RpcChainReader, RpcTxSender, createConnection } from '@rat/chain';
import { type AppConfig, NATIVE_SOL_MINT, createLogger, loadConfig, requireConfig, systemClock } from '@rat/core';
import { JupiterHttp, JupiterPriceSource, SlidingWindowLimiter } from '@rat/jupiter';
import { Store, openDatabase } from '@rat/db';
import { DbKeyStore, MasterKeyRing } from '@rat/keys';
import { DbKillSwitch, GuardedSender, ThrottledAlerts, fanOut, logSink, telegramSink } from '@rat/safety';
import { Command } from 'commander';
import { dryRunResetCommand } from './commands/dry-run';
import { keysBackupCommand, keysImportRoleCommand, keysRestoreCommand, keysRotateCommand, verifyKeyRecords } from './commands/keys';
import { killCommand, resumeCommand } from './commands/kill';
import { ledgerShowCommand } from './commands/ledger';
import { printPreflight, runPreflightChecks, telegramCheck } from './commands/preflight';
import { statusCommand } from './commands/status';
import { stocksSyncCommand } from './commands/stocks';
import { sweepCommand } from './commands/sweep';
import type { CliContext } from './context';

async function withContext(fn: (ctx: CliContext, cfg: AppConfig) => Promise<void>): Promise<void> {
  const config = loadConfig();
  requireConfig(config, ['databaseUrl']);
  const handle = await openDatabase(config.databaseUrl!);
  await handle.migrate();
  const store = new Store(handle.db, config.dryRun ? 'paper' : 'live', systemClock);
  try {
    await fn({ config, store, clock: systemClock, out: (l) => console.log(l) }, config);
  } finally {
    await handle.close();
  }
}

function ring(cfg: AppConfig): MasterKeyRing {
  requireConfig(cfg, ['keyEncryptionKey']);
  return new MasterKeyRing({ version: cfg.keyVersion, base64: cfg.keyEncryptionKey! });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write('Paste the private key (base58 or JSON array), then press Ctrl-D:\n');
  return readFileSync(0, 'utf8');
}

const program = new Command().name('rat').description('RAT RACE operator CLI');

program.command('status').description('mode, kill switch, buckets, caps, keys, rats, loops').action(() => withContext((ctx) => statusCommand(ctx)));
program.command('kill').description('engage the kill switch').option('-r, --reason <text>', 'reason', 'manual').action((o) => withContext((ctx) => killCommand(ctx, o.reason)));
program.command('resume').description('release the database kill switch').action(() => withContext((ctx) => resumeCommand(ctx)));

const keys = program.command('keys').description('key management');
keys
  .command('import')
  .description('import the creator private key from stdin (encrypted at rest)')
  .option('--role <role>', 'creator (the only key the bot holds besides rat wallets)', 'creator')
  .option('--replace', 'replace an existing key')
  .action((o) =>
    withContext(async (ctx, cfg) => {
      if (o.role !== 'creator') throw new Error('--role must be creator (there is no fund wallet: buy and burn was removed)');
      await keysImportRoleCommand(ctx, ring(cfg), o.role, await readStdin(), { replace: Boolean(o.replace) });
    }),
  );
keys
  .command('rotate')
  .description('re-encrypt every key under the current KEY_ENCRYPTION_KEY (needs KEY_ENCRYPTION_KEY_PREVIOUS + KEY_VERSION_PREVIOUS)')
  .action(() =>
    withContext(async (ctx, cfg) => {
      requireConfig(cfg, ['keyEncryptionKey']);
      const prev = process.env.KEY_ENCRYPTION_KEY_PREVIOUS;
      const prevVersion = Number(process.env.KEY_VERSION_PREVIOUS);
      if (!prev || !Number.isInteger(prevVersion)) throw new Error('set KEY_ENCRYPTION_KEY_PREVIOUS and KEY_VERSION_PREVIOUS');
      if (prevVersion === cfg.keyVersion) throw new Error('KEY_VERSION must differ from KEY_VERSION_PREVIOUS');
      const r = new MasterKeyRing({ version: cfg.keyVersion, base64: cfg.keyEncryptionKey! }, [{ version: prevVersion, base64: prev }]);
      await keysRotateCommand(ctx, r);
    }),
  );

keys
  .command('backup')
  .description('write every stored key (rat wallets, creator) to a file, still encrypted; every key is checked first')
  .requiredOption('--out <file>', 'backup file (created 0600, never overwritten without --force)')
  .option('--force', 'overwrite an existing file')
  .action((o) => withContext(async (ctx, cfg) => void (await keysBackupCommand(ctx, ring(cfg), o.out, { force: Boolean(o.force) }))));
keys
  .command('restore')
  .description('restore keys from a backup file (every key must decrypt with KEY_ENCRYPTION_KEY; existing keys are kept)')
  .requiredOption('--in <file>', 'backup file')
  .action((o) => withContext(async (ctx, cfg) => void (await keysRestoreCommand(ctx, ring(cfg), o.in))));

program
  .command('ledger')
  .description('ledger balances and recent entries')
  .option('--limit <n>', 'entries', (v) => Number(v), 30)
  .action((o) => withContext((ctx) => ledgerShowCommand(ctx, o.limit)));
program
  .command('dry-run-reset')
  .description('delete all DRY RUN paper data')
  .option('--yes', 'really delete')
  .action((o) => withContext((ctx) => dryRunResetCommand(ctx, Boolean(o.yes))));
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
program.command('stocks-sync').description('load config/stocks.json into the database').action(() => withContext((ctx) => stocksSyncCommand(ctx, REPO_ROOT)));
program
  .command('alert-test')
  .description('send a test alert')
  .action(() =>
    withContext(async (ctx, cfg) => {
      const log = createLogger({ level: cfg.logLevel });
      const sinks = [logSink(log)];
      if (cfg.telegram.botToken && cfg.telegram.chatId) sinks.push(telegramSink({ botToken: cfg.telegram.botToken, chatId: cfg.telegram.chatId, log }));
      await new ThrottledAlerts(fanOut(...sinks), ctx.clock, 0).send('info', 'alert_test', 'test alert from the RAT RACE CLI');
      ctx.out(cfg.telegram.botToken ? 'sent to Telegram and the log' : 'TELEGRAM_BOT_TOKEN not set: logged only');
    }),
  );
program
  .command('sweep')
  .description('EMERGENCY: move every live rat token + SOL to a cold wallet (typed confirmation required)')
  .requiredOption('--to <address>', 'cold wallet')
  .option('--confirm <phrase>', 'exact phrase printed by the plan')
  .option('--limit <n>', 'only the first n rats', (v) => Number(v))
  .action((o) =>
    withContext(async (ctx, cfg) => {
      requireConfig(cfg, ['rpcUrl']);
      const conn = createConnection(cfg.rpcUrl!);
      const chain = new RpcChainReader(conn, cfg.rpcUrlBackup ? createConnection(cfg.rpcUrlBackup) : undefined);
      const inner = new RpcTxSender(conn, { dryRun: cfg.dryRun, liveConfirmed: cfg.liveConfirmed, priorityFeeMaxMicroLamports: cfg.priorityFeeMicroLamportsMax });
      const sender = new GuardedSender(inner, { attempts: ctx.store.attempts, killSwitch: new DbKillSwitch(ctx.store.settings, cfg.killSwitch), dryRun: cfg.dryRun });
      const keyStore = new DbKeyStore(ctx.store.keys, ring(cfg), { expectedCreator: cfg.creatorPubkey });
      await sweepCommand(ctx, { chain, keys: keyStore, sender }, { to: o.to, confirm: o.confirm, limit: o.limit });
    }),
  );

program
  .command('preflight')
  .description('PASS / WARN / FAIL for every launch check (read-only, never sends). Exit code 1 if anything FAILs.')
  .option('--live', 'check for a live start: DRY RUN still on, no watch floor, kill switch on or no Telegram become FAIL')
  .action(async (o) => {
    const out = (l: string) => console.log(l);
    let cfg: AppConfig;
    try {
      cfg = loadConfig();
    } catch (err) {
      out(`FAIL  config  ${(err as Error).message}`);
      out('');
      out('NOT READY: fix the configuration first.');
      process.exitCode = 1;
      return;
    }
    let handle: Awaited<ReturnType<typeof openDatabase>> | null = null;
    let store: Store | null = null;
    let dbError: string | undefined;
    if (cfg.databaseUrl) {
      try {
        handle = await openDatabase(cfg.databaseUrl);
        await handle.migrate();
        store = new Store(handle.db, cfg.dryRun ? 'paper' : 'live', systemClock);
      } catch (err) {
        dbError = (err as Error).message;
      }
    }
    try {
      // each endpoint on its own (no failover), so a dead primary shows up
      const chain = cfg.rpcUrl ? new RpcChainReader(createConnection(cfg.rpcUrl)) : null;
      const backupChain = cfg.rpcUrlBackup ? new RpcChainReader(createConnection(cfg.rpcUrlBackup)) : null;
      const keys = store && cfg.keyEncryptionKey ? new DbKeyStore(store.keys, ring(cfg), { expectedCreator: cfg.creatorPubkey }) : null;
      const http = new JupiterHttp({ baseUrl: cfg.jupiter.baseUrl, apiKey: cfg.jupiter.apiKey, limiter: new SlidingWindowLimiter(cfg.jupiter.maxRpm), maxRetries: 1 });
      const lines = await runPreflightChecks(
        {
          config: cfg,
          store,
          dbError,
          chain,
          backupChain,
          keys,
          jupiterSolPrice: async () => {
            const q = (await new JupiterPriceSource(http).getPrices([NATIVE_SOL_MINT])).get(NATIVE_SOL_MINT);
            if (!q) throw new Error('no SOL price in the answer');
            return q.usdPrice;
          },
          telegram: () => telegramCheck(cfg.telegram.botToken ?? '', cfg.telegram.chatId ?? ''),
          ratKeys:
            store && cfg.keyEncryptionKey
              ? async () => {
                  const records = (await store!.keys.all()).filter((r) => r.role === 'rat');
                  const have = new Set(records.map((r) => r.pubkey));
                  const rats = await store!.rats.listByStatus(['hiring', 'active', 'frozen', 'failed']);
                  return { total: records.length, bad: verifyKeyRecords(records, ring(cfg)).bad.length, ratsWithoutKey: rats.filter((r) => !have.has(r.wallet)).length };
                }
              : undefined,
          now: () => Date.now(),
        },
        { live: Boolean(o.live) },
      );
      const title = `RAT RACE preflight (${cfg.dryRun ? 'DRY RUN' : 'LIVE'}${o.live ? ', checking for a live start' : ''})`;
      if (!printPreflight(lines, out, title)) process.exitCode = 1;
    } finally {
      await handle?.close();
    }
  });

program.parseAsync().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
