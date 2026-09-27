// Spend guard: the only way to reserve money for a hire or a burn.
//
// A spend is authorized only if ALL of these hold:
//   1. the kill switch is off
//   2. the ledger bucket (money the bot actually claimed) covers it; the wallet's own balance never counts
//   3. the rolling 60-minute net outflow of that bucket stays under its cap (30 SOL/h per bucket by default)
//   4. in smoke mode, the lifetime outflow stays under the smoke cap (0.1 SOL)
//   5. (live) the wallet still holds the amount + its reserve (+ for the creator: the fund's pending share)
// Then a negative ledger entry (the reservation) is written before any transaction is built.
import {
  type Alerts,
  type Bucket,
  type ChainReader,
  type Clock,
  type KillSwitch,
  type LedgerStore,
  type Pubkey,
  formatSol,
} from '@rat/core';

export interface Reservation {
  ledgerId: number;
  bucket: Bucket;
  lamports: bigint;
  refType: string;
  refId: string;
}

export type AuthorizeResult = { ok: true; reservation: Reservation } | { ok: false; reason: string; detail: string };

export interface SpendGuardConfig {
  capPerHour: Record<Bucket, bigint>;
  alertPct: number;
  /** wallet that pays each bucket: hire = creator, burn = fund */
  wallets: Record<Bucket, Pubkey | undefined>;
  reserves: Record<Bucket, bigint>;
  smokeMode: boolean;
  smokeCap: bigint;
  /** live mode: also check the real wallet balance */
  checkWallets: boolean;
}

export interface SpendGuardDeps {
  ledger: LedgerStore;
  killSwitch: KillSwitch;
  alerts: Alerts;
  clock: Clock;
  chain?: ChainReader;
  /** fund share still sitting in the creator wallet (must not be spent on hires) */
  pendingFundTransfer?: () => Promise<bigint>;
}

const HOUR_MS = 60 * 60 * 1000;

export class SpendGuard {
  constructor(
    private readonly deps: SpendGuardDeps,
    private readonly cfg: SpendGuardConfig,
  ) {}

  async authorize(req: { bucket: Bucket; lamports: bigint; refType: string; refId: string }): Promise<AuthorizeResult> {
    const { ledger, killSwitch, alerts, clock } = this.deps;
    const { bucket, lamports } = req;
    if (lamports <= 0n) return { ok: false, reason: 'invalid_amount', detail: 'amount must be positive' };

    const kill = await killSwitch.status();
    if (kill.on) return { ok: false, reason: 'kill_switch', detail: kill.reason ?? 'kill switch on' };

    const balance = await ledger.balance(bucket);
    if (balance < lamports) {
      return { ok: false, reason: 'insufficient_budget', detail: `${bucket} bucket has ${formatSol(balance)} SOL, needs ${formatSol(lamports)}` };
    }

    const cap = this.cfg.capPerHour[bucket];
    const since = new Date(clock.now().getTime() - HOUR_MS);
    const outflow = await ledger.netOutflowSince(bucket, since);
    if (outflow + lamports > cap) {
      await alerts.send('critical', `cap_reached_${bucket}`, `${bucket} spend cap reached: ${formatSol(outflow)} of ${formatSol(cap)} SOL in the last hour. Spending pauses until the window frees up; the budget carries over.`);
      return { ok: false, reason: 'hourly_cap', detail: `${bucket} outflow ${formatSol(outflow)} + ${formatSol(lamports)} > cap ${formatSol(cap)}` };
    }

    if (this.cfg.smokeMode) {
      const lifetime = await ledger.lifetimeNetOutflow();
      if (lifetime + lamports > this.cfg.smokeCap) {
        return { ok: false, reason: 'smoke_cap', detail: `smoke cap ${formatSol(this.cfg.smokeCap)} SOL reached` };
      }
    }

    if (this.cfg.checkWallets) {
      const wallet = this.cfg.wallets[bucket];
      if (!wallet || !this.deps.chain) return { ok: false, reason: 'wallet_unknown', detail: `no wallet configured for ${bucket}` };
      const sol = (await this.deps.chain.getSolBalances([wallet])).get(wallet) ?? 0n;
      const pending = bucket === 'hire' && this.deps.pendingFundTransfer ? await this.deps.pendingFundTransfer() : 0n;
      const needed = lamports + this.cfg.reserves[bucket] + pending;
      if (sol < needed) {
        await alerts.send('warn', `wallet_low_${bucket}`, `${bucket} wallet ${wallet} holds ${formatSol(sol)} SOL, needs ${formatSol(needed)} (amount + reserve${pending > 0n ? ' + fund share owed' : ''}).`);
        return { ok: false, reason: 'wallet_low', detail: `wallet has ${formatSol(sol)} SOL, needs ${formatSol(needed)}` };
      }
    }

    const ledgerId = await ledger.append({
      bucket,
      deltaLamports: -lamports,
      reason: bucket === 'hire' ? 'hire_reserve' : 'burn_reserve',
      refType: req.refType,
      refId: req.refId,
    });

    const threshold = (cap * BigInt(this.cfg.alertPct)) / 100n;
    if (outflow < threshold && outflow + lamports >= threshold) {
      await alerts.send('warn', `cap_alert_${bucket}`, `${bucket} spending crossed ${this.cfg.alertPct}% of the hourly cap (${formatSol(outflow + lamports)} of ${formatSol(cap)} SOL).`);
    }

    return { ok: true, reservation: { ledgerId, bucket, lamports, refType: req.refType, refId: req.refId } };
  }

  /** SOL that can still be spent from `bucket` in the current rolling hour. */
  async remainingCap(bucket: Bucket): Promise<bigint> {
    const since = new Date(this.deps.clock.now().getTime() - HOUR_MS);
    const left = this.cfg.capPerHour[bucket] - (await this.deps.ledger.netOutflowSince(bucket, since));
    return left > 0n ? left : 0n;
  }

  /** Books the real cost: the difference to the reservation is credited back (or debited). */
  async settle(r: Reservation, actualLamports: bigint): Promise<void> {
    const diff = r.lamports - actualLamports;
    if (diff === 0n) return;
    await this.deps.ledger.append({
      bucket: r.bucket,
      deltaLamports: diff,
      reason: r.bucket === 'hire' ? 'hire_settle' : 'burn_settle',
      refType: r.refType,
      refId: r.refId,
      note: `actual ${actualLamports}`,
    });
  }

  /** Returns the whole reservation (the spend definitely did not happen). */
  async release(r: Reservation, note?: string): Promise<void> {
    await this.deps.ledger.append({
      bucket: r.bucket,
      deltaLamports: r.lamports,
      reason: r.bucket === 'hire' ? 'hire_release' : 'burn_release',
      refType: r.refType,
      refId: r.refId,
      note,
    });
  }
}
