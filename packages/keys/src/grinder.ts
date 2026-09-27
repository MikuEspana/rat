// Vanity key grinder: ed25519 keys whose base58 public key ends with a suffix (case-sensitive).
// Runs in worker threads using Node's native ed25519. "RAT" needs ~195k tries per key on average.
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { Keypair } from '@solana/web3.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Self-contained worker source (plain CommonJS, no TypeScript loader needed).
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { generateKeyPairSync } = require('node:crypto');
const ALPHABET = '${ALPHABET}';
const { suffix, count, deadline } = workerData;
let target = 0, modulus = 1;
for (const ch of suffix) { target = target * 58 + ALPHABET.indexOf(ch); modulus *= 58; }
function mod(bytes) { let r = 0; for (let i = 0; i < bytes.length; i++) r = (r * 256 + bytes[i]) % modulus; return r; }
let found = 0, tries = 0;
while (found < count) {
  const kp = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const pub = kp.publicKey.subarray(kp.publicKey.length - 32);
  tries++;
  if (modulus === 1 || mod(pub) === target) {
    const seed = kp.privateKey.subarray(kp.privateKey.length - 32);
    const secret = new Uint8Array(64);
    secret.set(seed, 0); secret.set(pub, 32);
    parentPort.postMessage({ type: 'key', secret, tries });
    tries = 0;
    found++;
  }
  if ((tries & 1023) === 0 && Date.now() > deadline) break;
}
parentPort.postMessage({ type: 'done' });
`;

export interface GrindOptions {
  suffix: string;
  count: number;
  threads?: number;
  timeoutMs?: number;
}

export interface GrindResult {
  keys: Keypair[];
  tries: number;
  elapsedMs: number;
}

export function isValidSuffix(suffix: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{0,5}$/.test(suffix);
}

/** Grinds `count` keypairs whose address ends with `suffix`. Stops early at the timeout. */
export async function grindVanityKeys(opts: GrindOptions): Promise<GrindResult> {
  if (!isValidSuffix(opts.suffix)) throw new Error(`invalid base58 suffix "${opts.suffix}"`);
  if (opts.count <= 0) return { keys: [], tries: 0, elapsedMs: 0 };
  const threads = Math.max(1, Math.min(opts.threads ?? Math.max(1, availableParallelism() - 1), opts.count));
  const started = Date.now();
  const deadline = started + (opts.timeoutMs ?? 10 * 60_000);
  const perThread = Array.from({ length: threads }, (_, i) =>
    Math.floor(opts.count / threads) + (i < opts.count % threads ? 1 : 0),
  );
  const keys: Keypair[] = [];
  let tries = 0;
  await Promise.all(
    perThread.map(
      (n) =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { suffix: opts.suffix, count: n, deadline } });
          worker.on('message', (m: { type: string; secret?: Uint8Array; tries?: number }) => {
            if (m.type === 'key' && m.secret) {
              const kp = Keypair.fromSecretKey(new Uint8Array(m.secret));
              if (!kp.publicKey.toBase58().endsWith(opts.suffix)) {
                reject(new Error('grinder produced a key without the suffix'));
                return;
              }
              keys.push(kp);
              tries += m.tries ?? 0;
            }
          });
          worker.on('error', reject);
          worker.on('exit', () => resolve());
        }),
    ),
  );
  return { keys, tries, elapsedMs: Date.now() - started };
}
