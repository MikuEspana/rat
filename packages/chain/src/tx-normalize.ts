// Normalizes an RPC getTransaction response into the core TxRecord.
import type { TxInstructionRecord, TxRecord, TxTokenBalanceRecord } from '@rat/core';
import type { TokenBalance, VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';

export function normalizeTransaction(tx: VersionedTransactionResponse): TxRecord {
  const msg = tx.transaction.message;
  const meta = tx.meta;
  const keys = msg.getAccountKeys({ accountKeysFromLookups: meta?.loadedAddresses ?? undefined });
  const accountKeys = [
    ...keys.staticAccountKeys,
    ...(keys.accountKeysFromLookups?.writable ?? []),
    ...(keys.accountKeysFromLookups?.readonly ?? []),
  ].map((k) => k.toBase58());
  const key = (i: number) => accountKeys[i] ?? `unknown#${i}`;

  const instructions: TxInstructionRecord[] = [];
  msg.compiledInstructions.forEach((ci, index) => {
    instructions.push({ programId: key(ci.programIdIndex), accounts: ci.accountKeyIndexes.map(key), data: ci.data, inner: false });
    const inner = meta?.innerInstructions?.find((x) => x.index === index);
    for (const ii of inner?.instructions ?? []) {
      instructions.push({ programId: key(ii.programIdIndex), accounts: ii.accounts.map(key), data: bs58.decode(ii.data), inner: true });
    }
  });

  const tokens = (list: TokenBalance[] | null | undefined): TxTokenBalanceRecord[] =>
    (list ?? []).map((b) => ({
      accountIndex: b.accountIndex,
      account: key(b.accountIndex),
      owner: b.owner ?? null,
      mint: b.mint,
      amount: BigInt(b.uiTokenAmount.amount),
    }));

  const numSigners = msg.header.numRequiredSignatures;
  return {
    signature: tx.transaction.signatures[0] ?? '',
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    err: meta?.err ?? null,
    feePayer: key(0),
    signers: accountKeys.slice(0, numSigners),
    feeLamports: BigInt(meta?.fee ?? 0),
    accountKeys,
    preBalances: (meta?.preBalances ?? []).map((b) => BigInt(b)),
    postBalances: (meta?.postBalances ?? []).map((b) => BigInt(b)),
    preTokenBalances: tokens(meta?.preTokenBalances),
    postTokenBalances: tokens(meta?.postTokenBalances),
    instructions,
    logs: meta?.logMessages ?? [],
  };
}
