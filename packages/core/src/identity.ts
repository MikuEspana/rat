import { createHash } from 'node:crypto';

/** First 8 hex chars of sha256(wallet). Stable forever for a given wallet. */
export function avatarSeedFor(wallet: string): string {
  return createHash('sha256').update(wallet).digest('hex').slice(0, 8);
}

export function ratName(id: number): string {
  return `Rat #${String(id).padStart(4, '0')}`;
}
