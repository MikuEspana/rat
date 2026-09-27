// Minimal Jupiter HTTP client: API key header, shared limiter, retries on 429 / 5xx / network errors.
import type { SlidingWindowLimiter } from './rate-limiter';

export class JupiterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'JupiterError';
  }
}

export interface JupiterHttpOptions {
  baseUrl: string;
  apiKey?: string;
  limiter: SlidingWindowLimiter;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class JupiterHttp {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: JupiterHttpOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
  }

  async get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v);
    const url = `${this.opts.baseUrl}${path}?${qs.toString()}`;
    const maxRetries = this.opts.maxRetries ?? 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.opts.limiter.acquire();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
      try {
        const res = await this.fetchImpl(url, {
          headers: this.opts.apiKey ? { 'x-api-key': this.opts.apiKey } : {},
          signal: controller.signal,
        });
        if (res.status === 429) {
          const reset = Number(res.headers.get('x-ratelimit-reset'));
          const until = Number.isFinite(reset) && reset > 0 ? reset * 1000 : this.now() + 1_000 * 2 ** attempt;
          this.opts.limiter.blockUntil(until);
          lastErr = new JupiterError('rate limited (429)', 429, await res.text());
          continue;
        }
        if (res.status >= 500) {
          lastErr = new JupiterError(`server error ${res.status}`, res.status, await res.text());
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        if (!res.ok) throw new JupiterError(`Jupiter ${path} failed: ${res.status}`, res.status, await res.text());
        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof JupiterError && err.status < 500 && err.status !== 429) throw err;
        lastErr = err;
        await this.sleep(500 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
