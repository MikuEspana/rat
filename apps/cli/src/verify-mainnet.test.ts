// The read-only mainnet check against a fake RPC and a fake Jupiter: what it reports, and that it only reads and
// simulates (sigVerify off), never sends.
import { buildMintData } from '@rat/chain';
import { NATIVE_SOL_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '@rat/core';
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, bondingCurveAddress, creatorAccounts, encodeBondingCurve } from '@rat/pump';
import { ExtensionType } from '@solana/spl-token';
import { type AccountInfo, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { type Line, type VerifyConnection, type VerifyOptions, verifyMainnet } from './verify-mainnet';

const authority = Keypair.generate().publicKey;
const mints = ['A', 'B', 'C', 'D'].map((s) => ({ symbol: `${s}x`, mint: Keypair.generate().publicKey.toBase58() }));
const creator = Keypair.generate().publicKey.toBase58();
const coin = Keypair.generate().publicKey.toBase58();
const payer = Keypair.generate().publicKey.toBase58();

const info = (owner: string, data: Buffer | Uint8Array, extra: Partial<AccountInfo<Buffer>> = {}): AccountInfo<Buffer> => ({
  owner: new PublicKey(owner),
  data: Buffer.from(data),
  lamports: 2_000_000,
  executable: false,
  rentEpoch: 0,
  ...extra,
});
const stockMint = (o: { paused?: boolean; program?: string; transferFee?: boolean } = {}) => {
  let data = buildMintData({ decimals: 8, supply: 1_000n, mintAuthority: authority, pausable: { authority, paused: o.paused ?? false }, permanentDelegate: authority });
  if (o.transferFee) {
    const tlv = Buffer.alloc(4 + 108);
    tlv.writeUInt16LE(ExtensionType.TransferFeeConfig, 0);
    tlv.writeUInt16LE(108, 2);
    data = Buffer.concat([data, tlv]);
  }
  return info(o.program ?? TOKEN_2022_PROGRAM, data);
};

function world(over: { mintInfos?: (AccountInfo<Buffer> | null)[]; programs?: boolean; curve?: boolean; simErr?: unknown; noRoute?: string; impact?: string } = {}) {
  const sims: { sigVerify?: boolean }[] = [];
  const accounts = new Map<string, AccountInfo<Buffer>>();
  if (over.programs !== false) {
    accounts.set(PUMP_PROGRAM_ID, info('BPFLoaderUpgradeab1e11111111111111111111111', Buffer.alloc(36), { executable: true }));
    accounts.set(PUMP_AMM_PROGRAM_ID, info('BPFLoaderUpgradeab1e11111111111111111111111', Buffer.alloc(36), { executable: true }));
  }
  if (over.curve !== false) accounts.set(bondingCurveAddress(coin), info(PUMP_PROGRAM_ID, encodeBondingCurve({ creator })));
  accounts.set(creatorAccounts(creator).bondingVault, info('11111111111111111111111111111111', Buffer.alloc(0), { lamports: 1_500_000_000 }));
  const conn = {
    getAccountInfo: async (pk: PublicKey) => accounts.get(pk.toBase58()) ?? null,
    getMultipleAccountsInfo: async (pks: PublicKey[]) => over.mintInfos ?? pks.map(() => stockMint()),
    getLatestBlockhash: async () => ({ blockhash: bs58.encode(Buffer.alloc(32, 9)), lastValidBlockHeight: 100 }),
    simulateTransaction: async (_tx: VersionedTransaction, cfg: { sigVerify?: boolean }) => {
      sims.push(cfg);
      return { context: { slot: 1 }, value: { err: over.simErr ?? null, logs: ['Program log: ok'], accounts: null, unitsConsumed: 42_000 } };
    },
  } as unknown as VerifyConnection;
  const swapTx = new VersionedTransaction(
    new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: bs58.encode(Buffer.alloc(32, 1)), instructions: [] }).compileToV0Message(),
  );
  const urls: string[] = [];
  const getJson = async (url: string, body?: unknown) => {
    urls.push(url);
    if (url.includes('/price/v3')) {
      return Object.fromEntries([[NATIVE_SOL_MINT, { usdPrice: 200 }], ...mints.map((m) => [m.mint, { usdPrice: 100 }])]);
    }
    if (url.includes('/swap/v1/quote')) {
      const out = new URL(url).searchParams.get('outputMint')!;
      if (out === over.noRoute) throw new Error('HTTP 400: {"errorCode":"COULD_NOT_FIND_ANY_ROUTE"}');
      // 0.03 SOL at $200 = $6 = 0.06 of a $100 stock, 8 decimals, 0.5% worse than the Price API
      return { outAmount: String(Math.floor(0.06 * 0.995 * 1e8)), priceImpactPct: out === mints[1]!.mint ? (over.impact ?? '0.001') : '0.001', routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }] };
    }
    if (url.endsWith('/swap/v1/swap')) {
      expect((body as { userPublicKey: string }).userPublicKey).toBe(payer);
      return { swapTransaction: Buffer.from(swapTx.serialize()).toString('base64') };
    }
    throw new Error(`unexpected ${url}`);
  };
  return { deps: { conn, getJson, nowSec: 1_800_000_000 }, sims, urls };
}

const opts = (o: Partial<VerifyOptions> = {}): VerifyOptions => ({
  stocks: mints,
  amountLamports: 30_000_000n,
  slippageBps: 150,
  maxDeviationPct: 2,
  jupiterBase: 'https://lite-api.jup.ag/',
  ...o,
});
const by = (lines: Line[], check: string) => lines.find((l) => l.check === check);

describe('verify-mainnet (read only)', () => {
  it('everything live checks out: programs, every mint, a quote each, the fee vault, the claim and a swap simulate', async () => {
    const w = world();
    const lines = await verifyMainnet(w.deps, opts({ sampleMint: coin, payer }));
    expect(lines.filter((l) => l.status === 'FAIL' || l.status === 'WARN')).toEqual([]);
    expect(by(lines, 'pump program')?.status).toBe('PASS');
    expect(by(lines, `mint ${mints[0]!.symbol}`)?.detail).toMatch(/Token-2022, 8 decimals, authority .*PausableConfig.*PermanentDelegate/);
    expect(by(lines, `quote ${mints[0]!.symbol}`)?.detail).toMatch(/0\.03 SOL -> 0\.0597 Ax via Meteora DLMM, price impact 0\.10%, 0\.50% worse than the Price API/);
    expect(by(lines, 'bonding curve')?.detail).toContain(creatorAccounts(creator).bondingVault);
    expect(by(lines, 'claim simulation')?.status).toBe('PASS');
    expect(by(lines, 'swap simulation')?.status).toBe('PASS');
    // only simulations, never with signature checks, and no send method is ever reached
    expect(w.sims.length).toBe(2);
    expect(w.sims.every((s) => s.sigVerify === false)).toBe(true);
    expect(w.urls.every((u) => u.startsWith('https://lite-api.jup.ag/'))).toBe(true);
  });

  it('a mint that would break hires is a FAIL or a WARN, with the reason', async () => {
    const w = world({
      mintInfos: [stockMint({ program: TOKEN_PROGRAM }), stockMint({ paused: true }), stockMint({ transferFee: true }), null],
    });
    const lines = await verifyMainnet(w.deps, opts({ expectedAuthority: authority.toBase58() }));
    expect(by(lines, 'mint Ax')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/not a Token-2022 mint/) });
    expect(by(lines, 'mint Bx')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/PAUSED/) });
    expect(by(lines, 'mint Cx')).toMatchObject({ status: 'WARN', detail: expect.stringMatching(/transfer fee/) });
    expect(by(lines, 'mint Dx')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/not found/) });
  });

  it('no route is a FAIL, a price impact over 2% a WARN; without --sample and --payer those checks are SKIP', async () => {
    const w = world({ noRoute: mints[0]!.mint, impact: '0.035' });
    const lines = await verifyMainnet(w.deps, opts());
    expect(by(lines, 'quote Ax')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/COULD_NOT_FIND_ANY_ROUTE/) });
    expect(by(lines, 'quote Bx')).toMatchObject({ status: 'WARN', detail: expect.stringMatching(/price impact 3\.50%.*over the 2%/) });
    expect(by(lines, 'bonding curve')?.status).toBe('SKIP');
    expect(by(lines, 'swap simulation')?.status).toBe('SKIP');
    expect(w.sims.length).toBe(0);
  });

  it('missing programs, a wrong bonding curve and a failing claim simulation are reported', async () => {
    const lines = await verifyMainnet(world({ programs: false, curve: false }).deps, opts({ sampleMint: coin }));
    expect(by(lines, 'pump program')?.status).toBe('FAIL');
    expect(by(lines, 'bonding curve')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/missing/) });
    const failing = await verifyMainnet(world({ simErr: { InstructionError: [1, { Custom: 6000 }] } }).deps, opts({ sampleMint: coin }));
    expect(by(failing, 'claim simulation')).toMatchObject({ status: 'WARN', detail: expect.stringMatching(/Custom.*6000.*pass --payer/) });
  });
});
