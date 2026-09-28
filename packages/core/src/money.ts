// Lamports math. Every SOL amount inside the backend is a bigint of lamports.
// Decimals only appear at the edges (config input, API output, logs).

export const LAMPORTS_PER_SOL = 1_000_000_000n;
const SOL_DECIMALS = 9;

/** Parse a SOL amount ("0.03", 0.03) into lamports. Extra decimals beyond 9 are truncated. */
export function solToLamports(sol: string | number): bigint {
  let s: string;
  if (typeof sol === 'number') {
    if (!Number.isFinite(sol) || sol < 0) throw new Error(`invalid SOL amount: ${sol}`);
    s = sol.toFixed(SOL_DECIMALS);
  } else {
    s = sol.trim();
  }
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid SOL amount: ${String(sol)}`);
  const [whole = '0', frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(SOL_DECIMALS)).slice(0, SOL_DECIMALS);
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(fracPadded);
}

/** Lamports to a JS number of SOL. Display only: never feed the result back into math. */
export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / 1e9;
}

/** Exact decimal string of a raw integer amount with `decimals` places, trailing zeros trimmed. */
export function rawToDecimalString(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  if (decimals === 0) return `${negative ? '-' : ''}${abs.toString()}`;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`;
}

/** Exact SOL string for logs and messages. */
export function formatSol(lamports: bigint): string {
  return rawToDecimalString(lamports, SOL_DECIMALS);
}

/** floor(amount * bps / 10000) */
export function applyBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error(`invalid bps: ${bps}`);
  return (amount * BigInt(bps)) / 10_000n;
}

/**
 * The buy-and-burn fund's share of a claim: whatever HIRE_SPLIT_BPS does not send to hires, rounded down (the
 * rounding lamport stays with hires). 10000 (the default) = 0: every lamport pays for rats.
 */
export function fundShareOf(claimed: bigint, hireSplitBps: number): bigint {
  return applyBps(claimed, 10_000 - hireSplitBps);
}

export function minBig(...values: bigint[]): bigint {
  if (values.length === 0) throw new Error('minBig needs at least one value');
  return values.reduce((a, b) => (b < a ? b : a));
}

export function maxBig(...values: bigint[]): bigint {
  if (values.length === 0) throw new Error('maxBig needs at least one value');
  return values.reduce((a, b) => (b > a ? b : a));
}

export function sumBig(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/** Round to `places` decimals (display only). */
export function round(value: number, places = 2): number {
  const f = 10 ** places;
  return Math.round((value + Number.EPSILON) * f) / f;
}
