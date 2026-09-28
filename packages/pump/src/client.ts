// PumpClient: reads claimable fees and builds claim instructions. Reads go through the ChainReader
// port, so the same code runs against mainnet RPC or SimChain.
import {
  type ChainReader,
  type Claimable,
  type CoinInfo,
  NATIVE_SOL_MINT,
  type PumpClient,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  type TxRecord,
  solDelta,
  tokenAccountDelta,
} from '@rat/core';
import type { TransactionInstruction } from '@solana/web3.js';
import { CREATOR_VAULT_RENT, DISCRIMINATORS, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, hasDiscriminator } from './constants';
import {
  collectCoinCreatorFeeIx,
  collectCreatorFeeV2Ix,
  createCreatorWsolAtaIx,
  unwrapCreatorWsolIx,
} from './instructions';
import { type CreatorAccounts, creatorAccounts } from './pdas';

export interface PumpClaimable extends Claimable {
  /** WSOL already sitting in the creator's WSOL ATA (e.g. from an external AMM claim), unwrapped on our next claim */
  creatorWsolLamports: bigint;
}

export interface ClaimMeasurement {
  bondingLamports: bigint;
  ammLamports: bigint;
  totalLamports: bigint;
}

export class PumpFunClient implements PumpClient {
  constructor(private readonly reader: ChainReader) {}

  accounts(creator: string): CreatorAccounts {
    return creatorAccounts(creator);
  }

  async getClaimable(creator: string): Promise<PumpClaimable> {
    const a = creatorAccounts(creator);
    const [sol, tokens] = await Promise.all([
      this.reader.getSolBalances([a.bondingVault]),
      this.reader.getTokenAccounts([
        { owner: a.ammVaultAuthority, mint: NATIVE_SOL_MINT, tokenProgram: TOKEN_PROGRAM },
        { owner: creator, mint: NATIVE_SOL_MINT, tokenProgram: TOKEN_PROGRAM },
      ]),
    ]);
    const vaultLamports = sol.get(a.bondingVault) ?? 0n;
    const bonding = vaultLamports > CREATOR_VAULT_RENT ? vaultLamports - CREATOR_VAULT_RENT : 0n;
    const amm = tokens[0]?.amount ?? 0n;
    return { bondingLamports: bonding, ammLamports: amm, totalLamports: bonding + amm, creatorWsolLamports: tokens[1]?.amount ?? 0n };
  }

  /**
   * Claim instructions for whatever is claimable, plus the WSOL unwrap when AMM fees are involved.
   */
  buildClaimInstructions(args: { creator: string; claimable: Claimable }): TransactionInstruction[] {
    const c = args.claimable as PumpClaimable;
    const ixs: TransactionInstruction[] = [];
    if (c.bondingLamports > 0n) ixs.push(collectCreatorFeeV2Ix(args.creator));
    const needsUnwrap = c.ammLamports > 0n || (c.creatorWsolLamports ?? 0n) > 0n;
    if (needsUnwrap) {
      ixs.push(createCreatorWsolAtaIx(args.creator));
      if (c.ammLamports > 0n) ixs.push(collectCoinCreatorFeeIx(args.creator));
      ixs.push(unwrapCreatorWsolIx(args.creator));
    }
    return ixs;
  }

  async getCoinInfo(mint: string): Promise<CoinInfo> {
    const m = (await this.reader.getMintStates([mint])).get(mint);
    if (!m || !m.exists) throw new Error(`coin mint ${mint} not found`);
    if (m.tokenProgram !== TOKEN_PROGRAM && m.tokenProgram !== TOKEN_2022_PROGRAM) {
      throw new Error(`coin mint ${mint} is not owned by a token program (${m.tokenProgram})`);
    }
    return { mint, decimals: m.decimals, tokenProgram: m.tokenProgram, supply: m.supply };
  }

  /**
   * If `record` contains a pump.fun creator fee claim for OUR creator (any signer), returns how much left
   * our vaults in that tx. Null when the tx has no such claim or failed.
   */
  parseClaim(record: TxRecord, creator: string): ClaimMeasurement | null {
    if (record.err) return null;
    const a = creatorAccounts(creator);
    const hasClaim = record.instructions.some((ix) => {
      if (ix.programId === PUMP_PROGRAM_ID) {
        if (hasDiscriminator(ix.data, DISCRIMINATORS.collectCreatorFeeV2)) return ix.accounts[0] === creator;
        if (hasDiscriminator(ix.data, DISCRIMINATORS.collectCreatorFee)) return ix.accounts[0] === creator;
        return false;
      }
      if (ix.programId === PUMP_AMM_PROGRAM_ID && hasDiscriminator(ix.data, DISCRIMINATORS.collectCoinCreatorFee)) {
        return ix.accounts[2] === creator;
      }
      return false;
    });
    if (!hasClaim) return null;
    const bondingOut = -solDelta(record, a.bondingVault);
    const ammOut = -tokenAccountDelta(record, a.ammVaultAta);
    const bondingLamports = bondingOut > 0n ? bondingOut : 0n;
    const ammLamports = ammOut > 0n ? ammOut : 0n;
    return { bondingLamports, ammLamports, totalLamports: bondingLamports + ammLamports };
  }
}
