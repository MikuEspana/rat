// Runs a `rat` command inside the Railway worker container with the worker's settings.
//
// A `railway ssh` session does not get the service's variables, so a plain `pnpm rat ...` there has no
// DATABASE_URL or KEY_ENCRYPTION_KEY. This takes them, in order, from:
//   1. the running worker process (/proc/<pid>/environ: exactly what the worker runs with)
//   2. the service's variables sent as the FIRST LINE of stdin (JSON from `railway variable list --json`); with
//      RAT_SETTINGS_FROM=stdin (scripts/rat-local.sh) only these count
// The rest of stdin goes to the rat command (for example the creator key for `rat keys import`). No value is
// ever printed, logged or put on a command line.
//
// scripts/setup-mac.sh and scripts/rat.sh send this file (base64) and run:
//   node -e '<this file>' -- <rat arguments>      (or `-- --env-check` to test the settings are there)
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const REQUIRED = ['DATABASE_URL', 'KEY_ENCRYPTION_KEY'];
const complete = (env) => env && REQUIRED.every((k) => typeof env[k] === 'string' && env[k] !== '');

const seen = { processes: 0, unreadable: 0 }; // for the diagnosis (counts only)
function fromWorkerProcess() {
  let dirs = [];
  try {
    dirs = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d) && d !== String(process.pid));
  } catch {
    return null;
  }
  for (const d of dirs.sort((a, b) => Number(a) - Number(b))) {
    seen.processes++;
    let raw;
    try {
      raw = fs.readFileSync(`/proc/${d}/environ`, 'utf8');
    } catch {
      seen.unreadable++;
      continue;
    }
    const env = {};
    for (const kv of raw.split('\0')) {
      const i = kv.indexOf('=');
      if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    if (complete(env)) return env;
  }
  return null;
}

let input = Buffer.alloc(0);
try {
  input = fs.readFileSync(0);
} catch {
  // no stdin
}
const nl = input.indexOf(10);
const firstLine = (nl < 0 ? input : input.subarray(0, nl)).toString('utf8').trim();
const rest = nl < 0 ? Buffer.alloc(0) : input.subarray(nl + 1);
let sent = null;
if (firstLine.startsWith('{')) {
  try {
    const parsed = JSON.parse(firstLine);
    sent = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string'));
  } catch {
    sent = null;
  }
}

// scripts/rat-local.sh (on the Mac) sets RAT_SETTINGS_FROM=stdin: only the settings it sends count
const onlySent = process.env.RAT_SETTINGS_FROM === 'stdin';
const own = !onlySent && complete(process.env);
const proc = onlySent || own ? null : fromWorkerProcess();
const source = own ? 'this session' : proc ? 'the running worker' : complete(sent) ? 'the service variables' : null;
if (!source) {
  // what was tried, as names and counts only: never a value
  const line = !firstLine ? 'no settings line on stdin' : sent ? `settings line received, missing: ${REQUIRED.filter((k) => !sent[k]).join(', ')}` : 'settings line is not JSON';
  let user = '?';
  try {
    user = `${require('node:os').userInfo().username} (uid ${process.getuid()})`;
  } catch {}
  console.error('rat: the worker settings (DATABASE_URL, KEY_ENCRYPTION_KEY) are not available in this session');
  console.error(`rat: diagnosis: user ${user}; ${line}; ${seen.processes} other processes, ${seen.unreadable} with unreadable settings`);
  process.exit(3);
}
const env = { ...process.env, ...(own ? {} : proc ?? sent) };

// `node -e '<this file>' -- <args>` (inside the worker) or `node scripts/in-worker.cjs <args>` (scripts/rat-local.sh)
const args = process.argv.slice(process.argv[1] && require('node:path').resolve(process.argv[1]) === __filename ? 2 : 1);
if (args[0] === '--env-check') {
  console.log(`env-ok (settings from ${source})`);
  process.exit(0);
}
const r = spawnSync('pnpm', ['--silent', '--filter', '@rat/cli', 'rat', ...args], { env, input: rest, stdio: ['pipe', 'inherit', 'inherit'] });
if (r.error) console.error(`rat: could not start pnpm: ${r.error.message}`);
process.exit(r.status === null ? 1 : r.status);
