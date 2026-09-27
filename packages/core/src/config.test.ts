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
    expect(cfg.hireSplitBps).toBe(5000);
    expect(cfg.spendCapLamportsPerHour).toEqual({ hire: 30_000_000_000n, burn: 30_000_000_000n });
    expect(cfg.spendAlertPct).toBe(50);
    expect(cfg.maxHiresPerLoop).toBe(20);
    expect(cfg.jupiter.maxRpm).toBe(55);
    expect(cfg.hireMode).toBe('single');
    expect(cfg.intervals).toEqual({ claimSec: 35, burnSec: 600, priceSec: 15, freezeSec: 35 });
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
    expect(() => loadConfig({ HIRE_SPLIT_BPS: '10001' })).toThrow();
    expect(() => loadConfig({ KEY_ENCRYPTION_KEY: 'short' })).toThrow(/32 bytes/);
    expect(() => loadConfig({ CREATOR_PUBKEY: 'not a key!' })).toThrow();
    expect(() => loadConfig({ SALARY_SOL: '0.005' })).toThrow(/SALARY_SOL/);
    expect(() => loadConfig({ HIRE_MODE: 'three' })).toThrow();
  });

  it('parses per-bucket caps and optional values', () => {
    const cfg = loadConfig({
      SPEND_CAP_SOL_PER_HOUR_HIRE: '12.5',
      SPEND_CAP_SOL_PER_HOUR_BURN: '7',
      KEY_ENCRYPTION_KEY: KEY,
      JUPITER_MAX_RPM: '600',
      COIN_MINT: '',
    });
    expect(cfg.spendCapLamportsPerHour.hire).toBe(12_500_000_000n);
    expect(cfg.spendCapLamportsPerHour.burn).toBe(7_000_000_000n);
    expect(cfg.keyEncryptionKey).toBe(KEY);
    expect(cfg.jupiter.maxRpm).toBe(600);
    expect(cfg.coinMint).toBeUndefined();
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
