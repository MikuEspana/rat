// CI check, run inside the Docker image: the real solana-keygen grinds through our wrapper into an
// in-memory database, then we measure speed. Throwaway test keys only: never funded, never leave the container.
//   pnpm --filter @rat/keys check:keygen
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Store, openMemoryDatabase } from '@rat/db';
import { DbKeyStore, MasterKeyRing, detectSolanaKeygen, grindIntoPool } from '../src/index';

const bin = process.env.SOLANA_KEYGEN_PATH || 'solana-keygen';
const info = detectSolanaKeygen(bin);
if (!info.ok) {
  console.error(`solana-keygen not usable at "${bin}": ${info.error}`);
  process.exit(1);
}
console.log(`found: ${info.version}`);

const handle = await openMemoryDatabase();
const store = new Store(handle.db, 'paper');
const ring = new MasterKeyRing({ version: 1, base64: randomBytes(32).toString('base64') });
const threads = availableParallelism();
const shm = (() => {
  try {
    return readdirSync('/dev/shm').filter((f) => f.startsWith('rat-grind-')).length;
  } catch {
    return 0;
  }
})();

// 1. correctness: the wrapper imports exactly what solana-keygen reports, encrypted, and cleans up
const r = await grindIntoPool(store.keys, ring, { kind: 'solana-keygen', suffix: 'A', count: 5, threads, timeoutMs: 120_000, keygenPath: bin });
if (r.error || r.added !== 5) throw new Error(`expected 5 keys, got ${JSON.stringify(r)}`);
const ks = new DbKeyStore(store.keys, ring);
for (let i = 0; i < 5; i++) {
  const pub = await ks.takeRatKey();
  if (!pub?.endsWith('A')) throw new Error(`bad key ${pub}`);
  if ((await ks.ratSigner(pub)).publicKey.toBase58() !== pub) throw new Error(`secret does not match ${pub}`);
}
const left = (() => {
  try {
    return readdirSync('/dev/shm').filter((f) => f.startsWith('rat-grind-')).length;
  } catch {
    return 0;
  }
})();
if (left !== shm) throw new Error('a grind folder was left behind');
console.log('ok: 5 keys ending in A ground by solana-keygen, imported encrypted, plaintext files shredded');
// solana-keygen skips 44-character addresses when no prefix is given (agave keygen.rs skip_len_44_pubkeys)
const lengths = new Set((await store.keys.all()).map((k) => k.pubkey.length));
console.log(`solana-keygen address lengths: ${[...lengths].join(', ')} (44-character addresses are ~94% of all keys)`);

// 2. speed, same thread count for both: a 2-character suffix is 58x easier than RAT; extrapolate to RAT keys per hour
const sample = 60;
for (const kind of ['solana-keygen', 'js'] as const) {
  const s = await grindIntoPool(store.keys, ring, { kind, suffix: 'RA', count: sample, threads, timeoutMs: 600_000, keygenPath: bin });
  const secPerRaKey = s.elapsedMs / 1000 / Math.max(1, s.added);
  const ratPerHour = Math.round(3600 / (secPerRaKey * 58));
  console.log(`speed: ${kind} on ${threads} threads: ${s.added} RA keys in ${(s.elapsedMs / 1000).toFixed(1)}s => about ${ratPerHour} RAT keys/hour`);
}
await handle.close();
