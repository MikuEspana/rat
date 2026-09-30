import { type ChainReader, SETTINGS, isBase58Pubkey } from '@rat/core';
import { bondingCurveAddress, coinCreatorProblem } from '@rat/pump';
import type { CliContext } from '../context';

/**
 * Right after the launch: the public API (and so the site) shows this coin's CA before the bot goes live, instead of
 * after the launch redeploy. Only a pump.fun coin created by the creator wallet is accepted (read on chain), and
 * never another coin than the one the bot runs. Writes one setting; sends nothing, changes nothing the bot uses.
 */
export async function announceCaCommand(ctx: CliContext, chain: Pick<ChainReader, 'getAccountData'>, mint: string): Promise<boolean> {
  const cfg = ctx.config;
  if (!isBase58Pubkey(mint)) {
    ctx.out(`announce-ca: refused: ${mint} is not a Solana address.`);
    return false;
  }
  if (cfg.coinMint && cfg.coinMint !== mint) {
    ctx.out(`announce-ca: refused: the bot runs coin ${cfg.coinMint}, not ${mint}.`);
    return false;
  }
  if (!cfg.creatorPubkey) {
    ctx.out('announce-ca: refused: CREATOR_PUBKEY is not set.');
    return false;
  }
  const problem = coinCreatorProblem(await chain.getAccountData(bondingCurveAddress(mint)), cfg.creatorPubkey);
  if (problem) {
    ctx.out(`announce-ca: refused: ${mint}: ${problem}.`);
    return false;
  }
  await ctx.store.settings.set(SETTINGS.announcedCoinMint, mint);
  ctx.out(`announce-ca: the site shows coin ${mint} now (created by the creator wallet ${cfg.creatorPubkey}, checked on chain). The bot is unchanged: scripts/launch.sh takes it live.`);
  return true;
}
