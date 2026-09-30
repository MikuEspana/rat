// The contract address (CA) in the HUD and the coin price under MARKET CAP.
import { describe, expect, it, vi } from 'vitest';
import { caView, priceUsd, shortAddr } from './format';
import { copyText } from './clipboard';

const MINT = 'bCiRzzR8r269s9yjXZkkZmyVwwpUfN1YzyBL93spump';

describe('contract address', () => {
  it('is hidden while the coin has no mint', () => {
    expect(caView({ mint: null })).toBeNull();
    expect(caView({ mint: '' })).toBeNull();
    expect(caView({ mint: '   ' })).toBeNull();
  });

  it('shows the first and last 6 characters once the coin has a mint, and links to pump.fun', () => {
    const v = caView({ mint: MINT })!;
    expect(v.short).toBe('CA bCiRzz...3spump');
    expect(v.href).toBe(`https://pump.fun/coin/${MINT}`);
    expect(shortAddr('short')).toBe('short');
  });

  it('copies the whole mint, never the shortened one', async () => {
    const v = caView({ mint: MINT })!;
    expect(v.copy).toBe(MINT);
    const writeText = vi.fn(async () => {});
    expect(await copyText(v.copy, { clipboard: { writeText } }, undefined)).toBe(true);
    expect(writeText).toHaveBeenCalledWith(MINT);
  });

  it('falls back to a hidden textarea and execCommand when the Clipboard API is missing or refused', async () => {
    const copied: string[] = [];
    const children: unknown[] = [];
    const makeDoc = () => {
      const ta = {
        value: '',
        style: {} as Record<string, string>,
        setAttribute: () => {},
        select: () => {},
        setSelectionRange: () => {},
        remove: () => children.splice(children.indexOf(ta), 1),
      };
      return {
        body: { appendChild: (c: unknown) => children.push(c) },
        createElement: () => ta,
        execCommand: (cmd: string) => {
          if (cmd === 'copy') copied.push(ta.value);
          return true;
        },
      } as unknown as Document;
    };
    expect(await copyText(MINT, {}, makeDoc())).toBe(true);
    const refused = { clipboard: { writeText: async () => Promise.reject(new Error('denied')) } };
    expect(await copyText(MINT, refused, makeDoc())).toBe(true);
    expect(copied).toEqual([MINT, MINT]);
    expect(children).toEqual([]); // the textarea is removed again
  });
});

describe('coin price', () => {
  it('shows 4 significant figures, never e-notation', () => {
    expect(priceUsd(0.0000033768377450976705)).toBe('$0.000003377');
    expect(priceUsd(3.3788581567848046e-6)).toBe('$0.000003379');
    expect(priceUsd(1.2e-9)).toBe('$0.0000000012');
    expect(priceUsd(0.012345)).toBe('$0.01235');
    expect(priceUsd(1.5)).toBe('$1.5');
    expect(priceUsd(0)).toBe('$0');
  });

  it('is empty without a price', () => {
    expect(priceUsd(null)).toBe('');
    expect(priceUsd(undefined)).toBe('');
    expect(priceUsd(Number.NaN)).toBe('');
  });
});
