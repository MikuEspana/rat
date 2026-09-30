// Repositories. `Store` is bound to one mode (paper or live): every query on mode tables filters by it,
// so DRY RUN paper rows and live rows never mix.
import {
  type AttemptInput,
  type AttemptStore,
  type Bucket,
  type Clock,
  type EventType,
  type KeyPoolRecord,
  type KeyPoolStore,
  type LedgerEntryInput,
  type LedgerReason,
  type LedgerStore,
  type Mode,
  type OpenReservation,
  type Pubkey,
  type SettingsStore,
  type StockConfigEntry,
  type TxKind,
  type TxStatus,
  systemClock,
} from '@rat/core';
import { and, asc, desc, eq, gt, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from './connection';
import {
  claims,
  events,
  heartbeats,
  keyPool,
  ledgerEntries,
  locks,
  rats,
  seenSignatures,
  settings,
  stockPrices,
  stocks,
  txAttempts,
} from './schema';

export type RatRow = typeof rats.$inferSelect;
export type StockRow = typeof stocks.$inferSelect;
export type ClaimRow = typeof claims.$inferSelect;
export type AttemptRow = typeof txAttempts.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type HeartbeatRow = typeof heartbeats.$inferSelect;

const toBig = (v: unknown): bigint => BigInt((v as string | number | bigint | null) ?? 0);

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

// ---------------------------------------------------------------- settings

export class SettingsRepo implements SettingsStore {
  constructor(private readonly db: Database) {}

  async get(key: string): Promise<string | null> {
    const r = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    return r[0]?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }
}

// ---------------------------------------------------------------- keys

export class KeyPoolRepo implements KeyPoolStore {
  constructor(private readonly db: Database) {}

  async insertRatKey(record: KeyPoolRecord): Promise<void> {
    if (record.role !== 'rat') throw new Error('insertRatKey only stores rat keys');
    await this.db.insert(keyPool).values({ ...record, status: 'assigned', assignedAt: sql`now()` });
  }

  async markUnused(pubkey: Pubkey): Promise<void> {
    await this.db
      .update(keyPool)
      .set({ status: 'unused' })
      .where(and(eq(keyPool.pubkey, pubkey), eq(keyPool.role, 'rat')));
  }

  async get(pubkey: Pubkey): Promise<KeyPoolRecord | null> {
    const r = await this.db.select().from(keyPool).where(eq(keyPool.pubkey, pubkey)).limit(1);
    const k = r[0];
    return k ? { pubkey: k.pubkey, secretEnc: k.secretEnc, keyVersion: k.keyVersion, role: k.role as KeyPoolRecord['role'] } : null;
  }

  async getRole(role: 'creator'): Promise<KeyPoolRecord | null> {
    const r = await this.db.select().from(keyPool).where(eq(keyPool.role, role)).limit(1);
    const k = r[0];
    return k ? { pubkey: k.pubkey, secretEnc: k.secretEnc, keyVersion: k.keyVersion, role } : null;
  }

  /** The creator's public key only (the creator_pubkey view): the API's read-only user can read it, never the secret. */
  async creatorPubkey(): Promise<Pubkey | null> {
    const r = await this.db.execute(sql`select "pubkey" from "creator_pubkey" limit 1`);
    return (rowsOf<{ pubkey: Pubkey }>(r)[0]?.pubkey) ?? null;
  }

  /** Stores the creator key. Refuses to overwrite unless `replace` is set. */
  async setRoleKey(record: KeyPoolRecord & { role: 'creator' }, opts: { replace?: boolean } = {}): Promise<void> {
    const existing = await this.getRole(record.role);
    if (existing && !opts.replace) throw new Error(`a ${record.role} key is already stored (${existing.pubkey})`);
    await this.db.transaction(async (tx) => {
      await tx.delete(keyPool).where(eq(keyPool.role, record.role));
      await tx.insert(keyPool).values({ ...record, status: 'assigned' });
    });
  }

  /** Rat keys by status: assigned (a rat's wallet) and unused (hire abandoned before any transaction). */
  async counts(): Promise<{ assigned: number; unused: number }> {
    const r = await this.db
      .select({ status: keyPool.status, n: sql<number>`count(*)::int` })
      .from(keyPool)
      .where(eq(keyPool.role, 'rat'))
      .groupBy(keyPool.status);
    const get = (st: string) => Number(r.find((x) => x.status === st)?.n ?? 0);
    return { assigned: get('assigned'), unused: get('unused') };
  }

  /** Re-encryption support: every stored key. */
  async all(): Promise<KeyPoolRecord[]> {
    const r = await this.db.select().from(keyPool);
    return r.map((k) => ({ pubkey: k.pubkey, secretEnc: k.secretEnc, keyVersion: k.keyVersion, role: k.role as KeyPoolRecord['role'] }));
  }

  async updateSecret(pubkey: Pubkey, secretEnc: string, keyVersion: number): Promise<void> {
    await this.db.update(keyPool).set({ secretEnc, keyVersion }).where(eq(keyPool.pubkey, pubkey));
  }
}

// ---------------------------------------------------------------- ledger

const SPEND_REASONS: Record<Bucket, LedgerReason[]> = {
  hire: ['hire_reserve', 'hire_settle', 'hire_release'],
};

export class LedgerRepo implements LedgerStore {
  constructor(
    private readonly db: Database,
    readonly mode: Mode,
    private readonly clock: Clock,
  ) {}

  async append(entry: LedgerEntryInput): Promise<number> {
    const r = await this.db
      .insert(ledgerEntries)
      .values({
        mode: this.mode,
        at: this.clock.now(),
        bucket: entry.bucket,
        deltaLamports: entry.deltaLamports,
        reason: entry.reason,
        refType: entry.refType ?? null,
        refId: entry.refId ?? null,
        note: entry.note ?? null,
      })
      .returning({ id: ledgerEntries.id });
    return r[0]!.id;
  }

  async close(entry: LedgerEntryInput & { closesId: number }): Promise<boolean> {
    const r = await this.db
      .insert(ledgerEntries)
      .values({
        mode: this.mode,
        at: this.clock.now(),
        bucket: entry.bucket,
        deltaLamports: entry.deltaLamports,
        reason: entry.reason,
        refType: entry.refType ?? null,
        refId: entry.refId ?? null,
        note: entry.note ?? null,
        closesId: entry.closesId,
      })
      .onConflictDoNothing({ target: ledgerEntries.closesId })
      .returning({ id: ledgerEntries.id });
    return r.length > 0;
  }

  async isOpen(id: number): Promise<boolean> {
    const r = await this.db.select({ id: ledgerEntries.id }).from(ledgerEntries).where(eq(ledgerEntries.closesId, id)).limit(1);
    return r.length === 0;
  }

  async openReservations(bucket: Bucket): Promise<OpenReservation[]> {
    const rows = await this.db
      .select({ id: ledgerEntries.id, delta: ledgerEntries.deltaLamports, refType: ledgerEntries.refType, refId: ledgerEntries.refId })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.mode, this.mode),
          eq(ledgerEntries.bucket, bucket),
          eq(ledgerEntries.reason, `${bucket}_reserve`),
          sql`not exists (select 1 from ledger_entries c where c.closes_id = ${ledgerEntries.id})`,
        ),
      )
      .orderBy(ledgerEntries.id);
    return rows.map((r) => ({ id: r.id, lamports: -r.delta, refType: r.refType, refId: r.refId }));
  }

  async balance(bucket: Bucket): Promise<bigint> {
    const r = await this.db
      .select({ v: sql<string>`coalesce(sum(${ledgerEntries.deltaLamports}), 0)::text` })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.mode, this.mode), eq(ledgerEntries.bucket, bucket)));
    return toBig(r[0]?.v);
  }

  /**
   * Net spend in the window. A settle or release counts at the time of the reservation it closes (when the SOL
   * really left): counted at its own later time, a release would free cap room after its reservation had already
   * left the window, and the real outflow of an hour could exceed the cap.
   */
  async netOutflowSince(bucket: Bucket, since: Date): Promise<bigint> {
    const r = await this.db
      .select({ v: sql<string>`coalesce(-sum(${ledgerEntries.deltaLamports}), 0)::text` })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.mode, this.mode),
          eq(ledgerEntries.bucket, bucket),
          inArray(ledgerEntries.reason, SPEND_REASONS[bucket]),
          // a closing row is written at or after its reservation, so this only narrows the scan
          gte(ledgerEntries.at, since),
          sql`coalesce((select o.at from ledger_entries o where o.id = ${ledgerEntries.closesId}), ${ledgerEntries.at}) >= ${since}`,
        ),
      );
    return toBig(r[0]?.v);
  }

  async lifetimeNetOutflow(): Promise<bigint> {
    const r = await this.db
      .select({ v: sql<string>`coalesce(-sum(${ledgerEntries.deltaLamports}), 0)::text` })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.mode, this.mode),
          inArray(ledgerEntries.reason, [...SPEND_REASONS.hire, 'claim_fee']),
        ),
      );
    return toBig(r[0]?.v);
  }

  async sumByReason(): Promise<Map<string, bigint>> {
    const r = await this.db
      .select({ reason: ledgerEntries.reason, bucket: ledgerEntries.bucket, v: sql<string>`sum(${ledgerEntries.deltaLamports})::text` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.mode, this.mode))
      .groupBy(ledgerEntries.reason, ledgerEntries.bucket);
    return new Map(r.map((x) => [`${x.bucket}:${x.reason}`, toBig(x.v)]));
  }

  async list(limit = 100): Promise<(typeof ledgerEntries.$inferSelect)[]> {
    return this.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.mode, this.mode))
      .orderBy(desc(ledgerEntries.id))
      .limit(limit);
  }
}

// ---------------------------------------------------------------- tx attempts

export class AttemptRepo implements AttemptStore {
  constructor(
    private readonly db: Database,
    readonly mode: Mode,
    private readonly clock: Clock,
  ) {}

  async create(input: AttemptInput): Promise<number> {
    const now = this.clock.now();
    const r = await this.db
      .insert(txAttempts)
      .values({ mode: this.mode, ...input, status: 'pending', createdAt: now, updatedAt: now })
      .returning({ id: txAttempts.id });
    return r[0]!.id;
  }

  async finish(id: number, result: { status: TxStatus; error?: string; feeLamports?: bigint }): Promise<void> {
    await this.db
      .update(txAttempts)
      .set({ status: result.status, error: result.error ?? null, feeLamports: result.feeLamports ?? null, updatedAt: this.clock.now() })
      .where(eq(txAttempts.id, id));
  }

  /** Every attempt of this mode, oldest first (rat audit). */
  async all(): Promise<AttemptRow[]> {
    return this.db.select().from(txAttempts).where(eq(txAttempts.mode, this.mode)).orderBy(txAttempts.id);
  }

  /** The newest attempts of this mode (admin page). */
  async latest(limit: number): Promise<AttemptRow[]> {
    return this.db.select().from(txAttempts).where(eq(txAttempts.mode, this.mode)).orderBy(desc(txAttempts.id)).limit(limit);
  }

  async latestForRef(refType: string, refId: string): Promise<AttemptRow | null> {
    const r = await this.db
      .select()
      .from(txAttempts)
      .where(and(eq(txAttempts.mode, this.mode), eq(txAttempts.refType, refType), eq(txAttempts.refId, refId)))
      .orderBy(desc(txAttempts.id))
      .limit(1);
    return r[0] ?? null;
  }

  async forRef(refType: string, refId: string): Promise<AttemptRow[]> {
    return this.db
      .select()
      .from(txAttempts)
      .where(and(eq(txAttempts.mode, this.mode), eq(txAttempts.refType, refType), eq(txAttempts.refId, refId)))
      .orderBy(asc(txAttempts.id));
  }

  async bySignature(signature: string): Promise<AttemptRow | null> {
    const r = await this.db.select().from(txAttempts).where(eq(txAttempts.signature, signature)).limit(1);
    return r[0] ?? null;
  }

  async signaturesKnown(signatures: string[]): Promise<Set<string>> {
    if (signatures.length === 0) return new Set();
    const r = await this.db
      .select({ s: txAttempts.signature })
      .from(txAttempts)
      .where(inArray(txAttempts.signature, signatures));
    return new Set(r.map((x) => x.s));
  }

  async countByStatusSince(since: Date): Promise<Map<string, number>> {
    const r = await this.db
      .select({ status: txAttempts.status, n: sql<number>`count(*)::int` })
      .from(txAttempts)
      .where(and(eq(txAttempts.mode, this.mode), gte(txAttempts.createdAt, since)))
      .groupBy(txAttempts.status);
    return new Map(r.map((x) => [x.status, Number(x.n)]));
  }
}

// ---------------------------------------------------------------- stocks

export interface MintFacts {
  decimals: number;
  tokenProgram: string | null;
  mintAuthority: string | null;
  uiMultiplier: number;
}

export class StockRepo {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  /** Upserts config/stocks.json. Stocks missing from the file are disabled, never deleted. */
  async syncConfig(entries: StockConfigEntry[]): Promise<void> {
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      for (const e of entries) {
        await tx
          .insert(stocks)
          .values({ mint: e.mint, symbol: e.symbol, name: e.name, grp: e.group, enabled: e.enabled, approved: e.approved, updatedAt: now })
          .onConflictDoUpdate({
            target: stocks.mint,
            set: { symbol: e.symbol, name: e.name, grp: e.group, enabled: e.enabled, approved: e.approved, updatedAt: now },
          });
      }
      const mints = entries.map((e) => e.mint);
      const all = await tx.select({ mint: stocks.mint }).from(stocks);
      const missing = all.map((s) => s.mint).filter((m) => !mints.includes(m));
      if (missing.length > 0) {
        await tx.update(stocks).set({ enabled: false, updatedAt: now }).where(inArray(stocks.mint, missing));
      }
    });
  }

  async list(): Promise<StockRow[]> {
    return this.db.select().from(stocks).orderBy(asc(stocks.symbol));
  }

  async get(mint: string): Promise<StockRow | null> {
    const r = await this.db.select().from(stocks).where(eq(stocks.mint, mint)).limit(1);
    return r[0] ?? null;
  }

  async setMintFacts(mint: string, facts: MintFacts): Promise<void> {
    await this.db
      .update(stocks)
      .set({ ...facts, updatedAt: this.clock.now() })
      .where(eq(stocks.mint, mint));
  }

  async setVerification(mint: string, verified: boolean, error: string | null): Promise<void> {
    const now = this.clock.now();
    await this.db.update(stocks).set({ verified, verifyError: error, verifiedAt: now, updatedAt: now }).where(eq(stocks.mint, mint));
  }

  /** Returns the previous status. */
  async setStatus(mint: string, status: 'active' | 'paused'): Promise<string | null> {
    const prev = await this.get(mint);
    if (!prev) return null;
    if (prev.status !== status) {
      await this.db.update(stocks).set({ status, updatedAt: this.clock.now() }).where(eq(stocks.mint, mint));
    }
    return prev.status;
  }

  async setPrice(mint: string, priceUsd: number, change24hPct: number | null, at: Date): Promise<void> {
    await this.db.update(stocks).set({ priceUsd, change24hPct, priceAt: at }).where(eq(stocks.mint, mint));
  }

  async addPriceHistory(rows: { mint: string; priceUsd: number; at: Date }[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(stockPrices).values(rows);
  }

  async latestHistoryAt(mint: string): Promise<Date | null> {
    const r = await this.db
      .select({ at: stockPrices.at })
      .from(stockPrices)
      .where(eq(stockPrices.mint, mint))
      .orderBy(desc(stockPrices.at))
      .limit(1);
    return r[0]?.at ?? null;
  }

  async pruneHistory(before: Date): Promise<void> {
    await this.db.delete(stockPrices).where(sql`${stockPrices.at} < ${before}`);
  }
}

// ---------------------------------------------------------------- rats

export interface ActivateRat {
  hireSig: string;
  solSwappedLamports: bigint;
  tokenAmountRaw: bigint;
  tokenDecimals: number;
  costUsd: number;
  solUsdAtHire: number | null;
  hiredAt: Date;
}

export class RatRepo {
  constructor(
    private readonly db: Database,
    readonly mode: Mode,
    private readonly clock: Clock,
  ) {}

  async create(input: { wallet: string; stockMint: string; salaryLamports: bigint; avatarSeed: string }): Promise<RatRow> {
    const r = await this.db
      .insert(rats)
      .values({ mode: this.mode, status: 'hiring', createdAt: this.clock.now(), ...input })
      .returning();
    return r[0]!;
  }

  async get(id: number): Promise<RatRow | null> {
    const r = await this.db.select().from(rats).where(and(eq(rats.id, id), eq(rats.mode, this.mode))).limit(1);
    return r[0] ?? null;
  }

  async byWallet(wallet: string): Promise<RatRow | null> {
    const r = await this.db.select().from(rats).where(and(eq(rats.wallet, wallet), eq(rats.mode, this.mode))).limit(1);
    return r[0] ?? null;
  }

  async listByStatus(statuses: string[]): Promise<RatRow[]> {
    return this.db
      .select()
      .from(rats)
      .where(and(eq(rats.mode, this.mode), inArray(rats.status, statuses)))
      .orderBy(asc(rats.id));
  }

  async update(id: number, patch: Partial<Omit<RatRow, 'id' | 'mode' | 'wallet'>>): Promise<void> {
    await this.db.update(rats).set(patch).where(and(eq(rats.id, id), eq(rats.mode, this.mode)));
  }

  async activate(id: number, a: ActivateRat): Promise<void> {
    await this.update(id, { status: 'active', freezeReason: null, ...a });
  }

  async incrementAttempts(id: number): Promise<void> {
    await this.db
      .update(rats)
      .set({ hireAttempts: sql`${rats.hireAttempts} + 1` })
      .where(and(eq(rats.id, id), eq(rats.mode, this.mode)));
  }

  /** Freezes every active rat of a stock. Returns how many changed. */
  async freezeByStock(mint: string, reason: string): Promise<number> {
    const r = await this.db
      .update(rats)
      .set({ status: 'frozen', freezeReason: reason })
      .where(and(eq(rats.mode, this.mode), eq(rats.stockMint, mint), eq(rats.status, 'active')))
      .returning({ id: rats.id });
    return r.length;
  }

  /** Unfreezes rats frozen for `reason` on a stock. Returns how many changed. */
  async unfreezeByStock(mint: string, reason: string): Promise<number> {
    const r = await this.db
      .update(rats)
      .set({ status: 'active', freezeReason: null })
      .where(and(eq(rats.mode, this.mode), eq(rats.stockMint, mint), eq(rats.status, 'frozen'), eq(rats.freezeReason, reason)))
      .returning({ id: rats.id });
    return r.length;
  }

  async countByStatus(): Promise<Record<string, number>> {
    const r = await this.db
      .select({ status: rats.status, n: sql<number>`count(*)::int` })
      .from(rats)
      .where(eq(rats.mode, this.mode))
      .groupBy(rats.status);
    return Object.fromEntries(r.map((x) => [x.status, Number(x.n)]));
  }

  /** Active and frozen rats after `afterId`, for the rotating reconcile check. */
  async batchAfter(afterId: number, limit: number): Promise<RatRow[]> {
    return this.db
      .select()
      .from(rats)
      .where(and(eq(rats.mode, this.mode), inArray(rats.status, ['active', 'frozen']), gt(rats.id, afterId)))
      .orderBy(asc(rats.id))
      .limit(limit);
  }

  async touchChecked(ids: number[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.db.update(rats).set({ lastCheckedAt: at }).where(and(eq(rats.mode, this.mode), inArray(rats.id, ids)));
  }

  /** Roster for the API: hired rats (active or frozen) with their stock facts. */
  async roster(afterId = 0): Promise<{ rat: RatRow; stock: StockRow | null }[]> {
    const r = await this.db
      .select({ rat: rats, stock: stocks })
      .from(rats)
      .leftJoin(stocks, eq(stocks.mint, rats.stockMint))
      .where(and(eq(rats.mode, this.mode), inArray(rats.status, ['active', 'frozen']), gt(rats.id, afterId)))
      .orderBy(asc(rats.id));
    return r;
  }
}

// ---------------------------------------------------------------- claims

export class ClaimRepo {
  constructor(
    private readonly db: Database,
    readonly mode: Mode,
    private readonly clock: Clock,
  ) {}

  /** Every claim of this mode, oldest first (rat audit). */
  async all(): Promise<ClaimRow[]> {
    return this.db.select().from(claims).where(eq(claims.mode, this.mode)).orderBy(claims.id);
  }

  /** Bot claims whose transaction may still land (pending or unknown). */
  async openBot(): Promise<ClaimRow[]> {
    return this.db
      .select()
      .from(claims)
      .where(and(eq(claims.mode, this.mode), eq(claims.source, 'bot'), inArray(claims.status, ['pending', 'unknown'])));
  }

  async insert(row: Omit<typeof claims.$inferInsert, 'mode' | 'at' | 'id'> & { at?: Date }): Promise<number> {
    const r = await this.db
      .insert(claims)
      .values({ ...row, mode: this.mode, at: row.at ?? this.clock.now() })
      .returning({ id: claims.id });
    return r[0]!.id;
  }

  async update(id: number, patch: Partial<Omit<ClaimRow, 'id' | 'mode'>>): Promise<void> {
    await this.db.update(claims).set(patch).where(and(eq(claims.id, id), eq(claims.mode, this.mode)));
  }

  /**
   * Changes a claim only while its status is still one of `from` (default: open). Returns false when another worker
   * got there first: exactly once, like a reservation's settle, even with two workers during a redeploy overlap.
   */
  async closeOpen(id: number, patch: Partial<Omit<ClaimRow, 'id' | 'mode'>>, from: ClaimRow['status'][] = ['pending', 'unknown']): Promise<boolean> {
    const r = await this.db
      .update(claims)
      .set(patch)
      .where(and(eq(claims.id, id), eq(claims.mode, this.mode), inArray(claims.status, from)))
      .returning({ id: claims.id });
    return r.length > 0;
  }

  async bySig(sig: string): Promise<ClaimRow | null> {
    const r = await this.db.select().from(claims).where(eq(claims.sig, sig)).limit(1);
    return r[0] ?? null;
  }

  private credited() {
    return and(eq(claims.mode, this.mode), inArray(claims.status, ['confirmed', 'simulated']));
  }

  async totals(): Promise<{ claimed: bigint; hireShare: bigint; fee: bigint; count: number; lastAt: Date | null }> {
    const r = await this.db
      .select({
        claimed: sql<string>`coalesce(sum(${claims.claimedLamports}),0)::text`,
        hire: sql<string>`coalesce(sum(${claims.hireShareLamports}),0)::text`,
        fee: sql<string>`coalesce(sum(${claims.feeLamports}),0)::text`,
        n: sql<number>`count(*)::int`,
        lastAt: sql<Date | string | null>`max(${claims.at})`,
      })
      .from(claims)
      .where(this.credited());
    const x = r[0]!;
    return {
      claimed: toBig(x.claimed),
      hireShare: toBig(x.hire),
      fee: toBig(x.fee),
      count: Number(x.n),
      lastAt: x.lastAt ? new Date(x.lastAt) : null,
    };
  }
}

// ---------------------------------------------------------------- events

export class EventRepo {
  constructor(
    private readonly db: Database,
    readonly mode: Mode,
    private readonly clock: Clock,
  ) {}

  async append(e: { type: EventType; txSig?: string | null; data: Record<string, unknown>; at?: Date }): Promise<number> {
    const r = await this.db
      .insert(events)
      .values({ mode: this.mode, at: e.at ?? this.clock.now(), type: e.type, txSig: e.txSig ?? null, data: e.data })
      .returning({ id: events.id });
    return r[0]!.id;
  }

  async after(afterId: number, limit: number): Promise<EventRow[]> {
    return this.db
      .select()
      .from(events)
      .where(and(eq(events.mode, this.mode), gt(events.id, afterId)))
      .orderBy(asc(events.id))
      .limit(limit);
  }

  async latest(limit: number): Promise<EventRow[]> {
    return this.db.select().from(events).where(eq(events.mode, this.mode)).orderBy(desc(events.id)).limit(limit);
  }

  async lastId(): Promise<number> {
    const r = await this.db
      .select({ id: sql<number | null>`max(${events.id})` })
      .from(events)
      .where(eq(events.mode, this.mode));
    return Number(r[0]?.id ?? 0);
  }

  async countByType(): Promise<Record<string, number>> {
    const r = await this.db
      .select({ type: events.type, n: sql<number>`count(*)::int` })
      .from(events)
      .where(eq(events.mode, this.mode))
      .groupBy(events.type);
    return Object.fromEntries(r.map((x) => [x.type, Number(x.n)]));
  }
}

// ---------------------------------------------------------------- heartbeats, seen signatures, locks

export class HeartbeatRepo {
  constructor(private readonly db: Database) {}

  async beat(loop: string, at: Date, result: { ok: boolean; error?: string }): Promise<void> {
    await this.db
      .insert(heartbeats)
      .values({ loop, lastRunAt: at, lastOkAt: result.ok ? at : null, lastError: result.ok ? null : (result.error ?? 'error'), runs: 1 })
      .onConflictDoUpdate({
        target: heartbeats.loop,
        set: {
          lastRunAt: at,
          ...(result.ok ? { lastOkAt: at, lastError: null } : { lastError: result.error ?? 'error' }),
          runs: sql`${heartbeats.runs} + 1`,
        },
      });
  }

  async all(): Promise<HeartbeatRow[]> {
    return this.db.select().from(heartbeats).orderBy(asc(heartbeats.loop));
  }
}

export class SeenSignatureRepo {
  constructor(private readonly db: Database) {}

  async unseen(signatures: string[]): Promise<string[]> {
    if (signatures.length === 0) return [];
    const r = await this.db
      .select({ s: seenSignatures.signature })
      .from(seenSignatures)
      .where(inArray(seenSignatures.signature, signatures));
    const seen = new Set(r.map((x) => x.s));
    return signatures.filter((s) => !seen.has(s));
  }

  async add(signature: string, address: string, classification: string, at: Date): Promise<void> {
    await this.db.insert(seenSignatures).values({ signature, address, classification, at }).onConflictDoNothing();
  }
}

export class LockRepo {
  constructor(private readonly db: Database) {}

  /** Lease lock: acquired if free, expired, or already ours. Renew by calling again. */
  async acquire(name: string, holder: string, now: Date, ttlSec: number): Promise<boolean> {
    const expires = new Date(now.getTime() + ttlSec * 1000);
    const result = await this.db.execute(sql`
      INSERT INTO locks (name, holder, expires_at) VALUES (${name}, ${holder}, ${expires})
      ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
      WHERE locks.holder = EXCLUDED.holder OR locks.expires_at < ${now}
      RETURNING holder`);
    return rowsOf<{ holder: string }>(result).length > 0;
  }

  async release(name: string, holder: string): Promise<void> {
    await this.db.delete(locks).where(and(eq(locks.name, name), eq(locks.holder, holder)));
  }

  async holder(name: string): Promise<{ holder: string; expiresAt: Date } | null> {
    const r = await this.db.select().from(locks).where(eq(locks.name, name)).limit(1);
    return r[0] ? { holder: r[0].holder, expiresAt: r[0].expiresAt } : null;
  }
}

// ---------------------------------------------------------------- store

export class Store {
  readonly settings: SettingsRepo;
  readonly keys: KeyPoolRepo;
  readonly ledger: LedgerRepo;
  readonly attempts: AttemptRepo;
  readonly stocks: StockRepo;
  readonly rats: RatRepo;
  readonly claims: ClaimRepo;
  readonly events: EventRepo;
  readonly heartbeats: HeartbeatRepo;
  readonly seen: SeenSignatureRepo;
  readonly locks: LockRepo;

  constructor(
    readonly db: Database,
    readonly mode: Mode,
    readonly clock: Clock = systemClock,
  ) {
    this.settings = new SettingsRepo(db);
    this.keys = new KeyPoolRepo(db);
    this.ledger = new LedgerRepo(db, mode, clock);
    this.attempts = new AttemptRepo(db, mode, clock);
    this.stocks = new StockRepo(db, clock);
    this.rats = new RatRepo(db, mode, clock);
    this.claims = new ClaimRepo(db, mode, clock);
    this.events = new EventRepo(db, mode, clock);
    this.heartbeats = new HeartbeatRepo(db);
    this.seen = new SeenSignatureRepo(db);
    this.locks = new LockRepo(db);
  }

  /**
   * Deletes every DRY RUN (paper) row and returns the rat keys used by paper rats to the pool.
   * Live rows are never touched. Restarts rat numbering at 1 if there are no live rats yet.
   */
  async resetPaper(): Promise<{ rats: number; keysRetired: number }> {
    return this.db.transaction(async (tx) => {
      const paperRats = await tx.select({ wallet: rats.wallet }).from(rats).where(eq(rats.mode, 'paper'));
      const wallets = paperRats.map((r) => r.wallet);
      let keysRetired = 0;
      if (wallets.length > 0) {
        // paper wallets never held anything; they are retired, never handed out again
        const r = await tx
          .update(keyPool)
          .set({ status: 'unused' })
          .where(and(eq(keyPool.role, 'rat'), inArray(keyPool.pubkey, wallets)))
          .returning({ p: keyPool.pubkey });
        keysRetired = r.length;
      }
      for (const table of [rats, ledgerEntries, claims, txAttempts, events]) {
        await tx.delete(table).where(eq(table.mode, 'paper'));
      }
      await tx.delete(settings).where(inArray(settings.key, ['paper_claim_watermark']));
      const live = await tx.select({ n: sql<number>`count(*)::int` }).from(rats).where(eq(rats.mode, 'live'));
      if (Number(live[0]?.n ?? 0) === 0) {
        await tx.execute(sql`SELECT setval(pg_get_serial_sequence('rats', 'id'), 1, false)`);
      }
      return { rats: wallets.length, keysRetired };
    });
  }

  /** Runs `fn` in one database transaction: every write in it lands together, or none does. */
  transaction<T>(fn: (store: Store) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new Store(tx as unknown as Database, this.mode, this.clock)));
  }

  /** Same database, other mode. */
  forMode(mode: Mode): Store {
    return new Store(this.db, mode, this.clock);
  }
}

export type { TxKind };
