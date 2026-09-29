// The coin's bonding curve account (pump PDA ["bonding-curve", mint]). Its `creator` field is where the creator fee
// goes: "The `BondingCurve::creator` field therefore still tells you where the fee goes" (pump-public-docs
// docs/HOLDER_REWARDS_README.md). Fee sharing moves it to the sharing config PDA (docs/instructions/
// CREATOR_FEE_SHARING.md, step 1) and a holder rewards takeover to a pump.fun address: either way the bot would
// claim nothing. Layout VERIFIED against idl/pump.json (types.BondingCurve):
//   0..8 discriminator, 8..48 reserves and supply (5 x u64), 48 complete, 49..81 creator, 81 is_mayhem_mode,
//   82 is_cashback_coin, 83..115 quote_mint, 115..123 creator_fee_bps, 123 can_edit_creator_fee, 124 is_holder_reward
// Older curves are shorter: a missing trailing field reads as 0 / false / Pubkey::default() (docs/PUMP_PROGRAM_README.md),
// and quote_mint = Pubkey::default() means SOL-paired.
import { NATIVE_SOL_MINT } from '@rat/core';
import { PublicKey } from '@solana/web3.js';
import { PUMP_PROGRAM_ID } from './constants';

/** sha256("account:BondingCurve")[0..8], idl/pump.json accounts.BondingCurve */
export const BONDING_CURVE_DISCRIMINATOR = [23, 183, 248, 55, 96, 216, 172, 96];

export function bondingCurveAddress(mint: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], new PublicKey(PUMP_PROGRAM_ID))[0].toBase58();
}

export interface BondingCurveInfo {
  creator: string;
  complete: boolean;
  cashback: boolean;
  /** null = SOL-paired */
  quoteMint: string | null;
  feesGoToHolders: boolean;
}

export function parseBondingCurve(data: Uint8Array): BondingCurveInfo | null {
  if (data.length < 81 || !BONDING_CURVE_DISCRIMINATOR.every((b, i) => data[i] === b)) return null;
  const byte = (i: number) => (data.length > i ? data[i] : 0);
  const quote = data.length >= 115 ? data.subarray(83, 115) : null;
  return {
    creator: new PublicKey(data.subarray(49, 81)).toBase58(),
    complete: byte(48) === 1,
    cashback: byte(82) === 1,
    quoteMint: quote && quote.some((b) => b !== 0) ? new PublicKey(quote).toBase58() : null,
    feesGoToHolders: byte(124) === 1,
  };
}

/** Why this coin's creator fees would not reach `creator` in SOL (null = they do). */
export function coinCreatorProblem(account: { owner: string; data: Uint8Array } | null, creator: string): string | null {
  if (!account) return 'there is no pump.fun bonding curve for this mint (not a pump.fun coin, or another network)';
  if (account.owner !== PUMP_PROGRAM_ID) return `its bonding curve account is owned by ${account.owner}, not by the pump.fun program`;
  const bc = parseBondingCurve(account.data);
  if (!bc) return 'its bonding curve account has an unknown layout';
  if (bc.feesGoToHolders) return 'it is a holder rewards coin: the creator fee goes to holders, there is nothing to claim';
  if (bc.creator !== creator) {
    return `its creator fees go to ${bc.creator}, not to CREATOR_PUBKEY ${creator} (launched from another wallet, fee sharing, or a takeover): the bot would claim nothing`;
  }
  if (bc.cashback) return 'it is a cashback coin: the creator fee goes back to the traders';
  if (bc.quoteMint && bc.quoteMint !== NATIVE_SOL_MINT) return `it trades against ${bc.quoteMint}, not SOL: the bot only claims SOL creator fees`;
  return null;
}

/** The account bytes for a bonding curve (tests and the simulation). */
export function encodeBondingCurve(o: { creator: string; complete?: boolean; cashback?: boolean; quoteMint?: string; feesGoToHolders?: boolean }): Uint8Array {
  const data = new Uint8Array(151);
  data.set(BONDING_CURVE_DISCRIMINATOR, 0);
  data[48] = o.complete ? 1 : 0;
  data.set(new PublicKey(o.creator).toBytes(), 49);
  data[82] = o.cashback ? 1 : 0;
  if (o.quoteMint) data.set(new PublicKey(o.quoteMint).toBytes(), 83);
  data[124] = o.feesGoToHolders ? 1 : 0;
  return data;
}
