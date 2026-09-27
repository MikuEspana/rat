import type { CliContext } from '../context';

export async function dryRunResetCommand(ctx: CliContext, yes: boolean): Promise<void> {
  if (!yes) {
    ctx.out('This deletes every DRY RUN (paper) rat, claim, burn, ledger entry and event, and returns paper rat keys to the pool. Live rows are never touched. Re-run with --yes.');
    return;
  }
  const r = await ctx.store.resetPaper();
  ctx.out(`paper data reset: ${r.rats} paper rats removed, ${r.keysRetired} paper wallets retired (never reused).`);
}
