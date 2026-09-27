// pump.fun program constants. Source: official IDLs in github.com/pump-fun/pump-public-docs (idl/pump.json,
// idl/pump_amm.json). VERIFIED against the IDL files on 2026-09-27.
export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

/** Anchor discriminators (first 8 bytes of instruction data). */
export const DISCRIMINATORS = {
  /** pump: sweep bonding curve creator vault, unified layout */
  collectCreatorFeeV2: Uint8Array.from([207, 17, 138, 242, 4, 34, 19, 56]),
  /** pump: legacy sweep (someone else may still call it for our creator) */
  collectCreatorFee: Uint8Array.from([20, 22, 86, 123, 198, 28, 219, 132]),
  /** pump_amm: sweep coin creator vault ATA */
  collectCoinCreatorFee: Uint8Array.from([160, 57, 89, 42, 181, 139, 43, 66]),
} as const;

/** Rent-exempt minimum of a 0-data account; the program leaves the creator vault rent exempt. */
export const CREATOR_VAULT_RENT = 890_880n;

export function hasDiscriminator(data: Uint8Array, disc: Uint8Array): boolean {
  if (data.length < disc.length) return false;
  for (let i = 0; i < disc.length; i++) if (data[i] !== disc[i]) return false;
  return true;
}
