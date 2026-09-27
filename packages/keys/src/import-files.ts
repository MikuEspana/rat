// Imports keypair files produced by `solana-keygen grind --ends-with RAT:<n>` (much faster than the
// JS grinder). Each file is verified, encrypted into the pool, then overwritten with zeros and deleted.
// Overwriting is best effort on SSDs and copy-on-write filesystems: grind into a RAM disk (see keys.md).
import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyPoolStore } from '@rat/core';
import type { Keypair } from '@solana/web3.js';
import { storeRatKeys } from './keystore';
import { parseSecretKey } from './secret-input';
import type { MasterKeyRing } from './vault';

/** Overwrites a file with zeros, syncs it, then deletes it. */
export function shredFile(path: string): void {
  const size = statSync(path).size;
  const fd = openSync(path, 'r+');
  try {
    if (size > 0) writeSync(fd, Buffer.alloc(size, 0), 0, size, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  unlinkSync(path);
}

/** Reads one keypair file and checks the suffix. Throws with a reason when the file is not usable. */
export function readKeypairFile(path: string, suffix: string): Keypair {
  const kp = parseSecretKey(readFileSync(path, 'utf8'));
  if (!kp.publicKey.toBase58().endsWith(suffix)) throw new Error(`address does not end with ${suffix}`);
  return kp;
}

export interface ImportFilesResult {
  imported: number;
  skipped: { file: string; reason: string }[];
}

export async function importKeypairFiles(
  dir: string,
  pool: KeyPoolStore,
  ring: MasterKeyRing,
  opts: { suffix: string; shredAfterImport?: boolean },
): Promise<ImportFilesResult> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const keys: Keypair[] = [];
  const paths: string[] = [];
  const skipped: ImportFilesResult['skipped'] = [];
  for (const f of files) {
    const path = join(dir, f);
    try {
      keys.push(readKeypairFile(path, opts.suffix));
      paths.push(path);
    } catch (err) {
      skipped.push({ file: f, reason: (err as Error).message });
    }
  }
  const imported = await storeRatKeys(pool, ring, keys);
  if (opts.shredAfterImport !== false) for (const p of paths) shredFile(p);
  return { imported, skipped };
}
