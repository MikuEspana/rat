// The rat card: the wallet button, the value row, and the small cards for rats that are not hires. And the HUD
// pieces the owner asked to remove before launch.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeRatView } from '@rat/contract';
import { EXTRA_CARD, walletUrl, type ExtraKind } from './format';

const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

describe('rat card: wallet on Solscan', () => {
  it("links the rat's own on-chain wallet on Solscan, never the site", () => {
    expect(walletUrl(WALLET, false)).toBe(`https://solscan.io/account/${WALLET}`);
    expect(walletUrl(` ${WALLET} `, false)).toBe(`https://solscan.io/account/${WALLET}`);
    // the same address the API's solscanUrl carries
    const view = computeRatView(
      { id: 1, name: 'Inu', wallet: WALLET, stock: 'AAPLx', stockMint: 'm', status: 'active', avatarSeed: 's', hiredAt: new Date(0).toISOString(), hireTx: null, tokenAmount: '0', costUsd: 2.51 },
      null,
    );
    expect(walletUrl(WALLET, false)).toBe(view.solscanUrl);
    expect(walletUrl(WALLET, false)).not.toMatch(/wallstreetrats|wallstreetinu|theinuvestors|\?rat=|localhost/);
  });

  it('shows no link in the simulator (made-up wallets) or for anything that is not a Solana address', () => {
    expect(walletUrl(WALLET, true)).toBeNull();
    expect(walletUrl('', false)).toBeNull();
    expect(walletUrl(null, false)).toBeNull();
    expect(walletUrl('https://theinuvestors.world/?rat=3', false)).toBeNull();
    expect(walletUrl('0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl', false)).toBeNull(); // not base58
    expect(walletUrl('abc', false)).toBeNull();
  });
});

describe('cards for rats that are not hires', () => {
  it('say honestly what they are: no wallet, no stock', () => {
    const kinds: ExtraKind[] = ['founder', 'applicant', 'crew', 'staff', 'passerby'];
    for (const k of kinds) {
      const c = EXTRA_CARD[k];
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.line).toMatch(/no wallet/i);
      expect(c.line).not.toMatch(/solscan|\$\d/i);
    }
    expect(EXTRA_CARD.founder.line).toMatch(/^Founder: not a hire, no wallet/);
    expect(EXTRA_CARD.applicant.line).toMatch(/^Job applicant: waiting for a desk/);
  });
});

describe('the HUD and card after the pre-launch changes', () => {
  const ui = readFileSync(new URL('./ui.ts', import.meta.url), 'utf8');
  it('has no find-my-rat box, no COPY LINK, no cost on the value row, no PnL or job-fair tiles', () => {
    expect(ui).not.toMatch(/find my rat: wallet or #id|find-input|'FIND'/);
    expect(ui).not.toMatch(/COPY LINK|card-share/);
    expect(ui).not.toMatch(/\(cost \$\{/);
    expect(ui).not.toMatch(/'Portfolio PnL'|'Job fair'/);
  });
  it('keeps MARKET CAP, RATS HIRED and PORTFOLIO VALUE, the next-hire ring and a Solscan wallet button', () => {
    for (const t of ["'Market cap'", "'Inus hired'", "'Portfolio value'", 'ring-arc', 'WALLET ON SOLSCAN']) expect(ui).toContain(t);
  });
});
