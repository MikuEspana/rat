// Randomized chaos run (tests/chaos/fuzz.ts). CI runs a few seeds; a long run uses thousands, in shards:
//   CHAOS_RUNS=667 CHAOS_SEED=1 CHAOS_VERBOSE=1 pnpm vitest run tests/chaos/fuzz.test.ts
// A failure names its seed; CHAOS_SEED=<seed> CHAOS_RUNS=1 CHAOS_TRACE=1 replays exactly that launch, step by step.
import { describe, expect, it } from 'vitest';
import { fuzzLaunch } from './fuzz';

const RUNS = Number(process.env.CHAOS_RUNS ?? 8);
const FIRST = Number(process.env.CHAOS_SEED ?? 1);
const TRACE = process.env.CHAOS_TRACE === '1';
const VERBOSE = process.env.CHAOS_VERBOSE === '1';

describe('chaos: randomized launches (crashes, stalls, outages, leaked key, caps)', () => {
  it(`${RUNS} seeds from ${FIRST}: every invariant holds after every loop`, async () => {
    const failures: string[] = [];
    for (let seed = FIRST; seed < FIRST + RUNS; seed++) {
      try {
        const r = await fuzzLaunch(seed, TRACE ? (l) => console.log(l) : undefined);
        if (VERBOSE) console.log(`OK ${seed} ${JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
      } catch (err) {
        const line = `seed ${seed}: ${(err as Error).message.split('\n')[0]}`;
        if (VERBOSE) console.log(`FAIL ${line}`);
        failures.push(line);
      }
    }
    expect(failures).toEqual([]);
  }, 60 * 60_000);
});
