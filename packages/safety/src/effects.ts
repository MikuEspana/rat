// Spend limits on simulated effects. Pure: the GuardedSender calls it with what the sender's simulation reported.
import { type TxEffects, type TxKind, type TxLimits, formatSol } from '@rat/core';

/** Transaction kinds that must carry spend limits in live mode. `sweep` is the owner's emergency exit. */
export const LIMITED_TX_KINDS: readonly TxKind[] = ['claim', 'hire', 'burn'];

/** Every broken limit, in plain words. Empty = the transaction stays inside its limits. */
export function limitViolations(limits: TxLimits, eff: TxEffects): string[] {
  const out: string[] = [];
  const tokens = limits.tokens ?? [];
  if (eff.solDelta.length !== limits.solOut.length || eff.tokenDelta.length !== tokens.length) {
    return ['simulation did not report every limited account'];
  }
  limits.solOut.forEach((l, i) => {
    const lost = -eff.solDelta[i]!;
    if (lost > l.maxLamports) out.push(`${l.account} would lose ${formatSol(lost)} SOL, limit ${formatSol(l.maxLamports)}`);
  });
  tokens.forEach((t, i) => {
    const delta = eff.tokenDelta[i]!;
    if (delta < t.minDelta) out.push(`${t.owner} would get ${delta} raw ${t.mint}, needs at least ${t.minDelta}`);
  });
  return out;
}
