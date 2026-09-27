import { type GrinderChoice, formatSol } from '@rat/core';
import {
  type MasterKeyRing,
  decryptSecret,
  detectSolanaKeygen,
  encryptRoleKey,
  encryptSecret,
  grindIntoPool,
  importKeypairFiles,
  parseSecretKey,
  resolveGrinder,
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

/** Grinds keys into the pool: solana-keygen when installed (auto), else the built-in grinder. */
export async function keysGrindCommand(
  ctx: CliContext,
  ring: MasterKeyRing,
  count: number,
  opts: { threads?: number; grinder?: GrinderChoice; timeoutSec?: number } = {},
): Promise<void> {
  const kp = ctx.config.keypool;
  const kind = resolveGrinder(opts.grinder ?? kp.grinder, ctx.config.vanitySuffix, () => detectSolanaKeygen(kp.keygenPath)) ?? 'js';
  const r = await grindIntoPool(ctx.store.keys, ring, {
    kind,
    suffix: ctx.config.vanitySuffix,
    count,
    threads: opts.threads ?? kp.grindThreads,
    timeoutMs: (opts.timeoutSec ?? 24 * 3600) * 1000,
    keygenPath: kp.keygenPath,
  });
  if (r.error) throw new Error(r.error);
  ctx.out(`ground and stored ${r.added} keys ending in ${ctx.config.vanitySuffix} with ${r.grinder} in ${(r.elapsedMs / 1000).toFixed(1)}s.`);
}

export async function keysPoolCommand(ctx: CliContext): Promise<void> {
  const c = await ctx.store.keys.counts();
  const kp = ctx.config.keypool;
  ctx.out(`rat keys: ${c.available} available, ${c.assigned} assigned. Refill below ${kp.refillBelow}, target ${kp.target}.`);
  const keygen = detectSolanaKeygen(kp.keygenPath);
  const worker = resolveGrinder(kp.grinder, ctx.config.vanitySuffix, () => keygen);
  ctx.out(`worker grinder: ${worker ?? 'off'} (KEYPOOL_GRINDER=${kp.grinder}; solana-keygen ${keygen.ok ? `found: ${keygen.version}` : 'not found'})`);
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
