import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RatEvent } from '@rat/contract';
import eventsJson from '@rat/contract/mock/events.json';
import { STAGES } from '../floor/plan';
import { ago, claimProgress, compact, describe as line, pct, stageLine, usd } from './format';

describe('format', () => {
  it('formats money, percentages and big numbers compactly', () => {
    expect(usd(1797531)).toBe('$1.80M');
    expect(usd(5.41)).toBe('$5.41');
    expect(usd(-682.4)).toBe('-$682.40');
    expect(usd(null)).toBe('--');
    expect(pct(4.16)).toBe('+4.16%');
    expect(pct(-12)).toBe('-12.00%');
    expect(compact(12345678.9)).toBe('12.35M');
  });

  it('says how long ago', () => {
    const now = Date.parse('2026-10-01T18:00:00Z');
    expect(ago('2026-10-01T17:59:48Z', now)).toBe('12s ago');
    expect(ago('2026-10-01T17:57:00Z', now)).toBe('3m ago');
  });

  it('describes every event type in the mock feed without an em dash, and never shows a burn', () => {
    const events = (eventsJson as { events: RatEvent[] }).events;
    const types = new Set(events.map((e) => e.type));
    expect(types.size).toBeGreaterThanOrEqual(3);
    for (const e of events) {
      const d = line(e);
      if (!d) throw new Error(`no line for ${e.type}`);
      expect(d.tag.length).toBeGreaterThan(0);
      expect(`${d.tag} ${d.text}`.toLowerCase()).not.toContain('burn');
      expect(d.text.length).toBeGreaterThan(5);
      expect(d.text).not.toContain(String.fromCharCode(0x2014)); // no em dashes in owner-facing text
    }
  });

  it('computes the next-hire ring from the claim schedule', () => {
    const now = Date.parse('2026-10-01T18:00:10Z');
    expect(claimProgress('2026-10-01T18:00:00Z', '2026-10-01T18:00:20Z', now)).toBeCloseTo(0.5);
    expect(claimProgress(null, '2026-10-01T18:00:20Z', now)).toBeNull();
    expect(claimProgress('2026-10-01T18:00:00Z', '2026-10-01T17:00:00Z', now)).toBeNull();
  });

  it('is WALL STREET RATS everywhere a viewer can read it (no RAT RACE left in the site)', () => {
    const root = join(__dirname, '..', '..');
    const files: string[] = [join(root, 'index.html')];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|css)$/.test(f) && !f.endsWith('.test.ts')) files.push(p);
      }
    };
    walk(join(root, 'src'));
    const hits = files.filter((f) => /rat race/i.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    expect(html).toContain('<title>WALL STREET RATS</title>');
    expect(html).toContain('<meta property="og:title" content="WALL STREET RATS" />');
  });

  it('announces every stage in the feed; the last one reads as a place (the company made it to Wall Street)', () => {
    const lines = STAGES.map((st, k) => stageLine(st.name, k === STAGES.length - 1));
    expect(lines[0]).toBe('The company is now a garage startup');
    expect(lines[STAGES.length - 1]).toBe('The company made it to Wall Street');
    for (const l of lines) {
      expect(l).not.toMatch(/now an? wall street/i);
      expect(l).not.toMatch(/evil empire/i);
    }
  });
});
