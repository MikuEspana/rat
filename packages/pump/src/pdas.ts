// Program derived addresses used by the creator fee instructions (seeds VERIFIED against the IDLs).
import { NATIVE_SOL_MINT, TOKEN_PROGRAM } from '@rat/core';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from './constants';

const pump = new PublicKey(PUMP_PROGRAM_ID);
const amm = new PublicKey(PUMP_AMM_PROGRAM_ID);

export interface CreatorAccounts {
  creator: string;
  /** pump PDA ["creator-vault", creator]: bonding curve fees (lamports) */
  bondingVault: string;
  /** pump_amm PDA ["creator_vault", creator]: authority of the AMM fee vault */
  ammVaultAuthority: string;
  /** WSOL ATA of the AMM vault authority: AMM fees */
  ammVaultAta: string;
  /** creator's WSOL ATA: destination of AMM fees (unwrapped in the same tx) */
  creatorWsolAta: string;
  pumpEventAuthority: string;
  ammEventAuthority: string;
}

export function pumpEventAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], pump)[0];
}

export function ammEventAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], amm)[0];
}

export function creatorAccounts(creator: string): CreatorAccounts {
  const c = new PublicKey(creator);
  const wsol = new PublicKey(NATIVE_SOL_MINT);
  const tokenProgram = new PublicKey(TOKEN_PROGRAM);
  const bondingVault = PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), c.toBuffer()], pump)[0];
  const ammVaultAuthority = PublicKey.findProgramAddressSync([Buffer.from('creator_vault'), c.toBuffer()], amm)[0];
  return {
    creator,
    bondingVault: bondingVault.toBase58(),
    ammVaultAuthority: ammVaultAuthority.toBase58(),
    ammVaultAta: getAssociatedTokenAddressSync(wsol, ammVaultAuthority, true, tokenProgram).toBase58(),
    creatorWsolAta: getAssociatedTokenAddressSync(wsol, c, true, tokenProgram).toBase58(),
    pumpEventAuthority: pumpEventAuthority().toBase58(),
    ammEventAuthority: ammEventAuthority().toBase58(),
  };
}
