import { describe, expect, it } from 'vitest';
import { nextPopKind } from './money';

describe('money popups', () => {
  it('let claims (gold) and hires (green) take turns, so a rush of claims never hides the stock bought', () => {
    expect(nextPopKind({ claim: 0, hire: 0 }, null)).toBeNull();
    expect(nextPopKind({ claim: 5, hire: 0 }, 'claim')).toBe('claim');
    expect(nextPopKind({ claim: 0, hire: 5 }, 'hire')).toBe('hire');
    // both waiting: whichever did not go last
    expect(nextPopKind({ claim: 5, hire: 5 }, null)).toBe('claim');
    expect(nextPopKind({ claim: 5, hire: 5 }, 'claim')).toBe('hire');
    expect(nextPopKind({ claim: 5, hire: 5 }, 'hire')).toBe('claim');
    // claims every tick: hires still get every other popup
    let last: 'claim' | 'hire' | null = null;
    const shown: string[] = [];
    for (let k = 0; k < 10; k++) {
      last = nextPopKind({ claim: 1, hire: 1 }, last);
      shown.push(last!);
    }
    expect(shown.filter((x) => x === 'hire').length).toBe(5);
  });
});
