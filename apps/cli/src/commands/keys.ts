import { readFileSync, writeFileSync } from 'node:fs';
import type { KeyPoolRecord } from '@rat/core';
import { type MasterKeyRing, decryptSecret, encryptRoleKey, encryptSecret, parseSecretKey } from '@rat/keys';
import { Keypair } from '@solana/web3.js';
import type { CliContext } from '../context';

/** Imports the creator private key (read from stdin, never from argv). */
export async function keysImportRoleCommand(
  ctx: CliContext,
  ring: MasterKeyRing,
  role: 'creator',
  secretText: string,
  opts: { replace?: boolean } = {},
): Promise<void> {
  const expected = ctx.config.creatorPubkey;
  if (!expected) throw new Error(`CREATOR_PUBKEY must be set before importing the ${role} key`);
  const kp = parseSecretKey(secretText);
  if (kp.publicKey.toBase58() !== expected) {
    throw new Error(`the ${role} key is ${kp.publicKey.toBase58()} but CREATOR_PUBKEY is ${expected}`);
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

export const KEY_BACKUP_FORMAT = 'rat-race-keys-v1';

interface KeyBackupFile {
  format: typeof KEY_BACKUP_FORMAT;
  createdAt: string;
  keys: KeyPoolRecord[];
}

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
 * Writes every stored key (rat wallets and the creator) to a file, STILL ENCRYPTED with the master key. The rat
 * wallets' keys exist nowhere else: if the database is lost, this file plus KEY_ENCRYPTION_KEY recover them.
 * Every key is checked to decrypt first, so a backup is never silently broken. The file is created 0600.
 */
export async function keysBackupCommand(ctx: CliContext, ring: MasterKeyRing, outPath: string, opts: { force?: boolean } = {}): Promise<{ keys: number }> {
  const records = await ctx.store.keys.all();
  const check = verifyKeyRecords(records, ring);
  if (check.bad.length > 0) {
    throw new Error(`${check.bad.length} stored keys do not decrypt with KEY_ENCRYPTION_KEY (first: ${check.bad[0]!.pubkey}: ${check.bad[0]!.reason}). Backup refused.`);
  }
  const file: KeyBackupFile = { format: KEY_BACKUP_FORMAT, createdAt: ctx.clock.now().toISOString(), keys: records };
  writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: opts.force ? 'w' : 'wx' });
  const back = JSON.parse(readFileSync(outPath, 'utf8')) as KeyBackupFile;
  if (back.keys.length !== records.length) throw new Error('backup file did not read back completely');
  const rats = records.filter((r) => r.role === 'rat').length;
  ctx.out(`backed up ${records.length} keys (${rats} rat wallets, ${records.length - rats} creator) to ${outPath}, still encrypted (key versions ${[...new Set(records.map((r) => r.keyVersion))].join(', ')}).`);
  ctx.out('Keep this file and KEY_ENCRYPTION_KEY in two DIFFERENT safe places: one without the other is useless to a thief and to you.');
  return { keys: records.length };
}

/** Restores keys from a backup file into the database. Every key must decrypt first; existing keys are kept. */
export async function keysRestoreCommand(ctx: CliContext, ring: MasterKeyRing, inPath: string): Promise<{ restored: number; skipped: number }> {
  const file = JSON.parse(readFileSync(inPath, 'utf8')) as Partial<KeyBackupFile>;
  if (file.format !== KEY_BACKUP_FORMAT || !Array.isArray(file.keys)) throw new Error(`${inPath} is not a ${KEY_BACKUP_FORMAT} backup`);
  const wellFormed = file.keys.filter(
    (k) => typeof k?.pubkey === 'string' && typeof k.secretEnc === 'string' && Number.isInteger(k.keyVersion) && ['rat', 'creator', 'fund'].includes(k.role as string),
  );
  if (wellFormed.length !== file.keys.length) throw new Error('backup has malformed entries: nothing restored');
  // a backup from before buy and burn was removed can hold the old fund wallet's key: it is not restored
  const legacy = wellFormed.filter((k) => (k.role as string) === 'fund');
  for (const k of legacy) ctx.out(`skipped the old fund wallet key ${k.pubkey} (buy and burn was removed; the bot no longer uses a fund wallet)`);
  const records = wellFormed.filter((k): k is KeyPoolRecord => (k.role as string) !== 'fund');
  const check = verifyKeyRecords(records, ring);
  if (check.bad.length > 0) throw new Error(`${check.bad.length} keys in the backup do not decrypt with this master key (first: ${check.bad[0]!.pubkey}): nothing restored`);
  let restored = 0;
  let skipped = 0;
  for (const rec of records) {
    if (await ctx.store.keys.get(rec.pubkey)) {
      skipped++;
      continue;
    }
    if (rec.role === 'rat') await ctx.store.keys.insertRatKey(rec);
    else {
      const current = await ctx.store.keys.getRole(rec.role);
      if (current) {
        ctx.out(`kept the stored ${rec.role} key ${current.pubkey} (the backup has ${rec.pubkey})`);
        skipped++;
        continue;
      }
      await ctx.store.keys.setRoleKey({ ...rec, role: rec.role });
    }
    restored++;
  }
  ctx.out(`restored ${restored} keys from ${inPath} (${skipped} already present${legacy.length ? `, ${legacy.length} old fund key skipped` : ''}).`);
  return { restored, skipped: skipped + legacy.length };
}
