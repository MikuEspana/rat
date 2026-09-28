// Launch scenarios for the simulator: a market cap curve per scenario, trading volume from that curve, and
// creator fees from the volume. Everything after the fees (claims, hires, the per-loop limit and the hourly cap) is
// the backend's rules (rules.ts), run by engine.ts.

export type ScenarioId = 'normal' | 'mega' | 'rush' | 'rug';

export interface Scenario {
  id: ScenarioId;
  label: string;
  blurb: string;
  /** [minutes after launch, market cap in USD], log-interpolated between points */
  curve: ReadonlyArray<readonly [number, number]>;
  /** how long the scenario runs, in minutes */
  minutes: number;
  seed: string;
  /**
   * Fees paid straight from phases (SOL per phase) instead of the volume model: the backend's 3-hour launch
   * simulation (tests/sim/launch-3h.test.ts, SIMULATION.md), so the site shows the same launch.
   */
  feePhases?: ReadonlyArray<{ fromMin: number; toMin: number; sol: number; shape: 'decay' | 'bump'; k?: number }>;
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
    blurb: 'Runs to about $10M in 4 hours. The building fills up and new hires line up outside.',
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
    // about 6,400 rats: every desk taken, a few hundred in the job-fair line outside
    minutes: 300,
    seed: 'mega-1',
  },
  rush: {
    id: 'rush',
    label: 'Rush',
    blurb: 'The backend\'s 3-hour launch: 90 SOL of fees in 30 minutes. The job-fair line swells, then drains.',
    curve: [
      [0, 6_000],
      [5, 90_000],
      [15, 900_000],
      [30, 3_200_000],
      [60, 2_400_000],
      [90, 1_700_000],
      [105, 2_600_000],
      [120, 1_900_000],
      [180, 700_000],
      [240, 520_000],
    ],
    feePhases: [
      { fromMin: 0, toMin: 30, sol: 90, shape: 'decay', k: 2.5 },
      { fromMin: 30, toMin: 90, sol: 35, shape: 'decay', k: 1.5 },
      { fromMin: 90, toMin: 120, sol: 40, shape: 'bump' },
      { fromMin: 120, toMin: 180, sol: 15, shape: 'decay', k: 3 },
    ],
    minutes: 210,
    seed: 'rush-1',
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
 * little under the backend's 3-hour launch simulation (SIMULATION.md). Every fee hires rats, so that is about
 * 4,800 rats.
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
/** Fees (SOL per minute) at `minutes` from a scenario's fee phases: the same shapes as the backend simulation. */
export function phaseFeePerMin(phases: NonNullable<Scenario['feePhases']>, minutes: number): number {
  const p = phases.find((x) => minutes >= x.fromMin && minutes < x.toMin);
  if (!p) return 0;
  const span = p.toMin - p.fromMin;
  const x = (minutes - p.fromMin) / span;
  // the weight shape normalised so the phase pays exactly p.sol
  if (p.shape === 'bump') return ((p.sol / span) * Math.PI * Math.sin(Math.PI * x)) / 2;
  const k = p.k ?? 2;
  return ((p.sol / span) * k * Math.exp(-k * x)) / (1 - Math.exp(-k));
}

export function creatorFeeRate(mcap: number): number {
  if (mcap < 88_000) return 0.003;
  if (mcap <= 300_000) return 0.0095;
  return Math.max(0.0005, 0.0095 * Math.pow(mcap / 300_000, -0.7));
}
