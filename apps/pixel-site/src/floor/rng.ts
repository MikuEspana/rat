// Deterministic randomness: the same stocks always build the same floor.

/** FNV-1a, 32 bit. */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 */
export class Rng {
  private s: number;
  constructor(seed: number | string) {
    this.s = (typeof seed === 'string' ? hash32(seed) : seed) >>> 0 || 1;
  }

  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** integer in [0, n) */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  range(a: number, b: number): number {
    return a + this.int(b - a + 1);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(a: readonly T[]): T {
    return a[this.int(a.length)]!;
  }

  shuffle<T>(a: T[]): T[] {
    for (let k = a.length - 1; k > 0; k--) {
      const m = this.int(k + 1);
      [a[k], a[m]] = [a[m]!, a[k]!];
    }
    return a;
  }
}
