// Mint step (every ~35s, one RPC call for all stocks + the coin):
//  - records decimals, token program, mint authority and the Scaled UI multiplier
//  - verifies every stock mint (owner rule #12): Token-2022 + expected mint authority, else rejected
//  - Pausable: a paused stock freezes all its rats (one event), a resumed stock unfreezes them
import { SETTINGS } from '@rat/core';
import { verifyStockMints } from '@rat/safety';
import type { WorkerDeps } from '../deps';

export async function runMintStep(d: WorkerDeps): Promise<{ verified: number; rejected: string[]; paused: string[] }> {
  const stocks = await d.store.stocks.list();
  const mints = stocks.map((s) => s.mint);
  if (d.config.coinMint) mints.push(d.config.coinMint);
  const states = await d.chain.getMintStates(mints);

  if (d.config.coinMint) {
    const c = states.get(d.config.coinMint);
    if (c?.exists) {
      await d.store.settings.set(
        SETTINGS.coinInfo,
        JSON.stringify({ mint: c.mint, decimals: c.decimals, supplyRaw: c.supply.toString(), tokenProgram: c.tokenProgram }),
      );
    }
  }

  const stockStates = new Map(stocks.map((s) => [s.mint, states.get(s.mint)!]));
  const verification = verifyStockMints(stockStates, d.config.xstocksMintAuthority);
  await d.store.settings.set(SETTINGS.expectedMintAuthority, verification.expectedAuthority ?? '');
  const rejected: string[] = [];
  const paused: string[] = [];
  let verified = 0;
  for (const st of stocks) {
    const m = stockStates.get(st.mint)!;
    const check = verification.checks.get(st.mint)!;
    if (m.exists) {
      await d.store.stocks.setMintFacts(st.mint, {
        decimals: m.decimals,
        tokenProgram: m.tokenProgram,
        mintAuthority: m.mintAuthority,
        uiMultiplier: m.uiMultiplier,
      });
    }
    if (st.verified !== check.ok || st.verifyError !== (check.ok ? null : check.reason)) {
      await d.store.stocks.setVerification(st.mint, check.ok, check.ok ? null : check.reason);
      if (!check.ok && st.enabled) {
        await d.alerts.send('warn', `mint_rejected_${st.symbol}`, `${st.symbol} (${st.mint}) rejected, no hires: ${check.reason}`);
      }
    }
    if (check.ok) verified++;
    else rejected.push(`${st.symbol}: ${check.reason}`);

    if (!m.exists) continue;
    if (m.paused) paused.push(st.symbol);
    if (m.paused && st.status !== 'paused') {
      await d.store.stocks.setStatus(st.mint, 'paused');
      const n = await d.store.rats.freezeByStock(st.mint, 'stock_paused');
      await d.store.events.append({
        type: 'freeze',
        data: { scope: 'stock', stock: st.symbol, ratId: null, ratCount: n, reason: 'stock_paused' },
      });
      await d.alerts.send('warn', `stock_paused_${st.symbol}`, `${st.symbol} is paused by its issuer: ${n} rats frozen, no hires into it.`);
    } else if (!m.paused && st.status === 'paused') {
      await d.store.stocks.setStatus(st.mint, 'active');
      const n = await d.store.rats.unfreezeByStock(st.mint, 'stock_paused');
      await d.store.events.append({
        type: 'unfreeze',
        data: { scope: 'stock', stock: st.symbol, ratId: null, ratCount: n, reason: 'stock_resumed' },
      });
      await d.alerts.send('info', `stock_resumed_${st.symbol}`, `${st.symbol} resumed: ${n} rats unfrozen.`);
    }
  }
  return { verified, rejected, paused };
}
