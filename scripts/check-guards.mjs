#!/usr/bin/env node
// Repository guard checks. Run in CI before typecheck and tests.
//
// 1. Only the RPC sender may send transactions.
// 2. No committed keypairs (64-number JSON arrays) anywhere.
// 3. .env.example never carries a secret value.
// 4. @rat/contract stays browser safe (no Node built-ins).
// 5. No holder payout code paths.
// 6. No em dashes in authored text (owner preference).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.pglite']);
const TEXT_EXT = /\.(ts|mts|js|mjs|json|md|yml|yaml|sql|toml|txt)$|^\.env\.example$|Dockerfile/;

// Paths (posix, relative to repo root) allowed to call a transaction send API.
const SEND_ALLOWLIST = new Set(['packages/chain/src/rpc-sender.ts']);
const SEND_PATTERN = /\b(sendRawTransaction|sendTransaction|sendAndConfirmTransaction|sendAndConfirmRawTransaction)\s*\(/;
const KEYPAIR_ARRAY = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/;
const NODE_IMPORT = /from\s+['"](node:[^'"]+|fs|path|crypto|os|child_process|worker_threads|net|http|https)['"]/;
const PAYOUT_PATTERN = /\b(airdrop\w*|payout\w*|distributeToHolders|holderReward\w*|payHolders)\b/i;
const SECRET_ENV_KEYS = [
  'KEY_ENCRYPTION_KEY',
  'DATABASE_URL',
  'DATABASE_URL_READONLY',
  'RPC_URL',
  'RPC_URL_BACKUP',
  'JUPITER_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'LIVE_CONFIRM',
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const failures = [];
const files = walk(ROOT).map((f) => ({ full: f, rel: relative(ROOT, f).split(sep).join('/') }));

for (const { full, rel } of files) {
  const base = rel.split('/').pop();
  if (!TEXT_EXT.test(base)) continue;
  if (rel === 'pnpm-lock.yaml' || rel === 'scripts/check-guards.mjs') continue;
  const text = readFileSync(full, 'utf8');

  if (/\.(ts|mts|js|mjs)$/.test(rel) && SEND_PATTERN.test(text) && !SEND_ALLOWLIST.has(rel)) {
    failures.push(`${rel}: transaction send call outside the allowed sender (${[...SEND_ALLOWLIST].join(', ')})`);
  }
  if (KEYPAIR_ARRAY.test(text)) {
    failures.push(`${rel}: looks like a committed keypair (64-number array)`);
  }
  if (rel.startsWith('packages/contract/src/') && NODE_IMPORT.test(text)) {
    failures.push(`${rel}: @rat/contract must stay browser safe (no Node built-in imports)`);
  }
  if (/^(packages|apps)\/[^/]+\/src\//.test(rel) && /\.ts$/.test(rel) && PAYOUT_PATTERN.test(text)) {
    failures.push(`${rel}: holder payout code is forbidden (profits never go to holders)`);
  }
  if (text.includes('—')) {
    failures.push(`${rel}: contains an em dash`);
  }
}

const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');
for (const line of envExample.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) continue;
  const [, key, value] = m;
  if (SECRET_ENV_KEYS.includes(key) && value.trim() !== '') {
    failures.push(`.env.example: ${key} must be empty in the example file`);
  }
  if (key === 'DRY_RUN' && value.trim() !== 'true') {
    failures.push('.env.example: DRY_RUN must default to true');
  }
}

if (failures.length) {
  console.error(`Guard checks failed (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`Guard checks passed (${files.length} files scanned).`);
