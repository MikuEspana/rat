import { loadStocksFile } from '@rat/core';
import type { CliContext } from '../context';

export async function stocksSyncCommand(ctx: CliContext, cwd = process.cwd()): Promise<void> {
  const entries = loadStocksFile(ctx.config.stocksFile, cwd);
  await ctx.store.stocks.syncConfig(entries);
  for (const s of await ctx.store.stocks.list()) {
    ctx.out(`${s.symbol.padEnd(7)} enabled=${s.enabled} approved=${s.approved} verified=${s.verified}${s.verifyError ? ` (${s.verifyError})` : ''}`);
  }
}
