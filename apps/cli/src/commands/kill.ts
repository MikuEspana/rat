import { engageKillSwitch, releaseKillSwitch } from '@rat/safety';
import type { CliContext } from '../context';

export async function killCommand(ctx: CliContext, reason: string): Promise<void> {
  await engageKillSwitch(ctx.store.settings, reason || 'manual kill from CLI');
  ctx.out('Kill switch ON. No new transactions will be prepared or sent. Resume with: rat resume');
}

export async function resumeCommand(ctx: CliContext): Promise<void> {
  if (ctx.config.killSwitch) {
    ctx.out('The KILL_SWITCH env var is true: change it in the host config to resume.');
    return;
  }
  await releaseKillSwitch(ctx.store.settings);
  ctx.out('Kill switch OFF.');
}
