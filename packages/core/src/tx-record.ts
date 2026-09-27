// Helpers to read balance changes out of a normalized TxRecord.
import type { TxRecord } from './ports';
import type { Pubkey } from './types';

/** post - pre lamports of `pubkey` in this tx (0n when the account is not in the tx). */
export function solDelta(record: TxRecord, pubkey: Pubkey): bigint {
  const i = record.accountKeys.indexOf(pubkey);
  if (i < 0) return 0n;
  return (record.postBalances[i] ?? 0n) - (record.preBalances[i] ?? 0n);
}

/** post - pre raw token amount of a specific token account address. */
export function tokenAccountDelta(record: TxRecord, account: Pubkey): bigint {
  const pre = record.preTokenBalances.find((b) => b.account === account)?.amount ?? 0n;
  const post = record.postTokenBalances.find((b) => b.account === account)?.amount ?? 0n;
  return post - pre;
}

/** post - pre raw token amount summed over every account of (owner, mint). */
export function tokenOwnerDelta(record: TxRecord, owner: Pubkey, mint: Pubkey): bigint {
  const sum = (list: TxRecord['preTokenBalances']) =>
    list.filter((b) => b.owner === owner && b.mint === mint).reduce((a, b) => a + b.amount, 0n);
  return sum(record.postTokenBalances) - sum(record.preTokenBalances);
}

/** post raw token amount summed over every account of (owner, mint). */
export function tokenOwnerPost(record: TxRecord, owner: Pubkey, mint: Pubkey): bigint {
  return record.postTokenBalances
    .filter((b) => b.owner === owner && b.mint === mint)
    .reduce((a, b) => a + b.amount, 0n);
}
