// READ-ONLY mainnet check, run on the Mac before launch (docs/runbooks/verify-mainnet.md). Public endpoints, no
// keys, no database: it never signs and never sends (simulations run with sigVerify=false). Checks, against live
// mainnet data, what the bot depends on:
//   - the pump.fun programs exist and are executable
//   - every enabled xStock mint exists, is Token-2022, shares the xStocks mint authority, is not paused, and has no
//     extension that would break a hire (transfer fee, transfer hook program, default frozen accounts, non-transferable)
//   - a Jupiter quote for the salary (0.03 SOL) into each: a route, its price impact, and how far it is from the
//     Jupiter Price API (the bot refuses more than MAX_PRICE_IMPACT_PCT, default 2%)
//   - with --sample <any pump.fun coin mint>: the bonding curve layout and the creator vault derivation match live
//     data, and the claim instruction simulates
//   - with --payer <any wallet holding 0.05 SOL>: one Jupiter swap into the first stock simulates (ATA creation
//     for a Token-2022 account included)
// Usage (from the repo folder): scripts/verify-mainnet.sh [--sample <coin mint>] [--payer <wallet>] [--authority <xStocks mint authority>] [--json]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseMintAccount } from '@rat/chain';
import { type MintState, NATIVE_SOL_MINT, TOKEN_2022_PROGRAM, redactSecrets } from '@rat/core';
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, bondingCurveAddress, collectCreatorFeeV2Ix, creatorAccounts, parseBondingCurve } from '@rat/pump';
import { verifyStockMints } from '@rat/safety';
import { ExtensionType, getExtensionTypes, getTransferHook, unpackMint } from '@solana/spl-token';
import { type AccountInfo, ComputeBudgetProgram, type Connection, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

export type Status = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
export interface Line {
  status: Status;
  check: string;
  detail: string;
}

export type VerifyConnection = Pick<Connection, 'getAccountInfo' | 'getMultipleAccountsInfo' | 'simulateTransaction' | 'getLatestBlockhash'>;

export interface VerifyDeps {
  conn: VerifyConnection;
  /** GET (no body) or POST (JSON body) returning parsed JSON; throws on an HTTP error, with the body in the message */
  getJson: (url: string, body?: unknown) => Promise<unknown>;
  nowSec: number;
}

export interface VerifyOptions {
  stocks: { symbol: string; mint: string }[];
  /** SOL per quote, in lamports (the salary: 0.03 SOL) */
  amountLamports: bigint;
  slippageBps: number;
  maxDeviationPct: number;
  jupiterBase: string;
  /** any pump.fun coin: checks the bonding curve layout, the creator vault derivation and the claim */
  sampleMint?: string;
  /** any wallet with about 0.05 SOL: pays the simulated claim and swap (nothing is signed or sent) */
  payer?: string;
  /** the xStocks mint authority (XSTOCKS_MINT_AUTHORITY); default: the one most mints share, like the bot */
  expectedAuthority?: string;
}

/** Extensions an xStock must not have: each would make a hire fail or cost more than it should. */
const RISKY_EXTENSIONS: [ExtensionType, string][] = [
  [ExtensionType.TransferFeeConfig, 'transfer fee (the rat would receive less than quoted)'],
  [ExtensionType.DefaultAccountState, 'default account state (new token accounts may start frozen)'],
  [ExtensionType.NonTransferable, 'non-transferable'],
];

function mintExtensions(mint: string, info: AccountInfo<Buffer>): { names: string[]; risky: string[] } {
  if (info.owner.toBase58() !== TOKEN_2022_PROGRAM) return { names: [], risky: [] };
  const m = unpackMint(new PublicKey(mint), info, info.owner);
  const types = m.tlvData.length > 0 ? getExtensionTypes(m.tlvData) : [];
  const names = types.map((t) => ExtensionType[t] ?? String(t));
  const risky = RISKY_EXTENSIONS.filter(([t]) => types.includes(t)).map(([, why]) => why);
  const hook = getTransferHook(m);
  if (hook && !hook.programId.equals(PublicKey.default)) risky.push(`transfer hook program ${hook.programId.toBase58()} (transfers need its extra accounts)`);
  return { names, risky };
}

const errText = (err: unknown) => redactSecrets((err as Error)?.message ?? String(err)).slice(0, 300);

export async function verifyMainnet(d: VerifyDeps, o: VerifyOptions): Promise<Line[]> {
  const lines: Line[] = [];
  const add = (status: Status, check: string, detail: string) => lines.push({ status, check, detail });

  // 1. the pump.fun programs
  for (const [name, id] of [
    ['pump program', PUMP_PROGRAM_ID],
    ['pump_amm program', PUMP_AMM_PROGRAM_ID],
  ] as const) {
    try {
      const info = await d.conn.getAccountInfo(new PublicKey(id));
      if (info?.executable) add('PASS', name, `${id} exists and is executable.`);
      else add('FAIL', name, `${id} is ${info ? 'not executable' : 'missing'} on this network.`);
    } catch (err) {
      add('FAIL', name, `read failed: ${errText(err)}`);
    }
  }

  // 2. the xStock mints
  const states = new Map<string, MintState>();
  const decimals = new Map<string, number>();
  try {
    const infos = await d.conn.getMultipleAccountsInfo(o.stocks.map((s) => new PublicKey(s.mint)));
    o.stocks.forEach((s, i) => {
      const info = infos[i] ?? null;
      const state = parseMintAccount(s.mint, info, d.nowSec);
      states.set(s.mint, state);
      decimals.set(s.mint, state.decimals);
    });
    const v = verifyStockMints(states, o.expectedAuthority);
    for (const s of o.stocks) {
      const st = states.get(s.mint)!;
      const check = v.checks.get(s.mint)!;
      const info = infos[o.stocks.indexOf(s)] ?? null;
      if (!check.ok) {
        add('FAIL', `mint ${s.symbol}`, `${s.mint}: ${check.reason}.`);
        continue;
      }
      const ext = info ? mintExtensions(s.mint, info) : { names: [], risky: [] };
      const facts = `Token-2022, ${st.decimals} decimals, authority ${st.mintAuthority}, extensions: ${ext.names.join(', ') || 'none'}`;
      if (st.paused) add('FAIL', `mint ${s.symbol}`, `${s.mint} is PAUSED by its issuer. ${facts}.`);
      else if (ext.risky.length > 0) add('WARN', `mint ${s.symbol}`, `${s.mint}: ${ext.risky.join('; ')}. ${facts}.`);
      else add('PASS', `mint ${s.symbol}`, `${s.mint}: ${facts}${st.uiMultiplier !== 1 ? `, UI multiplier ${st.uiMultiplier}` : ''}.`);
    }
  } catch (err) {
    add('FAIL', 'mints', `read failed: ${errText(err)}`);
  }

  // 3. Jupiter: a quote for the salary into each stock, against the Price API
  const base = o.jupiterBase.replace(/\/+$/, '');
  let prices: Record<string, { usdPrice?: number } | null> = {};
  try {
    prices = (await d.getJson(`${base}/price/v3?ids=${[NATIVE_SOL_MINT, ...o.stocks.map((s) => s.mint)].join(',')}`)) as typeof prices;
  } catch (err) {
    add('WARN', 'jupiter prices', `Price API failed: ${errText(err)}. Quotes are checked without the price comparison.`);
  }
  const solUsd = prices[NATIVE_SOL_MINT]?.usdPrice;
  const quotes = new Map<string, unknown>();
  for (const s of o.stocks) {
    const check = `quote ${s.symbol}`;
    try {
      const q = (await d.getJson(
        `${base}/swap/v1/quote?inputMint=${NATIVE_SOL_MINT}&outputMint=${s.mint}&amount=${o.amountLamports}&slippageBps=${o.slippageBps}`,
      )) as { outAmount?: string; priceImpactPct?: string; routePlan?: { swapInfo?: { label?: string } }[] };
      if (!q?.outAmount || BigInt(q.outAmount) <= 0n) {
        add('FAIL', check, `no route from SOL to ${s.mint}.`);
        continue;
      }
      quotes.set(s.mint, q);
      const impact = Number(q.priceImpactPct ?? 0) * 100;
      const venues = [...new Set((q.routePlan ?? []).map((r) => r.swapInfo?.label).filter(Boolean))].join(' + ') || '?';
      const outUi = Number(q.outAmount) / 10 ** (decimals.get(s.mint) ?? 0);
      const usd = prices[s.mint]?.usdPrice;
      const gap = solUsd && usd && outUi > 0 ? (((Number(o.amountLamports) / 1e9) * solUsd) / outUi / usd - 1) * 100 : null;
      const detail = `${Number(o.amountLamports) / 1e9} SOL -> ${outUi} ${s.symbol} via ${venues}, price impact ${impact.toFixed(2)}%${gap === null ? ', no Price API price to compare' : `, ${gap >= 0 ? `${gap.toFixed(2)}% worse` : `${(-gap).toFixed(2)}% better`} than the Price API`}`;
      if (impact > o.maxDeviationPct || (gap !== null && gap > o.maxDeviationPct)) add('WARN', check, `${detail}: over the ${o.maxDeviationPct}% the bot accepts, so it would skip this stock.`);
      else if (gap === null) add('WARN', check, `${detail}. The bot hires only stocks with a price.`);
      else add('PASS', check, `${detail}.`);
    } catch (err) {
      add('FAIL', check, `no route or quote failed: ${errText(err)}`);
    }
  }

  // 4. pump.fun on a live coin: bonding curve layout, creator vault derivation, the claim instruction
  let simPayer = o.payer;
  if (!o.sampleMint) {
    add('SKIP', 'bonding curve', 'pass --sample <any pump.fun coin mint> to check the layout and the creator vault on live data.');
  } else {
    try {
      const curve = await d.conn.getAccountInfo(new PublicKey(bondingCurveAddress(o.sampleMint)));
      const bc = curve && curve.owner.toBase58() === PUMP_PROGRAM_ID ? parseBondingCurve(new Uint8Array(curve.data)) : null;
      if (!bc) {
        add('FAIL', 'bonding curve', `${bondingCurveAddress(o.sampleMint)} is ${curve ? 'not a pump.fun bonding curve with the known layout' : 'missing'}.`);
      } else {
        const vault = creatorAccounts(bc.creator).bondingVault;
        const vaultInfo = await d.conn.getAccountInfo(new PublicKey(vault));
        add(
          vaultInfo ? 'PASS' : 'WARN',
          'bonding curve',
          `layout read (creator ${bc.creator}${bc.complete ? ', graduated' : ''}${bc.quoteMint ? `, quote ${bc.quoteMint}` : ', SOL-paired'}); creator vault ["creator-vault", creator] = ${vault} ${vaultInfo ? `exists (${Number(vaultInfo.lamports) / 1e9} SOL)` : 'does not exist yet (no fees so far)'}.`,
        );
        simPayer ??= bc.creator;
        const r = await simulate(d, simPayer, [collectCreatorFeeV2Ix(bc.creator)]);
        if (r.ok) add('PASS', 'claim simulation', `collect_creator_fee_v2 for ${bc.creator} simulates (paid by ${simPayer}, not signed, not sent). ${r.note}`);
        else add(o.payer ? 'FAIL' : 'WARN', 'claim simulation', `${r.error}${o.payer ? '' : ` (paid by the coin's creator; pass --payer <a wallet with SOL> if it has none)`}`);
      }
    } catch (err) {
      add('FAIL', 'bonding curve', `read failed: ${errText(err)}`);
    }
  }

  // 5. one swap into the first stock with a route, simulated (the payer must hold the SOL)
  const first = o.stocks.find((s) => quotes.has(s.mint));
  if (!o.payer) add('SKIP', 'swap simulation', 'pass --payer <any wallet holding about 0.05 SOL> to simulate one Jupiter swap (nothing is signed or sent).');
  else if (!first) add('SKIP', 'swap simulation', 'no stock had a quote.');
  else {
    try {
      const res = (await d.getJson(`${base}/swap/v1/swap`, { quoteResponse: quotes.get(first.mint), userPublicKey: o.payer, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true })) as {
        swapTransaction?: string;
      };
      if (!res?.swapTransaction) throw new Error('Jupiter /swap returned no transaction');
      const tx = VersionedTransaction.deserialize(Buffer.from(res.swapTransaction, 'base64'));
      const sim = await d.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
      if (sim.value.err) add('FAIL', 'swap simulation', `SOL -> ${first.symbol} for ${o.payer}: ${JSON.stringify(sim.value.err)}; ${(sim.value.logs ?? []).slice(-3).join(' | ')}`);
      else add('PASS', 'swap simulation', `SOL -> ${first.symbol} for ${o.payer} simulates, ${sim.value.unitsConsumed ?? '?'} compute units (not signed, not sent).`);
    } catch (err) {
      add('FAIL', 'swap simulation', errText(err));
    }
  }
  return lines;
}

async function simulate(d: VerifyDeps, payer: string, instructions: ReturnType<typeof collectCreatorFeeV2Ix>[]): Promise<{ ok: true; note: string } | { ok: false; error: string }> {
  try {
    const { blockhash } = await d.conn.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: new PublicKey(payer),
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ...instructions],
    }).compileToV0Message();
    const sim = await d.conn.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
    if (sim.value.err) return { ok: false, error: `simulation error ${JSON.stringify(sim.value.err)}; ${(sim.value.logs ?? []).slice(-3).join(' | ')}` };
    return { ok: true, note: `${sim.value.unitsConsumed ?? '?'} compute units.` };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

export function printLines(lines: Line[], out: (l: string) => void): boolean {
  for (const l of lines) out(`${l.status.padEnd(5)} ${l.check.padEnd(18)} ${l.detail}`);
  const fails = lines.filter((l) => l.status === 'FAIL').length;
  const warns = lines.filter((l) => l.status === 'WARN').length;
  out(fails > 0 ? `NOT OK: ${fails} FAIL, ${warns} WARN` : `OK: no FAIL (${warns} WARN)`);
  return fails === 0;
}

async function main(argv: string[]): Promise<number> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const file = JSON.parse(readFileSync(`${root}config/stocks.json`, 'utf8')) as { stocks: { symbol: string; mint: string; enabled: boolean }[] };
  const { Connection } = await import('@solana/web3.js');
  // public endpoints by default; a private RPC URL only through the environment (never printed)
  const conn = new Connection(process.env.VERIFY_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
  const getJson = async (url: string, body?: unknown) => {
    const res = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as unknown;
  };
  const lines = await verifyMainnet(
    { conn, getJson, nowSec: Math.floor(Date.now() / 1000) },
    {
      stocks: file.stocks.filter((s) => s.enabled),
      amountLamports: 30_000_000n,
      slippageBps: 150,
      maxDeviationPct: 2,
      jupiterBase: process.env.VERIFY_JUPITER_URL || 'https://lite-api.jup.ag',
      sampleMint: arg('--sample'),
      payer: arg('--payer'),
      expectedAuthority: arg('--authority') || process.env.XSTOCKS_MINT_AUTHORITY || undefined,
    },
  );
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ok: !lines.some((l) => l.status === 'FAIL'), lines }));
    return lines.some((l) => l.status === 'FAIL') ? 1 : 0;
  }
  console.log('The Inuvestors: read-only mainnet check (nothing is signed or sent)');
  return printLines(lines, (l) => console.log(l)) ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`verify-mainnet: ${errText(err)}`);
      process.exit(1);
    },
  );
}
