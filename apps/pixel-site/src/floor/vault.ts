// The Vault: the money pile at the centre of the building. It shows the Idle Inu portfolio (what every rat's stock
// holdings are worth, in USD) in 6 stages on a steep early curve, so it visibly grows from the very first rat.
export interface VaultStage {
  /** portfolio value (USD) from which this stage shows */
  min: number;
  name: string;
  /** sprite (world atlas) */
  kind: string;
  /** drawn size */
  scale: number;
}

export const VAULT_STAGES: VaultStage[] = [
  { min: 0, name: 'LOOSE CHANGE', kind: 'vault_0', scale: 1.4 },
  { min: 50, name: 'CASH ON THE DESK', kind: 'vault_1', scale: 1.15 },
  { min: 500, name: 'THE CASH PALLET', kind: 'vault_2', scale: 1.1 },
  { min: 5_000, name: 'THE MONEY MOUNTAIN', kind: 'vault_3', scale: 1.15 },
  { min: 50_000, name: 'THE GLASS VAULT', kind: 'vault_4', scale: 1.1 },
  { min: 500_000, name: 'THE MONEY BIN', kind: 'vault_5', scale: 0.95 },
];

/** Which stage of the pile a portfolio value shows. */
export function vaultStageOf(valueUsd: number): number {
  let s = 0;
  for (let k = 0; k < VAULT_STAGES.length; k++) if (valueUsd >= VAULT_STAGES[k]!.min) s = k;
  return s;
}

/** A dollar amount short enough for a floating label: $4.91, $52, $1.2K, $3.4M. */
export function shortUsd(v: number): string {
  const a = Math.abs(v);
  const s = v < 0 ? '-' : '';
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  if (a >= 100) return `${s}$${Math.round(a)}`;
  return `${s}$${a.toFixed(2)}`;
}
