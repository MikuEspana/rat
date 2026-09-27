// SimChain: an in-memory Solana for tests and simulations. It executes real System, ATA and Token
// instructions (and any program registered with `registerProgram`), charges fees, enforces signers,
// rent exemption, paused mints and frozen accounts, and produces TxRecords like the real RPC.
// No network. Nothing here can touch mainnet.
import {
  ASSOCIATED_TOKEN_PROGRAM,
  type MintState,
  NATIVE_SOL_MINT,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  type TxInstructionRecord,
  type TxRecord,
  type TxTokenBalanceRecord,
} from '@rat/core';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ComputeBudgetInstruction, PublicKey, SystemInstruction, type TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { randomBytes } from 'node:crypto';

export const SYSTEM_ACCOUNT_RENT = 890_880n;
export const TOKEN_ACCOUNT_RENT = 2_039_280n;
/** Token-2022 accounts carry account extensions (xStocks: ImmutableOwner, PausableAccount, TransferHookAccount). Estimate. */
export const TOKEN_2022_ACCOUNT_RENT = 2_074_080n;
export const SIGNATURE_FEE = 5_000n;
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

export class SimError extends Error {}

export interface SimTokenAccount {
  address: string;
  owner: string;
  mint: string;
  program: string;
  amount: bigint;
  lamports: bigint;
  frozen: boolean;
}

interface SimState {
  sol: Map<string, bigint>;
  tokens: Map<string, SimTokenAccount>;
  mints: Map<string, MintState>;
}

function cloneState(s: SimState): SimState {
  const tokens = new Map<string, SimTokenAccount>();
  for (const [k, v] of s.tokens) tokens.set(k, { ...v });
  const mints = new Map<string, MintState>();
  for (const [k, v] of s.mints) mints.set(k, { ...v });
  return { sol: new Map(s.sol), tokens, mints };
}

export function ataAddress(owner: string, mint: string, program: string): string {
  return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, new PublicKey(program)).toBase58();
}

export function tokenRentFor(program: string): bigint {
  return program === TOKEN_2022_PROGRAM ? TOKEN_2022_ACCOUNT_RENT : TOKEN_ACCOUNT_RENT;
}

/** Execution context for one transaction (works on a copy of the state). */
export class SimContext {
  readonly touched = new Set<string>();
  readonly logs: string[] = [];
  readonly inner: TxInstructionRecord[] = [];

  constructor(
    readonly state: SimState,
    readonly signers: Set<string>,
    readonly chain: SimChain,
  ) {}

  requireSigner(pubkey: string): void {
    if (!this.signers.has(pubkey)) throw new SimError(`missing signature for ${pubkey}`);
  }

  isTokenAccount(address: string): boolean {
    return this.state.tokens.has(address);
  }

  lamports(address: string): bigint {
    const t = this.state.tokens.get(address);
    if (t) return t.lamports;
    return this.state.sol.get(address) ?? 0n;
  }

  credit(address: string, amount: bigint): void {
    if (amount < 0n) throw new SimError('negative credit');
    this.touched.add(address);
    const t = this.state.tokens.get(address);
    if (t) {
      t.lamports += amount;
      return;
    }
    this.state.sol.set(address, (this.state.sol.get(address) ?? 0n) + amount);
  }

  debit(address: string, amount: bigint): void {
    if (amount < 0n) throw new SimError('negative debit');
    this.touched.add(address);
    const have = this.lamports(address);
    if (have < amount) throw new SimError(`insufficient lamports in ${address}: have ${have}, need ${amount}`);
    const t = this.state.tokens.get(address);
    if (t) t.lamports -= amount;
    else this.state.sol.set(address, have - amount);
  }

  transferLamports(from: string, to: string, amount: bigint): void {
    this.debit(from, amount);
    this.credit(to, amount);
  }

  mint(address: string): MintState {
    const m = this.state.mints.get(address);
    if (!m || !m.exists) throw new SimError(`unknown mint ${address}`);
    return m;
  }

  token(address: string): SimTokenAccount {
    const t = this.state.tokens.get(address);
    if (!t) throw new SimError(`token account ${address} does not exist`);
    return t;
  }

  /** Creates (or returns) the associated token account, rent paid by `payer`. */
  ensureAta(owner: string, mint: string, program: string, payer: string, idempotent = true): SimTokenAccount {
    const address = ataAddress(owner, mint, program);
    const existing = this.state.tokens.get(address);
    if (existing) {
      if (!idempotent) throw new SimError(`account ${address} already exists`);
      return existing;
    }
    const m = this.state.mints.get(mint);
    if (mint !== NATIVE_SOL_MINT && (!m || !m.exists)) throw new SimError(`unknown mint ${mint}`);
    const rent = tokenRentFor(program);
    this.debit(payer, rent);
    const acct: SimTokenAccount = { address, owner, mint, program, amount: 0n, lamports: rent, frozen: false };
    this.state.tokens.set(address, acct);
    this.touched.add(address);
    return acct;
  }

  /** Moves tokens (and, for wrapped SOL, the lamports behind them). */
  moveTokens(from: SimTokenAccount, to: SimTokenAccount, amount: bigint): void {
    if (from.mint !== to.mint) throw new SimError('mint mismatch');
    if (from.frozen || to.frozen) throw new SimError('account is frozen');
    const m = this.state.mints.get(from.mint);
    if (m?.paused) throw new SimError('Transferring, minting, and burning is paused on this mint');
    if (from.amount < amount) throw new SimError(`insufficient token balance: have ${from.amount}, need ${amount}`);
    from.amount -= amount;
    to.amount += amount;
    if (from.mint === NATIVE_SOL_MINT) {
      from.lamports -= amount;
      to.lamports += amount;
    }
    this.touched.add(from.address);
    this.touched.add(to.address);
  }

  mintTo(to: SimTokenAccount, amount: bigint): void {
    const m = this.mint(to.mint);
    if (m.paused) throw new SimError('Transferring, minting, and burning is paused on this mint');
    to.amount += amount;
    m.supply += amount;
    this.touched.add(to.address);
  }

  burn(from: SimTokenAccount, amount: bigint): void {
    const m = this.mint(from.mint);
    if (m.paused) throw new SimError('Transferring, minting, and burning is paused on this mint');
    if (from.frozen) throw new SimError('account is frozen');
    if (from.amount < amount) throw new SimError(`insufficient token balance to burn: have ${from.amount}, need ${amount}`);
    from.amount -= amount;
    m.supply -= amount;
    this.touched.add(from.address);
  }

  log(msg: string): void {
    this.logs.push(msg);
  }
}

export type SimHandler = (ix: TransactionInstruction, ctx: SimContext) => void;

export interface SimTxSpec {
  signature: string;
  feePayer: string;
  signers: string[];
  instructions: TransactionInstruction[];
}

export interface ExecuteOptions {
  mutate: boolean;
  forceError?: string;
}

export type ExecuteResult = { landed: true; record: TxRecord } | { landed: false; reason: string };

export class SimChain {
  private state: SimState = { sol: new Map(), tokens: new Map(), mints: new Map() };
  private readonly handlers = new Map<string, SimHandler>();
  private readonly txs = new Map<string, TxRecord>();
  private readonly addressSigs = new Map<string, string[]>();
  slot = 1_000;
  blockHeight = 1_000;

  constructor() {
    this.registerProgram(COMPUTE_BUDGET_PROGRAM, () => {});
    this.registerProgram(SYSTEM_PROGRAM, systemHandler);
    this.registerProgram(ASSOCIATED_TOKEN_PROGRAM, ataHandler);
    this.registerProgram(TOKEN_PROGRAM, tokenHandler);
    this.registerProgram(TOKEN_2022_PROGRAM, tokenHandler);
    this.state.mints.set(NATIVE_SOL_MINT, {
      mint: NATIVE_SOL_MINT,
      exists: true,
      tokenProgram: TOKEN_PROGRAM,
      decimals: 9,
      supply: 0n,
      mintAuthority: null,
      freezeAuthority: null,
      paused: false,
      uiMultiplier: 1,
      hasPermanentDelegate: false,
    });
  }

  registerProgram(programId: string, handler: SimHandler): void {
    this.handlers.set(programId, handler);
  }

  newSignature(): string {
    return bs58.encode(randomBytes(64));
  }

  advanceBlocks(n: number): void {
    this.blockHeight += n;
    this.slot += n;
  }

  // ---------- direct state helpers (test setup, "the outside world") ----------

  airdrop(pubkey: string, lamports: bigint): void {
    this.state.sol.set(pubkey, (this.state.sol.get(pubkey) ?? 0n) + lamports);
  }

  setSol(pubkey: string, lamports: bigint): void {
    this.state.sol.set(pubkey, lamports);
  }

  createMint(m: Partial<MintState> & { mint: string; decimals: number; tokenProgram: string }): MintState {
    const state: MintState = {
      exists: true,
      supply: 0n,
      mintAuthority: null,
      freezeAuthority: null,
      paused: false,
      uiMultiplier: 1,
      hasPermanentDelegate: false,
      ...m,
    };
    this.state.mints.set(m.mint, state);
    return state;
  }

  updateMint(mint: string, patch: Partial<MintState>): void {
    const m = this.state.mints.get(mint);
    if (!m) throw new Error(`unknown mint ${mint}`);
    Object.assign(m, patch);
  }

  /** Sets a token balance directly (creates the ATA for free). For wrapped SOL the lamports follow. */
  setTokenBalance(owner: string, mint: string, amount: bigint, program = TOKEN_PROGRAM): SimTokenAccount {
    const address = ataAddress(owner, mint, program);
    let t = this.state.tokens.get(address);
    if (!t) {
      t = { address, owner, mint, program, amount: 0n, lamports: tokenRentFor(program), frozen: false };
      this.state.tokens.set(address, t);
    }
    if (mint === NATIVE_SOL_MINT) t.lamports = tokenRentFor(program) + amount;
    t.amount = amount;
    return t;
  }

  setFrozen(address: string, frozen: boolean): void {
    const t = this.state.tokens.get(address);
    if (!t) throw new Error(`no token account ${address}`);
    t.frozen = frozen;
  }

  /** Simulates the issuer's permanent delegate moving tokens out of an account. */
  seizeTokens(address: string, amount: bigint): void {
    const t = this.state.tokens.get(address);
    if (!t) throw new Error(`no token account ${address}`);
    t.amount -= amount;
  }

  // ---------- reads ----------

  sol(pubkey: string): bigint {
    const t = this.state.tokens.get(pubkey);
    if (t) return t.lamports;
    return this.state.sol.get(pubkey) ?? 0n;
  }

  tokenAccount(address: string): SimTokenAccount | undefined {
    const t = this.state.tokens.get(address);
    return t ? { ...t } : undefined;
  }

  tokenBalance(owner: string, mint: string, program: string): bigint {
    return this.state.tokens.get(ataAddress(owner, mint, program))?.amount ?? 0n;
  }

  mintState(mint: string): MintState | undefined {
    const m = this.state.mints.get(mint);
    return m ? { ...m } : undefined;
  }

  transaction(signature: string): TxRecord | undefined {
    return this.txs.get(signature);
  }

  signaturesFor(address: string): string[] {
    return [...(this.addressSigs.get(address) ?? [])];
  }

  // ---------- execution ----------

  execute(tx: SimTxSpec, opts: ExecuteOptions): ExecuteResult {
    const cbPrice = tx.instructions.find(
      (ix) => ix.programId.toBase58() === COMPUTE_BUDGET_PROGRAM && ix.data[0] === 3,
    );
    const cbLimit = tx.instructions.find(
      (ix) => ix.programId.toBase58() === COMPUTE_BUDGET_PROGRAM && ix.data[0] === 2,
    );
    const price = cbPrice ? BigInt(ComputeBudgetInstruction.decodeSetComputeUnitPrice(cbPrice).microLamports) : 0n;
    const limit = cbLimit ? BigInt(ComputeBudgetInstruction.decodeSetComputeUnitLimit(cbLimit).units) : 200_000n;
    const fee = SIGNATURE_FEE * BigInt(tx.signers.length) + (price * limit) / 1_000_000n;

    if ((this.state.sol.get(tx.feePayer) ?? 0n) < fee) {
      return { landed: false, reason: 'insufficient funds for fee' };
    }

    const before = this.state;
    const base = cloneState(before);
    base.sol.set(tx.feePayer, (base.sol.get(tx.feePayer) ?? 0n) - fee);
    const work = cloneState(base);
    const ctx = new SimContext(work, new Set(tx.signers), this);
    ctx.touched.add(tx.feePayer);
    let err: string | null = null;
    try {
      for (const ix of tx.instructions) {
        const handler = this.handlers.get(ix.programId.toBase58());
        if (!handler) throw new SimError(`unknown program ${ix.programId.toBase58()}`);
        handler(ix, ctx);
      }
      if (opts.forceError) throw new SimError(opts.forceError);
      for (const addr of ctx.touched) {
        if (work.tokens.has(addr)) continue;
        const l = work.sol.get(addr) ?? 0n;
        if (l > 0n && l < SYSTEM_ACCOUNT_RENT) throw new SimError(`insufficient funds for rent: ${addr}`);
      }
    } catch (e) {
      if (!(e instanceof SimError)) throw e;
      err = e.message;
    }
    const after = err ? base : work;

    const keySet: string[] = [];
    const addKey = (k: string) => {
      if (!keySet.includes(k)) keySet.push(k);
    };
    addKey(tx.feePayer);
    for (const s of tx.signers) addKey(s);
    for (const ix of tx.instructions) {
      for (const k of ix.keys) addKey(k.pubkey.toBase58());
    }
    for (const ix of tx.instructions) addKey(ix.programId.toBase58());

    const lamportsIn = (s: SimState, k: string) => s.tokens.get(k)?.lamports ?? s.sol.get(k) ?? 0n;
    const tokenBalances = (s: SimState): TxTokenBalanceRecord[] =>
      keySet
        .map((k, i) => ({ k, i, t: s.tokens.get(k) }))
        .filter((x) => x.t !== undefined)
        .map((x) => ({ accountIndex: x.i, account: x.k, owner: x.t!.owner, mint: x.t!.mint, amount: x.t!.amount }));

    const instructions: TxInstructionRecord[] = tx.instructions.map((ix) => ({
      programId: ix.programId.toBase58(),
      accounts: ix.keys.map((k) => k.pubkey.toBase58()),
      data: new Uint8Array(ix.data),
      inner: false,
    }));

    const record: TxRecord = {
      signature: tx.signature,
      slot: this.slot,
      blockTime: null,
      err: err ? { message: err } : null,
      feePayer: tx.feePayer,
      signers: [...tx.signers],
      feeLamports: fee,
      accountKeys: keySet,
      preBalances: keySet.map((k) => lamportsIn(before, k)),
      postBalances: keySet.map((k) => lamportsIn(after, k)),
      preTokenBalances: tokenBalances(before),
      postTokenBalances: tokenBalances(after),
      instructions: [...instructions, ...ctx.inner],
      logs: err ? [...ctx.logs, `Program failed: ${err}`] : ctx.logs,
    };

    if (opts.mutate) {
      this.state = after;
      this.txs.set(tx.signature, record);
      for (const k of keySet) {
        const list = this.addressSigs.get(k) ?? [];
        list.push(tx.signature);
        this.addressSigs.set(k, list);
      }
      this.advanceBlocks(1);
    }
    return { landed: true, record };
  }
}

// ---------- built-in program handlers ----------

function systemHandler(ix: TransactionInstruction, ctx: SimContext): void {
  const type = SystemInstruction.decodeInstructionType(ix);
  if (type !== 'Transfer') throw new SimError(`SimChain: unsupported system instruction ${type}`);
  const t = SystemInstruction.decodeTransfer(ix);
  const from = t.fromPubkey.toBase58();
  ctx.requireSigner(from);
  if (ctx.isTokenAccount(from)) throw new SimError('system transfer from a token account');
  ctx.transferLamports(from, t.toPubkey.toBase58(), t.lamports);
}

function ataHandler(ix: TransactionInstruction, ctx: SimContext): void {
  const mode = ix.data.length === 0 ? 0 : ix.data[0];
  if (mode !== 0 && mode !== 1) throw new SimError(`SimChain: unsupported ATA instruction ${mode}`);
  const [payer, ata, owner, mint, , tokenProgram] = ix.keys.map((k) => k.pubkey.toBase58());
  if (!payer || !ata || !owner || !mint || !tokenProgram) throw new SimError('ATA: missing accounts');
  ctx.requireSigner(payer);
  if (ataAddress(owner, mint, tokenProgram) !== ata) throw new SimError('ATA: address does not match derivation');
  ctx.ensureAta(owner, mint, tokenProgram, payer, mode === 1);
}

function readU64(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

function checkOwner(ctx: SimContext, acct: SimTokenAccount, owner: string): void {
  if (acct.owner !== owner) throw new SimError(`owner mismatch for ${acct.address}`);
  ctx.requireSigner(owner);
}

function tokenHandler(ix: TransactionInstruction, ctx: SimContext): void {
  const program = ix.programId.toBase58();
  const k = ix.keys.map((x) => x.pubkey.toBase58());
  const op = ix.data[0];
  const checkProgram = (a: SimTokenAccount) => {
    if (a.program !== program) throw new SimError(`account ${a.address} belongs to another token program`);
  };
  switch (op) {
    case 3: {
      // Transfer: source, destination, owner
      const src = ctx.token(k[0]!);
      const dst = ctx.token(k[1]!);
      checkProgram(src);
      checkOwner(ctx, src, k[2]!);
      ctx.moveTokens(src, dst, readU64(ix.data, 1));
      return;
    }
    case 12: {
      // TransferChecked: source, mint, destination, owner
      const src = ctx.token(k[0]!);
      const dst = ctx.token(k[2]!);
      checkProgram(src);
      checkOwner(ctx, src, k[3]!);
      if (ctx.mint(k[1]!).decimals !== ix.data[9]) throw new SimError('decimals mismatch');
      ctx.moveTokens(src, dst, readU64(ix.data, 1));
      return;
    }
    case 8:
    case 15: {
      // Burn / BurnChecked: account, mint, owner
      const acct = ctx.token(k[0]!);
      checkProgram(acct);
      if (acct.mint !== k[1]) throw new SimError('burn: mint mismatch');
      checkOwner(ctx, acct, k[2]!);
      if (op === 15 && ctx.mint(k[1]!).decimals !== ix.data[9]) throw new SimError('decimals mismatch');
      ctx.burn(acct, readU64(ix.data, 1));
      return;
    }
    case 9: {
      // CloseAccount: account, destination, owner
      const acct = ctx.token(k[0]!);
      checkProgram(acct);
      checkOwner(ctx, acct, k[2]!);
      if (acct.mint !== NATIVE_SOL_MINT && acct.amount !== 0n) throw new SimError('close: non-native account has balance');
      ctx.credit(k[1]!, acct.lamports);
      ctx.state.tokens.delete(acct.address);
      ctx.touched.add(acct.address);
      return;
    }
    case 17: {
      // SyncNative: account
      const acct = ctx.token(k[0]!);
      if (acct.mint !== NATIVE_SOL_MINT) throw new SimError('sync native on non-native account');
      acct.amount = acct.lamports - tokenRentFor(acct.program);
      return;
    }
    default:
      throw new SimError(`SimChain: unsupported token instruction ${op}`);
  }
}
