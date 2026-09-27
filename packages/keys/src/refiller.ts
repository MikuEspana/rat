// Grinds rat keys straight into the encrypted pool, and the background refiller the worker uses.
//   auto: solana-keygen when it is installed (it is in the Docker image), else the built-in JS grinder
// The refiller never blocks the bot loop: maybeStart() kicks off one batch in the background and returns.
import { readdirSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import type { GrinderChoice, KeyPoolStore, Logger } from '@rat/core';
import { grindVanityKeys } from './grinder';
import { readKeypairFile, shredFile } from './import-files';
import { storeRatKeys } from './keystore';
import { type KeygenInfo, detectSolanaKeygen, makePrivateGrindDir, runSolanaKeygenGrind } from './solana-keygen';
import type { MasterKeyRing } from './vault';

export type GrinderKind = 'solana-keygen' | 'js';

export interface GrindIntoPoolOptions {
  kind: GrinderKind;
  suffix: string;
  count: number;
  /** 0 or undefined = CPU count minus one */
  threads?: number;
  timeoutMs: number;
  keygenPath: string;
  /** parent folder for plaintext files (tests); default /dev/shm or the OS temp dir */
  workDirRoot?: string;
  signal?: AbortSignal;
  log?: Logger;
}

export interface GrindIntoPoolResult {
  grinder: GrinderKind;
  requested: number;
  added: number;
  skipped: number;
  elapsedMs: number;
  timedOut: boolean;
  error?: string;
}

/** auto = solana-keygen when it works and the suffix is non-empty, else the built-in JS grinder. */
export function resolveGrinder(choice: GrinderChoice, suffix: string, detect: () => KeygenInfo): GrinderKind | null {
  if (choice === 'off') return null;
  if (choice === 'js' || choice === 'solana-keygen') return choice;
  return suffix && detect().ok ? 'solana-keygen' : 'js';
}

export function defaultGrindThreads(threads?: number): number {
  return threads && threads > 0 ? threads : Math.max(1, availableParallelism() - 1);
}

/** Removes every file left in a grind folder (zero-overwritten first), then the folder. */
function sweepDir(dir: string): void {
  try {
    for (const f of readdirSync(dir)) {
      try {
        shredFile(join(dir, f));
      } catch {
        // already gone
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Grinds `count` keys and stores them encrypted. Never leaves a plaintext file behind. */
export async function grindIntoPool(pool: KeyPoolStore, ring: MasterKeyRing, o: GrindIntoPoolOptions): Promise<GrindIntoPoolResult> {
  const threads = defaultGrindThreads(o.threads);
  const started = Date.now();
  if (o.kind === 'js') {
    const res = await grindVanityKeys({ suffix: o.suffix, count: o.count, threads, timeoutMs: o.timeoutMs, signal: o.signal });
    const added = await storeRatKeys(pool, ring, res.keys);
    return { grinder: 'js', requested: o.count, added, skipped: res.keys.length - added, elapsedMs: Date.now() - started, timedOut: res.keys.length < o.count && !o.signal?.aborted };
  }

  const dir = makePrivateGrindDir(o.workDirRoot);
  let added = 0;
  let skipped = 0;
  const importOne = async (path: string) => {
    try {
      const kp = readKeypairFile(path, o.suffix);
      added += await storeRatKeys(pool, ring, [kp]);
    } catch (err) {
      skipped++;
      o.log?.warn({ file: path.split('/').pop(), reason: (err as Error).message }, 'grind file not imported');
    } finally {
      try {
        shredFile(path);
      } catch {
        // missing file: nothing to shred
      }
    }
  };
  try {
    const r = await runSolanaKeygenGrind({ bin: o.keygenPath, suffix: o.suffix, count: o.count, threads, timeoutMs: o.timeoutMs, dir, signal: o.signal, onKeyFile: importOne, log: o.log });
    // A key written just before the kill but not yet reported still counts.
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) await importOne(join(dir, f));
    const failed = r.exitCode !== 0 && !r.timedOut && !r.aborted && r.reported < o.count;
    return {
      grinder: 'solana-keygen',
      requested: o.count,
      added,
      skipped,
      elapsedMs: Date.now() - started,
      timedOut: r.timedOut,
      error: failed ? `solana-keygen exited with ${r.exitCode}: ${r.stderr.slice(0, 300)}` : undefined,
    };
  } finally {
    sweepDir(dir);
  }
}

export interface RefillerOptions {
  suffix: string;
  refillBelow: number;
  target: number;
  batch: number;
  grinder: GrinderChoice;
  threads: number;
  timeoutMs: number;
  keygenPath: string;
  workDirRoot?: string;
}

export interface RefillStart {
  started: boolean;
  count: number;
  grinder: GrinderKind | null;
  reason?: string;
}

export class KeyPoolRefiller {
  private current: { promise: Promise<GrindIntoPoolResult>; abort: AbortController } | null = null;
  private keygen: KeygenInfo | null = null;
  last: GrindIntoPoolResult | null = null;

  constructor(
    private readonly deps: {
      pool: KeyPoolStore;
      ring: MasterKeyRing;
      log?: Logger;
      /** called after every batch (alerts on errors) */
      onResult?: (r: GrindIntoPoolResult) => void | Promise<void>;
      detect?: (bin: string) => KeygenInfo;
    },
    private readonly opts: RefillerOptions,
  ) {}

  /** solana-keygen detection, cached. */
  keygenInfo(): KeygenInfo {
    if (!this.keygen) this.keygen = (this.deps.detect ?? detectSolanaKeygen)(this.opts.keygenPath);
    return this.keygen;
  }

  /** The grinder the next batch will use, or null when grinding is off. */
  grinderKind(): GrinderKind | null {
    return resolveGrinder(this.opts.grinder, this.opts.suffix, () => this.keygenInfo());
  }

  get busy(): boolean {
    return this.current !== null;
  }

  /** Starts one background batch when the pool is below the refill threshold. Never throws, never blocks. */
  maybeStart(available: number): RefillStart {
    if (this.current) return { started: false, count: 0, grinder: null, reason: 'already grinding' };
    if (available >= this.opts.refillBelow) return { started: false, count: 0, grinder: null, reason: 'pool above refill threshold' };
    const kind = this.grinderKind();
    if (!kind) return { started: false, count: 0, grinder: null, reason: 'grinder off' };
    const count = Math.min(this.opts.target - available, this.opts.batch);
    if (count <= 0) return { started: false, count: 0, grinder: null, reason: 'nothing to grind' };
    const abort = new AbortController();
    const promise = grindIntoPool(this.deps.pool, this.deps.ring, {
      kind,
      suffix: this.opts.suffix,
      count,
      threads: this.opts.threads,
      timeoutMs: this.opts.timeoutMs,
      keygenPath: this.opts.keygenPath,
      workDirRoot: this.opts.workDirRoot,
      signal: abort.signal,
      log: this.deps.log,
    })
      .catch((err): GrindIntoPoolResult => ({ grinder: kind, requested: count, added: 0, skipped: 0, elapsedMs: 0, timedOut: false, error: (err as Error).message }))
      .then(async (r) => {
        this.last = r;
        this.current = null;
        this.deps.log?.info({ ...r }, 'key pool refill batch finished');
        try {
          await this.deps.onResult?.(r);
        } catch {
          // alerting must never break the refiller
        }
        return r;
      });
    this.current = { promise, abort };
    return { started: true, count, grinder: kind };
  }

  /** Resolves when the running batch (if any) is done. */
  async wait(): Promise<GrindIntoPoolResult | null> {
    return this.current ? this.current.promise : null;
  }

  /** Stops the running batch (kills solana-keygen / the JS threads) and waits for its cleanup. */
  async stop(): Promise<void> {
    if (!this.current) return;
    this.current.abort.abort();
    await this.current.promise;
  }
}
