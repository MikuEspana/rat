// Armed launch: the worker goes LIVE before the coin exists, with the kill switch ON (rat launch-arm). The owner
// launches on pump.fun from the creator wallet, then ONE call (rat launch-register) records the launch as the
// owner's (the wallet watch accepts its signatures) and releases the kill switch: founding rats are hired in the next
// loop, no restart. Both commands only write settings; they send nothing.
import { ARMED_KILL_REASON, type ChainReader, SETTINGS, isTxSignature, parseSigList } from '@rat/core';
import { engageKillSwitch, releaseKillSwitch } from '@rat/safety';
import type { CliContext } from '../context';
import { announceCaCommand } from './announce';

/** How long an unknown creator-signed tx waits for rat launch-register instead of killing the bot. */
export const LAUNCH_PENDING_MS = 30 * 60_000;

export async function launchArmCommand(ctx: CliContext): Promise<boolean> {
  const { config: cfg, store } = ctx;
  if (!cfg.creatorPubkey) {
    ctx.out('launch-arm: refused: CREATOR_PUBKEY is not set.');
    return false;
  }
  if (cfg.coinMint) {
    ctx.out(`launch-arm: refused: COIN_MINT is set (${cfg.coinMint}): the coin is already launched.`);
    return false;
  }
  if (cfg.killSwitch) {
    ctx.out('launch-arm: refused: the KILL_SWITCH env var is true (launch-register could not release it): set it to false first.');
    return false;
  }
  const on = (await store.settings.get(SETTINGS.killSwitch)) === 'on';
  const reason = await store.settings.get(SETTINGS.killReason);
  if (on && reason !== ARMED_KILL_REASON) {
    ctx.out(`launch-arm: refused: the kill switch is already on for another reason (${reason ?? 'unknown'}): check it, then rat resume first.`);
    return false;
  }
  if (!on) await engageKillSwitch(store.settings, ARMED_KILL_REASON);
  const until = new Date(ctx.clock.now().getTime() + LAUNCH_PENDING_MS).toISOString();
  await store.settings.set(SETTINGS.launchPendingUntil, until);
  ctx.out(`launch-arm: armed: kill switch ON (${ARMED_KILL_REASON}), owner launch pending until ${until}. Launch on pump.fun, then: rat launch-register <mint> --sigs <sig,...>`);
  return true;
}

export async function launchRegisterCommand(
  ctx: CliContext,
  chain: Pick<ChainReader, 'getAccountData'>,
  mint: string,
  opts: { sigs?: string },
): Promise<boolean> {
  const { config: cfg, store } = ctx;
  const sigs = parseSigList(opts.sigs);
  if (sigs.length === 0) {
    ctx.out('launch-register: refused: pass the launch transaction signature(s): --sigs <sig,...>.');
    return false;
  }
  const bad = sigs.find((s) => !isTxSignature(s));
  if (bad) {
    ctx.out(`launch-register: refused: not a transaction signature: "${bad.slice(0, 20)}".`);
    return false;
  }
  // same checks as announce-ca (the coin's creator read on chain, never another coin than COIN_MINT); it writes
  // SETTINGS.announcedCoinMint only when they pass
  const lines: string[] = [];
  const ok = await announceCaCommand({ ...ctx, out: (l) => lines.push(l) }, chain, mint);
  if (!ok) {
    for (const l of lines) ctx.out(l.replace(/^announce-ca:/, 'launch-register:'));
    return false;
  }
  const known = parseSigList(await store.settings.get(SETTINGS.knownOwnerTxSigs));
  const merged = [...new Set([...known, ...sigs])];
  await store.settings.set(SETTINGS.knownOwnerTxSigs, merged.join(','));
  await store.settings.delete(SETTINGS.launchPendingUntil);
  const on = (await store.settings.get(SETTINGS.killSwitch)) === 'on';
  const reason = await store.settings.get(SETTINGS.killReason);
  let kill: string;
  if (on && reason === ARMED_KILL_REASON) {
    await releaseKillSwitch(store.settings);
    kill = cfg.killSwitch ? 'armed kill released, but the KILL_SWITCH env var is still true' : 'kill switch released: hires start in the next loop';
  } else if (on) {
    kill = `kill switch left ON: its reason is not the armed one (${reason ?? 'unknown'})`;
  } else {
    kill = cfg.killSwitch ? 'kill switch left ON by the KILL_SWITCH env var' : 'kill switch was already off';
  }
  ctx.out(`launch-register: coin ${mint} registered (creator checked on chain), ${sigs.length} owner signature(s) accepted (${merged.length} known), pending cleared, ${kill}.`);
  return true;
}
