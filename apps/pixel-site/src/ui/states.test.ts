// What the site says in the states around launch: before the coin, the bot starting, no rats yet, paused.
import { describe, expect, it } from 'vitest';
import { BOT_STALE_SEC, bannerText, emptyBoardText, hireRing, ordinal, ratsSub } from './format';
import { headlines, type NewsStats } from './news';

const now = Date.parse('2026-10-01T18:00:00Z');
const at = (sec: number): string => new Date(now + sec * 1000).toISOString();
const MINT = 'RaTRaceMockMint1111111111111111111111111pump';
const ring = (bot: { mode: 'live' | 'dry_run' | 'paused'; lastClaimAt: string | null; nextClaimAt: string | null }, mint: string | null = MINT) =>
  hireRing({ bot, coin: { mint } }, now);

describe('next-hire ring', () => {
  it('counts down while the bot runs, then says hiring for a short while', () => {
    expect(ring({ mode: 'live', lastClaimAt: at(-15), nextClaimAt: at(20) })).toMatchObject({ label: 'next hire 20s', waiting: false });
    expect(ring({ mode: 'live', lastClaimAt: at(-40), nextClaimAt: at(-5) })).toMatchObject({ label: 'hiring...', progress: 1, waiting: false });
    expect(ring({ mode: 'live', lastClaimAt: at(-40), nextClaimAt: at(-BOT_STALE_SEC) }).label).toBe('hiring...');
  });

  it('right after launch (no claim loop yet, or a stale one) it says the bot is starting, never a stuck "hiring..."', () => {
    expect(ring({ mode: 'live', lastClaimAt: null, nextClaimAt: null })).toEqual({ label: 'bot starting', progress: null, waiting: true });
    // the last heartbeat is from before the redeploy: minutes old
    expect(ring({ mode: 'live', lastClaimAt: null, nextClaimAt: at(-300) })).toEqual({ label: 'bot starting', progress: null, waiting: true });
    // it ran before and stopped (a restart): it comes back on its own
    expect(ring({ mode: 'live', lastClaimAt: at(-600), nextClaimAt: at(-300) })).toEqual({ label: 'back soon', progress: null, waiting: true });
    // no next claim but claims before (the simulator after its launch ends): no countdown, no "starting"
    expect(ring({ mode: 'live', lastClaimAt: at(-600), nextClaimAt: null })).toEqual({ label: 'next hire --', progress: null, waiting: false });
    // a DRY RUN bot that is not up yet reads the same way
    expect(ring({ mode: 'dry_run', lastClaimAt: null, nextClaimAt: null }).label).toBe('bot starting');
  });

  it('the simulator (clock up to 300x, polled 4 times a second) never reads as a stalled bot', () => {
    const late = { bot: { mode: 'live' as const, lastClaimAt: at(-400), nextClaimAt: at(-300) }, coin: { mint: MINT } };
    expect(hireRing(late, now, Number.POSITIVE_INFINITY)).toMatchObject({ label: 'hiring...', waiting: false });
  });

  it('before the coin exists, hiring opens at launch', () => {
    expect(ring({ mode: 'dry_run', lastClaimAt: null, nextClaimAt: null }, null)).toMatchObject({ label: 'opens at launch', waiting: true });
    expect(ring({ mode: 'dry_run', lastClaimAt: at(-10), nextClaimAt: at(25) }, null).label).toBe('opens at launch');
  });

  it('paused wins over everything', () => {
    expect(ring({ mode: 'paused', lastClaimAt: null, nextClaimAt: null })).toMatchObject({ label: 'paused', waiting: false });
    expect(ring({ mode: 'paused', lastClaimAt: at(-600), nextClaimAt: at(-300) }).label).toBe('paused');
  });
});

describe('banner', () => {
  it('DRY RUN before and after the coin exists; PAUSED; nothing when live', () => {
    const pre = bannerText({ bot: { mode: 'dry_run' }, coin: { mint: null } })!;
    const warm = bannerText({ bot: { mode: 'dry_run' }, coin: { mint: MINT } })!;
    // tools/verify-live.mjs looks for these prefixes on the published site
    expect(pre.startsWith('DRY RUN:')).toBe(true);
    expect(warm.startsWith('DRY RUN:')).toBe(true);
    expect(pre).toMatch(/pre-launch/);
    expect(pre).toMatch(/not real money|Nothing on this page is real money/);
    expect(warm).toMatch(/warming up/);
    expect(warm).toMatch(/simulated/);
    expect(bannerText({ bot: { mode: 'paused' }, coin: { mint: MINT } })!.startsWith('PAUSED:')).toBe(true);
    expect(bannerText({ bot: { mode: 'live' }, coin: { mint: MINT } })).toBeNull();
  });
});

describe('no rats yet', () => {
  it('RATS HIRED does not say "all at work" with nobody hired', () => {
    expect(ratsSub({ ratCount: 0, frozenCount: 0 }, 'live')).toBe('first hire soon');
    expect(ratsSub({ ratCount: 0, frozenCount: 0 }, 'dry_run')).toBe('none yet');
    expect(ratsSub({ ratCount: 0, frozenCount: 0 }, 'paused')).toBe('none yet');
    expect(ratsSub({ ratCount: 5, frozenCount: 0 }, 'live')).toBe('all at work');
    expect(ratsSub({ ratCount: 5, frozenCount: 2 }, 'live')).toBe('2 frozen');
  });

  it('the leaderboard explains why it is empty', () => {
    expect(emptyBoardText({ coin: { mint: null }, portfolio: { ratCount: 0 } })).toMatch(/opens at launch/);
    expect(emptyBoardText({ coin: { mint: MINT }, portfolio: { ratCount: 0 } })).toMatch(/first one is hired/);
  });

  const stats = (rats: number, stage = 0): NewsStats => ({
    stage,
    rats,
    frozen: 0,
    fund: '$0.00',
    mcap: '$1.80M',
    price: '$0.00182',
    topStock: 'NOBODY',
    topRats: 0,
    worstStock: 'NOBODY',
    worstPct: '--',
    bestRat: 'nobody',
    bestPct: '--',
  });

  it('the news ticker never says "0TH RAT" or counts zero rats', () => {
    const zero = headlines(stats(0)).join(' / ');
    expect(zero).not.toMatch(/\b0 ?(TH|RATS)\b|NOBODY/);
    expect(zero).toMatch(/FIRST RAT/);
    // every stage with 0 rats (the stage goes by SOL claimed, so a stage can come before the first hire)
    for (let stage = 0; stage < 6; stage++) expect(headlines(stats(0, stage)).join(' / ')).not.toMatch(/\b0 RATS\b|0TH/);
  });

  it('ordinals are English', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 1234].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th', '1,234th',
    ]);
    expect(headlines(stats(1)).join(' / ')).toMatch(/ITS 1ST RAT/);
    expect(headlines(stats(22)).join(' / ')).toMatch(/ITS 22ND RAT/);
  });
});
