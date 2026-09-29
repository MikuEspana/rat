// `rat preflight`: one PASS / WARN / FAIL line per launch check, then a one-line verdict. Exit code 1 if anything
// FAILs. Read-only: it never sends a transaction. With --live, anything that would stop a live launch is a FAIL
// (DRY RUN still on, no watch floor, kill switch on, no Telegram).
import { type AppConfig, type ChainReader, type KeyStore, SETTINGS, formatSol } from '@rat/core';
import { type Store, isStagingDatabase, stagingProblems } from '@rat/db';
import { verifyStockMints } from '@rat/safety';
import { PublicKey } from '@solana/web3.js';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface CheckLine {
  status: CheckStatus;
  check: string;
  detail: string;
}

export interface PreflightDeps {
  config: AppConfig;
  /** null = the database could not be opened */
  store: Store | null;
  dbError?: string;
  chain: ChainReader | null;
  backupChain?: ChainReader | null;
  keys: KeyStore | null;
  /** SOL price through the configured Jupiter key (throws on any API error) */
  jupiterSolPrice: () => Promise<number>;
  /** Telegram bot + chat check (read-only: getMe + getChat) */
  telegram: () => Promise<{ ok: boolean; detail: string }>;
  /** every stored rat key decrypts with the current master key, and every rat has a stored key */
  ratKeys?: () => Promise<{ total: number; bad: number; ratsWithoutKey: number }>;
  now: () => number;
}

/** WATCH_FROM_SLOT may be at most this far ahead of the chain (same rule as the worker). */
const WATCH_MAX_AHEAD = 150;
/** a worker loop older than this means the worker is probably not running */
const HEARTBEAT_STALE_SEC = 120;

const REQUIRED: [(c: AppConfig) => unknown, string][] = [
  [(c) => c.databaseUrl, 'DATABASE_URL'],
  [(c) => c.rpcUrl, 'RPC_URL'],
  [(c) => c.keyEncryptionKey, 'KEY_ENCRYPTION_KEY'],
  [(c) => c.creatorPubkey, 'CREATOR_PUBKEY'],
  [(c) => c.coinMint, 'COIN_MINT'],
  [(c) => c.jupiter.apiKey, 'JUPITER_API_KEY'],
];

function errText(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

/** Creator wallet signatures listed per preflight run, and transaction records fetched to check their signers. */
const LAUNCH_SCAN_SIGS = 1000;
const LAUNCH_SCAN_RECORDS = 60;

function short(sigs: string[]): string {
  return sigs.length <= 2 ? sigs.join(', ') : `${sigs.slice(0, 2).join(', ')} and ${sigs.length - 2} more`;
}

function formatTokens(amount: bigint, decimals: number): string {
  return (amount / 10n ** BigInt(decimals)).toLocaleString('en-US');
}

type AddLine = (status: CheckStatus, check: string, detail: string) => void;

/**
 * KNOWN_OWNER_TX_SIGS must name real transactions of the creator wallet, and every transaction the creator wallet
 * signed from the watch floor on that the bot did not send must be listed (the launch with the dev buy). Anything
 * unlisted would make the live worker engage the kill switch, by design: an unknown signature means a leaked key.
 */
async function launchTxChecks(d: PreflightDeps, creator: string, floor: number, add: AddLine, softFail: (check: string, detail: string) => void): Promise<void> {
  const chain = d.chain!;
  const known = d.config.knownOwnerTxSigs;
  const missing: string[] = [];
  const notCreator: string[] = [];
  for (const sig of known) {
    const rec = await chain.getTransactionRecord(sig);
    if (!rec) missing.push(sig);
    else if (!rec.signers.includes(creator)) notCreator.push(sig);
  }
  if (missing.length) softFail('owner txs', `KNOWN_OWNER_TX_SIGS: ${short(missing)} not found on this network. A typo? Copy the signatures from Solscan again.`);
  if (notCreator.length) add('WARN', 'owner txs', `KNOWN_OWNER_TX_SIGS: ${short(notCreator)} not signed by the creator wallet, so not needed there.`);

  const sigs = (await chain.getSignaturesSince(creator, null, LAUNCH_SCAN_SIGS)).filter((s) => s.slot >= floor);
  const listed = new Set(known);
  const ours = d.store ? await d.store.attempts.signaturesKnown(sigs.map((s) => s.signature)) : new Set<string>();
  const candidates = sigs.filter((s) => !listed.has(s.signature) && !ours.has(s.signature));
  const unlisted: string[] = [];
  let checked = 0;
  for (const s of candidates) {
    if (checked >= LAUNCH_SCAN_RECORDS) break;
    checked++;
    const rec = await chain.getTransactionRecord(s.signature);
    if (rec && rec.slot >= floor && rec.signers.includes(creator)) unlisted.push(s.signature);
  }
  if (unlisted.length) {
    softFail(
      'launch txs',
      `${unlisted.length} transaction(s) signed by the creator wallet from WATCH_FROM_SLOT on are not in KNOWN_OWNER_TX_SIGS: ${short(unlisted)}. The live worker would engage the kill switch on them. If they are yours (the launch with the dev buy), add them to KNOWN_OWNER_TX_SIGS. If not, the creator key has leaked.`,
    );
  } else if (candidates.length > checked || sigs.length >= LAUNCH_SCAN_SIGS) {
    add('WARN', 'launch txs', `only the newest ${checked} of the creator wallet's transactions from WATCH_FROM_SLOT on were checked; none of them is unlisted.`);
  } else {
    add('PASS', 'launch txs', `every transaction the creator wallet signed from WATCH_FROM_SLOT on was sent by the bot or is in KNOWN_OWNER_TX_SIGS (${listed.size} listed).`);
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t };
}

export async function runPreflightChecks(d: PreflightDeps, opts: { live?: boolean } = {}): Promise<CheckLine[]> {
  const c = d.config;
  const strict = Boolean(opts.live) || !c.dryRun; // a live start: every launch blocker is a FAIL
  const lines: CheckLine[] = [];
  const add = (status: CheckStatus, check: string, detail: string) => lines.push({ status, check, detail });
  const softFail = (check: string, detail: string) => add(strict ? 'FAIL' : 'WARN', check, detail);

  // 1. mode
  if (c.dryRun) {
    if (opts.live) add('FAIL', 'mode', 'DRY_RUN is still true: set DRY_RUN=false and LIVE_CONFIRM to go live.');
    else add('PASS', 'mode', 'DRY RUN: every transaction is simulated, nothing is sent.');
  } else {
    add('PASS', 'mode', 'LIVE: DRY_RUN=false and LIVE_CONFIRM set. Transactions WILL be sent.');
  }
  if (c.smokeMode) add('WARN', 'smoke mode', `SMOKE_MODE on: lifetime spending capped at ${formatSol(c.smokeCapLamports)} SOL.`);

  // 2. settings
  const missing = REQUIRED.filter(([get]) => !get(c)).map(([, env]) => env);
  if (missing.length > 0) add('FAIL', 'settings', `missing: ${missing.join(', ')} (see .env.example).`);
  else add('PASS', 'settings', 'all required settings are present.');
  if (!c.rpcUrlBackup) add('WARN', 'backup RPC', 'RPC_URL_BACKUP not set: reads have no failover.');

  // 3. database
  if (!d.store) {
    add('FAIL', 'database', `cannot open the database: ${d.dbError ?? 'DATABASE_URL not set'}`);
  } else {
    try {
      await d.store.settings.get(SETTINGS.killSwitch);
      add('PASS', 'database', 'connected, migrations applied.');
    } catch (err) {
      add('FAIL', 'database', `query failed: ${errText(err)}`);
    }
    // 3b. rehearsal: staging and production never meet
    const problems = await stagingProblems(d.store, c).catch((err) => [`check failed: ${errText(err)}`]);
    if (problems.length > 0) add('FAIL', 'staging', problems.join(' '));
    else if (c.staging) {
      if (await isStagingDatabase(d.store, c)) add('WARN', 'staging', `STAGING: rehearsal project, test creator ${c.creatorPubkey}. Test-only features are on (seed, crash test).`);
      else add('FAIL', 'staging', 'STAGING is on but this database is not marked as staging. Run: rat staging-init');
    }
  }

  // 4. RPC
  let slot: number | null = null;
  if (!d.chain) {
    add('FAIL', 'rpc', 'RPC_URL not set.');
  } else {
    try {
      const r = await timed(() => d.chain!.getSlot());
      slot = r.value;
      add('PASS', 'rpc', `slot ${r.value} in ${r.ms} ms.`);
    } catch (err) {
      add('FAIL', 'rpc', `RPC_URL did not answer: ${errText(err)}`);
    }
  }
  if (d.backupChain) {
    try {
      const r = await timed(() => d.backupChain!.getSlot());
      add('PASS', 'backup RPC', `slot ${r.value} in ${r.ms} ms.`);
    } catch (err) {
      add('WARN', 'backup RPC', `RPC_URL_BACKUP did not answer: ${errText(err)}`);
    }
  }

  // 5. Jupiter
  if (!c.jupiter.apiKey) {
    add('FAIL', 'jupiter', 'JUPITER_API_KEY not set.');
  } else {
    try {
      const price = await d.jupiterSolPrice();
      add('PASS', 'jupiter', `API key works (SOL = $${price.toFixed(2)}).`);
    } catch (err) {
      add('FAIL', 'jupiter', `price call failed with the configured key: ${errText(err)}`);
    }
  }

  // 6. keys: imported, decryptable with KEY_ENCRYPTION_KEY, matching the configured public keys
  if (!d.keys) {
    add('FAIL', 'keys', 'KEY_ENCRYPTION_KEY or the database is missing: stored keys cannot be checked.');
  } else {
    try {
      const kp = await d.keys.creator();
      add('PASS', 'creator key', `imported, decrypts, matches ${kp.publicKey.toBase58()}.`);
    } catch (err) {
      add('FAIL', 'creator key', errText(err));
    }
  }

  // 6b. rat wallet keys: they exist nowhere else (back them up with rat keys backup)
  if (d.ratKeys) {
    try {
      const k = await d.ratKeys();
      if (k.bad > 0 || k.ratsWithoutKey > 0) {
        add('FAIL', 'rat keys', `${k.bad} of ${k.total} stored rat keys do not decrypt with KEY_ENCRYPTION_KEY, ${k.ratsWithoutKey} rats have no stored key. Their tokens cannot be moved.`);
      } else {
        add('PASS', 'rat keys', `${k.total} rat wallet keys stored, all decrypt with the current master key. Back them up: rat keys backup --out <file>.`);
      }
    } catch (err) {
      add('FAIL', 'rat keys', `check failed: ${errText(err)}`);
    }
  }

  // 7. wallet balance (its own SOL must cover the reserve: fees before the first claim, rent)
  if (d.chain && c.creatorPubkey) {
    try {
      const sol = await d.chain.getSolBalances([c.creatorPubkey]);
      const have = sol.get(c.creatorPubkey) ?? 0n;
      const reserve = c.creatorReserveLamports;
      if (have >= reserve) add('PASS', 'creator wallet', `${formatSol(have)} SOL (reserve ${formatSol(reserve)}).`);
      else add('FAIL', 'creator wallet', `${formatSol(have)} SOL, needs at least the ${formatSol(reserve)} SOL reserve. Send SOL to ${c.creatorPubkey}.`);
    } catch (err) {
      add('FAIL', 'wallets', `balance read failed: ${errText(err)}`);
    }
  }

  // 7b. cold wallet: the emergency sweep target must be a normal wallet the bot has no key for
  if (!c.coldWallet) {
    add('WARN', 'cold wallet', 'COLD_WALLET not set: rat sweep will need --to <your cold wallet>.');
  } else if (c.coldWallet === c.creatorPubkey) {
    add('FAIL', 'cold wallet', 'COLD_WALLET is the creator wallet. It must be a wallet only you control.');
  } else if (!PublicKey.isOnCurve(new PublicKey(c.coldWallet).toBytes())) {
    add('FAIL', 'cold wallet', `COLD_WALLET ${c.coldWallet} is not a normal wallet address (off-curve / program address).`);
  } else if (d.store && (await d.store.keys.get(c.coldWallet))) {
    add('FAIL', 'cold wallet', `COLD_WALLET ${c.coldWallet} is one of the bot's own wallets. It must be a wallet only you control.`);
  } else {
    add('PASS', 'cold wallet', `${c.coldWallet} (rat sweep moves the rats' tokens there in an emergency).`);
  }

  // 8. coin
  if (d.chain && c.coinMint) {
    try {
      const m = (await d.chain.getMintStates([c.coinMint])).get(c.coinMint);
      if (m?.exists) add('PASS', 'coin', `mint ${c.coinMint} exists (${m.decimals} decimals).`);
      else add('FAIL', 'coin', `COIN_MINT ${c.coinMint} does not exist on this network.`);
    } catch (err) {
      add('FAIL', 'coin', `mint read failed: ${errText(err)}`);
    }
  }

  // 9. stocks: approved, and the mints pass the xStocks check
  if (d.store) {
    const all = await d.store.stocks.list();
    const approved = all.filter((s) => s.enabled && s.approved);
    if (approved.length === 0) {
      softFail('stocks', `0 of ${all.filter((s) => s.enabled).length} enabled stocks are approved: no rat can be hired live. Verify the mints on xstocks.fi, then run scripts/approve-stocks.sh (APPROVED_STOCKS).`);
    } else if (d.chain) {
      try {
        const v = verifyStockMints(await d.chain.getMintStates(approved.map((s) => s.mint)), c.xstocksMintAuthority);
        const bad = approved.filter((s) => !v.checks.get(s.mint)?.ok);
        if (bad.length === approved.length) add('FAIL', 'stocks', `none of the ${approved.length} approved stocks passes the mint check: ${bad.map((s) => `${s.symbol} (${v.checks.get(s.mint)?.reason ?? 'no mint'})`).join(', ')}.`);
        else if (bad.length > 0) add('WARN', 'stocks', `${approved.length - bad.length} of ${approved.length} approved stocks pass; failing: ${bad.map((s) => s.symbol).join(', ')}.`);
        else add('PASS', 'stocks', `${approved.length} approved, all pass the mint check: ${approved.map((s) => s.symbol).join(', ')}.`);
      } catch (err) {
        add('FAIL', 'stocks', `mint check failed: ${errText(err)}`);
      }
    }
  }

  // 10. wallet watch floor
  if (c.watchFromSlot <= 0) {
    softFail('watch floor', 'WATCH_FROM_SLOT not set: set it to the coin launch slot + 1 (docs/runbooks/go-live.md), or the launch tx may trip the kill switch.');
  } else if (slot !== null && c.watchFromSlot > slot + WATCH_MAX_AHEAD) {
    add('FAIL', 'watch floor', `WATCH_FROM_SLOT=${c.watchFromSlot} is ahead of the chain (slot ${slot}): the wallet watch would ignore every transaction until then.`);
  } else {
    add('PASS', 'watch floor', `WATCH_FROM_SLOT=${c.watchFromSlot}, ${c.knownOwnerTxSigs.length} known owner tx(s).`);
  }

  // 10b. launch transactions: the launch (with the dev buy) and anything else YOU signed with the creator wallet from
  // the watch floor on must be in KNOWN_OWNER_TX_SIGS, or the live worker engages the kill switch on it.
  if (d.chain && c.creatorPubkey && c.watchFromSlot > 0) {
    try {
      await launchTxChecks(d, c.creatorPubkey, c.watchFromSlot, add, softFail);
    } catch (err) {
      add('WARN', 'launch txs', `could not check the creator wallet's transactions: ${errText(err)}`);
    }
  }

  // 10c. the dev buy: coins the creator wallet bought at launch stay there. They are not fees and never hire rats.
  if (d.chain && c.creatorPubkey && c.coinMint) {
    try {
      const mint = (await d.chain.getMintStates([c.coinMint])).get(c.coinMint);
      if (mint?.exists && mint.tokenProgram) {
        const [acct] = await d.chain.getTokenAccounts([{ owner: c.creatorPubkey, mint: c.coinMint, tokenProgram: mint.tokenProgram }]);
        const amount = acct?.amount ?? 0n;
        if (amount > 0n) {
          add('PASS', 'dev buy', `the creator wallet holds ${formatTokens(amount, mint.decimals)} coins from the launch. They stay there, are never counted as fees and never hire rats. Selling or moving them needs the creator key and stops the bot.`);
        } else {
          add('PASS', 'dev buy', 'the creator wallet holds no coins (no dev buy).');
        }
      }
    } catch (err) {
      add('WARN', 'dev buy', `could not read the creator wallet's coins: ${errText(err)}`);
    }
  }

  // 11. kill switch
  if (d.store) {
    const db = await d.store.settings.get(SETTINGS.killSwitch);
    const reason = await d.store.settings.get(SETTINGS.killReason);
    if (c.killSwitch) softFail('kill switch', 'ON via the KILL_SWITCH env var: nothing will be sent (remove it and redeploy).');
    else if (db === 'on') softFail('kill switch', `ON in the database (${reason ?? 'no reason'}): run rat resume when ready.`);
    else add('PASS', 'kill switch', 'off.');
  }

  // 12. caps (information)
  add('PASS', 'caps', `hires ${formatSol(c.spendCapLamportsPerHour.hire)} SOL/h, salary ${formatSol(c.salaryLamports)} SOL, max ${c.maxHiresPerLoop} hires per loop. Every claimed SOL goes to hires.`);

  // 13. Telegram
  if (!c.telegram.botToken || !c.telegram.chatId) {
    softFail('telegram', 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set: no alert would reach you.');
  } else {
    try {
      const t = await d.telegram();
      add(t.ok ? 'PASS' : 'FAIL', 'telegram', t.detail);
    } catch (err) {
      add('FAIL', 'telegram', `check failed: ${errText(err)}`);
    }
  }

  // 14. worker (information: preflight usually runs before the worker starts)
  if (d.store) {
    const beats = await d.store.heartbeats.all();
    const last = beats.reduce<number>((m, b) => Math.max(m, b.lastRunAt?.getTime() ?? 0), 0);
    if (last === 0) add('WARN', 'worker', 'no loop has run yet (fine before the first start).');
    else {
      const age = Math.round((d.now() - last) / 1000);
      if (age <= HEARTBEAT_STALE_SEC) add('PASS', 'worker', `last loop ${age}s ago.`);
      else add('WARN', 'worker', `last loop ${age}s ago: is the worker running?`);
    }
  }
  return lines;
}

export function printPreflight(lines: CheckLine[], out: (l: string) => void, title: string): boolean {
  out(title);
  const width = Math.max(...lines.map((l) => l.check.length));
  for (const l of lines) out(`${l.status.padEnd(4)}  ${l.check.padEnd(width)}  ${l.detail}`);
  const fails = lines.filter((l) => l.status === 'FAIL').length;
  const warns = lines.filter((l) => l.status === 'WARN').length;
  out('');
  out(fails === 0 ? `READY: ${lines.length - warns} PASS, ${warns} WARN, 0 FAIL.` : `NOT READY: ${fails} FAIL, ${warns} WARN. Fix every FAIL line first.`);
  return fails === 0;
}

/** Telegram check through the Bot API (getMe + getChat, both read-only). */
export async function telegramCheck(botToken: string, chatId: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  const call = async (method: string, body: Record<string, string> = {}) => {
    const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: { username?: string; title?: string; type?: string } };
    return { ok: res.ok && json.ok === true, json };
  };
  const me = await call('getMe');
  if (!me.ok) return { ok: false, detail: `bot token rejected: ${me.json.description ?? 'no answer'}` };
  const chat = await call('getChat', { chat_id: chatId });
  if (!chat.ok) return { ok: false, detail: `bot @${me.json.result?.username} cannot see chat ${chatId}: ${chat.json.description ?? 'no answer'} (start the bot / add it to the chat).` };
  return { ok: true, detail: `bot @${me.json.result?.username} can post to ${chat.json.result?.title ?? chat.json.result?.type ?? chatId}.` };
}
