import { formatSol } from '@rat/core';
import {
  type MasterKeyRing,
  decryptSecret,
  encryptRoleKey,
  encryptSecret,
  grindVanityKeys,
  importKeypairFiles,
  parseSecretKey,
  storeRatKeys,
} from '@rat/keys';
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

export async function keysImportDirCommand(ctx: CliContext, ring: MasterKeyRing, dir: string, opts: { shred?: boolean } = {}): Promise<void> {
  const r = await importKeypairFiles(dir, ctx.store.keys, ring, { suffix: ctx.config.vanitySuffix, shredAfterImport: opts.shred !== false });
  ctx.out(`imported ${r.imported} rat keys${opts.shred !== false ? ' (files shredded)' : ''}.`);
  for (const s of r.skipped) ctx.out(`skipped ${s.file}: ${s.reason}`);
}

export async function keysGrindCommand(ctx: CliContext, ring: MasterKeyRing, count: number, threads?: number): Promise<void> {
  const res = await grindVanityKeys({ suffix: ctx.config.vanitySuffix, count, threads });
  const n = await storeRatKeys(ctx.store.keys, ring, res.keys);
  ctx.out(`ground and stored ${n} keys ending in ${ctx.config.vanitySuffix} in ${(res.elapsedMs / 1000).toFixed(1)}s (${res.tries} tries).`);
}

export async function keysPoolCommand(ctx: CliContext): Promise<void> {
  const c = await ctx.store.keys.counts();
  ctx.out(`rat keys: ${c.available} available, ${c.assigned} assigned. Target ${ctx.config.keypoolTarget}, refill below ${ctx.config.keypoolMin}.`);
  ctx.out(`salary per rat: ${formatSol(ctx.config.salaryLamports)} SOL`);
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
