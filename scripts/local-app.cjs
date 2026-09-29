// Runs one part of the bot on THIS Mac for the fast rehearsal (scripts/staging-local.sh): the worker, the API or the
// site. The settings arrive as ONE JSON line on stdin (from `railway variable list`), never on a command line, never
// printed, never written to disk. The app runs with only those settings plus PATH, HOME and LANG, so nothing from this
// Mac's own shell can point it somewhere else. SIGTERM and SIGINT are passed on: a stop lets the worker finish its
// current tick and release its lock.
//   printf '%s\n' "$settings" | node scripts/local-app.cjs worker
//   printf '{}\n' | node scripts/local-app.cjs site --port 5173 --strictPort
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
// every app runs from its own folder, TypeScript straight from source (the same code the Dockerfile runs)
const APPS = {
  worker: { dir: 'apps/worker', args: ['--import', 'tsx', 'src/main.ts'], needs: ['DATABASE_URL', 'KEY_ENCRYPTION_KEY'] },
  api: { dir: 'apps/api', args: ['--import', 'tsx', 'src/main.ts'], needs: ['DATABASE_URL_READONLY'] },
  site: { dir: 'apps/pixel-site', args: ['node_modules/vite/bin/vite.js'], needs: [] },
};
const name = process.argv[2];
const app = APPS[name];
if (!app) {
  console.error('local-app: which app? worker | api | site');
  process.exit(2);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let settings;
  try {
    settings = JSON.parse(input.split('\n')[0] || '{}');
  } catch {
    console.error('local-app: the settings line is not JSON');
    process.exit(3);
  }
  // names only, never a value
  const missing = app.needs.filter((k) => typeof settings[k] !== 'string' || settings[k] === '');
  if (missing.length > 0) {
    console.error(`local-app: ${name} is missing settings: ${missing.join(', ')}`);
    process.exit(3);
  }
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || 'en_US.UTF-8', ...settings };
  const child = spawn(process.execPath, [...app.args, ...process.argv.slice(3)], {
    cwd: path.join(root, app.dir),
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true, // its own session: closing the Terminal window does not stop it (scripts/staging-local.sh stop does)
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
  child.on('error', (err) => {
    console.error(`local-app: could not start ${name}: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code === null ? (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1) : code));
});
