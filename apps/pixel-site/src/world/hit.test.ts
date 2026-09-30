import { describe, expect, it } from 'vitest';
import { ratHit } from './hit';

describe('rat click targets', () => {
  it('hits the whole body, feet to ears, and misses beside it', () => {
    // a rat with its feet at (100, 200), scale 1, camera at zoom 2 (the box is the sprite, not the minimum)
    expect(ratHit(100, 200, 1, 100, 177, 2)).toBeLessThan(0.1); // the middle of the body
    expect(ratHit(100, 200, 1, 100, 202, 2)).toBeLessThanOrEqual(1); // the feet
    expect(ratHit(100, 200, 1, 100, 152, 2)).toBeLessThanOrEqual(1); // the ears
    expect(ratHit(100, 200, 1, 112, 180, 2)).toBeLessThanOrEqual(1); // the edge of the body
    expect(ratHit(100, 200, 1, 130, 180, 2)).toBeGreaterThan(1); // beside it
    expect(ratHit(100, 200, 1, 100, 140, 2)).toBeGreaterThan(1); // above the ears
  });

  it('never shrinks below a finger-sized target on screen when zoomed out', () => {
    // at zoom 0.4 a rat is about 10 px wide on screen; a click 12 screen px beside its middle still hits it
    const zoom = 0.4;
    expect(ratHit(100, 200, 1, 100 + 12 / zoom, 177, zoom)).toBeLessThanOrEqual(1);
    expect(ratHit(100, 200, 1, 100 + 20 / zoom, 177, zoom)).toBeGreaterThan(1);
    // zoomed in the box is the body, not the minimum
    expect(ratHit(100, 200, 1, 100 + 12, 177, 3)).toBeLessThanOrEqual(1);
    expect(ratHit(100, 200, 1, 100 + 16, 177, 3)).toBeGreaterThan(1);
  });

  it('ranks the rat whose body is nearer the click first (two overlapping boxes)', () => {
    const a = ratHit(100, 200, 1, 108, 180, 1);
    const b = ratHit(116, 200, 1, 108, 180, 1);
    expect(a).toBeLessThanOrEqual(1);
    expect(b).toBeLessThanOrEqual(1);
    expect(ratHit(100, 200, 1, 103, 180, 1)).toBeLessThan(ratHit(116, 200, 1, 103, 180, 1));
  });

  it('scales with the tier: a partner is a bigger target than an intern', () => {
    expect(ratHit(0, 0, 1.3, 16, -30, 2)).toBeLessThanOrEqual(1);
    expect(ratHit(0, 0, 0.88, 16, -30, 2)).toBeGreaterThan(1);
  });
});
