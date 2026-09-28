// Launch scenarios for the simulator: a market cap curve per scenario, trading volume from that curve, and
// creator fees from the volume. Everything after the fees (claims, the hire split, hires, burns, caps) is the
// backend's rules (rules.ts), run by engine.ts.

export type ScenarioId = 'normal' | 'mega' | 'rug';

export interface Scenario {
  id: ScenarioId;
  label: string;
  blurb: string;
  /** [minutes after launch, market cap in USD], log-interpolated between points */
  curve: ReadonlyArray<readonly [number, number]>;
  /** how long the scenario runs, in minutes */
  minutes: number;
  seed: string;
}

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  normal: {
    id: 'normal',
    label: 'Normal',
    blurb: 'Pumps to about $1.8M over 3 hours, then cools off.',
    curve: [
      [0, 6_000],
      [4, 25_000],
      [12, 70_000],
      [30, 240_000],
      [60, 560_000],
      [100, 950_000],
      [140, 1_350_000],
      [180, 1_800_000],
      [210, 1_560_000],
      [260, 1_150_000],
      [330, 900_000],
      [420, 780_000],
    ],
    minutes: 420,
    seed: 'normal-1',
  },
  mega: {
    id: 'mega',
    label: 'Mega',
    blurb: 'Runs to about $10M in 4 hours. Hiring maxes out at the hourly cap.',
    curve: [
      [0, 6_000],
      [4, 30_000],
      [10, 75_000],
      [30, 420_000],
      [60, 1_250_000],
      [100, 2_600_000],
      [150, 4_600_000],
      [200, 7_200_000],
      [250, 10_000_000],
      [290, 8_600_000],
      [360, 7_000_000],
      [480, 6_000_000],
    ],
    // ends while money still waits under the hourly cap: about 5,000 rats, what the building is drawn for
    minutes: 300,
    seed: 'mega-1',
  },
  rug: {
    id: 'rug',
    label: 'Rug',
    blurb: 'Pumps to about $300K, then dumps 80% in minutes.',
    curve: [
      [0, 6_000],
      [4, 25_000],
      [12, 70_000],
      [30, 180_000],
      [50, 300_000],
      [54, 240_000],
      [58, 60_000],
      [90, 50_000],
      [180, 38_000],
    ],
    minutes: 180,
    seed: 'rug-1',
  },
};

/** SOL price used to turn USD volume into SOL fees (held flat during a launch). */
export const SOL_USD = 185;
export const COIN_SUPPLY = 1_000_000_000;

/** Market cap from the curve (no noise) and its slope in ln(USD) per hour. */
export function curveAt(s: Scenario, minutes: number): { mcap: number; slopePerHour: number } {
  const c = s.curve;
  const first = c[0]!;
  const last = c[c.length - 1]!;
  if (minutes <= first[0]) return { mcap: first[1], slopePerHour: 0 };
  if (minutes >= last[0]) return { mcap: last[1], slopePerHour: 0 };
  for (let k = 1; k < c.length; k++) {
    const [t1, m1] = c[k]!;
    if (minutes > t1) continue;
    const [t0, m0] = c[k - 1]!;
    const u = (minutes - t0) / (t1 - t0);
    const l0 = Math.log(m0);
    const l1 = Math.log(m1);
    return { mcap: Math.exp(l0 + (l1 - l0) * u), slopePerHour: ((l1 - l0) / (t1 - t0)) * 60 };
  }
  return { mcap: last[1], slopePerHour: 0 };
}

/**
 * Trading volume, USD per hour: a base turnover of the market cap, plus more while the price moves fast (pumps
 * and dumps both trade heavily). A rough model, tuned so the Normal launch pays about 145 SOL of creator fees, a
 * little under the backend's 3-hour launch simulation (180 SOL, SIMULATION.md). Every fee hires rats, so that is
 * about 4,900 rats.
 */
export const TURNOVER_BASE_PER_HOUR = 0.62;
export const TURNOVER_PER_MOVE = 0.8;

export function volumeUsdPerHour(mcap: number, slopePerHour: number): number {
  return mcap * (TURNOVER_BASE_PER_HOUR + TURNOVER_PER_MOVE * Math.abs(slopePerHour));
}

/**
 * Creator fee rate (fraction of volume) by market cap. Approximates pump.fun's creator fee tiers: a flat rate on
 * the bonding curve, the highest rate just after graduation, then lower as the market cap grows (about 0.05% at
 * $20M). REPORTED, not verified here: the real tiers are set on-chain by pump.fun and can change.
 */
export function creatorFeeRate(mcap: number): number {
  if (mcap < 88_000) return 0.003;
  if (mcap <= 300_000) return 0.0095;
  return Math.max(0.0005, 0.0095 * Math.pow(mcap / 300_000, -0.7));
}
