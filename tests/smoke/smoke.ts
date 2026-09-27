// MAINNET SMOKE TEST. Run ONLY by the owner, with THROWAWAY wallets and a THROWAWAY test coin.
// Never run by agents. Hard cap 0.1 SOL of bot spend (SMOKE_MODE lifetime cap in the SpendGuard).
//
//   pnpm --filter @rat/tests smoke -- --topup-hire 0.06 --topup-burn 0.012
//
// Steps: preflight -> claim (real fees of the test coin) -> optional ledger top-up (the test coin's fees are
// tiny; you send the SOL to the creator/fund wallets yourself first) -> hire 2 rats -> 1 buy + burn -> report.
import { writeFileSync } from 'node:fs';
import { createLogger, formatSol, loadConfig, solToLamports, TOKEN_2022_PROGRAM } from '@rat/core';
import { createProductionDeps, runBurnStep, runClaimStep, runHireStep, runMintStep, runPriceStep, WorkerState } from '@rat/worker';
import { smokePreflight } from './preflight';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cfg = loadConfig({ ...process.env, MAX_HIRES_PER_LOOP: process.env.MAX_HIRES_PER_LOOP ?? '2' });
const pre = await smokePreflight(cfg, null);
if (pre.length > 0) {
  console.error(`Smoke test refused:\n  - ${pre.join('\n  - ')}`);
  process.exit(1);
}
const log = createLogger({ level: 'info', name: 'rat-smoke' });
const { deps, handle } = await createProductionDeps(cfg, log);
const again = await smokePreflight(cfg, deps.store);
if (again.length > 0) {
  console.error(`Smoke test refused:\n  - ${again.join('\n  - ')}`);
  await handle.close();
  process.exit(1);
}
const state = new WorkerState();
const report: string[] = ['# Smoke test report', '', `Run at ${new Date().toISOString()}`, ''];
const step = async (name: string, fn: () => Promise<unknown>) => {
  const out = await fn();
  report.push(`## ${name}`, '', '```json', JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2), '```', '');
  log.info({ step: name }, 'done');
  return out;
};

try {
  await step('prices', () => runPriceStep(deps, state));
  await step('mints (verification)', () => runMintStep(deps));
  await step('claim', () => runClaimStep(deps, state));
  const topHire = arg('--topup-hire');
  const topBurn = arg('--topup-burn');
  if (topHire) await deps.store.ledger.append({ bucket: 'hire', deltaLamports: solToLamports(topHire), reason: 'claim_credit', refType: 'smoke_topup', note: 'owner-funded smoke test' });
  if (topBurn) await deps.store.ledger.append({ bucket: 'burn', deltaLamports: solToLamports(topBurn), reason: 'claim_credit', refType: 'smoke_topup', note: 'owner-funded smoke test' });
  await step('hire (2 rats)', () => runHireStep(deps, state));
  const rats = await deps.store.rats.listByStatus(['active', 'hiring', 'failed']);
  const stocks = new Map((await deps.store.stocks.list()).map((s) => [s.mint, s]));
  const facts = [];
  for (const r of rats) {
    const st = stocks.get(r.stockMint);
    const [acct] = await deps.chain.getTokenAccounts([{ owner: r.wallet, mint: r.stockMint, tokenProgram: st?.tokenProgram ?? TOKEN_2022_PROGRAM }]);
    const sol = (await deps.chain.getSolBalances([r.wallet])).get(r.wallet) ?? 0n;
    facts.push({ id: r.id, wallet: r.wallet, stock: st?.symbol, status: r.status, sig: r.hireSig, tokensDb: r.tokenAmountRaw?.toString(), tokensChain: acct?.amount.toString(), ratSol: formatSol(sol) });
  }
  report.push('## rats on-chain', '', '```json', JSON.stringify(facts, null, 2), '```', '');
  await step('buy + burn', () => runBurnStep(deps, state));
  report.push('## ledger', '', '```json', JSON.stringify(Object.fromEntries([...(await deps.store.ledger.sumByReason())].map(([k, v]) => [k, formatSol(v)])), null, 2), '```', '');
  report.push(
    '## What to check',
    '',
    '- Each rat is a fresh wallet that holds its stock on Solscan (single-tx hire worked with an unfunded taker + `payer`: owner decision #3).',
    '- Real cost per rat vs the 0.03 SOL salary (token account rent for xStocks, fees).',
    '- The coin token program (runtime detection, owner decision #5) and that the burn reduced supply.',
    '- Run `pnpm --filter @rat/jupiter check:scaled-ui` for owner decision #6.',
  );
} finally {
  writeFileSync(new URL('./REPORT.md', import.meta.url), report.join('\n'));
  await handle.close();
}
console.log('Smoke test finished. See tests/smoke/REPORT.md');
