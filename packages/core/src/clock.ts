import { randomInt } from 'node:crypto';
import type { Clock, Rng } from './ports';

export const systemClock: Clock = { now: () => new Date() };

/** Manually advanced clock for tests and simulations. */
export class FakeClock implements Clock {
  private ms: number;
  constructor(start: Date | string | number = '2026-10-01T12:00:00Z') {
    this.ms = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    if (ms < 0) throw new Error('FakeClock cannot go backwards');
    this.ms += ms;
  }
  advanceSeconds(s: number): void {
    this.advance(s * 1000);
  }
  set(date: Date | string | number): void {
    this.ms = new Date(date).getTime();
  }
}

/** Deterministic PRNG (mulberry32). */
export class SeededRng implements Rng {
  private state: number;
  constructor(seed = 1) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

/** Production randomness (stock picks): from the OS CSPRNG, so it cannot be predicted. */
export const systemRng: Rng = { next: () => randomInt(0, 2 ** 48 - 1) / 2 ** 48 };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
