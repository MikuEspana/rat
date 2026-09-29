// Checks stored keys against a master key ring without ever returning a secret.
import type { KeyPoolRecord } from '@rat/core';
import { Keypair } from '@solana/web3.js';
import { type MasterKeyRing, decryptSecret } from './vault';

/**
 * Decrypts every record with the master key ring and checks it matches its public key. Returns only public keys
 * and reasons, never a secret; the decrypted bytes are wiped right away.
 */
export function verifyKeyRecords(records: KeyPoolRecord[], ring: MasterKeyRing): { ok: number; bad: { pubkey: string; reason: string }[] } {
  let ok = 0;
  const bad: { pubkey: string; reason: string }[] = [];
  for (const rec of records) {
    try {
      const secret = decryptSecret(rec.secretEnc, ring.get(rec.keyVersion), rec.pubkey);
      const matches = Keypair.fromSecretKey(secret).publicKey.toBase58() === rec.pubkey;
      secret.fill(0);
      if (matches) ok++;
      else bad.push({ pubkey: rec.pubkey, reason: 'decrypts to a different key' });
    } catch (err) {
      bad.push({ pubkey: rec.pubkey, reason: (err as Error).message });
    }
  }
  return { ok, bad };
}

/**
 * Keys stored under the ring's CURRENT version that do not decrypt with it: the master key was changed without a new
 * KEY_VERSION. Writing more keys then would mix two master keys under one version label, and whichever key is kept,
 * some rat wallets could never be signed for again. Rows under another version cannot be confused and are not checked.
 */
export function sameVersionKeysThatFail(records: KeyPoolRecord[], ring: MasterKeyRing): { pubkey: string; reason: string }[] {
  return verifyKeyRecords(records.filter((r) => r.keyVersion === ring.currentVersion), ring).bad;
}
