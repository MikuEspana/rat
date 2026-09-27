#!/usr/bin/env node
// Test double for the Agave `solana-keygen` CLI, used only by the keys tests. It mimics the two things the
// wrapper relies on (checked against agave keygen/src/keygen.rs):
//   --version                                   -> "solana-keygen <version> (...)"
//   grind --ends-with SUF:N --num-threads T     -> writes ./<PUBKEY>.json (JSON byte array, mode 0600)
//                                                  and prints "Wrote keypair to <PUBKEY>.json" per match
// FAKE_MODE (set by the per-test wrapper script): normal | hang (keeps finding keys, never exits) |
// fail (exit 1) | junk (also writes a file with the wrong suffix) | slow (sleeps 400 ms per key found)
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}
function keypair() {
  const kp = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const pub = kp.publicKey.subarray(kp.publicKey.length - 32);
  const seed = kp.privateKey.subarray(kp.privateKey.length - 32);
  return { pub: b58(pub), secret: [...seed, ...pub] };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE ?? 'normal';
if (args[0] === '--version') {
  console.log('solana-keygen 0.0.0-fake (src:00000000; feat:0, client:Fake)');
  process.exit(0);
}
if (args[0] !== 'grind') {
  console.error('fake solana-keygen: only --version and grind are supported');
  process.exit(2);
}
if (mode === 'fail') {
  console.error('error: simulated failure');
  process.exit(1);
}
const ends = args[args.indexOf('--ends-with') + 1] ?? '';
const [suffix, countText] = ends.split(':');
let left = Number(countText);
const threads = Number(args[args.indexOf('--num-threads') + 1] ?? '1');
console.log(`Searching with ${threads} threads for:`);
console.log(`\t${left} pubkeys that start with '' and end with '${suffix}'`);
if (mode === 'junk') {
  let other = keypair();
  while (other.pub.endsWith(suffix)) other = keypair();
  writeFileSync(`${other.pub}.json`, JSON.stringify(other.secret), { mode: 0o600 });
}
while (left > 0 || mode === 'hang') {
  const kp = keypair();
  if (!kp.pub.endsWith(suffix)) continue;
  if (mode === 'slow') await sleep(400);
  writeFileSync(`${kp.pub}.json`, JSON.stringify(kp.secret), { mode: 0o600 });
  console.log(`Wrote keypair to ${kp.pub}.json`);
  left--;
  if (mode === 'hang') await sleep(5);
}
