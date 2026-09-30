import { describe, expect, it } from 'vitest';
import { CLICK_SLOP, wheelAction } from './camera';

const wheel = (deltaX: number, deltaY: number, ctrlKey = false, deltaMode = 0, shiftKey = false) => ({ deltaX, deltaY, deltaMode, ctrlKey, shiftKey });

describe('camera input', () => {
  it('a plain two-finger trackpad scroll pans, in both directions, and never zooms', () => {
    expect(wheelAction(wheel(0, 40))).toEqual({ kind: 'pan', dx: -0, dy: -40 });
    expect(wheelAction(wheel(-25, 10))).toEqual({ kind: 'pan', dx: 25, dy: -10 });
    // a mouse wheel without ctrl pans too (zoom with ctrl + wheel or the HUD buttons)
    expect(wheelAction(wheel(0, 100)).kind).toBe('pan');
    // Firefox counts a mouse wheel in lines
    expect(wheelAction(wheel(0, 3, false, 1))).toEqual({ kind: 'pan', dx: -0, dy: -48 });
    // shift + wheel scrolls sideways
    expect(wheelAction(wheel(0, 30, false, 0, true))).toEqual({ kind: 'pan', dx: -30, dy: 0 });
  });

  it('a pinch (wheel with ctrlKey, how browsers report a trackpad pinch) zooms: fingers apart in, together out', () => {
    const zin = wheelAction(wheel(0, -8, true));
    const zout = wheelAction(wheel(0, 8, true));
    expect(zin.kind).toBe('zoom');
    expect(zout.kind).toBe('zoom');
    if (zin.kind !== 'zoom' || zout.kind !== 'zoom') return;
    expect(zin.factor).toBeGreaterThan(1);
    expect(zout.factor).toBeLessThan(1);
    expect(zin.factor * zout.factor).toBeCloseTo(1, 9);
  });

  it('ctrl + a mouse wheel notch zooms one gentle step, not a jump', () => {
    const a = wheelAction(wheel(0, -100, true));
    const b = wheelAction(wheel(0, 1000, true));
    if (a.kind !== 'zoom' || b.kind !== 'zoom') throw new Error('expected zoom');
    expect(a.factor).toBeLessThan(2);
    expect(b.factor).toBeGreaterThan(0.5);
  });

  it('a tap that wobbles a little is still a click (more slack for a finger)', () => {
    expect(CLICK_SLOP.touch).toBeGreaterThan(CLICK_SLOP.mouse);
    expect(CLICK_SLOP.mouse).toBeGreaterThanOrEqual(5);
  });
});
