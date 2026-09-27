import { formatSol } from '@rat/core';
import type { CliContext } from '../context';

export async function ledgerShowCommand(ctx: CliContext, limit = 30): Promise<void> {
  const { store, out } = ctx;
  out(`ledger (${store.mode}): hire ${formatSol(await store.ledger.balance('hire'))} SOL, burn ${formatSol(await store.ledger.balance('burn'))} SOL`);
  for (const [k, v] of await store.ledger.sumByReason()) out(`  ${k.padEnd(24)} ${formatSol(v)}`);
  out(`last ${limit} entries:`);
  for (const e of await store.ledger.list(limit)) {
    out(`  #${e.id} ${e.at.toISOString()} ${e.bucket.padEnd(4)} ${e.reason.padEnd(13)} ${formatSol(e.deltaLamports).padStart(14)} ${e.refType ?? ''}:${e.refId ?? ''}`);
  }
}
