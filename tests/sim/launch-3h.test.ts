// Q5: a 3-hour launch, live on SimChain (in memory, no network): a huge first 30 minutes, cooling, a second pump,
// then the coin dies. 180 SOL of creator fees, and every claimed lamport hires rats (about 6,000 of them): nothing is
// bought back or burned. We stay on Jupiter's Free tier: the worker's Jupiter budget allows at most 40 calls
// (prices + builds + retries) in any 60 seconds. Asserts the money invariants and every limit, and measures what
// the owner asked: the most Jupiter calls in any minute, the longest hiring delay, how many rats waited at peak,
// and whether every fee was spent. `pnpm sim:3h` (WRITE_SIMULATION=1) writes the numbers into SIMULATION.md.
// Part of the long CI job (`pnpm test:long`).
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { StateService } from '@rat/api';
import { lamportsToSol } from '@rat/core';
import { type SimWorld, createSimWorld } from '@rat/worker';
import { describe, expect, it } from 'vitest';
import { type Phase, phasedCurve } from '../e2e/helpers';
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
/** after the fees stop, keep running until the hire budget is spent (at most this long) */
const DRAIN_MAX_MIN = 240;
const WRITE = process.env.WRITE_SIMULATION === '1';

interface Row {
  min: number;
  phase: string;
  fees: bigint;
  claimed: bigint;
  rats: number;
  hires: number;
  waiting: bigint;
  outHour: bigint;
  jupiterMax: number;
}

interface Run {
  label: string;
  maxHiresPerLoop: number;
  capLamports: bigint;
  jupiterMaxRpm: number;
  rows: Row[];
  rats: number;
  lastHireMin: number;
  spentMin: number | null;
  longestStall: { min: number; atMin: number };
  peakWaiting: { sol: bigint; atMin: number };
  /** the longest any claimed SOL waited before it hired a rat (first in, first out), and when that SOL came in */
  longestDelay: { min: number; claimedAtMin: number };
  /** calls the budget allowed in its busiest minute (its own count) */
  budgetMaxInWindow: number;
  /** hire loops where the Jupiter budget held hires back */
  jupiterWaits: number;
  hireLeftLamports: bigint;
  maxOutHour: bigint;
  maxHiresInLoop: number;
  maxJupiterPerMin: number;
  buildCalls: number;
  priceCalls: number;
  maxTickMs: number;
  txs: number;
  api: { stateKb: number; stateGzKb: number; ratsKb: number; ratsGzKb: number };
  runtimeSec: number;
}

/** the most calls in any 60-second window */
function maxPerMinute(samples: { t: number; calls: number }[], from = 0, to = samples.length): number {
  let max = 0;
  for (let i = from; i < to; i++) {
    let j = i;
    while (j + 1 < samples.length && samples[j + 1]!.t - samples[i]!.t < 60) j++;
    max = Math.max(max, samples[j]!.calls - (i > 0 ? samples[i - 1]!.calls : 0));
  }
  return max;
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
    const samples: { t: number; calls: number }[] = [];
    let rowFrom = 0;
    let maxTickMs = 0;
    let maxHiresInLoop = 0;
    let lastRats = 0;
    let lastHireMin = 0;
    let stallStart: number | null = null;
    let longestStall = { min: 0, atMin: 0 };
    let waiting = 0n;
    let peakWaiting = { sol: 0n, atMin: 0 };
    let maxOutHour = 0n;
    let window = { fees: 0n, rats: 0 };
    let spentMin: number | null = null;
    let jupiterWaits = 0;
    /** at every claim loop: minute, SOL claimed so far, SOL spent on hires so far (claimed - waiting - claim fees) */
    const flow: { min: number; claimed: bigint; hired: bigint }[] = [];
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
      samples.push({ t: i * STEP, calls: w.swap.calls + w.prices.calls });

      // hires only happen in the claim loop (every 35 s): read the ledger only then
      const hire = (ran.get('claim') as { hire?: { hired: number; attempted: number; retried: number; waitingForJupiter?: boolean } } | undefined)?.hire;
      if (hire) {
        maxHiresInLoop = Math.max(maxHiresInLoop, hire.attempted + hire.retried);
        if (hire.waitingForJupiter) jupiterWaits++;
        const rats = lastRats + hire.hired;
        waiting = await w.store.ledger.balance('hire');
        const totals = await w.store.claims.totals();
        flow.push({ min: minute, claimed: totals.claimed, hired: totals.claimed - totals.fee - waiting });
        if (rats > lastRats) {
          if (stallStart !== null && minute - stallStart > longestStall.min) longestStall = { min: minute - stallStart, atMin: stallStart };
          stallStart = null;
          lastHireMin = minute;
        } else if (waiting >= cfg.salaryLamports && stallStart === null) {
          stallStart = minute;
        }
        window.rats += rats - lastRats;
        lastRats = rats;
        if (waiting > peakWaiting.sol) peakWaiting = { sol: waiting, atMin: minute };
      }

      const done = (i + 1) * STEP;
      if (done % (ROW_MIN * 60) === 0) {
        const hourAgo = new Date(w.clock.now().getTime() + STEP * 1000 - 3_600_000);
        const outHour = await w.store.ledger.netOutflowSince('hire', hourAgo);
        if (outHour > maxOutHour) maxOutHour = outHour;
        rows.push({
          min: done / 60,
          phase: phaseAt(i),
          fees: window.fees,
          claimed: (await w.store.claims.totals()).claimed,
          rats: lastRats,
          hires: window.rats,
          waiting,
          outHour,
          jupiterMax: maxPerMinute(samples, rowFrom, samples.length),
        });
        rowFrom = samples.length;
        window = { fees: 0n, rats: 0 };
      }
      w.clock.advanceSeconds(STEP);
      w.prices.step(w.rng);

      if (i >= fees.length && spentMin === null && waiting < cfg.salaryLamports) spentMin = done / 60;
      if (spentMin !== null && i >= fees.length && (done / 60) % ROW_MIN === 0) break;
    }

    await checkMoney(w, start);
    // first in, first out: the SOL spent by minute t was claimed when the claimed total first reached it
    let longestDelay = { min: 0, claimedAtMin: 0 };
    for (let i = 0, j = 0; i < flow.length; i++) {
      while (j < flow.length && flow[j]!.claimed < flow[i]!.hired) j++;
      const f = flow[Math.min(j, flow.length - 1)]!;
      if (flow[i]!.min - f.min > longestDelay.min) longestDelay = { min: flow[i]!.min - f.min, claimedAtMin: f.min };
    }
    const service = new StateService(w.store, cfg, w.clock);
    const state = JSON.stringify(await service.stateResponse());
    const ratsJson = JSON.stringify(await service.ratsResponse());
    const kb = (s: string | Buffer) => Math.round(Buffer.byteLength(s) / 102.4) / 10;
    return {
      label,
      maxHiresPerLoop: cfg.maxHiresPerLoop,
      capLamports: cfg.spendCapLamportsPerHour.hire,
      jupiterMaxRpm: cfg.jupiter.maxRpm,
      rows,
      rats: lastRats,
      lastHireMin,
      spentMin,
      longestStall,
      peakWaiting,
      longestDelay,
      budgetMaxInWindow: w.jupiter.maxInWindow,
      jupiterWaits,
      hireLeftLamports: await w.store.ledger.balance('hire'),
      maxOutHour,
      maxHiresInLoop,
      maxJupiterPerMin: maxPerMinute(samples),
      buildCalls: w.swap.calls,
      priceCalls: w.prices.calls,
      maxTickMs,
      txs: w.simSender.submitted,
      api: { stateKb: kb(state), stateGzKb: kb(gzipSync(state)), ratsKb: kb(ratsJson), ratsGzKb: kb(gzipSync(ratsJson)) },
      runtimeSec: (performance.now() - t0) / 1000,
    };
  } finally {
    await w.close();
  }
}

function check(run: Run) {
  // the hourly hire cap holds in every window, and it is what paces the rush
  for (const r of run.rows) expect(r.outHour).toBeLessThanOrEqual(run.capLamports);
  // the Jupiter budget: never more than 40 calls (prices + builds) in any 60 seconds, well under the Free tier's 60
  expect(run.jupiterMaxRpm).toBe(40);
  expect(run.maxJupiterPerMin).toBeLessThanOrEqual(run.jupiterMaxRpm);
  expect(run.budgetMaxInWindow).toBeLessThanOrEqual(run.jupiterMaxRpm);
  // every fee was spent: less than one salary left
  expect(run.hireLeftLamports).toBeLessThan(30_000_000n);
  expect(run.maxHiresInLoop).toBeLessThanOrEqual(run.maxHiresPerLoop);
  expect(run.spentMin).not.toBeNull();
  // 180 SOL, all of it to hires, at ~0.026 SOL real cost per rat on SimChain (0.024 transfer + its rent and fees; mainnet measured 0.0278)
  expect(run.rats).toBeGreaterThan(6_500);
  expect(run.rats).toBeLessThanOrEqual(7_200);
}

/** SOL with 2 decimals (the report is for reading; the money check itself is exact to the lamport) */
const sol = (l: bigint) => (Number(l) / 1e9).toFixed(2);
const min = (m: number) => `${Math.round(m)} min`;
const n = (x: number) => x.toLocaleString('en-US');

function report(r: Run): string {
  const cap = sol(r.capLamports).replace(/\.00$/, '');
  const salary = 30_000_000n;
  const o: string[] = [];
  o.push('<!-- sim-3h:start -->');
  o.push(`## 3-hour launch (live on SimChain, 180 SOL of creator fees, about ${n(Math.round(r.rats / 100) * 100)} rats)`);
  o.push('');
  o.push(`Generated by \`pnpm sim:3h\` (${new Date().toISOString().slice(0, 10)}). In memory only: PGlite, SimChain, mock Jupiter, fake clock, 5 second ticks. Every claim and hire is executed on SimChain and every lamport is checked against the chain at the end. Every claimed lamport hires rats: nothing is bought back or burned. Jupiter Free tier: the worker's budget allows at most ${r.jupiterMaxRpm} calls (prices + builds + retries) in any 60 seconds.`);
  o.push('');
  o.push('**The launch** (creator fees paid into our vaults; graduation to PumpSwap at 12 min):');
  o.push('');
  o.push('| Phase | Time | Creator fees |');
  o.push('|---|---|---|');
  for (const p of PHASES) o.push(`| ${p.label} | ${p.fromMin} to ${p.toMin} min | ${p.sol} SOL |`);
  o.push(`| **total** | 3 hours | **${PHASES.reduce((a, p) => a + p.sol, 0)} SOL** (all of it to hires) |`);
  o.push('');
  o.push('Creator fee rates depend on the coin\'s market cap tier (set on-chain by pump.fun), so this is modelled in fees, not trading volume.');
  o.push('');
  o.push(`### Result (defaults: ${r.maxHiresPerLoop} hires per loop, ${cap} SOL/h, Jupiter budget ${r.jupiterMaxRpm} calls a minute, prices every 45 s)`);
  o.push('');
  o.push('| | |');
  o.push('|---|---|');
  const row = (k: string, v: string) => o.push(`| ${k} | ${v} |`);
  row('Most Jupiter calls in any minute', `**${r.maxJupiterPerMin}** (budget ${r.jupiterMaxRpm}; Free tier 60)`);
  row('Jupiter calls in total', `${n(r.buildCalls + r.priceCalls)} (${n(r.buildCalls)} \`/swap/v2/build\`, ${n(r.priceCalls)} \`/price/v3\`)`);
  row('Hire loops held back by the Jupiter budget', `${r.jupiterWaits}`);
  row('Longest hiring delay (claimed SOL waiting for its rat)', `**${min(r.longestDelay.min)}** (SOL claimed at minute ${Math.round(r.longestDelay.claimedAtMin)})`);
  row('Longest pause in hiring while budget waited', r.longestStall.min < 0.5 ? 'none: hiring never stopped while SOL waited' : `${min(r.longestStall.min)} (from minute ${Math.round(r.longestStall.atMin)})`);
  row('Rats waiting at peak (claimed, not hired yet)', `**about ${n(Math.floor(Number(r.peakWaiting.sol / salary)))}** (${sol(r.peakWaiting.sol)} SOL, minute ${Math.round(r.peakWaiting.atMin)})`);
  row('Every fee spent', r.spentMin === null ? '**no**' : `**yes, by minute ${Math.round(r.spentMin)}** (${sol(r.hireLeftLamports)} SOL left, less than one salary)`);
  row('Rats hired', `**${n(r.rats)}**`);
  row('Most spent in any hour (cap)', `${sol(r.maxOutHour)} SOL (${cap})`);
  row('Most hires in one loop', `${r.maxHiresInLoop} (limit ${r.maxHiresPerLoop})`);
  row('Transactions sent', `${n(r.txs)}`);
  row('Slowest worker loop (in memory)', `${Math.round(r.maxTickMs)} ms`);
  row('`/api/state` size at the end', `${r.api.stateKb} KB (${r.api.stateGzKb} KB gzipped)`);
  row('`/api/rats` size at the end', `${r.api.ratsKb} KB (${r.api.ratsGzKb} KB gzipped)`);
  row('Money check (ledger = chain, to the lamport)', 'exact');
  row('Simulation runtime', `${Math.round(r.runtimeSec)} s`);
  o.push('');
  o.push('### Timeline');
  o.push('');
  o.push(`Every 10 minutes. "Waiting" = claimed SOL not spent yet. "Last hour" = rolling 60-minute spend vs the ${cap} SOL cap. "Jupiter" = most calls in any minute of those 10 (budget ${r.jupiterMaxRpm}).`);
  o.push('');
  o.push('| Minute | Phase | Fees in | Claimed | Rats | New rats | Waiting | Last hour | Jupiter |');
  o.push('|---|---|---|---|---|---|---|---|---|');
  for (const x of r.rows) o.push(`| ${x.min} | ${x.phase} | ${sol(x.fees)} | ${sol(x.claimed)} | ${x.rats} | ${x.hires} | ${sol(x.waiting)} | ${sol(x.outHour)} | ${x.jupiterMax} |`);
  o.push('');
  o.push('### What this means');
  o.push('');
  o.push(`- **Jupiter stays on the Free tier.** The busiest minute had ${r.maxJupiterPerMin} calls, under the budget of ${r.jupiterMaxRpm} and far under Jupiter's 60. One \`/swap/v2/build\` per hire plus one \`/price/v3\` call every 45 s for every mint. When the budget is used up, hires wait for the next loop (the job-fair line); nothing fails and nothing retries in a tight loop. A 429 stops every Jupiter call with an exponential backoff (5 s up to 5 min) and alerts the owner.`);
  o.push(`- **The budget is a little tighter than the hourly cap.** Two 20-hire loops can fall inside one minute, so the budget caps hiring at about 38 builds a minute; with the price calls that tops out a little under the ${cap} SOL/h cap's pace in a long rush.`);
  o.push(`- **Every fee still hires rats.** 180 SOL of fees became ${n(r.rats)} rats, and the hire budget was fully spent by minute ${r.spentMin === null ? '?' : Math.round(r.spentMin)}. At the peak about ${n(Math.floor(Number(r.peakWaiting.sol / salary)))} rats' worth of SOL waited; no claimed SOL waited more than ${min(r.longestDelay.min)} for its rat.`);
  o.push(`- **The site** must handle ${n(r.rats)} rats: \`/api/rats\` is ${r.api.ratsKb} KB (${r.api.ratsGzKb} KB gzipped). Fetch it once, then follow \`/api/events\`. The building has desks for about 5,800; the rest line up outside (the job-fair line).`);
  o.push('- Not modelled: real Jupiter routes and xStock liquidity, real priority fees, real RPC latency (the worker loop time above is in memory).');
  o.push('<!-- sim-3h:end -->');
  return o.join('\n');
}

describe('Q5: 3-hour launch simulation', () => {
  it('every fee hires rats inside every limit (60 SOL/h, 20 per loop, 40 Jupiter calls a minute); ledger equals chain', async () => {
    const r = await simulate('defaults', {});
    check(r);
    expect(r.maxHiresPerLoop).toBe(20);
    expect(r.capLamports).toBe(60_000_000_000n);
    if (WRITE) {
      const path = new URL('../../SIMULATION.md', import.meta.url);
      const current = readFileSync(path, 'utf8');
      const section = report(r);
      const next = current.includes('<!-- sim-3h:start -->')
        ? current.replace(/<!-- sim-3h:start -->[\s\S]*<!-- sim-3h:end -->/, section)
        : current.replace(/\n## /, `\n${section}\n\n## `);
      writeFileSync(path, next);
      console.log(section);
    }
    console.log(
      `${r.rats} rats, spent by ${r.spentMin} min, max ${r.maxJupiterPerMin} Jupiter calls/min (budget max ${r.budgetMaxInWindow}), longest delay ${r.longestDelay.min.toFixed(1)} min, stall ${r.longestStall.min.toFixed(1)} min, peak waiting ${lamportsToSol(r.peakWaiting.sol)} SOL at ${r.peakWaiting.atMin.toFixed(0)} min, ${r.jupiterWaits} loops held by Jupiter, max ${lamportsToSol(r.maxOutHour)} SOL/h`,
    );
  }, 1_500_000);
});
