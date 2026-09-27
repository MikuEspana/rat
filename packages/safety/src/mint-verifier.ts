// Owner rule #12: before any stock can be hired into, its mint must be a Token-2022 mint and its mint
// authority must match the other verified xStocks. Failing mints are rejected (never hired into).
import { type MintState, TOKEN_2022_PROGRAM } from '@rat/core';

export interface MintCheck {
  ok: boolean;
  reason: string;
}

export interface MintVerification {
  expectedAuthority: string | null;
  source: 'config' | 'majority' | 'none';
  checks: Map<string, MintCheck>;
}

/**
 * `expectedAuthority` from XSTOCKS_MINT_AUTHORITY wins. Without it, the expected authority is the one shared
 * by a strict majority of the Token-2022 mints, and by at least `minMajority` of them. No clear majority
 * means no expected authority: every mint is rejected (safest).
 */
export function verifyStockMints(states: Map<string, MintState>, expectedAuthority?: string, minMajority = 3): MintVerification {
  const t22 = [...states.values()].filter((m) => m.exists && m.tokenProgram === TOKEN_2022_PROGRAM && m.mintAuthority);
  let expected: string | null = expectedAuthority ?? null;
  let source: MintVerification['source'] = expected ? 'config' : 'none';
  if (!expected) {
    const counts = new Map<string, number>();
    for (const m of t22) counts.set(m.mintAuthority!, (counts.get(m.mintAuthority!) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= minMajority && top[1] * 2 > t22.length) {
      expected = top[0];
      source = 'majority';
    }
  }
  const checks = new Map<string, MintCheck>();
  for (const [mint, m] of states) {
    if (!m.exists) checks.set(mint, { ok: false, reason: 'mint account not found' });
    else if (m.tokenProgram !== TOKEN_2022_PROGRAM) checks.set(mint, { ok: false, reason: `not a Token-2022 mint (owner ${m.tokenProgram})` });
    else if (!expected) checks.set(mint, { ok: false, reason: 'no expected xStocks mint authority (set XSTOCKS_MINT_AUTHORITY)' });
    else if (m.mintAuthority !== expected) checks.set(mint, { ok: false, reason: `mint authority ${m.mintAuthority ?? 'none'} does not match expected ${expected}` });
    else checks.set(mint, { ok: true, reason: 'Token-2022 with the expected mint authority' });
  }
  return { expectedAuthority: expected, source, checks };
}
