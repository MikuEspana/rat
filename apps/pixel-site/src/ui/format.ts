// Display formatting for the HUD, feed, card and leaderboard.
import type { RatEvent, StateResponse, Tier } from '@rat/contract';
import { now as clockNow } from '../now';

export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '--';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1e4) return `${sign}$${compact(a)}`;
  return `${sign}$${a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '--';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function sol(n: number): string {
  return `${n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 3 : 1 })} SOL`;
}

/** Token amounts are decimal strings in the contract. */
export function tokens(s: string | null | undefined): string {
  const n = Number(s);
  return Number.isFinite(n) ? compact(n) : '--';
}

export function ago(iso: string, now = clockNow()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function signClass(n: number | null | undefined): 'up' | 'down' | 'flat' {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return 'flat';
  return n > 0 ? 'up' : 'down';
}

export const TIER_COLOR: Record<Tier | 'frozen', string> = {
  intern: '#7a5a32',
  analyst: '#2d3b6e',
  associate: '#2f6a3e',
  vp: '#b3243c',
  partner: '#23232b',
  frozen: '#8a8a92',
};

export const TIER_LABEL: Record<Tier | 'frozen', string> = {
  intern: 'Intern',
  analyst: 'Analyst',
  associate: 'Associate',
  vp: 'VP',
  partner: 'Partner',
  frozen: 'Frozen',
};

/**
 * A SOL amount for the stage bars and the roadmap: 0.62, 3.2, 72.4. Rounded down, so it never shows a stage's target
 * before the target is reached (0.2499 reads 0.24).
 */
export function solAmount(v: number): string {
  const a = Number.isFinite(v) ? Math.max(0, v) : 0;
  const d = a < 1 ? 2 : a < 100 ? 1 : 0;
  const f = 10 ** d;
  return (Math.floor(a * f + 1e-7) / f).toLocaleString('en-US', { maximumFractionDigits: d });
}

/**
 * Feed line for a new stage: the SOL milestone that opened it ("1 SOL claimed: FULL FLOOR"). The last stage is a
 * place, not a kind of company: the company made it there.
 */
export function stageLine(name: string, last: boolean, sol?: number): string {
  if (last) return 'The company made it to Wall Street';
  if (sol !== undefined) return `${solAmount(sol)} SOL claimed: ${name}`;
  const n = name.toLowerCase();
  return `The company is now ${/^[aeiou]/.test(n) ? 'an' : 'a'} ${n}`;
}

/** One feed line: a tag and a sentence. */
export function describe(e: RatEvent): { tag: string; text: string } {
  switch (e.type) {
    case 'hire':
      return { tag: 'HIRE', text: `${e.data.ratName} hired for ${e.data.stock} (${usd(e.data.costUsd)})` };
    case 'claim':
      return { tag: 'CLAIM', text: `${sol(e.data.amountSol)} in creator fees, all of it hires rats` };
    case 'freeze':
      return {
        tag: 'FREEZE',
        text: e.data.scope === 'stock' ? `${e.data.stock} paused: ${e.data.ratCount} rats frozen` : `Rat #${e.data.ratId} frozen (${e.data.reason.replace(/_/g, ' ')})`,
      };
    case 'unfreeze':
      return {
        tag: 'THAW',
        text: e.data.scope === 'stock' ? `${e.data.stock} resumed: ${e.data.ratCount} rats back at work` : `Rat #${e.data.ratId} back at work`,
      };
  }
}

/** Share of the wait from the last claim to the next one, 0..1 (null when unknown). */
export function claimProgress(last: string | null, next: string | null, now = clockNow()): number | null {
  if (!last || !next) return null;
  const a = Date.parse(last);
  const b = Date.parse(next);
  if (!(b > a)) return null;
  return Math.min(1, Math.max(0, (now - a) / (b - a)));
}

/** A claim this long overdue means the bot is not running its loop (starting, restarting or stalled). */
export const BOT_STALE_SEC = 90;

/**
 * The next-hire ring. While the bot is not running yet (right after launch the worker takes a few minutes to start)
 * it says so on purpose, instead of a countdown stuck at "hiring...".
 */
export function hireRing(
  s: { bot: Pick<StateResponse['bot'], 'mode' | 'lastClaimAt' | 'nextClaimAt'>; coin: Pick<StateResponse['coin'], 'mint'> },
  now = clockNow(),
  /** seconds overdue before the bot counts as not running (the simulator, whose clock runs up to 300x, turns it off) */
  staleSec = BOT_STALE_SEC,
): { label: string; progress: number | null; waiting: boolean } {
  const { mode, lastClaimAt, nextClaimAt } = s.bot;
  if (mode === 'paused') return { label: 'paused', progress: claimProgress(lastClaimAt, nextClaimAt, now), waiting: false };
  if (!s.coin.mint) return { label: 'opens at launch', progress: null, waiting: true };
  const next = nextClaimAt ? Math.round((Date.parse(nextClaimAt) - now) / 1000) : null;
  if (next === null || Number.isNaN(next)) {
    // no claim loop has ever run: the bot is starting. (The simulator, once its launch is over, has claims and no next.)
    return lastClaimAt ? { label: 'next hire --', progress: null, waiting: false } : { label: 'clocking in', progress: null, waiting: true };
  }
  if (next > 0) return { label: `next hire ${next}s`, progress: claimProgress(lastClaimAt, nextClaimAt, now), waiting: false };
  if (-next <= staleSec) return { label: 'hiring...', progress: 1, waiting: false };
  return { label: lastClaimAt ? 'back soon' : 'clocking in', progress: null, waiting: true };
}

/**
 * The banner above the HUD (null: no banner). Buyers read it: plain words, nothing technical (no "DRY RUN", no "kill
 * switch"). Before the bot goes live it says the rats are clocking in; if practice rats are ever on screen then, it
 * says plainly that they are not real money.
 */
export function bannerText(s: {
  bot: Pick<StateResponse['bot'], 'mode'>;
  coin: Pick<StateResponse['coin'], 'mint'>;
  portfolio?: Pick<StateResponse['portfolio'], 'ratCount'>;
}): string | null {
  if (s.bot.mode === 'paused') return '\u{1F400} The rats are on a break. Hiring is paused for now.';
  if (s.bot.mode !== 'dry_run') return null;
  const practice = (s.portfolio?.ratCount ?? 0) > 0 ? ' Practice rats only, not real money yet.' : '';
  return s.coin.mint ? `\u{1F400} The rats are clocking in...${practice}` : `\u{1F400} The rats are clocking in... Hiring starts at launch.${practice}`;
}

/** Under RATS HIRED. */
export function ratsSub(p: Pick<StateResponse['portfolio'], 'ratCount' | 'frozenCount'>, mode: StateResponse['bot']['mode']): string {
  if (p.ratCount === 0) return mode === 'live' ? 'first hire soon' : 'none yet';
  return p.frozenCount ? `${p.frozenCount} frozen` : 'all at work';
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st ... */
export function ordinal(n: number): string {
  const v = Math.abs(Math.trunc(n));
  const teen = v % 100 >= 11 && v % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[v % 10] ?? 'th';
  return `${n.toLocaleString('en-US')}${suffix}`;
}

/** The leaderboard with nobody on it. */
export function emptyBoardText(s: { coin: Pick<StateResponse['coin'], 'mint'>; portfolio: Pick<StateResponse['portfolio'], 'ratCount'> }): string {
  if (s.portfolio.ratCount > 0) return 'No rats to rank yet.';
  return s.coin.mint ? 'No rats yet. The first one is hired as soon as the fees cover its salary.' : 'No rats yet. Hiring opens at launch.';
}
