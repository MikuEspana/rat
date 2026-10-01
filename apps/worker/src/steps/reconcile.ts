// Reconcile (live only): each loop checks RECONCILE_BATCH rat token accounts on-chain (3,000 rats about every
// 3.5 minutes at 500 per loop, 6,000 in 7). An issuer-frozen account or a balance lower than the database (the issuer
// has a permanent delegate) freezes that rat and alerts. Recovery unfreezes it.
import type { WorkerDeps, WorkerState } from '../deps';

export interface ReconcileResult {
  checked: number;
  frozen: number;
  unfrozen: number;
}

export async function runReconcileStep(d: WorkerDeps, s: WorkerState): Promise<ReconcileResult> {
  const res: ReconcileResult = { checked: 0, frozen: 0, unfrozen: 0 };
  if (d.store.mode === 'paper') return res;
  let batch = await d.store.rats.batchAfter(s.reconcileCursor, d.config.reconcileBatch);
  if (batch.length === 0 && s.reconcileCursor > 0) {
    s.reconcileCursor = 0;
    batch = await d.store.rats.batchAfter(0, d.config.reconcileBatch);
  }
  if (batch.length === 0) return res;
  const stocks = new Map((await d.store.stocks.list()).map((st) => [st.mint, st]));
  const withProgram = batch.filter((r) => stocks.get(r.stockMint)?.tokenProgram);
  const accounts = await d.chain.getTokenAccounts(
    withProgram.map((r) => ({ owner: r.wallet, mint: r.stockMint, tokenProgram: stocks.get(r.stockMint)!.tokenProgram! })),
  );
  for (let i = 0; i < withProgram.length; i++) {
    const rat = withProgram[i]!;
    const acct = accounts[i]!;
    const symbol = stocks.get(rat.stockMint)?.symbol ?? rat.stockMint;
    const expected = rat.tokenAmountRaw ?? 0n;
    const event = async (type: 'freeze' | 'unfreeze', reason: string) =>
      d.store.events.append({ type, data: { scope: 'rat', stock: symbol, ratId: rat.id, ratCount: 1, reason } });

    if (rat.status === 'active' && acct.frozen) {
      await d.store.rats.update(rat.id, { status: 'frozen', freezeReason: 'account_frozen' });
      await event('freeze', 'account_frozen');
      await d.alerts.send('warn', `rat_frozen_${rat.id}`, `Inu #${rat.id} (${rat.wallet}) token account was frozen by the issuer.`);
      res.frozen++;
    } else if (rat.status === 'active' && acct.amount < expected) {
      await d.store.rats.update(rat.id, { status: 'frozen', freezeReason: 'balance_mismatch' });
      await event('freeze', 'balance_mismatch');
      await d.alerts.send('critical', `rat_balance_${rat.id}`, `Inu #${rat.id} (${rat.wallet}) holds ${acct.amount} raw ${symbol}, database says ${expected}. Frozen.`);
      res.frozen++;
    } else if (rat.status === 'frozen' && rat.freezeReason === 'account_frozen' && !acct.frozen) {
      await d.store.rats.update(rat.id, { status: 'active', freezeReason: null });
      await event('unfreeze', 'account_thawed');
      res.unfrozen++;
    } else if (rat.status === 'frozen' && rat.freezeReason === 'balance_mismatch' && acct.amount >= expected && !acct.frozen) {
      await d.store.rats.update(rat.id, { status: 'active', freezeReason: null });
      await event('unfreeze', 'balance_restored');
      res.unfrozen++;
    }
  }
  await d.store.rats.touchChecked(batch.map((r) => r.id), d.clock.now());
  s.reconcileCursor = batch[batch.length - 1]!.id;
  res.checked = withProgram.length;
  return res;
}
