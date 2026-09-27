#!/usr/bin/env -S npx tsx
// RAT RACE operator CLI. Every command reads config from the environment (see .env.example).
import { readFileSync } from 'node:fs';
import { RpcChainReader, RpcTxSender, createConnection } from '@rat/chain';
import { type AppConfig, createLogger, loadConfig, requireConfig, systemClock } from '@rat/core';
import { Store, openDatabase } from '@rat/db';
import { DbKeyStore, MasterKeyRing } from '@rat/keys';
import { DbKillSwitch, GuardedSender, ThrottledAlerts, fanOut, logSink, telegramSink } from '@rat/safety';
import { Command } from 'commander';
import { dryRunResetCommand } from './commands/dry-run';
import { keysGrindCommand, keysImportDirCommand, keysImportRoleCommand, keysPoolCommand, keysRotateCommand } from './commands/keys';
import { killCommand, resumeCommand } from './commands/kill';
import { ledgerShowCommand } from './commands/ledger';
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

program.command('status').description('mode, kill switch, buckets, caps, key pool, rats, loops').action(() => withContext((ctx) => statusCommand(ctx)));
program.command('kill').description('engage the kill switch').option('-r, --reason <text>', 'reason', 'manual').action((o) => withContext((ctx) => killCommand(ctx, o.reason)));
program.command('resume').description('release the database kill switch').action(() => withContext((ctx) => resumeCommand(ctx)));

const keys = program.command('keys').description('key management');
keys
  .command('import')
  .description('import the creator or fund private key from stdin (encrypted at rest)')
  .requiredOption('--role <role>', 'creator | fund')
  .option('--replace', 'replace an existing key')
  .action((o) =>
    withContext(async (ctx, cfg) => {
      if (o.role !== 'creator' && o.role !== 'fund') throw new Error('--role must be creator or fund');
      await keysImportRoleCommand(ctx, ring(cfg), o.role, await readStdin(), { replace: Boolean(o.replace) });
    }),
  );
keys
  .command('import-dir <dir>')
  .description('import solana-keygen grind files (verified, encrypted, then shredded)')
  .option('--no-shred', 'keep the files')
  .action((dir, o) => withContext((ctx, cfg) => keysImportDirCommand(ctx, ring(cfg), dir, { shred: o.shred })));
keys
  .command('grind')
  .description('grind vanity rat keys with the built-in grinder')
  .requiredOption('--count <n>', 'number of keys', (v) => Number(v))
  .option('--threads <n>', 'worker threads', (v) => Number(v))
  .action((o) => withContext((ctx, cfg) => keysGrindCommand(ctx, ring(cfg), o.count, o.threads)));
keys.command('pool').description('key pool counts').action(() => withContext((ctx) => keysPoolCommand(ctx)));
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
      const keyStore = new DbKeyStore(ctx.store.keys, ring(cfg), { expectedCreator: cfg.creatorPubkey, expectedFund: cfg.fundPubkey });
      await sweepCommand(ctx, { chain, keys: keyStore, sender }, { to: o.to, confirm: o.confirm, limit: o.limit });
    }),
  );

program.parseAsync().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
