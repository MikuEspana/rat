// Runs the real `solana-keygen grind` (Agave CLI) as a child process. Behavior checked against the Agave
// source (keygen/src/keygen.rs): `grind --ends-with SUFFIX:COUNT --num-threads N` matches case-sensitively
// (no --ignore-case), writes every match to ./<PUBKEY>.json in its working directory (file mode 0600) and
// prints "Wrote keypair to <PUBKEY>.json". We import and shred each file as soon as that line appears, so a
// plaintext key sits in a private folder (a RAM disk when /dev/shm exists) for milliseconds, not minutes.
// The child never sees our environment (no master key, no database URL): it gets PATH and a throwaway HOME.
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@rat/core';
import { isValidSuffix } from './grinder';

export interface KeygenInfo {
  ok: boolean;
  version?: string;
  error?: string;
}

/** `solana-keygen --version`. Never throws. */
export function detectSolanaKeygen(bin: string): KeygenInfo {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000, env: childEnv(tmpdir()) });
    if (r.error) return { ok: false, error: r.error.message };
    if (r.status !== 0) return { ok: false, error: `exit ${r.status}: ${(r.stderr ?? '').trim().slice(0, 200)}` };
    const out = (r.stdout ?? '').trim();
    if (!/solana-keygen/.test(out)) return { ok: false, error: `unexpected --version output: ${out.slice(0, 120)}` };
    return { ok: true, version: out };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

let niceChecked: boolean | null = null;
/** true when `nice` exists (coreutils), so grind threads run at a lower priority than the bot loop. */
export function hasNice(): boolean {
  if (niceChecked === null) {
    const r = spawnSync('nice', ['-n', '10', 'true'], { timeout: 5_000 });
    niceChecked = !r.error && r.status === 0;
  }
  return niceChecked;
}

function childEnv(home: string): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C' };
}

function isWritableDir(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** A fresh private (0700) folder for plaintext key files. Prefers /dev/shm (RAM) over the disk. */
export function makePrivateGrindDir(root?: string): string {
  const base = root ?? (isWritableDir('/dev/shm') ? '/dev/shm' : tmpdir());
  return mkdtempSync(join(base, 'rat-grind-'));
}

const WROTE_LINE = /^Wrote keypair to (\S+)$/;
const KEY_FILE = /^[1-9A-HJ-NP-Za-km-z]{32,44}\.json$/;

export interface KeygenGrindOptions {
  bin: string;
  suffix: string;
  count: number;
  threads: number;
  timeoutMs: number;
  /** working directory, from makePrivateGrindDir() */
  dir: string;
  /** run under `nice -n 10` when available (default true) */
  nice?: boolean;
  signal?: AbortSignal;
  /** called once per reported key file; must import and shred it. Calls are serialized. */
  onKeyFile: (path: string) => Promise<void>;
  log?: Logger;
}

export interface KeygenGrindResult {
  /** "Wrote keypair" lines seen */
  reported: number;
  timedOut: boolean;
  aborted: boolean;
  exitCode: number | null;
  elapsedMs: number;
  stderr: string;
}

/**
 * Grinds `count` keys with solana-keygen. The process is killed as soon as `count` files were reported
 * (we never rely on it stopping by itself), at the timeout, or on abort. Resolves after every reported
 * file was handed to `onKeyFile`. Leftover files in `dir` are the caller's to sweep.
 */
export function runSolanaKeygenGrind(opts: KeygenGrindOptions): Promise<KeygenGrindResult> {
  if (!opts.suffix || !isValidSuffix(opts.suffix)) {
    return Promise.reject(new Error(`solana-keygen needs a non-empty base58 suffix, got "${opts.suffix}"`));
  }
  if (!Number.isInteger(opts.count) || opts.count <= 0) return Promise.reject(new Error('count must be a positive integer'));
  const args = ['grind', '--ends-with', `${opts.suffix}:${opts.count}`, '--num-threads', String(Math.max(1, opts.threads))];
  const useNice = opts.nice !== false && hasNice();
  const [cmd, argv] = useNice ? ['nice', ['-n', '10', opts.bin, ...args]] : [opts.bin, args];
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd: opts.dir, env: childEnv(opts.dir), stdio: ['ignore', 'pipe', 'pipe'] });
    let reported = 0;
    let timedOut = false;
    let aborted = false;
    let stderr = '';
    let buffered = '';
    let chain: Promise<void> = Promise.resolve();
    let handlerError: Error | null = null;

    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    const onLine = (line: string) => {
      const m = WROTE_LINE.exec(line.trim());
      if (!m) return;
      const name = m[1]!;
      if (!KEY_FILE.test(name)) {
        opts.log?.warn({ line }, 'solana-keygen reported an unexpected file name; it will be swept, not imported');
        return;
      }
      reported++;
      const path = join(opts.dir, name);
      chain = chain.then(() => opts.onKeyFile(path)).catch((err) => {
        handlerError = err as Error;
      });
      if (reported >= opts.count) kill();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      let nl = buffered.indexOf('\n');
      while (nl >= 0) {
        onLine(buffered.slice(0, nl));
        buffered = buffered.slice(nl + 1);
        nl = buffered.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (buffered) onLine(buffered);
      chain.then(() => {
        if (handlerError) reject(handlerError);
        else resolve({ reported, timedOut, aborted, exitCode: code, elapsedMs: Date.now() - started, stderr: stderr.trim() });
      });
    });
  });
}
