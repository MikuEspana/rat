import { BlockedError, NATIVE_SOL_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type TxRequest } from '@rat/core';
import { createBurnCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
  type AccountInfo,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { buildMintData } from './mint-data';
import { parseMintAccount } from './mint-parse';
import { RpcTxSender, type SenderConnection } from './rpc-sender';
import { SimChain, SimChainReader, SimTxSender, SYSTEM_ACCOUNT_RENT, SIGNATURE_FEE, ataAddress } from './sim';
import { normalizeTransaction } from './tx-normalize';

const info = (owner: string, data: Buffer): AccountInfo<Buffer> => ({
  owner: new PublicKey(owner),
  data,
  lamports: 1_000_000,
  executable: false,
  rentEpoch: 0,
});

describe('mint parsing', () => {
  const authority = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey.toBase58();

  it('reads Token-2022 Pausable, Scaled UI Amount and Permanent Delegate', () => {
    const data = buildMintData({
      decimals: 8,
      supply: 123_456_789n,
      mintAuthority: authority,
      freezeAuthority: authority,
      pausable: { authority, paused: true },
      scaledUi: { authority, multiplier: 1.0, newMultiplier: 1.05, effectiveTimestamp: 1_800_000_000n },
      permanentDelegate: authority,
    });
    const before = parseMintAccount(mint, info(TOKEN_2022_PROGRAM, data), 1_799_999_999);
    expect(before).toMatchObject({
      exists: true,
      tokenProgram: TOKEN_2022_PROGRAM,
      decimals: 8,
      supply: 123_456_789n,
      mintAuthority: authority.toBase58(),
      paused: true,
      uiMultiplier: 1.0,
      hasPermanentDelegate: true,
    });
    expect(parseMintAccount(mint, info(TOKEN_2022_PROGRAM, data), 1_800_000_000).uiMultiplier).toBe(1.05);
  });

  it('reads an unpaused Token-2022 mint and a legacy SPL mint', () => {
    const t22 = buildMintData({ decimals: 8, supply: 1n, mintAuthority: authority, pausable: { authority, paused: false } });
    expect(parseMintAccount(mint, info(TOKEN_2022_PROGRAM, t22), 0).paused).toBe(false);
    const legacy = buildMintData({ decimals: 6, supply: 1_000n, mintAuthority: null });
    const p = parseMintAccount(mint, info(TOKEN_PROGRAM, legacy), 0);
    expect(p).toMatchObject({ tokenProgram: TOKEN_PROGRAM, decimals: 6, mintAuthority: null, paused: false, uiMultiplier: 1 });
  });

  it('flags accounts that are not mints', () => {
    expect(parseMintAccount(mint, null, 0).exists).toBe(false);
    const p = parseMintAccount(mint, info(SystemProgram.programId.toBase58(), Buffer.alloc(0)), 0);
    expect(p.exists).toBe(true);
    expect(p.tokenProgram).toBe(SystemProgram.programId.toBase58());
  });
});

// ---------------------------------------------------------------- RpcTxSender

function fakeConnection(overrides: Partial<Record<keyof SenderConnection, unknown>> = {}) {
  const state = { sent: 0, height: 100 };
  const conn = {
    getLatestBlockhash: async () => ({ blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: 150 }),
    getRecentPrioritizationFees: async () => [{ slot: 1, prioritizationFee: 5_000 }, { slot: 2, prioritizationFee: 900_000 }],
    sendRawTransaction: async () => {
      state.sent++;
      return 'sig';
    },
    getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [null] }),
    getBlockHeight: async () => state.height,
    getEpochInfo: async () => ({ absoluteSlot: 1, blockHeight: state.height, epoch: 0, slotIndex: 1, slotsInEpoch: 432_000 }),
    getTransaction: async () => null,
    simulateTransaction: async () => ({ context: { slot: 1 }, value: { err: null, logs: ['ok'], accounts: null, unitsConsumed: 1 } }),
    ...overrides,
  };
  return { conn: conn as unknown as SenderConnection, state };
}

function request(extra: Partial<TxRequest> = {}): TxRequest {
  const payer = Keypair.generate();
  return {
    kind: 'claim',
    label: 'test',
    feePayer: payer,
    signers: [],
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
    computeUnitLimit: 200_000,
    ...extra,
  };
}

describe('RpcTxSender', () => {
  it('refuses to send in DRY RUN or without the live confirmation', async () => {
    for (const opts of [
      { dryRun: true, liveConfirmed: false },
      { dryRun: false, liveConfirmed: false },
      { dryRun: true, liveConfirmed: true },
    ]) {
      const { conn, state } = fakeConnection();
      const s = new RpcTxSender(conn, { ...opts, priorityFeeMaxMicroLamports: 100_000, sleep: async () => {} });
      const p = await s.prepare(request());
      await expect(s.submit(p)).rejects.toBeInstanceOf(BlockedError);
      expect(state.sent).toBe(0);
    }
  });

  it('prepares a signed v0 tx with a capped priority fee', async () => {
    const { conn } = fakeConnection();
    const s = new RpcTxSender(conn, { dryRun: true, liveConfirmed: false, priorityFeeMaxMicroLamports: 100_000 });
    const p = await s.prepare(request());
    const tx = VersionedTransaction.deserialize(p.serialized);
    expect(bs58.encode(tx.signatures[0]!)).toBe(p.signature);
    expect(p.lastValidBlockHeight).toBe(150);
    // compute limit, compute price (capped at 100k from the 900k p75 estimate), transfer
    expect(tx.message.compiledInstructions.length).toBe(3);
    const priceIx = tx.message.compiledInstructions[1]!;
    expect(Buffer.from(priceIx.data).readBigUInt64LE(1)).toBe(100_000n);
  });

  it('fails prepare when a required signer is missing', async () => {
    const { conn } = fakeConnection();
    const s = new RpcTxSender(conn, { dryRun: true, liveConfirmed: false, priorityFeeMaxMicroLamports: 1 });
    const other = Keypair.generate();
    const req = request();
    req.instructions.push(SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: other.publicKey, lamports: 1 }));
    await expect(s.prepare(req)).rejects.toThrow();
  });

  it('a rejected send stays unknown (never retried hot), is not rebroadcast, and only its blockhash expiry settles it', async () => {
    // web3.js raises SendTransactionError for ANY JSON-RPC error (connection.ts sendEncodedTransaction), and a
    // load-balanced RPC can reject on one node what another already forwarded: until the blockhash expires the tx
    // may still land, so its reservation stays and the rat is not retried.
    const { conn, state } = fakeConnection({
      sendRawTransaction: async () => {
        state.sent++;
        throw new SendTransactionError({ action: 'send', signature: 'x', transactionMessage: 'Transaction simulation failed: Blockhash not found', logs: [] });
      },
    });
    const s = new RpcTxSender(conn, { dryRun: false, liveConfirmed: true, priorityFeeMaxMicroLamports: 1, sleep: async () => {} });
    const p = await s.prepare(request());
    const out = await s.submit(p);
    expect(out.status).toBe('unknown');
    expect(out.error).toMatch(/^preflight: /);
    expect(out.record).toBeUndefined();
    expect(state.sent, 'no rebroadcast of a rejected tx (it could land as a failed tx and cost a fee)').toBe(1);
    state.height = 150 + 31;
    expect((await s.status(p.signature, p.lastValidBlockHeight)).status).toBe('expired');
  });

  it('never calls a tx expired from a status node that lags behind the block height it was compared with', async () => {
    // the height comes from one node (slot 1000, height 200), the status from another still at slot 900: a tx that
    // landed at slot 950 is invisible there. Expired would release the reservation and pay the rat a second time.
    const { conn } = fakeConnection({
      getEpochInfo: async () => ({ absoluteSlot: 1000, blockHeight: 200, epoch: 0, slotIndex: 1000, slotsInEpoch: 432_000 }),
      getSignatureStatuses: async () => ({ context: { slot: 900 }, value: [null] }),
    });
    const s = new RpcTxSender(conn, { dryRun: false, liveConfirmed: true, priorityFeeMaxMicroLamports: 1, sleep: async () => {} });
    expect((await s.status('sig', 150)).status).toBe('unknown');
    const caughtUp = fakeConnection({
      getEpochInfo: async () => ({ absoluteSlot: 1000, blockHeight: 200, epoch: 0, slotIndex: 1000, slotsInEpoch: 432_000 }),
      getSignatureStatuses: async () => ({ context: { slot: 1000 }, value: [null] }),
    });
    const s2 = new RpcTxSender(caughtUp.conn, { dryRun: false, liveConfirmed: true, priorityFeeMaxMicroLamports: 1, sleep: async () => {} });
    expect((await s2.status('sig', 150)).status).toBe('expired');
  });

  it('reports expired only after the blockhash is past its margin', async () => {
    const { conn, state } = fakeConnection();
    const s = new RpcTxSender(conn, { dryRun: false, liveConfirmed: true, priorityFeeMaxMicroLamports: 1, sleep: async () => { state.height += 10; }, expiryMarginBlocks: 30 });
    const out = await s.submit(await s.prepare(request()));
    expect(out.status).toBe('expired');
    expect(state.height).toBeGreaterThan(150 + 30);
    expect(state.sent).toBeGreaterThan(1);
  });

  it('confirms and returns the normalized record', async () => {
    let prepared: Uint8Array | null = null;
    let polls = 0;
    const { conn } = fakeConnection({
      getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [polls++ > 0 ? { confirmationStatus: 'confirmed', err: null, slot: 5, confirmations: 1 } : null] }),
      getTransaction: async () => {
        const vtx = VersionedTransaction.deserialize(prepared!);
        const n = vtx.message.staticAccountKeys.length;
        return {
          slot: 5,
          blockTime: 1,
          transaction: { message: vtx.message, signatures: vtx.signatures.map((x) => bs58.encode(x)) },
          meta: {
            fee: 5000,
            err: null,
            preBalances: Array(n).fill(10),
            postBalances: Array(n).fill(9),
            preTokenBalances: [],
            postTokenBalances: [],
            innerInstructions: [],
            logMessages: ['done'],
            loadedAddresses: { writable: [], readonly: [] },
          },
        };
      },
    });
    const s = new RpcTxSender(conn, { dryRun: false, liveConfirmed: true, priorityFeeMaxMicroLamports: 1, sleep: async () => {} });
    const p = await s.prepare(request());
    prepared = p.serialized;
    const out = await s.submit(p);
    expect(out.status).toBe('confirmed');
    expect(out.feeLamports).toBe(5000n);
    expect(out.record?.signature).toBe(p.signature);
    expect(out.record?.feePayer).toBe(p.request.feePayer.publicKey.toBase58());
    expect(out.record?.instructions.length).toBe(3);
  });

  it('claims and hires go to the RPC: one send with preflight, then preflight-skipped rebroadcasts of the same bytes', async () => {
    for (const kind of ['claim', 'hire'] as const) {
      const sends: { bytes: Uint8Array; skipPreflight?: boolean }[] = [];
      const { conn, state } = fakeConnection({
        sendRawTransaction: async (bytes: Uint8Array, o: { skipPreflight?: boolean }) => {
          sends.push({ bytes, skipPreflight: o.skipPreflight });
          return 'sig';
        },
      });
      const s = new RpcTxSender(conn, { dryRun: false, liveConfirmed: true, priorityFeeMaxMicroLamports: 1, sleep: async () => { state.height += 10; } });
      const p = await s.prepare(request({ kind }));
      expect((await s.submit(p)).status).toBe('expired');
      expect(sends.length).toBeGreaterThan(1);
      expect(sends[0]!.skipPreflight).toBe(false);
      expect(sends.slice(1).every((x) => x.skipPreflight === true)).toBe(true);
      expect(sends.every((x) => Buffer.from(x.bytes).equals(Buffer.from(p.serialized)))).toBe(true);
    }
  });

  it('a send error that is not a preflight rejection may have been broadcast: it keeps polling and rebroadcasting', async () => {
    let calls = 0;
    const { conn, state } = fakeConnection({
      sendRawTransaction: async () => {
        calls++;
        if (calls === 1) throw new Error('fetch failed: ECONNRESET');
        return 'sig';
      },
    });
    const s = new RpcTxSender(conn, { dryRun: false, liveConfirmed: true, priorityFeeMaxMicroLamports: 1, sleep: async () => { state.height += 10; } });
    const out = await s.submit(await s.prepare(request({ kind: 'hire' })));
    expect(out.status).toBe('expired');
    expect(calls).toBeGreaterThan(1);
  });

  it('simulates without sending', async () => {
    const { conn, state } = fakeConnection();
    const s = new RpcTxSender(conn, { dryRun: true, liveConfirmed: false, priorityFeeMaxMicroLamports: 1 });
    const out = await s.simulate(await s.prepare(request()));
    expect(out.status).toBe('simulated');
    expect(state.sent).toBe(0);
  });
});

describe('normalizeTransaction', () => {
  it('flattens inner instructions after their outer instruction', async () => {
    const { conn } = fakeConnection();
    const s = new RpcTxSender(conn, { dryRun: true, liveConfirmed: false, priorityFeeMaxMicroLamports: 1 });
    const p = await s.prepare(request());
    const vtx = VersionedTransaction.deserialize(p.serialized);
    const rec = normalizeTransaction({
      slot: 1,
      blockTime: null,
      transaction: { message: vtx.message, signatures: [p.signature] },
      meta: {
        fee: 5000,
        err: null,
        preBalances: [1, 2, 3, 4],
        postBalances: [1, 2, 3, 4],
        preTokenBalances: [{ accountIndex: 1, mint: 'M', owner: 'O', uiTokenAmount: { amount: '42', decimals: 0, uiAmount: 42, uiAmountString: '42' } }],
        postTokenBalances: [],
        innerInstructions: [{ index: 2, instructions: [{ programIdIndex: 0, accounts: [1], data: bs58.encode(Buffer.from([9, 9])) }] }],
        logMessages: [],
        loadedAddresses: { writable: [], readonly: [] },
      },
    } as never);
    expect(rec.instructions.map((i) => i.inner)).toEqual([false, false, false, true]);
    expect(Array.from(rec.instructions[3]!.data)).toEqual([9, 9]);
    expect(rec.preTokenBalances[0]).toMatchObject({ amount: 42n, owner: 'O', mint: 'M' });
    expect(rec.signers).toEqual([p.request.feePayer.publicKey.toBase58()]);
  });
});

// ---------------------------------------------------------------- SimChain

describe('SimChain', () => {
  const setup = () => {
    const chain = new SimChain();
    const sender = new SimTxSender(chain);
    const reader = new SimChainReader(chain);
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    chain.fundAccount(alice.publicKey.toBase58(), 1_000_000_000n);
    return { chain, sender, reader, alice, bob };
  };
  const tx = (payer: Keypair, instructions: TransactionInstruction[], signers: Keypair[] = []): TxRequest => ({
    kind: 'claim',
    label: 't',
    feePayer: payer,
    signers,
    instructions,
    computeUnitLimit: 200_000,
  });

  it('transfers SOL, charges the fee, records balances', async () => {
    const { chain, sender, alice, bob } = setup();
    const p = await sender.prepare(tx(alice, [SystemProgram.transfer({ fromPubkey: alice.publicKey, toPubkey: bob.publicKey, lamports: 10_000_000 })]));
    const out = await sender.submit(p);
    expect(out.status).toBe('confirmed');
    expect(chain.sol(bob.publicKey.toBase58())).toBe(10_000_000n);
    expect(chain.sol(alice.publicKey.toBase58())).toBe(1_000_000_000n - 10_000_000n - SIGNATURE_FEE);
    expect(out.record!.feeLamports).toBe(SIGNATURE_FEE);
  });

  it('rejects a transfer that leaves the receiver below rent', async () => {
    const { chain, sender, alice, bob } = setup();
    const out = await sender.submit(await sender.prepare(tx(alice, [SystemProgram.transfer({ fromPubkey: alice.publicKey, toPubkey: bob.publicKey, lamports: 1_000 })])));
    expect(out.status).toBe('failed');
    expect(chain.sol(bob.publicKey.toBase58())).toBe(0n);
    expect(chain.sol(alice.publicKey.toBase58())).toBe(1_000_000_000n - SIGNATURE_FEE);
    expect(SYSTEM_ACCOUNT_RENT).toBe(890_880n);
  });

  it('enforces signers', async () => {
    const { sender, alice, bob } = setup();
    const out = await sender.submit(await sender.prepare(tx(alice, [SystemProgram.transfer({ fromPubkey: bob.publicKey, toPubkey: alice.publicKey, lamports: 1 })])));
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/missing signature/);
  });

  it('creates ATAs, moves tokens, blocks paused mints, burns and unwraps WSOL', async () => {
    const { chain, sender, alice, bob } = setup();
    const mint = Keypair.generate().publicKey;
    chain.createMint({ mint: mint.toBase58(), decimals: 8, tokenProgram: TOKEN_2022_PROGRAM, supply: 100n });
    chain.setTokenBalance(alice.publicKey.toBase58(), mint.toBase58(), 100n, TOKEN_2022_PROGRAM);
    const prog = new PublicKey(TOKEN_2022_PROGRAM);
    const aliceAta = getAssociatedTokenAddressSync(mint, alice.publicKey, true, prog);
    const bobAta = getAssociatedTokenAddressSync(mint, bob.publicKey, true, prog);
    const create = createAssociatedTokenAccountIdempotentInstruction(alice.publicKey, bobAta, bob.publicKey, mint, prog);
    const move = createTransferCheckedInstruction(aliceAta, mint, bobAta, alice.publicKey, 40n, 8, [], prog);
    const out = await sender.submit(await sender.prepare(tx(alice, [create, create, move])));
    expect(out.status).toBe('confirmed');
    expect(chain.tokenBalance(bob.publicKey.toBase58(), mint.toBase58(), TOKEN_2022_PROGRAM)).toBe(40n);

    chain.updateMint(mint.toBase58(), { paused: true });
    const blocked = await sender.submit(await sender.prepare(tx(alice, [move])));
    expect(blocked.status).toBe('failed');
    expect(blocked.error).toMatch(/paused/);
    chain.updateMint(mint.toBase58(), { paused: false });

    const burn = createBurnCheckedInstruction(aliceAta, mint, alice.publicKey, 60n, 8, [], prog);
    expect((await sender.submit(await sender.prepare(tx(alice, [burn])))).status).toBe('confirmed');
    expect(chain.mintState(mint.toBase58())!.supply).toBe(40n);

    // wrapped SOL: 0.5 SOL of WSOL closes back into native SOL
    chain.setTokenBalance(bob.publicKey.toBase58(), NATIVE_SOL_MINT, 500_000_000n, TOKEN_PROGRAM);
    chain.fundAccount(bob.publicKey.toBase58(), 1_000_000n);
    const wsolAta = getAssociatedTokenAddressSync(new PublicKey(NATIVE_SOL_MINT), bob.publicKey, true, new PublicKey(TOKEN_PROGRAM));
    const before = chain.sol(bob.publicKey.toBase58());
    const close = createCloseAccountInstruction(wsolAta, bob.publicKey, bob.publicKey, [], new PublicKey(TOKEN_PROGRAM));
    expect((await sender.submit(await sender.prepare(tx(bob, [close])))).status).toBe('confirmed');
    expect(chain.sol(bob.publicKey.toBase58())).toBe(before + 500_000_000n + 2_039_280n - SIGNATURE_FEE);
  });

  it('failure injection: drop, fail, land_timeout, reject', async () => {
    const { chain, sender, alice, bob } = setup();
    const t = () => tx(alice, [SystemProgram.transfer({ fromPubkey: alice.publicKey, toPubkey: bob.publicKey, lamports: 1_000_000 })]);

    sender.failNext('drop');
    const p1 = await sender.prepare(t());
    expect((await sender.submit(p1)).status).toBe('expired');
    expect((await sender.status(p1.signature, p1.lastValidBlockHeight)).status).toBe('expired');

    sender.failNext('fail');
    const out2 = await sender.submit(await sender.prepare(t()));
    expect(out2.status).toBe('failed');
    expect(out2.record).toBeDefined();
    expect(chain.sol(bob.publicKey.toBase58())).toBe(0n);

    sender.failNext('land_timeout');
    const p3 = await sender.prepare(t());
    expect((await sender.submit(p3)).status).toBe('unknown');
    expect(chain.sol(bob.publicKey.toBase58())).toBe(1_000_000n);
    expect((await sender.status(p3.signature, p3.lastValidBlockHeight)).status).toBe('confirmed');

    sender.failNext('reject');
    const p4 = await sender.prepare(t());
    const out4 = await sender.submit(p4);
    expect(out4.status).toBe('unknown');
    expect(out4.record).toBeUndefined();
    expect(chain.sol(bob.publicKey.toBase58())).toBe(1_000_000n);
    chain.advanceBlocks(p4.lastValidBlockHeight - chain.blockHeight + 1);
    expect((await sender.status(p4.signature, p4.lastValidBlockHeight)).status).toBe('expired');

    sender.failNext('reject_lands');
    const p5 = await sender.prepare(t());
    expect((await sender.submit(p5)).status).toBe('unknown');
    expect(chain.sol(bob.publicKey.toBase58())).toBe(2_000_000n);
    expect((await sender.status(p5.signature, p5.lastValidBlockHeight)).status).toBe('confirmed');
  });

  it('simulate never mutates; reader returns signatures newest first', async () => {
    const { chain, sender, reader, alice, bob } = setup();
    const t = tx(alice, [SystemProgram.transfer({ fromPubkey: alice.publicKey, toPubkey: bob.publicKey, lamports: 1_000_000 })]);
    const sim = await sender.simulate(await sender.prepare(t));
    expect(sim.status).toBe('simulated');
    expect(chain.sol(bob.publicKey.toBase58())).toBe(0n);
    const a = await sender.submit(await sender.prepare(t));
    const b = await sender.submit(await sender.prepare(t));
    const sigs = await reader.getSignaturesSince(bob.publicKey.toBase58(), null);
    expect(sigs.map((s) => s.signature)).toEqual([b.signature, a.signature]);
    expect((await reader.getSignaturesSince(bob.publicKey.toBase58(), a.signature)).map((s) => s.signature)).toEqual([b.signature]);
    const tokens = await reader.getTokenAccounts([{ owner: bob.publicKey.toBase58(), mint: NATIVE_SOL_MINT, tokenProgram: TOKEN_PROGRAM }]);
    expect(tokens[0]).toMatchObject({ exists: false, amount: 0n, address: ataAddress(bob.publicKey.toBase58(), NATIVE_SOL_MINT, TOKEN_PROGRAM) });
  });
});

describe('red team: RPC effects simulation and signature paging', () => {
  it('simulateEffects reads pre state, then post state from simulateTransaction, and diffs SOL and token amounts', async () => {
    const req = request();
    const payer = req.feePayer;
    const rat = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();
    const tokenAcct = (amount: bigint) => {
      const d = Buffer.alloc(170);
      d.writeBigUInt64LE(amount, 64);
      return d;
    };
    let simConfig: { accounts?: { addresses: string[] }; minContextSlot?: number } = {};
    const { conn } = fakeConnection({
      getMultipleAccountsInfoAndContext: async () => ({ context: { slot: 77 }, value: [{ lamports: 1_000_000_000, data: Buffer.alloc(0) }, null] }),
      simulateTransaction: async (_tx: unknown, cfg: typeof simConfig) => {
        simConfig = cfg;
        return {
          context: { slot: 78 },
          value: { err: null, logs: [], accounts: [{ lamports: 969_000_000, data: ['', 'base64'] }, { lamports: 2_074_080, data: [tokenAcct(12_345n).toString('base64'), 'base64'] }] },
        };
      },
    });
    const s = new RpcTxSender(conn, { dryRun: false, liveConfirmed: true, priorityFeeMaxMicroLamports: 1 });
    const p = await s.prepare(req);
    const limits = { solOut: [{ account: payer.publicKey.toBase58(), maxLamports: 30_000_000n }], tokens: [{ owner: rat, mint, tokenProgram: TOKEN_2022_PROGRAM, minDelta: 1n }] };
    const eff = await s.simulateEffects(p, limits);
    expect(eff).toEqual({ solDelta: [-31_000_000n], tokenDelta: [12_345n] });
    // the token account asked for is the rat's associated token account; the simulation is at least as new as the pre read
    expect(simConfig.accounts?.addresses[1]).toBe(getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(rat), true, new PublicKey(TOKEN_2022_PROGRAM)).toBase58());
    expect(simConfig.minContextSlot).toBe(77);
  });

  it('simulateEffects reports a failing simulation and refuses a response without account states', async () => {
    const failing = fakeConnection({
      getMultipleAccountsInfoAndContext: async () => ({ context: { slot: 1 }, value: [null] }),
      simulateTransaction: async () => ({ context: { slot: 1 }, value: { err: { InstructionError: [2, 'Custom'] }, logs: [], accounts: null } }),
    });
    const s = new RpcTxSender(failing.conn, { dryRun: false, liveConfirmed: true, priorityFeeMaxMicroLamports: 1 });
    const limits = { solOut: [{ account: Keypair.generate().publicKey.toBase58(), maxLamports: 1n }] };
    expect((await s.simulateEffects(await s.prepare(request()), limits)).error).toMatch(/InstructionError/);
    const empty = fakeConnection({ getMultipleAccountsInfoAndContext: async () => ({ context: { slot: 1 }, value: [null] }) });
    const s2 = new RpcTxSender(empty.conn, { dryRun: false, liveConfirmed: true, priorityFeeMaxMicroLamports: 1 });
    await expect(s2.simulateEffects(await s2.prepare(request()), limits)).rejects.toThrow(/no account states/);
  });

  it('getSignaturesSince pages back with `before` until it reaches the cursor: no signature is skipped', async () => {
    const all = Array.from({ length: 2_345 }, (_, i) => `sig${2_345 - i}`); // newest first
    const calls: { before?: string; limit?: number }[] = [];
    const conn = {
      getSignaturesForAddress: async (_a: unknown, o: { before?: string; until?: string; limit: number }) => {
        calls.push({ before: o.before, limit: o.limit });
        const start = o.before ? all.indexOf(o.before) + 1 : 0;
        const stop = o.until ? all.indexOf(o.until) : all.length;
        return all.slice(start, stop).slice(0, o.limit).map((signature) => ({ signature, slot: 1, err: null, blockTime: null }));
      },
    };
    const { RpcChainReader } = await import('./rpc-reader');
    const reader = new RpcChainReader(conn as never);
    const got = await reader.getSignaturesSince(Keypair.generate().publicKey.toBase58(), 'sig5', 10_000);
    expect(got.length).toBe(2_340);
    expect(got.at(-1)?.signature).toBe('sig6');
    expect(calls.map((c) => c.limit)).toEqual([1000, 1000, 1000]);
    expect(calls[1]?.before).toBe(all[999]);
  });
});
