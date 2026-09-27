// SimChain handlers for the pump.fun creator fee instructions, plus helpers that make fees accrue
// (as trades would). In-memory only.
import { NATIVE_SOL_MINT, TOKEN_PROGRAM } from '@rat/core';
import { type SimChain, SimError } from '@rat/chain/sim';
import { CREATOR_VAULT_RENT, DISCRIMINATORS, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, hasDiscriminator } from './constants';
import { creatorAccounts } from './pdas';

export function registerPumpSimPrograms(chain: SimChain): void {
  chain.registerProgram(PUMP_PROGRAM_ID, (ix, ctx) => {
    const isV2 = hasDiscriminator(ix.data, DISCRIMINATORS.collectCreatorFeeV2);
    const isLegacy = hasDiscriminator(ix.data, DISCRIMINATORS.collectCreatorFee);
    if (!isV2 && !isLegacy) throw new SimError('pump sim: only creator fee claims are simulated');
    const creator = ix.keys[0]!.pubkey.toBase58();
    const vault = ix.keys[isV2 ? 2 : 1]!.pubkey.toBase58();
    if (creatorAccounts(creator).bondingVault !== vault) throw new SimError('pump sim: creator vault seeds mismatch');
    const lamports = ctx.lamports(vault);
    const claim = lamports > CREATOR_VAULT_RENT ? lamports - CREATOR_VAULT_RENT : 0n;
    if (claim > 0n) ctx.transferLamports(vault, creator, claim);
    ctx.log(`pump: collect_creator_fee ${claim}`);
  });
  chain.registerProgram(PUMP_AMM_PROGRAM_ID, (ix, ctx) => {
    if (!hasDiscriminator(ix.data, DISCRIMINATORS.collectCoinCreatorFee)) throw new SimError('pump_amm sim: only creator fee claims are simulated');
    const creator = ix.keys[2]!.pubkey.toBase58();
    const a = creatorAccounts(creator);
    if (ix.keys[3]!.pubkey.toBase58() !== a.ammVaultAuthority || ix.keys[4]!.pubkey.toBase58() !== a.ammVaultAta) {
      throw new SimError('pump_amm sim: vault seeds mismatch');
    }
    const vault = ctx.token(a.ammVaultAta);
    const dest = ctx.token(ix.keys[5]!.pubkey.toBase58());
    if (dest.owner !== creator) throw new SimError('pump_amm sim: destination not owned by coin creator');
    const amount = vault.amount;
    if (amount > 0n) ctx.moveTokens(vault, dest, amount);
    ctx.log(`pump_amm: collect_coin_creator_fee ${amount}`);
  });
}

/** Simulates trading volume paying creator fees into our vaults. */
export function accrueCreatorFees(chain: SimChain, creator: string, fees: { bondingLamports?: bigint; ammLamports?: bigint }): void {
  const a = creatorAccounts(creator);
  if (fees.bondingLamports && fees.bondingLamports > 0n) {
    const current = chain.sol(a.bondingVault);
    chain.setSol(a.bondingVault, (current === 0n ? CREATOR_VAULT_RENT : current) + fees.bondingLamports);
  }
  if (fees.ammLamports && fees.ammLamports > 0n) {
    const current = chain.tokenBalance(a.ammVaultAuthority, NATIVE_SOL_MINT, TOKEN_PROGRAM);
    chain.setTokenBalance(a.ammVaultAuthority, NATIVE_SOL_MINT, current + fees.ammLamports, TOKEN_PROGRAM);
  }
}
