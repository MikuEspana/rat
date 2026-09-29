// The worker's database writes, fenced by the single-worker lease like its sends (GuardedSender).
//
// A worker can freeze in the middle of a tick (a hung RPC call, a paused container) for longer than its 120 s lease,
// and a replacement takes over. When the frozen one wakes up, the fence refuses its sends, but its database writes
// used to go through, made from rows it read before it froze: it released a reservation the replacement had just paid
// a hire with, or cleared the rat's pointer to it (then released as an orphan). The ledger then counted SOL the chain
// no longer had, and later hires spent the creator's own SOL (chaos seeds 2711 and 2789). Now every write first proves
// the lease is still ours (and renews it): a worker that lost it stops at its first write and writes nothing more.
import type { Store } from '@rat/db';

export class LeaseLostError extends Error {
  constructor() {
    super('lease_lost: another worker holds the worker lease; this worker writes nothing more');
    this.name = 'LeaseLostError';
  }
}

/**
 * Repository methods that only read. Every other method is a write and is fenced: a method missing from this list
 * (a new one) counts as a write, the safe side.
 */
export const STORE_READS: Readonly<Record<string, readonly string[]>> = {
  settings: ['get'],
  keys: ['all', 'counts', 'get', 'getRole'],
  ledger: ['balance', 'isOpen', 'lifetimeNetOutflow', 'list', 'netOutflowSince', 'openReservations', 'sumByReason'],
  attempts: ['all', 'bySignature', 'countByStatusSince', 'forRef', 'latest', 'latestForRef', 'signaturesKnown'],
  stocks: ['get', 'latestHistoryAt', 'list'],
  rats: ['batchAfter', 'byWallet', 'countByStatus', 'get', 'listByStatus', 'roster'],
  claims: ['all', 'bySig', 'openBot', 'totals'],
  events: ['after', 'countByType', 'lastId', 'latest'],
  heartbeats: ['all'],
  seen: ['unseen'],
};

/** Passed through untouched: the lease itself, the raw handle, the mode and the clock. */
const PASS = new Set<PropertyKey>(['locks', 'db', 'mode', 'clock']);

/** Late-bound lease check: open until bound (startup writes), then the runner's fence. */
export class LeaseGate {
  private check: (() => Promise<boolean>) | null = null;

  bind(check: () => Promise<boolean>): void {
    this.check = check;
  }

  holds(): Promise<boolean> {
    return this.check ? this.check() : Promise.resolve(true);
  }
}

/** The same store, with every write refused (LeaseLostError) once `holdsLease` says another worker took over. */
export function fenceWrites(store: Store, holdsLease: () => Promise<boolean>): Store {
  const check = async (): Promise<void> => {
    if (!(await holdsLease())) throw new LeaseLostError();
  };
  const repos = new Map<PropertyKey, unknown>();
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (PASS.has(prop)) return value;
      if (prop === 'transaction') {
        // checked once before it starts; inside, one transaction commits all or nothing
        return async <T>(fn: (s: Store) => Promise<T>): Promise<T> => {
          await check();
          return target.transaction(fn);
        };
      }
      if (prop === 'forMode') return (mode: Parameters<Store['forMode']>[0]) => fenceWrites(target.forMode(mode), holdsLease);
      if (typeof value === 'function') {
        // a method of the store itself (resetPaper): a write
        return async (...args: unknown[]) => {
          await check();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (value === null || typeof value !== 'object' || typeof prop !== 'string') return value;
      if (!repos.has(prop)) {
        const reads = new Set(STORE_READS[prop] ?? []);
        repos.set(
          prop,
          new Proxy(value, {
            get(repo, method, r) {
              const fn: unknown = Reflect.get(repo, method, r);
              if (typeof fn !== 'function') return fn;
              if (typeof method === 'string' && reads.has(method)) return (fn as (...a: unknown[]) => unknown).bind(repo);
              return async (...args: unknown[]) => {
                await check();
                return (fn as (...a: unknown[]) => unknown).apply(repo, args);
              };
            },
          }),
        );
      }
      return repos.get(prop);
    },
  });
}
