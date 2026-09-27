import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock';
import { avatarSeedFor, ratName } from './identity';

describe('identity', () => {
  it('avatar seed is stable 8 hex chars', () => {
    const s = avatarSeedFor('7xKpQm3vN8aLr2Tz9WcYh4sBd6FjE1uGkPoXqZyRAT');
    expect(s).toMatch(/^[0-9a-f]{8}$/);
    expect(avatarSeedFor('7xKpQm3vN8aLr2Tz9WcYh4sBd6FjE1uGkPoXqZyRAT')).toBe(s);
  });
  it('rat names pad to 4 digits', () => {
    expect(ratName(42)).toBe('Rat #0042');
    expect(ratName(1042)).toBe('Rat #1042');
    expect(ratName(12345)).toBe('Rat #12345');
  });
  it('fake clock advances and never goes backwards', () => {
    const c = new FakeClock('2026-10-01T00:00:00Z');
    c.advanceSeconds(35);
    expect(c.now().toISOString()).toBe('2026-10-01T00:00:35.000Z');
    expect(() => c.advance(-1)).toThrow();
  });
});
