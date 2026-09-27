// Builds raw Token-2022 mint account data with extensions. Used by tests to prove the parser
// reads Pausable, Scaled UI Amount and Permanent Delegate the way the real program lays them out.
import {
  ExtensionType,
  MINT_SIZE,
  MintLayout,
  PausableConfigLayout,
  ScaledUiAmountConfigLayout,
  getMintLen,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

export interface MintDataSpec {
  decimals: number;
  supply: bigint;
  mintAuthority: PublicKey | null;
  freezeAuthority?: PublicKey | null;
  pausable?: { authority: PublicKey; paused: boolean };
  scaledUi?: { authority: PublicKey; multiplier: number; newMultiplier: number; effectiveTimestamp: bigint };
  permanentDelegate?: PublicKey;
}

const ACCOUNT_TYPE_MINT = 1;
const BASE_ACCOUNT_LENGTH = 165;

export function buildMintData(spec: MintDataSpec): Buffer {
  const exts: ExtensionType[] = [];
  if (spec.pausable) exts.push(ExtensionType.PausableConfig);
  if (spec.scaledUi) exts.push(ExtensionType.ScaledUiAmountConfig);
  if (spec.permanentDelegate) exts.push(ExtensionType.PermanentDelegate);
  const len = exts.length ? getMintLen(exts) : MINT_SIZE;
  const data = Buffer.alloc(len);
  MintLayout.encode(
    {
      mintAuthorityOption: spec.mintAuthority ? 1 : 0,
      mintAuthority: spec.mintAuthority ?? PublicKey.default,
      supply: spec.supply,
      decimals: spec.decimals,
      isInitialized: true,
      freezeAuthorityOption: spec.freezeAuthority ? 1 : 0,
      freezeAuthority: spec.freezeAuthority ?? PublicKey.default,
    },
    data,
  );
  if (!exts.length) return data;
  data[BASE_ACCOUNT_LENGTH] = ACCOUNT_TYPE_MINT;
  let offset = BASE_ACCOUNT_LENGTH + 1;
  const writeTlv = (type: ExtensionType, body: Buffer) => {
    data.writeUInt16LE(type, offset);
    data.writeUInt16LE(body.length, offset + 2);
    body.copy(data, offset + 4);
    offset += 4 + body.length;
  };
  if (spec.pausable) {
    const b = Buffer.alloc(PausableConfigLayout.span);
    PausableConfigLayout.encode({ authority: spec.pausable.authority, paused: spec.pausable.paused }, b);
    writeTlv(ExtensionType.PausableConfig, b);
  }
  if (spec.scaledUi) {
    const b = Buffer.alloc(ScaledUiAmountConfigLayout.span);
    ScaledUiAmountConfigLayout.encode(
      {
        authority: spec.scaledUi.authority,
        multiplier: spec.scaledUi.multiplier,
        newMultiplierEffectiveTimestamp: spec.scaledUi.effectiveTimestamp,
        newMultiplier: spec.scaledUi.newMultiplier,
      },
      b,
    );
    writeTlv(ExtensionType.ScaledUiAmountConfig, b);
  }
  if (spec.permanentDelegate) writeTlv(ExtensionType.PermanentDelegate, spec.permanentDelegate.toBuffer());
  return data;
}
