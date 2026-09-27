import { type MasterKeyRing, decryptSecret, encryptRoleKey, encryptSecret, parseSecretKey } from '@rat/keys';
import type { CliContext } from '../context';

/** Imports the creator or fund private key (read from stdin, never from argv). */
export async function keysImportRoleCommand(
  ctx: CliContext,
  ring: MasterKeyRing,
  role: 'creator' | 'fund',
  secretText: string,
  opts: { replace?: boolean } = {},
): Promise<void> {
  const expected = role === 'creator' ? ctx.config.creatorPubkey : ctx.config.fundPubkey;
  if (!expected) throw new Error(`${role === 'creator' ? 'CREATOR_PUBKEY' : 'FUND_PUBKEY'} must be set before importing the ${role} key`);
  const kp = parseSecretKey(secretText);
  if (kp.publicKey.toBase58() !== expected) {
    throw new Error(`the ${role} key is ${kp.publicKey.toBase58()} but ${role === 'creator' ? 'CREATOR_PUBKEY' : 'FUND_PUBKEY'} is ${expected}`);
  }
  await ctx.store.keys.setRoleKey(encryptRoleKey(kp, ring, role), { replace: opts.replace });
  ctx.out(`${role} key ${expected} imported (encrypted, key version ${ring.currentVersion}).`);
}

/**
 * Re-encrypts every stored key under the current master key (KEY_ENCRYPTION_KEY / KEY_VERSION).
 * `ring` must also hold the previous key (KEY_ENCRYPTION_KEY_PREVIOUS / KEY_VERSION_PREVIOUS).
 * Each key is decrypted, checked against its public key, and re-encrypted; nothing is ever printed.
 */
export async function keysRotateCommand(ctx: CliContext, ring: MasterKeyRing): Promise<{ rotated: number; skipped: number }> {
  let rotated = 0;
  let skipped = 0;
  for (const rec of await ctx.store.keys.all()) {
    if (rec.keyVersion === ring.currentVersion) {
      skipped++;
      continue;
    }
    const secret = decryptSecret(rec.secretEnc, ring.get(rec.keyVersion), rec.pubkey);
    const kp = parseSecretKey(JSON.stringify(Array.from(secret)));
    if (kp.publicKey.toBase58() !== rec.pubkey) throw new Error(`stored key ${rec.pubkey} does not match its secret`);
    await ctx.store.keys.updateSecret(rec.pubkey, encryptSecret(secret, ring.current(), rec.pubkey), ring.currentVersion);
    rotated++;
  }
  ctx.out(`re-encrypted ${rotated} keys under master key version ${ring.currentVersion} (${skipped} already current).`);
  return { rotated, skipped };
}
