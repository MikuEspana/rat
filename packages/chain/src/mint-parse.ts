// Parses mint and token accounts (SPL Token and Token-2022) into the core MintState / TokenAccountState.
import { type MintState, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '@rat/core';
import {
  ExtensionType,
  getExtensionTypes,
  getPausableConfig,
  getScaledUiAmountConfig,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token';
import { type AccountInfo, PublicKey } from '@solana/web3.js';

export function isTokenProgram(owner: string): boolean {
  return owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM;
}

export function missingMint(mint: string): MintState {
  return {
    mint,
    exists: false,
    tokenProgram: null,
    decimals: 0,
    supply: 0n,
    mintAuthority: null,
    freezeAuthority: null,
    paused: false,
    uiMultiplier: 1,
    hasPermanentDelegate: false,
  };
}

/** `nowSec` decides which Scaled UI multiplier is in effect. */
export function parseMintAccount(mint: string, info: AccountInfo<Buffer> | null, nowSec: number): MintState {
  if (!info) return missingMint(mint);
  const owner = info.owner.toBase58();
  if (!isTokenProgram(owner)) return { ...missingMint(mint), exists: true, tokenProgram: owner };
  const m = unpackMint(new PublicKey(mint), info, info.owner);
  let paused = false;
  let uiMultiplier = 1;
  let hasPermanentDelegate = false;
  if (owner === TOKEN_2022_PROGRAM && m.tlvData.length > 0) {
    paused = getPausableConfig(m)?.paused ?? false;
    const scaled = getScaledUiAmountConfig(m);
    if (scaled) {
      uiMultiplier = BigInt(nowSec) >= scaled.newMultiplierEffectiveTimestamp ? scaled.newMultiplier : scaled.multiplier;
    }
    hasPermanentDelegate = getExtensionTypes(m.tlvData).includes(ExtensionType.PermanentDelegate);
  }
  return {
    mint,
    exists: true,
    tokenProgram: owner,
    decimals: m.decimals,
    supply: m.supply,
    mintAuthority: m.mintAuthority?.toBase58() ?? null,
    freezeAuthority: m.freezeAuthority?.toBase58() ?? null,
    paused,
    uiMultiplier,
    hasPermanentDelegate,
  };
}

export function parseTokenAccount(
  address: string,
  info: AccountInfo<Buffer> | null,
): { exists: boolean; owner: string | null; mint: string | null; amount: bigint; frozen: boolean } {
  if (!info || !isTokenProgram(info.owner.toBase58())) return { exists: false, owner: null, mint: null, amount: 0n, frozen: false };
  const a = unpackAccount(new PublicKey(address), info, info.owner);
  return { exists: true, owner: a.owner.toBase58(), mint: a.mint.toBase58(), amount: a.amount, frozen: a.isFrozen };
}
