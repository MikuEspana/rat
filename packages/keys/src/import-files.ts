// Imports keypair files produced by `solana-keygen grind --ends-with RAT:<n>` (much faster than the
// JS grinder). Each file is verified, encrypted into the pool, then overwritten with zeros and deleted.
import { openSync, readFileSync, readdirSync, statSync, unlinkSync, writeSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyPoolStore } from '@rat/core';
import type { Keypair } from '@solana/web3.js';
import { storeRatKeys } from './keystore';
import { parseSecretKey } from './secret-input';
import type { MasterKeyRing } from './vault';

function shred(path: string): void {
  const size = statSync(path).size;
  const fd = openSync(path, 'r+');
  try {
    writeSync(fd, Buffer.alloc(size, 0), 0, size, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  unlinkSync(path);
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
      const kp = parseSecretKey(readFileSync(path, 'utf8'));
      if (!kp.publicKey.toBase58().endsWith(opts.suffix)) {
        skipped.push({ file: f, reason: `address does not end with ${opts.suffix}` });
        continue;
      }
      keys.push(kp);
      paths.push(path);
    } catch (err) {
      skipped.push({ file: f, reason: (err as Error).message });
    }
  }
  const imported = await storeRatKeys(pool, ring, keys);
  if (opts.shredAfterImport !== false) for (const p of paths) shred(p);
  return { imported, skipped };
}
