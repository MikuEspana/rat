import { LIVE_CONFIRM_PHRASE, loadConfig } from '@rat/core';
import { Store, openMemoryDatabase } from '@rat/db';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { smokePreflight } from './preflight';

const pk = () => Keypair.generate().publicKey.toBase58();
const good = {
  SMOKE_MODE: 'true',
  SMOKE_CAP_SOL: '0.1',
  DRY_RUN: 'false',
  LIVE_CONFIRM: LIVE_CONFIRM_PHRASE,
  COIN_MINT: pk(),
  CREATOR_PUBKEY: pk(),
  MAX_HIRES_PER_LOOP: '2',
};

describe('smoke preflight (the script is never run by agents)', () => {
  it('passes only when every smoke condition holds', async () => {
    expect(await smokePreflight(loadConfig(good), null)).toEqual([]);
  });

  it('refuses without smoke mode, with a cap above 0.1, in dry run, or with more than 2 hires per loop', async () => {
    expect(await smokePreflight(loadConfig({ ...good, SMOKE_MODE: 'false' }), null)).toContain('SMOKE_MODE must be true');
    expect((await smokePreflight(loadConfig({ ...good, SMOKE_CAP_SOL: '0.5' }), null)).join()).toMatch(/0.1 or less/);
    expect((await smokePreflight(loadConfig({ ...good, DRY_RUN: 'true', LIVE_CONFIRM: '' }), null)).join()).toMatch(/real transactions/);
    expect((await smokePreflight(loadConfig({ ...good, MAX_HIRES_PER_LOOP: '20' }), null)).join()).toMatch(/2 or less/);
    expect((await smokePreflight(loadConfig({ ...good, COIN_MINT: '' }), null)).join()).toMatch(/THROWAWAY test coin/);
    expect((await smokePreflight(loadConfig({ ...good, CREATOR_PUBKEY: '' }), null)).join()).toMatch(/CREATOR_PUBKEY must be the throwaway test wallet/);
  });

  it('refuses a database that already has live rats', async () => {
    const h = await openMemoryDatabase();
    try {
      const store = new Store(h.db, 'live');
      await store.rats.create({ wallet: 'w1RAT', stockMint: pk(), salaryLamports: 1n, avatarSeed: 'aaaaaaaa' });
      expect((await smokePreflight(loadConfig(good), store)).join()).toMatch(/fresh smoke-test database/);
    } finally {
      await h.close();
    }
  });
});
