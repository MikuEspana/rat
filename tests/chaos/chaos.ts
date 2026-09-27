// Chaos harness (in-memory only): wraps the database repos, the chain reader / sender and Jupiter so a test can
// kill the worker right before its k-th operation (every later call hangs forever, like a dead process), or make
// the RPC, the database or Jupiter fail from the k-th call on.
import { JupiterError } from '@rat/jupiter';
import type { Store } from '@rat/db';
import type { SimWorld, WorldParts } from '@rat/worker';

export type OpKind = 'db' | 'rpc' | 'jupiter';

export class Chaos {
  readonly ops: { kind: OpKind; name: string }[] = [];
  readonly counts: Record<OpKind, number> = { db: 0, rpc: 0, jupiter: 0 };
  /** hang forever at this operation (1-based, counted across all kinds); 0 = never */
  killAt = 0;
  dead = false;
  /** every call of this kind fails from its `from`-th call on (1-based) */
  failing: { kind: OpKind; from: number } | null = null;
  /** every call of these kinds fails (an outage) */
  readonly down = new Set<OpKind>();
  private markDead!: () => void;
  readonly died = new Promise<void>((resolve) => {
    this.markDead = resolve;
  });

  wrap<T extends object>(obj: T, kind: OpKind, label: string): T {
    const chaos = this;
    return new Proxy(obj, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function' || prop === 'constructor') return value;
        return (...args: unknown[]) => {
          if (chaos.dead) return new Promise(() => {});
          chaos.ops.push({ kind, name: `${label}.${String(prop)}` });
          chaos.counts[kind]++;
          if (chaos.killAt > 0 && chaos.ops.length === chaos.killAt) {
            chaos.dead = true;
            chaos.markDead();
            return new Promise(() => {});
          }
          const f = chaos.failing;
          if (chaos.down.has(kind) || (f && f.kind === kind && chaos.counts[kind] >= f.from)) {
            return Promise.reject(kind === 'jupiter' ? new JupiterError('rate limited (429)', 429, 'chaos') : new Error(`${kind} down: ${label}.${String(prop)}`));
          }
          return value.apply(target, args);
        };
      },
    });
  }

  /** The store with every repository wrapped (the raw drizzle handle is left alone). */
  wrapStore(store: Store): Store {
    const cache = new Map<PropertyKey, unknown>();
    const chaos = this;
    return new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'db' || value === null || typeof value !== 'object') return value;
        if (!cache.has(prop)) cache.set(prop, chaos.wrap(value as object, 'db', String(prop)));
        return cache.get(prop);
      },
    });
  }

  /** World parts with every outside dependency wrapped. */
  parts(w: SimWorld): WorldParts {
    return {
      store: this.wrapStore(w.store),
      reader: this.wrap(w.reader, 'rpc', 'chain'),
      sender: this.wrap(w.simSender, 'rpc', 'send'),
      swap: this.wrap(w.swap, 'jupiter', 'swap'),
      prices: this.wrap(w.prices, 'jupiter', 'prices'),
    };
  }
}
