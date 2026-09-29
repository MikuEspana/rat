// Zod schemas for every response the website reads. Types are inferred from these,
// so the schemas are the single source of truth (see CONTRACT.md).
import { z } from 'zod';

export const SCHEMA_VERSION = 2 as const;

const isoTime = z.string().datetime({ offset: true });
const finite = z.number().finite();
/** decimal string in UI units, e.g. "0.014139" */
const decimalString = z.string().regex(/^\d+(\.\d+)?$/);

export const TierSchema = z.enum(['intern', 'analyst', 'associate', 'vp', 'partner']);
export const BotModeSchema = z.enum(['live', 'dry_run', 'paused']);
export const RatStatusSchema = z.enum(['active', 'frozen']);
export const StockStatusSchema = z.enum(['active', 'paused']);
export const FreezeReasonSchema = z.enum(['stock_paused', 'account_frozen', 'balance_mismatch']);
export const UnfreezeReasonSchema = z.enum(['stock_resumed', 'account_thawed', 'balance_restored']);

export const RatViewSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    wallet: z.string().min(1),
    solscanUrl: z.string().url(),
    stock: z.string().min(1),
    stockMint: z.string().min(1),
    status: RatStatusSchema,
    avatarSeed: z.string().regex(/^[0-9a-f]{8}$/),
    hiredAt: isoTime,
    hireTx: z.string().nullable(),
    tokenAmount: decimalString,
    costUsd: finite,
    valueUsd: finite,
    pnlUsd: finite,
    pnlPct: finite,
    rank: z.number().int().positive(),
    tier: TierSchema,
    sizeScale: z.number().min(0.5).max(3),
  })
  .strict();

export const StockViewSchema = z
  .object({
    symbol: z.string().min(1),
    name: z.string().min(1),
    mint: z.string().min(1),
    priceUsd: finite.nullable(),
    change24hPct: finite.nullable(),
    status: StockStatusSchema,
    ratCount: z.number().int().nonnegative(),
    costUsd: finite,
    valueUsd: finite,
    pnlUsd: finite,
    pnlPct: finite,
    allocationPct: finite,
    hireWeightPct: finite,
  })
  .strict();

const eventBase = {
  id: z.number().int().positive(),
  at: isoTime,
  txSig: z.string().nullable(),
  txUrl: z.string().url().nullable(),
  dryRun: z.boolean(),
};

export const ClaimEventSchema = z
  .object({
    ...eventBase,
    type: z.literal('claim'),
    data: z
      .object({
        amountSol: finite,
        source: z.enum(['bot', 'external']),
      })
      .strict(),
  })
  .strict();

export const HireEventSchema = z
  .object({
    ...eventBase,
    type: z.literal('hire'),
    data: z
      .object({
        ratId: z.number().int().positive(),
        ratName: z.string(),
        wallet: z.string(),
        stock: z.string(),
        salarySol: finite,
        costUsd: finite,
      })
      .strict(),
  })
  .strict();

const freezeData = z
  .object({
    scope: z.enum(['stock', 'rat']),
    stock: z.string(),
    ratId: z.number().int().positive().nullable(),
    ratCount: z.number().int().nonnegative(),
  })
  .strict();

export const FreezeEventSchema = z
  .object({ ...eventBase, type: z.literal('freeze'), data: freezeData.extend({ reason: FreezeReasonSchema }).strict() })
  .strict();

export const UnfreezeEventSchema = z
  .object({ ...eventBase, type: z.literal('unfreeze'), data: freezeData.extend({ reason: UnfreezeReasonSchema }).strict() })
  .strict();

export const EventSchema = z.discriminatedUnion('type', [
  ClaimEventSchema,
  HireEventSchema,
  FreezeEventSchema,
  UnfreezeEventSchema,
]);

export const PortfolioSchema = z
  .object({
    ratCount: z.number().int().nonnegative(),
    activeCount: z.number().int().nonnegative(),
    frozenCount: z.number().int().nonnegative(),
    positionCount: z.number().int().nonnegative(),
    costUsd: finite,
    valueUsd: finite,
    pnlUsd: finite,
    pnlPct: finite,
  })
  .strict();

export const StateResponseSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    generatedAt: isoTime,
    bot: z
      .object({
        mode: BotModeSchema,
        lastClaimAt: isoTime.nullable(),
        nextClaimAt: isoTime.nullable(),
      })
      .strict(),
    coin: z
      .object({
        mint: z.string().nullable(),
        symbol: z.string(),
        priceUsd: finite.nullable(),
        supply: decimalString.nullable(),
        marketCapUsd: finite.nullable(),
      })
      .strict(),
    wallets: z.object({ creator: z.string().nullable() }).strict(),
    treasury: z
      .object({
        totalClaimedSol: finite,
        totalHiredSol: finite,
        waitingSol: finite,
        /** rehearsal (STAGING) API only: claimed plus seeded SOL, the site's stage source. Production never sends it. */
        stageSol: finite.optional(),
      })
      .strict(),
    portfolio: PortfolioSchema,
    stocks: z.array(StockViewSchema),
    leaderboard: z.object({ top: z.array(RatViewSchema).max(10), bottom: z.array(RatViewSchema).max(10) }).strict(),
    events: z.array(EventSchema).max(50),
  })
  .strict();

export const RatsResponseSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    generatedAt: isoTime,
    total: z.number().int().nonnegative(),
    rats: z.array(RatViewSchema),
  })
  .strict();

export const EventsResponseSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    generatedAt: isoTime,
    lastId: z.number().int().nonnegative(),
    events: z.array(EventSchema),
  })
  .strict();

export const HealthResponseSchema = z
  .object({
    ok: z.boolean(),
    mode: BotModeSchema,
    heartbeatAgeSec: z.number().nonnegative().nullable(),
  })
  .strict();
