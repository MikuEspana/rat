import { describe, expect, it } from 'vitest';
import { applyBps, formatSol, fundShareOf, lamportsToSol, maxBig, minBig, rawToDecimalString, solToLamports, sumBig } from './money';

describe('money', () => {
  it('parses SOL strings and numbers exactly', () => {
    expect(solToLamports('0.03')).toBe(30_000_000n);
    expect(solToLamports('1')).toBe(1_000_000_000n);
    expect(solToLamports('0.000000001')).toBe(1n);
    expect(solToLamports(0.03)).toBe(30_000_000n);
    expect(solToLamports('30')).toBe(30_000_000_000n);
    expect(solToLamports('0.1234567899')).toBe(123_456_789n);
  });

  it('rejects invalid amounts', () => {
    expect(() => solToLamports('-1')).toThrow();
    expect(() => solToLamports('abc')).toThrow();
    expect(() => solToLamports(Number.NaN)).toThrow();
    expect(() => solToLamports(-0.5)).toThrow();
  });

  it('round trips lamports to strings exactly', () => {
    for (const l of [0n, 1n, 30_000_000n, 1_234_567_891n, 180_000_000_000n]) {
      expect(solToLamports(formatSol(l))).toBe(l);
    }
    expect(formatSol(30_000_000n)).toBe('0.03');
    expect(formatSol(-5_000n)).toBe('-0.000005');
  });

  it('formats raw token amounts', () => {
    expect(rawToDecimalString(1_413_900n, 8)).toBe('0.014139');
    expect(rawToDecimalString(100n, 0)).toBe('100');
    expect(rawToDecimalString(1_000_000n, 6)).toBe('1');
  });

  it('applies bps with floor', () => {
    expect(applyBps(101n, 5000)).toBe(50n);
    expect(applyBps(1_284_000_001n, 5000)).toBe(642_000_000n);
    expect(() => applyBps(1n, 10_001)).toThrow();
  });

  it('fund share is what the hire split leaves (the split is the HIRES\' share)', () => {
    expect(fundShareOf(1_000n, 10_000)).toBe(0n); // default: everything to rats
    expect(fundShareOf(1_000n, 0)).toBe(1_000n);
    expect(fundShareOf(1_000n, 7_000)).toBe(300n);
    expect(fundShareOf(101n, 5_000)).toBe(50n); // 50/50: the rounding lamport stays with hires, as before
    expect(fundShareOf(1_284_000_001n, 5_000)).toBe(642_000_000n);
  });

  it('min/max/sum', () => {
    expect(minBig(3n, 1n, 2n)).toBe(1n);
    expect(maxBig(3n, 1n, 2n)).toBe(3n);
    expect(sumBig([1n, 2n, 3n])).toBe(6n);
    expect(lamportsToSol(1_500_000_000n)).toBe(1.5);
  });
});
