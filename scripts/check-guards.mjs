#!/usr/bin/env node
// Repository guard checks. Run in CI before typecheck and tests.
//
// 1. Only the RPC sender may send transactions.
// 2. No committed keypairs (64-number JSON arrays) anywhere.
// 3. .env.example never carries a secret value.
// 4. @rat/contract stays browser safe (no Node built-ins).
// 5. No holder payout code paths.
// 6. No em dashes in authored text (owner preference).
// 7. No token burn code outside tests: buy and burn was removed, every claimed fee hires rats.
// 9. One Postgres major: CI and setup follow infra/backup/Dockerfile.
// 8. Rehearsal-only switches are never turned on in a deploy or setup file (scripts, Railway files, workflows,
//    Dockerfiles, .env files) except the staging scripts; the runtime also refuses them with the production creator.
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
const BURN_PATTERN = /\b(createBurn\w*Instruction|buildBurnInstruction|burnIx)\b/;
const SECRET_ENV_KEYS = [
  'KEY_ENCRYPTION_KEY',
  'DATABASE_URL',
  'DATABASE_URL_READONLY',
  'RPC_URL',
  'RPC_URL_BACKUP',
  'JUPITER_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'LIVE_CONFIRM',
  'RAT_API_DB_PASSWORD',
  'BACKUP_S3_ACCESS_KEY_ID',
  'BACKUP_S3_SECRET_ACCESS_KEY',
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
  if (/^(packages|apps)\/[^/]+\/src\//.test(rel) && /\.ts$/.test(rel) && !/\.test\.ts$/.test(rel) && BURN_PATTERN.test(text)) {
    failures.push(`${rel}: token burn code is forbidden (buy and burn was removed; every claimed fee hires rats)`);
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

// 8. rehearsal-only switches in deploy and setup files
const STAGING_ON = /\bSTAGING['"]?\s*[=:]\s*['"]?(true|1|yes)\b|\bSTAGING_CRASH_AFTER_SEND['"]?\s*[=:]\s*['"]?[1-9]/i;
const DEPLOY_FILE = /\.(sh|json|ya?ml|toml)$|^\.env|Dockerfile/;
const STAGING_ALLOW = new Set(['scripts/setup-staging.sh', 'scripts/staging.sh']);
for (const { full, rel } of files) {
  const base = rel.split('/').pop();
  if (!DEPLOY_FILE.test(base) || rel === 'pnpm-lock.yaml' || STAGING_ALLOW.has(rel) || rel.startsWith('tests/')) continue;
  if (STAGING_ON.test(readFileSync(full, 'utf8'))) failures.push(`${rel}: turns on a rehearsal-only switch (STAGING / STAGING_CRASH_AFTER_SEND); only the staging scripts may`);
}

// 9. One Postgres major everywhere: the backup image (infra/backup/Dockerfile) is the source of truth; CI's
//    database and client must match it, and setup reads it (never a hard-coded postgresql@N)
{
  const major = (readFileSync(join(ROOT, 'infra/backup/Dockerfile'), 'utf8').match(/^FROM postgres:(\d+)-alpine/m) ?? [])[1];
  if (!major) failures.push('infra/backup/Dockerfile: no FROM postgres:N-alpine line');
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  for (const [what, re] of [['service image postgres', /image: postgres:(\d+)/g], ['postgresql-client', /postgresql-client-(\d+)/g], ['client path', /\/usr\/lib\/postgresql\/(\d+)\/bin/g]]) {
    const seen = [...ci.matchAll(re)].map((m) => m[1]);
    if (seen.length === 0) failures.push(`.github/workflows/ci.yml: no ${what} version found`);
    for (const v of seen) if (v !== major) failures.push(`.github/workflows/ci.yml: ${what} ${v}, but infra/backup/Dockerfile is Postgres ${major}`);
  }
  if (/postgresql@\d+/.test(readFileSync(join(ROOT, 'scripts/setup-mac.sh'), 'utf8'))) {
    failures.push('scripts/setup-mac.sh: a hard-coded postgresql@N; read the major from infra/backup/Dockerfile');
  }
}

if (failures.length) {
  console.error(`Guard checks failed (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`Guard checks passed (${files.length} files scanned).`);
