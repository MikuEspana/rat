// Q5: a 3-hour launch, live on SimChain (in memory, no network): a huge first 30 minutes, cooling, a second pump,
// then the coin dies. 180 SOL of creator fees = the ~3,000 rat plan. Runs twice: the default settings, and hires
// paced to 10 per loop. Asserts the money invariants and the limits; with WRITE_SIMULATION=1 it also writes the
// numbers into SIMULATION.md (`pnpm sim:3h`). Part of the long CI job (`pnpm test:long`).
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { StateService } from '@rat/api';
import { lamportsToSol } from '@rat/core';
import { type SimWorld, createSimWorld } from '@rat/worker';
import { describe, expect, it } from 'vitest';
import { type Phase, burnRounds, phasedCurve } from '../e2e/helpers';
import { checkMoney, moneyStart } from '../e2e/money-check';

const PHASES: Phase[] = [
  { label: 'launch rush', fromMin: 0, toMin: 30, sol: 90, shape: 'decay', k: 2.5 },
  { label: 'cooling', fromMin: 30, toMin: 90, sol: 35, shape: 'decay', k: 1.5 },
  { label: 'second pump', fromMin: 90, toMin: 120, sol: 40, shape: 'bump' },
  { label: 'dying', fromMin: 120, toMin: 180, sol: 15, shape: 'decay', k: 3 },
];
const STEP = 5;
const GRADUATE_MIN = 12;
const ROW_MIN = 10;
/** after the fees stop, keep running until the budgets are spent (at most this long) */
const DRAIN_MAX_MIN = 75;

interface Row {
  min: number;
  phase: string;
  fees: bigint;
  claimed: bigint;
  rats: number;
  hires: number;
  hireWaiting: bigint;
  hireOutHour: bigint;
  burnTxs: number;
  burnedSol: bigint;
  burnWaiting: bigint;
  burnOutHour: bigint;
}

interface Run {
  label: string;
  maxHiresPerLoop: number;
  rows: Row[];
  rats: number;
  lastHireMin: number;
  budgetsSpentMin: number | null;
  longestStall: { min: number; atMin: number };
  longestBurnGap: { min: number; atMin: number };
  peakHireWaiting: { sol: bigint; atMin: number };
  maxHiresInLoop: number;
  maxJupiterPerMin: number;
  maxTickMs: number;
  burns: ReturnType<typeof burnRounds>;
  txs: number;
  api: { stateKb: number; stateGzKb: number; ratsKb: number; ratsGzKb: number };
  runtimeSec: number;
}

async function simulate(label: string, env: Record<string, string>): Promise<Run> {
  const w: SimWorld = await createSimWorld({ dryRun: false, seed: 3, env });
  try {
    const cfg = w.deps.config;
    const start = moneyStart(w);
    const { fees, phaseAt } = phasedCurve(PHASES, STEP);
    start.accrued = fees.reduce((a, b) => a + b, 0n);
    const t0 = performance.now();
    const rows: Row[] = [];
    const jupiterSamples: { t: number; calls: number }[] = [];
    let maxTickMs = 0;
    let maxHiresInLoop = 0;
    let lastRats = 0;
    let lastHireMin = 0;
    let stallStart: number | null = null;
    let longestStall = { min: 0, atMin: 0 };
    let longestBurnGap = { min: 0, atMin: 0 };
    let burnGapStart: number | null = null;
    let lastBurnMin = 0;
    let hireWaiting = 0n;
    let peakHireWaiting = { sol: 0n, atMin: 0 };
    let window = { fees: 0n, rats: 0, burnTxs: 0 };
    let budgetsSpentMin: number | null = null;
    const totalTicks = fees.length + (DRAIN_MAX_MIN * 60) / STEP;

    for (let i = 0; i < totalTicks; i++) {
      const minute = (i * STEP) / 60;
      const fee = fees[i] ?? 0n;
      if (minute < GRADUATE_MIN) w.accrue({ bondingLamports: fee });
      else w.accrue({ ammLamports: fee });
      window.fees += fee;

      const a = performance.now();
      const ran = await w.worker.tick();
      maxTickMs = Math.max(maxTickMs, performance.now() - a);
      jupiterSamples.push({ t: i * STEP, calls: w.swap.calls + w.prices.calls });

      // hires only happen in the claim loop (every 35 s): read the ledger only then
      const hire = (ran.get('claim') as { hire?: { hired: number; attempted: number; retried: number } } | undefined)?.hire;
      if (hire) {
        maxHiresInLoop = Math.max(maxHiresInLoop, hire.attempted + hire.retried);
        const rats = lastRats + hire.hired;
        hireWaiting = await w.store.ledger.balance('hire');
        if (rats > lastRats) {
          if (stallStart !== null && minute - stallStart > longestStall.min) longestStall = { min: minute - stallStart, atMin: stallStart };
          stallStart = null;
          lastHireMin = minute;
        } else if (hireWaiting >= cfg.salaryLamports && stallStart === null) {
          stallStart = minute;
        }
        window.rats += rats - lastRats;
        lastRats = rats;
        if (hireWaiting > peakHireWaiting.sol) peakHireWaiting = { sol: hireWaiting, atMin: minute };
        // burns: the longest gap between burn transactions while at least 1 SOL of burn budget waited
        const burnWaiting = await w.store.ledger.balance('burn');
        if (burnWaiting >= 1_000_000_000n && burnGapStart === null) burnGapStart = lastBurnMin;
      }
      const burn = ran.get('burn') as { status?: string } | undefined;
      if (burn?.status === 'burned') {
        if (burnGapStart !== null && minute - burnGapStart > longestBurnGap.min) longestBurnGap = { min: minute - burnGapStart, atMin: burnGapStart };
        burnGapStart = null;
        lastBurnMin = minute;
      }
      const rats = lastRats;

      const done = (i + 1) * STEP;
      if (done % (ROW_MIN * 60) === 0) {
        const hourAgo = new Date(w.clock.now().getTime() + STEP * 1000 - 3_600_000);
        const burns = await w.store.burns.totals();
        rows.push({
          min: done / 60,
          phase: phaseAt(i),
          fees: window.fees,
          claimed: (await w.store.claims.totals()).claimed,
          rats,
          hires: window.rats,
          hireWaiting,
          hireOutHour: await w.store.ledger.netOutflowSince('hire', hourAgo),
          burnTxs: burns.count - window.burnTxs,
          burnedSol: burns.spent,
          burnWaiting: await w.store.ledger.balance('burn'),
          burnOutHour: await w.store.ledger.netOutflowSince('burn', hourAgo),
        });
        window = { fees: 0n, rats: 0, burnTxs: burns.count };
      }
      w.clock.advanceSeconds(STEP);
      w.prices.step(w.rng);

      if (i >= fees.length && budgetsSpentMin === null) {
        const burnLeft = await w.store.ledger.balance('burn');
        if (hireWaiting < cfg.salaryLamports && burnLeft < cfg.minBurnLamports) budgetsSpentMin = done / 60;
      }
      if (budgetsSpentMin !== null && i >= fees.length && (done / 60) % ROW_MIN === 0) break;
    }

    await checkMoney(w, start);
    const service = new StateService(w.store, cfg, w.clock);
    const state = JSON.stringify(await service.stateResponse());
    const ratsJson = JSON.stringify(await service.ratsResponse());
    let maxPerMin = 0;
    for (let i = 0; i < jupiterSamples.length; i++) {
      let j = i;
      while (j + 1 < jupiterSamples.length && jupiterSamples[j + 1]!.t - jupiterSamples[i]!.t < 60) j++;
      maxPerMin = Math.max(maxPerMin, jupiterSamples[j]!.calls - (i > 0 ? jupiterSamples[i - 1]!.calls : 0));
    }
    const kb = (s: string | Buffer) => Math.round(Buffer.byteLength(s) / 102.4) / 10;
    return {
      label,
      maxHiresPerLoop: cfg.maxHiresPerLoop,
      rows,
      rats: lastRats,
      lastHireMin,
      budgetsSpentMin,
      longestStall,
      longestBurnGap,
      peakHireWaiting,
      maxHiresInLoop,
      maxJupiterPerMin: maxPerMin,
      maxTickMs,
      burns: burnRounds(await w.store.burns.listByStatus(['confirmed'])),
      txs: w.simSender.submitted,
      api: { stateKb: kb(state), stateGzKb: kb(gzipSync(state)), ratsKb: kb(ratsJson), ratsGzKb: kb(gzipSync(ratsJson)) },
      runtimeSec: (performance.now() - t0) / 1000,
    };
  } finally {
    await w.close();
  }
}

function check(run: Run, cfg = { capSol: 30n, jupiterMaxRpm: 55 }) {
  for (const r of run.rows) {
    expect(r.hireOutHour).toBeLessThanOrEqual(cfg.capSol * 1_000_000_000n);
    expect(r.burnOutHour).toBeLessThanOrEqual(cfg.capSol * 1_000_000_000n);
  }
  expect(run.maxJupiterPerMin).toBeLessThanOrEqual(cfg.jupiterMaxRpm);
  expect(run.maxHiresInLoop).toBeLessThanOrEqual(run.maxHiresPerLoop);
  expect(run.budgetsSpentMin).not.toBeNull();
  expect(run.rats).toBeGreaterThan(2_900); // 90 SOL hire share at ~0.0296 SOL real cost per rat
  expect(run.rats).toBeLessThanOrEqual(3_100);
}

/** SOL with 2 decimals (the report is for reading; the money check itself is exact to the lamport) */
const sol = (l: bigint) => (Number(l) / 1e9).toFixed(2);
const min = (m: number) => `${Math.round(m)} min`;

function report(runs: Run[]): string {
  const [base, paced] = runs as [Run, Run];
  const o: string[] = [];
  o.push('<!-- sim-3h:start -->');
  o.push('## 3-hour launch (live on SimChain, 180 SOL of creator fees, about 3,000 rats)');
  o.push('');
  o.push(`Generated by \`pnpm sim:3h\` (${new Date().toISOString().slice(0, 10)}). In memory only: PGlite, SimChain, mock Jupiter, fake clock, 5 second ticks. Every claim, hire and burn is executed on SimChain and every lamport is checked against the chain at the end.`);
  o.push('');
  o.push('**The launch** (creator fees paid into our vaults; graduation to PumpSwap at 12 min):');
  o.push('');
  o.push('| Phase | Time | Creator fees |');
  o.push('|---|---|---|');
  for (const p of PHASES) o.push(`| ${p.label} | ${p.fromMin} to ${p.toMin} min | ${p.sol} SOL |`);
  o.push(`| **total** | 3 hours | **${PHASES.reduce((a, p) => a + p.sol, 0)} SOL** (half to hires, half to buy + burn) |`);
  o.push('');
  o.push('Creator fee rates depend on the coin\'s market cap tier (set on-chain by pump.fun), so this is modelled in fees, not trading volume.');
  o.push('');
  o.push('### Result');
  o.push('');
  o.push(`| | Unpaced (${base.maxHiresPerLoop} hires per loop, no round limit) | **Defaults** (${paced.maxHiresPerLoop} hires per loop, 5 SOL per burn round) |`);
  o.push('|---|---|---|');
  const both = (name: string, f: (r: Run) => string) => o.push(`| ${name} | ${f(base)} | ${f(paced)} |`);
  both('Rats hired', (r) => `**${r.rats}**`);
  both('Last hire', (r) => min(r.lastHireMin));
  both('Both budgets fully spent', (r) => (r.budgetsSpentMin === null ? 'not yet' : min(r.budgetsSpentMin)));
  both('Longest pause in hiring while budget waited', (r) => `**${min(r.longestStall.min)}** (from minute ${Math.round(r.longestStall.atMin)})`);
  both('Longest gap between burns while at least 1 SOL waited', (r) => `**${min(r.longestBurnGap.min)}** (from minute ${Math.round(r.longestBurnGap.atMin)})`);
  both('Most hire budget waiting', (r) => `${sol(r.peakHireWaiting.sol)} SOL (minute ${Math.round(r.peakHireWaiting.atMin)})`);
  both('Buy + burn', (r) => `${r.burns.rounds} rounds, ${r.burns.txs} txs, largest ${sol(r.burns.maxChunk)} SOL`);
  both('Most hires in one loop', (r) => `${r.maxHiresInLoop} (limit ${r.maxHiresPerLoop})`);
  both('Most Jupiter calls in any minute', (r) => `${r.maxJupiterPerMin} (limit 55)`);
  both('Transactions sent', (r) => `${r.txs}`);
  both('Slowest worker loop (in memory)', (r) => `${Math.round(r.maxTickMs)} ms`);
  both('`/api/state` size at the end', (r) => `${r.api.stateKb} KB (${r.api.stateGzKb} KB gzipped)`);
  both('`/api/rats` size at the end', (r) => `${r.api.ratsKb} KB (${r.api.ratsGzKb} KB gzipped)`);
  both('Money check (ledger = chain, to the lamport)', () => 'exact');
  both('Simulation runtime', (r) => `${Math.round(r.runtimeSec)} s`);
  o.push('');
  for (const r of runs) {
    o.push(`### Timeline: ${r.label}`);
    o.push('');
    o.push('Every 10 minutes. "Waiting" = claimed SOL not spent yet. "Last hour" = rolling 60-minute spend vs the 30 SOL cap.');
    o.push('');
    o.push('| Minute | Phase | Fees in | Claimed | Rats | New rats | Hire waiting | Hire last hour | Burn txs | Burned (total) | Burn waiting | Burn last hour |');
    o.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const x of r.rows) {
      o.push(
        `| ${x.min} | ${x.phase} | ${sol(x.fees)} | ${sol(x.claimed)} | ${x.rats} | ${x.hires} | ${sol(x.hireWaiting)} | ${sol(x.hireOutHour)} | ${x.burnTxs} | ${sol(x.burnedSol)} | ${sol(x.burnWaiting)} | ${sol(x.burnOutHour)} |`,
      );
    }
    o.push('');
  }
  o.push('### What this means');
  o.push('');
  o.push(`- **The 30 SOL/hour caps set the pace, not the fees.** The rush pays ${PHASES[0]!.sol / 2} SOL into each budget in 30 minutes; at most 30 SOL per bucket can be spent in any 60 minutes, so the rest waits (peak ${sol(base.peakHireWaiting.sol)} SOL of hire budget) and is spent over the next hours. Nothing is lost: every lamport is spent by minute ${base.budgetsSpentMin === null ? '?' : Math.round(base.budgetsSpentMin)}.`);
  o.push(`- **Unpaced settings hire in bursts.** ${base.maxHiresPerLoop} hires per loop reach the hourly cap in about half an hour, then hiring stops for up to **${min(base.longestStall.min)}** until the window slides, right when the site has the most visitors. The defaults (${paced.maxHiresPerLoop} per loop) keep the longest pause to ${min(paced.longestStall.min)}: the office fills evenly (about ${Math.round((60 / 35) * paced.maxHiresPerLoop)} rats a minute) and finishes at about the same time.`);
  o.push(`- **Unpaced burns do the same**: whole rounds burn everything the cap allows, so burning stops for up to **${min(base.longestBurnGap.min)}**. With the default \`BURN_ROUND_MAX_SOL=5\` the longest gap is ${min(paced.longestBurnGap.min)} (just the random 8 to 12 minute spacing of rounds): steady buy pressure on the chart, and smaller, less tempting rounds for sandwich bots. The price: the burn budget is fully spent at minute ${paced.budgetsSpentMin === null ? '?' : Math.round(paced.budgetsSpentMin)} instead of ${base.budgetsSpentMin === null ? '?' : Math.round(base.budgetsSpentMin)}.`);
  o.push(`- **These are the defaults** (\`MAX_HIRES_PER_LOOP=${paced.maxHiresPerLoop}\`, \`BURN_ROUND_MAX_SOL=5\`, chosen by Miguel after this simulation). Raise the hourly caps only if you want the money spent faster.`);
  o.push(`- Burns keep the random 8 to 12 minute rhythm with chunks of at most 1 SOL, and keep going after the coin dies until the burn budget is spent.`);
  o.push(`- **The site** must handle ${base.rats} rats: \`/api/rats\` is ${base.api.ratsKb} KB (${base.api.ratsGzKb} KB gzipped). Fetch it once, then follow \`/api/events\`.`);
  o.push('- Not modelled: real Jupiter routes and xStock liquidity, real priority fees, real RPC latency (the worker loop time above is in memory).');
  o.push('<!-- sim-3h:end -->');
  return o.join('\n');
}

describe('Q5: 3-hour launch simulation', () => {
  it('unpaced vs the defaults: every limit holds, all money is spent, ledger equals chain', async () => {
    const runs = [
      await simulate('unpaced (MAX_HIRES_PER_LOOP=20, BURN_ROUND_MAX_SOL=0)', { MAX_HIRES_PER_LOOP: '20', BURN_ROUND_MAX_SOL: '0' }),
      await simulate('defaults (MAX_HIRES_PER_LOOP=10, BURN_ROUND_MAX_SOL=5)', {}),
    ];
    for (const r of runs) check(r);
    // pacing removes the long mid-launch pauses
    expect(runs[1]!.longestStall.min).toBeLessThan(runs[0]!.longestStall.min);
    expect(runs[1]!.longestBurnGap.min).toBeLessThan(runs[0]!.longestBurnGap.min);
    if (process.env.WRITE_SIMULATION === '1') {
      const path = new URL('../../SIMULATION.md', import.meta.url);
      const current = readFileSync(path, 'utf8');
      const section = report(runs);
      const next = current.includes('<!-- sim-3h:start -->')
        ? current.replace(/<!-- sim-3h:start -->[\s\S]*<!-- sim-3h:end -->/, section)
        : current.replace(/\n## /, `\n${section}\n\n## `);
      writeFileSync(path, next);
      console.log(section);
    }
    console.log(runs.map((r) => `${r.label}: ${r.rats} rats, last hire ${Math.round(r.lastHireMin)} min, stall ${Math.round(r.longestStall.min)} min, ${lamportsToSol(r.peakHireWaiting.sol)} SOL peak waiting`).join('\n'));
  }, 900_000);
});
