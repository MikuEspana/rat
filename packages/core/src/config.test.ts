import { describe, expect, it } from 'vitest';
import { loadConfig, parseStocks, publicConfigSummary, requireConfig } from './config';
import { LIVE_CONFIRM_PHRASE } from './constants';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('loadConfig', () => {
  it('defaults to DRY RUN with safe values', () => {
    const cfg = loadConfig({});
    expect(cfg.dryRun).toBe(true);
    expect(cfg.liveConfirmed).toBe(false);
    expect(cfg.killSwitch).toBe(false);
    expect(cfg.salaryLamports).toBe(30_000_000n);
    expect(cfg.spendCapLamportsPerHour).toEqual({ hire: 60_000_000_000n });
    expect(cfg.spendAlertPct).toBe(50);
    expect(cfg.maxHiresPerLoop).toBe(20);
    expect(cfg.jupiter.maxRpm).toBe(40);
    expect(cfg.hireMode).toBe('single');
    expect(cfg.intervals).toEqual({ claimSec: 35, priceSec: 45, freezeSec: 35 });
  });

  it('idle hire budget alert: 30 min, 0.1 SOL, configurable', () => {
    expect(loadConfig({}).hireIdleAlert).toEqual({ minutes: 30, lamports: 100_000_000n });
    expect(loadConfig({ HIRE_IDLE_ALERT_MIN: '45', HIRE_IDLE_ALERT_SOL: '0.25' }).hireIdleAlert).toEqual({ minutes: 45, lamports: 250_000_000n });
  });

  it('wallet watch: WATCH_FROM_SLOT and KNOWN_OWNER_TX_SIGS', () => {
    const d = loadConfig({});
    expect(d.watchFromSlot).toBe(0);
    expect(d.knownOwnerTxSigs).toEqual([]);
    const sig = '5'.repeat(88);
    const c = loadConfig({ WATCH_FROM_SLOT: '312345678', KNOWN_OWNER_TX_SIGS: ` ${sig}, ${'4'.repeat(87)} ` });
    expect(c.watchFromSlot).toBe(312_345_678);
    expect(c.knownOwnerTxSigs).toEqual([sig, '4'.repeat(87)]);
    expect(() => loadConfig({ KNOWN_OWNER_TX_SIGS: 'not-a-signature' })).toThrow(/signature/);
    expect(() => loadConfig({ WATCH_FROM_SLOT: '-5' })).toThrow();
  });

  it('refuses DRY_RUN=false without the exact confirmation phrase', () => {
    expect(() => loadConfig({ DRY_RUN: 'false' })).toThrow(/LIVE_CONFIRM/);
    expect(() => loadConfig({ DRY_RUN: 'false', LIVE_CONFIRM: 'yes' })).toThrow(/LIVE_CONFIRM/);
    const cfg = loadConfig({ DRY_RUN: 'false', LIVE_CONFIRM: LIVE_CONFIRM_PHRASE });
    expect(cfg.dryRun).toBe(false);
    expect(cfg.liveConfirmed).toBe(true);
  });

  it('a confirmation phrase alone does not turn dry run off', () => {
    const cfg = loadConfig({ LIVE_CONFIRM: LIVE_CONFIRM_PHRASE });
    expect(cfg.dryRun).toBe(true);
    expect(cfg.liveConfirmed).toBe(false);
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ DRY_RUN: 'maybe' })).toThrow();
    expect(() => loadConfig({ SALARY_SOL: 'abc' })).toThrow();
    expect(() => loadConfig({ MAX_HIRES_PER_LOOP: '201' })).toThrow();
    expect(() => loadConfig({ SPEND_CAP_SOL_PER_HOUR_HIRE: 'lots' })).toThrow(/SPEND_CAP_SOL_PER_HOUR_HIRE/);
    expect(() => loadConfig({ KEY_ENCRYPTION_KEY: 'short' })).toThrow(/32 bytes/);
    expect(() => loadConfig({ CREATOR_PUBKEY: 'not a key!' })).toThrow();
    expect(() => loadConfig({ SALARY_SOL: '0.005' })).toThrow(/SALARY_SOL/);
    expect(() => loadConfig({ HIRE_MODE: 'three' })).toThrow();
  });

  it('parses the hire cap and optional values', () => {
    const cfg = loadConfig({
      SPEND_CAP_SOL_PER_HOUR_HIRE: '12.5',
      KEY_ENCRYPTION_KEY: KEY,
      JUPITER_MAX_RPM: '30',
      COIN_MINT: '',
    });
    expect(cfg.spendCapLamportsPerHour).toEqual({ hire: 12_500_000_000n });
    expect(cfg.keyEncryptionKey).toBe(KEY);
    expect(cfg.jupiter.maxRpm).toBe(30);
    expect(cfg.coinMint).toBeUndefined();
  });

  it('the Jupiter budget is capped at 40 calls a minute (Free tier is 60): a higher value is refused', () => {
    expect(loadConfig({ JUPITER_MAX_RPM: '40' }).jupiter.maxRpm).toBe(40);
    expect(() => loadConfig({ JUPITER_MAX_RPM: '41' })).toThrow(/JUPITER_MAX_RPM/);
    expect(() => loadConfig({ JUPITER_MAX_RPM: '600' })).toThrow(/JUPITER_MAX_RPM/);
    expect(() => loadConfig({ JUPITER_MAX_RPM: '0' })).toThrow(/JUPITER_MAX_RPM/);
  });

  it('fake claims only exist in dry run', () => {
    expect(loadConfig({ DRY_RUN_FAKE_CLAIM_SOL_PER_HOUR: '50' }).dryRunFakeClaimLamportsPerHour).toBe(50_000_000_000n);
    const live = loadConfig({ DRY_RUN: 'false', LIVE_CONFIRM: LIVE_CONFIRM_PHRASE, DRY_RUN_FAKE_CLAIM_SOL_PER_HOUR: '50' });
    expect(live.dryRunFakeClaimLamportsPerHour).toBe(0n);
  });

  it('requireConfig lists missing keys', () => {
    const cfg = loadConfig({});
    expect(() => requireConfig(cfg, ['databaseUrl', 'rpcUrl'])).toThrow(/databaseUrl, rpcUrl/);
  });

  it('public summary never contains secrets', () => {
    const cfg = loadConfig({ KEY_ENCRYPTION_KEY: KEY, JUPITER_API_KEY: 'jup-secret', TELEGRAM_BOT_TOKEN: 'tg-secret', DATABASE_URL: 'postgres://u:p@h/db' });
    const text = JSON.stringify(publicConfigSummary(cfg));
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('jup-secret');
    expect(text).not.toContain('tg-secret');
    expect(text).not.toContain('postgres://');
  });
});

describe('parseStocks', () => {
  const mint = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
  it('accepts the repo stocks file shape', () => {
    const s = parseStocks({ stocks: [{ symbol: 'TSLAx', name: 'Tesla', mint, group: 'volatile', enabled: true, approved: false }] });
    expect(s[0]?.symbol).toBe('TSLAx');
  });
  it('rejects duplicates and bad mints', () => {
    const e = { symbol: 'A', name: 'A', mint, group: 'steady', enabled: true, approved: true };
    expect(() => parseStocks({ stocks: [e, { ...e, symbol: 'B' }] })).toThrow(/Duplicate stock mint/);
    expect(() => parseStocks({ stocks: [{ ...e, mint: 'bad' }] })).toThrow();
  });
});
