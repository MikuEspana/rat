// Jito tip accounts (read only). JSON-RPC getTipAccounts on <block engine>/bundles, as in Jito's official client
// (github.com/jito-labs/jito-js-rpc src/index.ts). Cached; only valid base58 public keys are kept.
import { type Clock, isBase58Pubkey, systemClock } from '@rat/core';

export class JitoTipAccounts {
  private cache: { at: number; accounts: string[] } | null = null;

  constructor(
    private readonly url: string,
    private readonly opts: { fetch?: typeof fetch; ttlMs?: number; clock?: Clock } = {},
  ) {}

  async get(): Promise<string[]> {
    const now = (this.opts.clock ?? systemClock).now().getTime();
    if (this.cache && now - this.cache.at < (this.opts.ttlMs ?? 3_600_000)) return this.cache.accounts;
    const res = await (this.opts.fetch ?? fetch)(`${this.url}/bundles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown } | null;
    const list = Array.isArray(body?.result) ? (body.result as unknown[]).filter((a): a is string => typeof a === 'string' && isBase58Pubkey(a)) : [];
    if (!res.ok || list.length === 0) throw new Error(`jito getTipAccounts failed (${res.status})`);
    this.cache = { at: now, accounts: list };
    return list;
  }
}
