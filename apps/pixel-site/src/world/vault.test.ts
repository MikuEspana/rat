import { Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { VaultView, type VaultAnchor } from './vault';

const frame = { texture: Texture.EMPTY, x: 0, y: 0, w: 40, h: 40, anchorX: 0.5, anchorY: 1 };
const atlas = { has: () => true, frame: () => frame };

describe('the Vault', () => {
  it('flies bills in on every claim with a gold "+$X" and on every hire with a green one; neither waits for the other', () => {
    const p = { x: 0, y: 0, texture: Texture.EMPTY, anchorX: 0.5, anchorY: 1, scaleX: 1, scaleY: 1 };
    const v = new VaultView(atlas as never, { item: { p }, x: 0, y: 0, glow: null } as unknown as VaultAnchor);
    // a rush: a claim every tick, and a hire in between
    for (let k = 0; k < 20; k++) v.claim({ x: 300, y: 200 }, 120, 6);
    v.hire({ x: 300, y: 200 }, 4.53);
    const bills = (v as unknown as { bills: Array<{ label: string | null; gold: boolean }> }).bills;
    expect(bills.length).toBe(20 * 6 + 3);
    const labels = bills.filter((b) => b.label);
    expect(labels.filter((b) => b.gold)).toHaveLength(20);
    expect(labels.filter((b) => !b.gold).map((b) => b.label)).toEqual(['+$4.53']);
  });
});
