// Display formatting for the HUD, feed, card and leaderboard.
import type { RatEvent, Tier } from '@rat/contract';
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
