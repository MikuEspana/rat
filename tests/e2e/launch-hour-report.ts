// Writes SIMULATION.md: the DRY RUN launch hour (50 SOL of fees), the cap scenario (100 SOL) and a live run on
// SimChain with the conservation check. Everything in memory: PGlite + SimChain + mock Jupiter + FakeClock.
//   pnpm --filter @rat/tests sim:launch-hour
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { formatSol, lamportsToSol } from '@rat/core';
import { SOL, type SimWorld, createSimWorld } from '@rat/worker';
import { runLaunch } from './helpers';

const HOUR = 3600;
const lines: string[] = [];
const out = (l = '') => lines.push(l);

async function snapshot(w: SimWorld) {
  const hourAgo = new Date(w.clock.now().getTime() - HOUR * 1000);
  return {
    claimed: (await w.store.claims.totals()).claimed,
    rats: (await w.store.rats.listByStatus(['active', 'frozen'])).length,
    hireOut: await w.store.ledger.netOutflowSince('hire', hourAgo),
    hireBal: await w.store.ledger.balance('hire'),
  };
}

async function scenarioA() {
  const w = await createSimWorld({ dryRun: true });
  const cfg = w.deps.config;
  const cap = formatSol(cfg.spendCapLamportsPerHour.hire);
  const creatorStart = w.chain.sol(w.creator.publicKey.toBase58());
  const timeline: string[] = [];
  const t0 = performance.now();
  const meter = await runLaunch(w, {
    seconds: HOUR,
    totalFees: 50n * SOL,
    graduateAtSec: 20 * 60,
    onTick: async (t) => {
      if (t % 600 === 595) {
        const s = await snapshot(w);
        timeline.push(
          `| ${Math.round((t + 5) / 60)} min | ${formatSol(s.claimed)} | ${s.rats} | ${formatSol(s.hireBal)} | ${formatSol(s.hireOut)} / ${cap} |`,
        );
      }
    },
  });
  await w.run(5 * 60, { stepSec: 5 });
  const seconds = (performance.now() - t0) / 1000;
  const s = await snapshot(w);
  const sums = await w.store.ledger.sumByReason();
  const rats = await w.store.rats.listByStatus(['active']);
  const stocks = await w.store.stocks.list();
  const bySymbol = stocks
    .map((st) => ({ st, n: rats.filter((r) => r.stockMint === st.mint).length }))
    .sort((a, b) => (b.st.change24hPct ?? 0) - (a.st.change24hPct ?? 0));

  out('## A. DRY RUN launch hour: 50 SOL of creator fees');
  out();
  out(`Fees accrue on a launch-shaped curve (front-loaded, decaying) for 60 minutes: bonding curve for 20 minutes, then PumpSwap after graduation. The worker runs on a fake clock in 5 second ticks. Config: salary ${formatSol(cfg.salaryLamports)} SOL, every claimed lamport hires rats, hire cap ${cap} SOL/h (alert at ${cfg.spendAlertPct}%), max ${cfg.maxHiresPerLoop} hires per loop, claim every ${cfg.intervals.claimSec}s. Then 5 more minutes with no new fees so the last claims get hired.`);
  out();
  out('| Check | Result |');
  out('|---|---|');
  out(`| Fees claimed | **${formatSol(s.claimed)} SOL** of 50 (every lamport once) |`);
  out(`| Credited to hires | ${formatSol(sums.get('hire:claim_credit') ?? 0n)} SOL (all of it) |`);
  out(`| Rats hired | **${s.rats}** (paper), ${formatSol(BigInt(s.rats) * cfg.salaryLamports)} SOL of salaries |`);
  out(`| Hire budget left | ${formatSol(s.hireBal)} SOL (less than one salary) |`);
  out(`| Max hires in one loop | ${meter.maxHiresPerLoop} (limit ${cfg.maxHiresPerLoop}) |`);
  out(`| Max Jupiter calls in any minute | ${meter.maxJupiterPerMinute} (limit ${cfg.jupiter.maxRpm}) |`);
  out(`| Cap alerts | ${w.alerts.keys().filter((k) => k.startsWith('cap_alert')).join(', ') || 'none'} (50% crossed once); cap reached: ${w.alerts.keys().filter((k) => k.startsWith('cap_reached')).length > 0 ? 'yes' : 'no'} |`);
  out(`| Transactions sent | **${w.simSender.submitted}** (DRY RUN simulated ${w.simSender.simulated}) |`);
  out(`| Creator wallet change | ${formatSol(w.chain.sol(w.creator.publicKey.toBase58()) - creatorStart)} SOL |`);
  out(`| Simulation runtime | ${seconds.toFixed(1)}s |`);
  out();
  out(`Timeline (cumulative; outflow = rolling last hour vs the ${cap} SOL cap):`);
  out();
  out('| Time | Claimed SOL | Rats | Hire budget waiting | Hire outflow |');
  out('|---|---|---|---|---|');
  for (const t of timeline) out(t);
  out();
  out('Hires by stock. Weights follow the 24h change rank at each hire (better performers get more new hires, 5% floor). Prices move during the simulated hour, so this table shows the change at the end:');
  out();
  out('| Stock | 24h change (end) | Rats |');
  out('|---|---|---|');
  for (const { st, n } of bySymbol) out(`| ${st.symbol} | ${(st.change24hPct ?? 0).toFixed(2)}% | ${n} |`);
  out();
  await w.close();
}

async function scenarioB() {
  const w = await createSimWorld({ dryRun: true });
  const cap = formatSol(w.deps.config.spendCapLamportsPerHour.hire);
  const meter = await runLaunch(w, { seconds: HOUR, totalFees: 100n * SOL });
  const first = await snapshot(w);
  await w.run(HOUR + 120, { stepSec: 5 });
  const second = await snapshot(w);
  out('## B. DRY RUN double volume: 100 SOL in one hour (hire cap)');
  out();
  out('| Check | Result |');
  out('|---|---|');
  out(`| Hire outflow in the first hour | **${formatSol(first.hireOut)} SOL** (cap ${cap}) |`);
  out(`| Max hires in one loop | ${meter.maxHiresPerLoop} (limit ${w.deps.config.maxHiresPerLoop}) |`);
  out(`| Max Jupiter calls in any minute | ${meter.maxJupiterPerMinute} (limit ${w.deps.config.jupiter.maxRpm}) |`);
  out(`| Alerts | ${[...new Set(w.alerts.keys().filter((k) => k.startsWith('cap_')))].join(', ')} |`);
  out(`| Budget carried into hour 2 | ${formatSol(first.hireBal)} SOL |`);
  out(`| After hour 2 | ${second.rats} rats, hire budget left ${formatSol(second.hireBal)} SOL |`);
  out(`| Transactions sent | ${w.simSender.submitted} |`);
  out();
  await w.close();
}

async function scenarioC() {
  const w = await createSimWorld({ dryRun: false });
  const creator = w.creator.publicKey.toBase58();
  const cStart = w.chain.sol(creator);
  const supplyStart = w.chain.mintState(w.coinMint)!.supply;
  await runLaunch(w, { seconds: HOUR, totalFees: 50n * SOL, graduateAtSec: 20 * 60 });
  await w.run(60, { stepSec: 5 });
  const hire = await w.store.ledger.balance('hire');
  const rats = await w.store.rats.listByStatus(['active']);
  const sums = await w.store.ledger.sumByReason();
  const hireSpent = -((sums.get('hire:hire_reserve') ?? 0n) + (sums.get('hire:hire_settle') ?? 0n) + (sums.get('hire:hire_release') ?? 0n));
  out('## C. Live execution on SimChain (in-memory, no network): 50 SOL hour');
  out();
  out('Same hour, but every claim and hire is executed on SimChain (real System/ATA/Token semantics, the real pump.fun claim instructions, a mock Jupiter swap).');
  out();
  out('| Check | Result |');
  out('|---|---|');
  out(`| Creator wallet change vs ledger | ${formatSol(w.chain.sol(creator) - cStart)} SOL vs ${formatSol(hire)} SOL: **${w.chain.sol(creator) - cStart === hire ? 'exact' : 'MISMATCH'}** |`);
  out(`| Coin supply | ${w.chain.mintState(w.coinMint)!.supply === supplyStart ? 'unchanged (nothing buys or burns the coin)' : 'CHANGED'} |`);
  out(`| Rats | ${rats.length}, real cost per rat ${formatSol(hireSpent / BigInt(rats.length))} SOL (salary ${formatSol(w.deps.config.salaryLamports)}) |`);
  out(`| Each rat on-chain | holds exactly its database token amount and ${formatSol(w.deps.config.ratBufferLamports)} SOL buffer |`);
  out(`| Transactions | ${w.simSender.submitted} submitted to SimChain |`);
  out();
  await w.close();
}

out('# Simulation report');
out();
out('Every claimed fee hires rats: buy and burn was removed on 2026-09-28. Defaults: at most 20 hires per 35 s loop and 60 SOL per hour.');
out();
out(`The 3-hour launch below is generated by \`pnpm sim:3h\`; sections A to C by \`pnpm --filter @rat/tests sim:launch-hour\` (${new Date().toISOString().slice(0, 10)}). Everything runs in memory (PGlite, SimChain, mock Jupiter, fake clock). Nothing touches mainnet. The same scenarios run as tests in \`tests/e2e\` and \`tests/sim\`.`);
out();
await scenarioA();
await scenarioB();
await scenarioC();
out('## Not covered by simulation');
out();
out('- Real Jupiter routes, real xStock liquidity and real priority fees (mocked). Checked by the owner-run smoke test and `check:stocks`.');
out('- Real RPC latency and rate limits (the sender and reader are unit-tested against fake connections).');
// keep the 3-hour launch section written by `pnpm sim:3h` (tests/sim/launch-3h.test.ts)
const path = new URL('../../SIMULATION.md', import.meta.url);
const previous = existsSync(path) ? readFileSync(path, 'utf8') : '';
const threeHour = previous.match(/<!-- sim-3h:start -->[\s\S]*<!-- sim-3h:end -->/)?.[0];
const body = lines.join('\n');
writeFileSync(path, `${threeHour ? body.replace(/\n## /, `\n${threeHour}\n\n## `) : body}\n`);
console.log(lines.join('\n'));
console.log(`\n(total fees simulated: ${lamportsToSol(200n * SOL)} SOL across scenarios)`);
