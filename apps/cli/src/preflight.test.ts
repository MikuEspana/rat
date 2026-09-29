import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FakeClock, SETTINGS, TOKEN_2022_PROGRAM, loadConfig } from '@rat/core';
import { SimChain, SimChainReader } from '@rat/chain/sim';
import { type DbHandle, Store, openMemoryDatabase } from '@rat/db';
import { DbKeyStore, MasterKeyRing, encryptRoleKey } from '@rat/keys';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CheckLine, type PreflightDeps, printPreflight, runPreflightChecks, telegramCheck } from './commands/preflight';

let handle: DbHandle;
beforeEach(async () => {
  handle = await openMemoryDatabase();
});
afterEach(async () => handle.close());

const SOL = 1_000_000_000n;

async function setup(env: Record<string, string> = {}, over: Partial<PreflightDeps> = {}) {
  const clock = new FakeClock('2026-10-01T12:00:00Z');
  const chain = new SimChain();
  const creator = Keypair.generate();
  const authority = Keypair.generate().publicKey.toBase58();
  const coin = Keypair.generate().publicKey.toBase58();
  const stock = Keypair.generate().publicKey.toBase58();
  chain.createMint({ mint: coin, decimals: 6, tokenProgram: TOKEN_2022_PROGRAM, supply: 1n });
  chain.createMint({ mint: stock, decimals: 8, tokenProgram: TOKEN_2022_PROGRAM, mintAuthority: authority, supply: 1n });
  chain.fundAccount(creator.publicKey.toBase58(), SOL / 10n);
  const master = randomBytes(32).toString('base64');
  const config = loadConfig({
    DATABASE_URL: 'memory://',
    RPC_URL: 'http://localhost:8899',
    KEY_ENCRYPTION_KEY: master,
    CREATOR_PUBKEY: creator.publicKey.toBase58(),
    COIN_MINT: coin,
    JUPITER_API_KEY: 'jup-key',
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_CHAT_ID: '-1001',
    WATCH_FROM_SLOT: '1',
    XSTOCKS_MINT_AUTHORITY: authority,
    ...env,
  });
  const store = new Store(handle.db, config.dryRun ? 'paper' : 'live', clock);
  const ring = new MasterKeyRing({ version: 1, base64: master });
  await store.keys.setRoleKey(encryptRoleKey(creator, ring, 'creator'));
  await store.stocks.syncConfig([{ symbol: 'TSTx', name: 'Test', mint: stock, group: 'volatile', enabled: true, approved: true }]);
  const deps: PreflightDeps = {
    config,
    store,
    chain: new SimChainReader(chain),
    keys: new DbKeyStore(store.keys, ring, { expectedCreator: config.creatorPubkey }),
    jupiterSolPrice: async () => 185.4,
    telegram: async () => ({ ok: true, detail: 'bot @rat_bot can post to ops.' }),
    now: () => clock.now().getTime(),
    ...over,
  };
  return { deps, store, chain, creator, stock, coin };
}

const byCheck = (lines: CheckLine[], check: string) => lines.find((l) => l.check === check);
const fails = (lines: CheckLine[]) => lines.filter((l) => l.status === 'FAIL').map((l) => l.check);

describe('rat preflight', () => {
  it('everything configured (DRY RUN): no FAIL, READY, and it lists every check', async () => {
    const { deps } = await setup();
    const lines = await runPreflightChecks(deps);
    expect(fails(lines)).toEqual([]);
    expect(lines.map((l) => l.check)).toEqual(
      expect.arrayContaining(['mode', 'settings', 'database', 'rpc', 'jupiter', 'creator key', 'creator wallet', 'coin', 'stocks', 'watch floor', 'kill switch', 'caps', 'telegram', 'worker']),
    );
    // there is no fund wallet any more: every claimed SOL hires rats
    expect(lines.map((l) => l.check).filter((c) => /fund/.test(c))).toEqual([]);
    expect(byCheck(lines, 'caps')?.detail).toMatch(/hires 60 SOL\/h, .* max 20 hires per loop/);
    expect(byCheck(lines, 'mode')?.detail).toMatch(/DRY RUN/);
    const out: string[] = [];
    expect(printPreflight(lines, (l) => out.push(l), 'RAT RACE preflight')).toBe(true);
    expect(out.at(-1)).toMatch(/^READY: /);
    expect(out.some((l) => /^PASS  rpc +slot/.test(l))).toBe(true);
  });

  it('--live while DRY RUN is on, and launch blockers become FAIL', async () => {
    const { deps, store } = await setup({ WATCH_FROM_SLOT: '0', TELEGRAM_BOT_TOKEN: '' });
    await store.settings.set(SETTINGS.killSwitch, 'on');
    const soft = await runPreflightChecks(deps);
    expect(fails(soft)).toEqual([]); // DRY RUN: warnings only
    expect(soft.filter((l) => l.status === 'WARN').map((l) => l.check)).toEqual(expect.arrayContaining(['watch floor', 'kill switch', 'telegram']));
    const live = await runPreflightChecks(deps, { live: true });
    expect(fails(live)).toEqual(expect.arrayContaining(['mode', 'watch floor', 'kill switch', 'telegram']));
    const out: string[] = [];
    expect(printPreflight(live, (l) => out.push(l), 't')).toBe(false);
    expect(out.at(-1)).toMatch(/^NOT READY: 4 FAIL/);
  });

  it('missing settings, dead RPC, rejected Jupiter key, missing keys: each is a FAIL with the fix', async () => {
    const { deps } = await setup(
      { COIN_MINT: '', JUPITER_API_KEY: '' },
      {
        chain: { ...new SimChainReader(new SimChain()), getSlot: async () => Promise.reject(new Error('ECONNREFUSED')) } as never,
        keys: new DbKeyStore(new Store(handle.db, 'paper', new FakeClock()).keys, new MasterKeyRing({ version: 1, base64: randomBytes(32).toString('base64') })),
      },
    );
    const lines = await runPreflightChecks(deps);
    expect(byCheck(lines, 'settings')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/COIN_MINT, JUPITER_API_KEY/) });
    expect(byCheck(lines, 'rpc')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/ECONNREFUSED/) });
    expect(byCheck(lines, 'jupiter')?.status).toBe('FAIL');
    // keys stored under another master key do not decrypt
    expect(byCheck(lines, 'creator key')?.status).toBe('FAIL');
  });

  it('rat keys: every stored rat key must decrypt and every rat must have one', async () => {
    const ok = await setup({}, { ratKeys: async () => ({ total: 3042, bad: 0, ratsWithoutKey: 0 }) });
    expect(byCheck(await runPreflightChecks(ok.deps), 'rat keys')).toMatchObject({ status: 'PASS', detail: expect.stringMatching(/3042 rat wallet keys/) });
    const bad = await runPreflightChecks({ ...ok.deps, ratKeys: async () => ({ total: 10, bad: 2, ratsWithoutKey: 1 }) });
    expect(byCheck(bad, 'rat keys')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/2 of 10 .* 1 rats have no stored key/) });
  });

  it('a rejected Jupiter key is a FAIL', async () => {
    const { deps } = await setup({}, { jupiterSolPrice: () => Promise.reject(new Error('Jupiter /price/v3 failed: 401')) });
    expect(byCheck(await runPreflightChecks(deps), 'jupiter')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/401/) });
  });

  it('creator wallet under its reserve, unapproved or unverifiable stocks, watch floor in the future', async () => {
    const s = await setup({ CREATOR_RESERVE_SOL: '0.5', WATCH_FROM_SLOT: '99999999' });
    const lines = await runPreflightChecks(s.deps);
    expect(byCheck(lines, 'creator wallet')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/0\.1 SOL, needs at least the 0\.5 SOL reserve/) });
    expect(byCheck(lines, 'watch floor')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/ahead of the chain/) });
    // a stock whose mint authority is not the xStocks one fails the mint check
    s.chain.updateMint(s.stock, { mintAuthority: Keypair.generate().publicKey.toBase58() });
    expect(byCheck(await runPreflightChecks(s.deps), 'stocks')?.status).toBe('FAIL');
    await s.store.stocks.syncConfig([{ symbol: 'TSTx', name: 'Test', mint: s.stock, group: 'volatile', enabled: true, approved: false }]);
    expect(byCheck(await runPreflightChecks(s.deps), 'stocks')?.status).toBe('WARN');
    expect(byCheck(await runPreflightChecks(s.deps, { live: true }), 'stocks')?.status).toBe('FAIL');
  });

  it('launch with a dev buy: every creator-signed tx from the watch floor on must be in KNOWN_OWNER_TX_SIGS', async () => {
    const s = await setup();
    const creator = s.creator.publicKey.toBase58();
    // the launch: the creator wallet signs it, pays for the dev buy and ends up holding the coins
    const launch = s.chain.newSignature();
    const out = s.chain.execute(
      { signature: launch, feePayer: creator, signers: [creator], instructions: [SystemProgram.transfer({ fromPubkey: s.creator.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1_000_000 })] },
      { mutate: true },
    );
    expect(out.landed).toBe(true);
    s.chain.setTokenBalance(creator, s.coin, 35_000_000n * 1_000_000n, TOKEN_2022_PROGRAM);

    // unlisted: the live worker would engage the kill switch on it (WARN in DRY RUN, FAIL for a live start)
    let lines = await runPreflightChecks(s.deps);
    expect(byCheck(lines, 'launch txs')).toMatchObject({ status: 'WARN', detail: expect.stringContaining(launch) });
    expect(byCheck(await runPreflightChecks(s.deps, { live: true }), 'launch txs')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/kill switch/) });
    // the dev buy's coins are shown and never counted as fees
    expect(byCheck(lines, 'dev buy')).toMatchObject({ status: 'PASS', detail: expect.stringMatching(/holds 35,000,000 coins .* never counted as fees/) });

    // listed: accepted
    s.deps.config.knownOwnerTxSigs.push(launch);
    lines = await runPreflightChecks(s.deps, { live: true });
    expect(byCheck(lines, 'launch txs')).toMatchObject({ status: 'PASS', detail: expect.stringMatching(/1 listed/) });
    expect(lines.find((l) => l.check === 'owner txs')).toBeUndefined();

    // a typo in KNOWN_OWNER_TX_SIGS is caught (the real launch signature would be unlisted)
    s.deps.config.knownOwnerTxSigs.push('5'.repeat(88));
    expect(byCheck(await runPreflightChecks(s.deps, { live: true }), 'owner txs')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/not found on this network/) });

    // before the watch floor nothing needs listing
    s.deps.config.knownOwnerTxSigs.length = 0;
    s.deps.config.watchFromSlot = s.chain.slot + 1;
    expect(byCheck(await runPreflightChecks(s.deps, { live: true }), 'launch txs')?.status).toBe('PASS');
  });

  it('no dev buy: the creator wallet holds no coins', async () => {
    const s = await setup();
    expect(byCheck(await runPreflightChecks(s.deps), 'dev buy')).toMatchObject({ status: 'PASS', detail: expect.stringMatching(/holds no coins/) });
  });

  it('cold wallet: unset is a warning; the creator wallet or an off-curve address is a FAIL; a normal wallet passes', async () => {
    const s = await setup();
    expect(byCheck(await runPreflightChecks(s.deps), 'cold wallet')?.status).toBe('WARN');
    s.deps.config.coldWallet = s.creator.publicKey.toBase58();
    expect(byCheck(await runPreflightChecks(s.deps), 'cold wallet')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/creator wallet/) });
    // a program derived address is off-curve: nobody could sign for tokens sent there
    s.deps.config.coldWallet = PublicKey.findProgramAddressSync([Buffer.from('x')], SystemProgram.programId)[0].toBase58();
    expect(byCheck(await runPreflightChecks(s.deps), 'cold wallet')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/off-curve/) });
    const cold = Keypair.generate().publicKey.toBase58();
    s.deps.config.coldWallet = cold;
    expect(byCheck(await runPreflightChecks(s.deps), 'cold wallet')).toMatchObject({ status: 'PASS', detail: expect.stringContaining(cold) });
  });

  it('scripts/setup-mac.sh lets exactly the two expected pre-launch FAILs through, matched on the real wording', async () => {
    // the state setup-mac.sh leaves: DRY RUN, creator key imported, no coin, no launch slot, creator not funded yet,
    // stocks not approved yet, no backup RPC
    const s = await setup({ COIN_MINT: '', WATCH_FROM_SLOT: '', COLD_WALLET: Keypair.generate().publicKey.toBase58() });
    s.chain.setSol(s.creator.publicKey.toBase58(), 0n);
    await s.store.stocks.syncConfig([{ symbol: 'TSTx', name: 'Test', mint: s.stock, group: 'volatile', enabled: true, approved: false }]);
    const failing = (await runPreflightChecks(s.deps)).filter((l) => l.status === 'FAIL');
    expect(failing.map((l) => l.check).sort()).toEqual(['creator wallet', 'settings']);
    const settings = byCheck(failing, 'settings');
    const script = readFileSync(fileURLToPath(new URL('../../../scripts/setup-mac.sh', import.meta.url)), 'utf8');
    expect(script).toContain(`.check == "settings" and .detail == "${settings?.detail}"`);
    expect(script).toContain('.check == "creator wallet"');
  });

  it('Telegram check: bad token, bot not in the chat, working bot', async () => {
    const reply = (ok: boolean, body: object) => new Response(JSON.stringify({ ok, ...body }), { status: ok ? 200 : 400 });
    const fake = (getChatOk: boolean, tokenOk = true) =>
      (async (url: string) => {
        if (url.endsWith('/getMe')) return tokenOk ? reply(true, { result: { username: 'rat_bot' } }) : new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 });
        return getChatOk ? reply(true, { result: { title: 'rat ops' } }) : reply(false, { description: 'Bad Request: chat not found' });
      }) as unknown as typeof fetch;
    expect(await telegramCheck('t', '1', fake(true))).toEqual({ ok: true, detail: 'bot @rat_bot can post to rat ops.' });
    expect((await telegramCheck('t', '1', fake(false))).detail).toMatch(/cannot see chat 1: Bad Request: chat not found/);
    expect((await telegramCheck('t', '1', fake(true, false))).detail).toMatch(/bot token rejected: Unauthorized/);
  });
});
