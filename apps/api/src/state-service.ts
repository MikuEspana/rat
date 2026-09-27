// Builds the CONTRACT.md responses from the database. Read-only. Uses the same display math as the site
// (@rat/contract), so the numbers on screen always match.
import {
  type BotMode,
  type EventsResponse,
  type RatEvent,
  type RatView,
  type RatsResponse,
  SCHEMA_VERSION,
  type StateResponse,
  type StockFacts,
  computeRatView,
  leaderboard,
  rankRats,
  round2,
  solscanTxUrl,
  summarizePortfolio,
  summarizeStocks,
} from '@rat/contract';
import { type AppConfig, type Clock, SETTINGS, hireWeights, lamportsToSol, ratName, rawToDecimalString } from '@rat/core';
import type { EventRow, Store, StockRow } from '@rat/db';

function uiAmount(raw: bigint, decimals: number, multiplier: number): string {
  if (multiplier === 1) return rawToDecimalString(raw, decimals);
  const scaled = (Number(raw) / 10 ** decimals) * multiplier;
  return scaled.toFixed(decimals).replace(/\.?0+$/, '') || '0';
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function isEligible(cfg: AppConfig, st: StockRow, now: Date, mode: string): boolean {
  const fresh = st.priceAt !== null && now.getTime() - st.priceAt.getTime() <= cfg.priceStaleSec * 1000;
  return st.enabled && st.verified && st.status === 'active' && st.priceUsd !== null && fresh && (mode === 'paper' || st.approved);
}

export class StateService {
  constructor(
    private readonly store: Store,
    private readonly cfg: AppConfig,
    private readonly clock: Clock,
  ) {}

  private async mode(): Promise<BotMode> {
    if (this.cfg.killSwitch || (await this.store.settings.get(SETTINGS.killSwitch)) === 'on') return 'paused';
    return this.cfg.dryRun ? 'dry_run' : 'live';
  }

  async rats(afterId = 0): Promise<{ all: RatView[]; stocks: StockRow[] }> {
    const stocks = await this.store.stocks.list();
    const rows = await this.store.rats.roster(0);
    const views = rows.map(({ rat, stock }) =>
      computeRatView(
        {
          id: rat.id,
          name: ratName(rat.id),
          wallet: rat.wallet,
          stock: stock?.symbol ?? '?',
          stockMint: rat.stockMint,
          status: rat.status === 'frozen' ? 'frozen' : 'active',
          avatarSeed: rat.avatarSeed,
          hiredAt: (rat.hiredAt ?? rat.createdAt).toISOString(),
          hireTx: rat.hireSig || null,
          tokenAmount: uiAmount(rat.tokenAmountRaw ?? 0n, rat.tokenDecimals ?? stock?.decimals ?? 0, stock?.uiMultiplier ?? 1),
          costUsd: rat.costUsd ?? 0,
        },
        stock?.priceUsd ?? null,
      ),
    );
    const ranked = rankRats(views);
    return { all: afterId > 0 ? ranked.filter((r) => r.id > afterId) : ranked, stocks };
  }

  async ratsResponse(afterId = 0): Promise<RatsResponse> {
    const { all } = await this.rats(0);
    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: this.clock.now().toISOString(),
      total: all.length,
      rats: afterId > 0 ? all.filter((r) => r.id > afterId) : all,
    };
  }

  toEvent(row: EventRow): RatEvent {
    return {
      id: row.id,
      type: row.type,
      at: row.at.toISOString(),
      txSig: row.txSig,
      txUrl: row.txSig ? solscanTxUrl(row.txSig) : null,
      dryRun: row.mode === 'paper',
      data: row.data,
    } as RatEvent;
  }

  async eventsResponse(afterId: number, limit: number): Promise<EventsResponse> {
    const rows = await this.store.events.after(afterId, Math.min(Math.max(limit, 1), 500));
    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: this.clock.now().toISOString(),
      lastId: rows.length > 0 ? rows[rows.length - 1]!.id : await this.store.events.lastId(),
      events: rows.map((r) => this.toEvent(r)),
    };
  }

  async stateResponse(): Promise<StateResponse> {
    const now = this.clock.now();
    const { all, stocks } = await this.rats(0);
    const eligible = stocks.filter((s) => isEligible(this.cfg, s, now, this.store.mode));
    const weights = hireWeights(eligible.map((s) => ({ key: s.mint, change24hPct: s.change24hPct })), this.cfg.minStockWeightBps);
    const shown = stocks.filter((s) => s.enabled || all.some((r) => r.stockMint === s.mint));
    const facts: StockFacts[] = shown.map((s) => ({
      symbol: s.symbol,
      name: s.name,
      mint: s.mint,
      priceUsd: s.priceUsd,
      change24hPct: s.change24hPct === null ? null : round2(s.change24hPct),
      status: s.status === 'paused' ? 'paused' : 'active',
      hireWeight: weights.get(s.mint) ?? 0,
    }));

    const claims = await this.store.claims.totals();
    const burns = await this.store.burns.totals();
    const coinInfoRaw = await this.store.settings.get(SETTINGS.coinInfo);
    const coinInfo = coinInfoRaw ? (JSON.parse(coinInfoRaw) as { decimals: number; supplyRaw: string }) : null;
    const coinPriceRaw = await this.store.settings.get(SETTINGS.priceCoin);
    const coinPrice = coinPriceRaw ? (JSON.parse(coinPriceRaw) as { usd: number }).usd : null;
    const supplyUi = coinInfo ? Number(rawToDecimalString(BigInt(coinInfo.supplyRaw), coinInfo.decimals)) : null;
    const lastClaim = claims.lastAt;
    const lastBurnRunRaw = await this.store.settings.get(SETTINGS.lastBurnRunAt);
    const lastBurnRun = lastBurnRunRaw ? new Date(lastBurnRunRaw) : null;
    const burnWindow = await this.store.settings.get(SETTINGS.burnWindowOpensAt);
    const claimBeat = (await this.store.heartbeats.all()).find((h) => h.loop === 'claim');
    const events = await this.store.events.latest(50);

    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: now.toISOString(),
      bot: {
        mode: await this.mode(),
        lastClaimAt: iso(lastClaim),
        nextClaimAt: claimBeat ? new Date(claimBeat.lastRunAt.getTime() + this.cfg.intervals.claimSec * 1000).toISOString() : null,
        // earliest possible start of the next burn round: the exact time is random and deliberately not published
        nextBurnAt: burnWindow ?? (lastBurnRun ? new Date(lastBurnRun.getTime() + this.cfg.intervals.burnMinSec * 1000).toISOString() : null),
      },
      coin: {
        mint: this.cfg.coinMint ?? null,
        symbol: 'RAT',
        priceUsd: this.cfg.coinMint ? coinPrice : null,
        supply: coinInfo ? rawToDecimalString(BigInt(coinInfo.supplyRaw), coinInfo.decimals) : null,
        marketCapUsd: coinPrice !== null && supplyUi !== null ? Math.round(coinPrice * supplyUi) : null,
        burnedTokens: rawToDecimalString(burns.burnedRaw, burns.decimals ?? coinInfo?.decimals ?? 6),
      },
      wallets: { creator: this.cfg.creatorPubkey ?? null, fund: this.cfg.fundPubkey ?? null },
      treasury: {
        totalClaimedSol: lamportsToSol(claims.claimed),
        totalToHiresSol: lamportsToSol(claims.hireShare),
        totalToFundSol: lamportsToSol(claims.fundShare),
        fundWalletSol: lamportsToSol(await this.store.ledger.balance('burn')),
        totalBurnSpentSol: lamportsToSol(burns.spent),
        burnCount: burns.count,
        lastBurnAt: iso(burns.lastAt),
      },
      portfolio: summarizePortfolio(all),
      stocks: summarizeStocks(facts, all),
      leaderboard: leaderboard(all),
      events: events.map((e) => this.toEvent(e)),
    };
  }

  async health(): Promise<{ ok: boolean; mode: BotMode; heartbeatAgeSec: number | null }> {
    const beat = (await this.store.heartbeats.all()).find((h) => h.loop === 'claim');
    const age = beat ? Math.round((this.clock.now().getTime() - beat.lastRunAt.getTime()) / 1000) : null;
    return { ok: age !== null && age <= this.cfg.intervals.claimSec * 3, mode: await this.mode(), heartbeatAgeSec: age };
  }
}
