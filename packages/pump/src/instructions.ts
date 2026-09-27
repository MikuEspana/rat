// Creator fee instructions, account order exactly as in the IDL / COLLECT_CREATOR_FEE.md.
import { ASSOCIATED_TOKEN_PROGRAM, NATIVE_SOL_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM } from '@rat/core';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { DISCRIMINATORS, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from './constants';
import { creatorAccounts } from './pdas';

const pk = (s: string) => new PublicKey(s);

/** pump `collect_creator_fee_v2` for a SOL-paired coin: vault lamports go to the creator wallet. */
export function collectCreatorFeeV2Ix(creator: string): TransactionInstruction {
  const a = creatorAccounts(creator);
  const wsol = pk(NATIVE_SOL_MINT);
  const tokenProgram = pk(TOKEN_PROGRAM);
  const creatorTokenAccount = getAssociatedTokenAddressSync(wsol, pk(creator), true, tokenProgram);
  const vaultTokenAccount = getAssociatedTokenAddressSync(wsol, pk(a.bondingVault), true, tokenProgram);
  return new TransactionInstruction({
    programId: pk(PUMP_PROGRAM_ID),
    keys: [
      { pubkey: pk(creator), isSigner: false, isWritable: true },
      { pubkey: creatorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: pk(a.bondingVault), isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: wsol, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: pk(ASSOCIATED_TOKEN_PROGRAM), isSigner: false, isWritable: false },
      { pubkey: pk(SYSTEM_PROGRAM), isSigner: false, isWritable: false },
      { pubkey: pk(a.pumpEventAuthority), isSigner: false, isWritable: false },
      { pubkey: pk(PUMP_PROGRAM_ID), isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISCRIMINATORS.collectCreatorFeeV2),
  });
}

/** pump_amm `collect_coin_creator_fee`: vault WSOL goes to the creator's WSOL ATA. */
export function collectCoinCreatorFeeIx(creator: string): TransactionInstruction {
  const a = creatorAccounts(creator);
  return new TransactionInstruction({
    programId: pk(PUMP_AMM_PROGRAM_ID),
    keys: [
      { pubkey: pk(NATIVE_SOL_MINT), isSigner: false, isWritable: false },
      { pubkey: pk(TOKEN_PROGRAM), isSigner: false, isWritable: false },
      { pubkey: pk(creator), isSigner: false, isWritable: false },
      { pubkey: pk(a.ammVaultAuthority), isSigner: false, isWritable: false },
      { pubkey: pk(a.ammVaultAta), isSigner: false, isWritable: true },
      { pubkey: pk(a.creatorWsolAta), isSigner: false, isWritable: true },
      { pubkey: pk(a.ammEventAuthority), isSigner: false, isWritable: false },
      { pubkey: pk(PUMP_AMM_PROGRAM_ID), isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISCRIMINATORS.collectCoinCreatorFee),
  });
}

export function createCreatorWsolAtaIx(creator: string): TransactionInstruction {
  const a = creatorAccounts(creator);
  return createAssociatedTokenAccountIdempotentInstruction(
    pk(creator),
    pk(a.creatorWsolAta),
    pk(creator),
    pk(NATIVE_SOL_MINT),
    pk(TOKEN_PROGRAM),
  );
}

/** Closes the creator's WSOL ATA: unwraps its WSOL (and rent) into native SOL on the creator wallet. */
export function unwrapCreatorWsolIx(creator: string): TransactionInstruction {
  const a = creatorAccounts(creator);
  return createCloseAccountInstruction(pk(a.creatorWsolAta), pk(creator), pk(creator), [], pk(TOKEN_PROGRAM));
}

/** BurnChecked from the owner's ATA, with the coin's own token program (SPL Token or Token-2022). */
export function burnIx(args: { owner: string; mint: string; amount: bigint; decimals: number; tokenProgram: string }): TransactionInstruction {
  const program = pk(args.tokenProgram);
  const ata = getAssociatedTokenAddressSync(pk(args.mint), pk(args.owner), true, program);
  return createBurnCheckedInstruction(ata, pk(args.mint), pk(args.owner), args.amount, args.decimals, [], program);
}
