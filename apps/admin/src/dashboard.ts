// What the admin page shows: mode, kill switch, ledger buckets, caps used, rats, last transactions, errors.
// Read from the database only; the page never talks to the chain or Jupiter.
import { type AppConfig, type Clock, SETTINGS, formatSol } from '@rat/core';
import type { Store } from '@rat/db';
import { WORKER_STALE_SEC, newestLoop } from './watchdog';

const HOUR_MS = 3_600_000;

export interface Dashboard {
  generatedAt: string;
  mode: 'DRY RUN' | 'LIVE';
  smoke: boolean;
  kill: { on: boolean; source: 'env' | 'database' | null; reason: string | null };
  buckets: { bucket: 'hire'; available: string; spentLastHour: string; cap: string; capPct: number; openReservations: number }[];
  claimed: string;
  claims: number;
  /** spent on hires: salaries plus their fees, rent and tips */
  hired: string;
  /** claimed, not spent yet (waits under the hourly hire cap) */
  waiting: string;
  rats: Record<string, number>;
  txs: { at: string; kind: string; status: string; signature: string; url: string; error: string | null }[];
  errors: { source: string; at: string; message: string }[];
  loops: { loop: string; lastRun: string | null; lastOk: string | null; lastError: string | null; ageSec: number | null }[];
  /** the newest worker loop is older than WORKER_STALE_SEC (null = no loop ever ran) */
  workerDown: boolean | null;
}

export async function loadDashboard(store: Store, config: AppConfig, clock: Clock): Promise<Dashboard> {
  const now = clock.now();
  const since = new Date(now.getTime() - HOUR_MS);
  const envKill = config.killSwitch;
  const dbKill = (await store.settings.get(SETTINGS.killSwitch)) === 'on';
  const buckets = [];
  for (const bucket of ['hire'] as const) {
    const spent = await store.ledger.netOutflowSince(bucket, since);
    const cap = config.spendCapLamportsPerHour[bucket];
    buckets.push({
      bucket,
      available: formatSol(await store.ledger.balance(bucket)),
      spentLastHour: formatSol(spent),
      cap: formatSol(cap),
      capPct: cap > 0n ? Math.round(Number((spent * 1000n) / cap) / 10) : 0,
      openReservations: (await store.ledger.openReservations(bucket)).length,
    });
  }
  const claims = await store.claims.totals();
  const byReason = await store.ledger.sumByReason();
  const hired = -(['hire_reserve', 'hire_settle', 'hire_release'] as const).reduce((a, r) => a + (byReason.get(`hire:${r}`) ?? 0n), 0n);
  const attempts = await store.attempts.latest(25);
  const txs = attempts.map((a) => ({
    at: a.createdAt.toISOString(),
    kind: a.kind,
    status: a.status,
    signature: a.signature,
    url: `https://solscan.io/tx/${a.signature}`,
    error: a.error,
  }));
  const loops = (await store.heartbeats.all()).map((h) => ({
    loop: h.loop,
    lastRun: h.lastRunAt?.toISOString() ?? null,
    lastOk: h.lastOkAt?.toISOString() ?? null,
    lastError: h.lastError,
    ageSec: h.lastRunAt ? Math.round((now.getTime() - h.lastRunAt.getTime()) / 1000) : null,
  }));
  const errors = [
    ...loops.filter((l) => l.lastError).map((l) => ({ source: `loop ${l.loop}`, at: l.lastRun ?? '', message: l.lastError! })),
    ...txs.filter((t) => t.error && t.status !== 'confirmed').map((t) => ({ source: `${t.kind} tx ${t.status}`, at: t.at, message: t.error! })),
  ];
  const newest = await newestLoop(store, clock);
  return {
    workerDown: newest ? newest.ageSec > WORKER_STALE_SEC : null,
    generatedAt: now.toISOString(),
    mode: config.dryRun ? 'DRY RUN' : 'LIVE',
    smoke: config.smokeMode,
    kill: {
      on: envKill || dbKill,
      source: envKill ? 'env' : dbKill ? 'database' : null,
      reason: envKill ? 'KILL_SWITCH env var' : dbKill ? await store.settings.get(SETTINGS.killReason) : null,
    },
    buckets,
    claimed: formatSol(claims.claimed),
    claims: claims.count,
    hired: formatSol(hired),
    waiting: formatSol(await store.ledger.balance('hire')),
    rats: await store.rats.countByStatus(),
    txs,
    errors,
    loops,
  };
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Server-rendered page: no JavaScript, no outside assets, refreshes itself every 15 seconds. */
export function renderDashboard(d: Dashboard, csrf: string, notice: string | null): string {
  const row = (cells: unknown[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const killBox = d.kill.on
    ? `<div class="kill on">KILL SWITCH ON (${esc(d.kill.source)}): ${esc(d.kill.reason ?? '')}. Nothing is being sent.</div>`
    : `<div class="kill off">Kill switch off. The bot is running.</div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15"><title>IDLE INU admin</title>
<style>
:root{--bg:#0f1115;--fg:#e8e8e8;--mute:#9aa0a6;--line:#2a2f3a;--red:#ff4d4d;--green:#35c46a;--amber:#f5b83d}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
h1{font-size:20px;margin:0 0 8px}h2{font-size:15px;margin:22px 0 8px;color:var(--mute)}
.banner{display:inline-block;padding:2px 8px;border-radius:4px;font-weight:700;background:${d.mode === 'LIVE' ? 'var(--red)' : 'var(--amber)'};color:#000}
.kill{padding:10px 12px;border-radius:6px;margin:12px 0;font-weight:600}.kill.on{background:#4a1111;border:1px solid var(--red)}.kill.off{background:#10301c;border:1px solid var(--green)}
.notice{padding:8px 12px;border:1px solid var(--amber);border-radius:6px;margin:8px 0}
table{border-collapse:collapse;width:100%;overflow-x:auto;display:block}td,th{padding:5px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{color:var(--mute);font-weight:500}a{color:#7ab7ff}.err{color:var(--red);white-space:normal}
form{display:inline-block;margin:6px 12px 6px 0}input[type=text]{background:#1a1d24;color:var(--fg);border:1px solid var(--line);padding:6px;border-radius:4px}
button{padding:8px 14px;border-radius:4px;border:0;font-weight:700;cursor:pointer}.stop{background:var(--red);color:#fff}.go{background:var(--green);color:#000}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}.card{border:1px solid var(--line);border-radius:6px;padding:8px}.card b{display:block;font-size:18px}
</style></head><body>
<h1>IDLE INU admin <span class="banner">${esc(d.mode)}${d.smoke ? ' + SMOKE' : ''}</span></h1>
<div style="color:var(--mute)">Updated ${esc(d.generatedAt)} (refreshes every 15 s)</div>
${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
${d.workerDown ? '<div class="kill on">WORKER DOWN: no loop has run for over 3 minutes. Claims and hires have stopped. Check the worker on Railway.</div>' : ''}
${d.workerDown === null ? '<div class="notice">The worker has not run yet.</div>' : ''}
${killBox}
<form method="post" action="/kill"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="text" name="reason" placeholder="reason (optional)" maxlength="200"> <button class="stop" type="submit">KILL: stop everything</button></form>
<form method="post" action="/resume"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="text" name="confirm" placeholder="type RESUME" maxlength="10" autocomplete="off"> <button class="go" type="submit">Resume</button></form>
<h2>Money</h2>
<div class="grid">
<div class="card">Claimed<b>${esc(d.claimed)} SOL</b>${d.claims} claims</div>
<div class="card">Spent on hires<b>${esc(d.hired)} SOL</b>every claimed SOL goes to hires</div>
<div class="card">Waiting for hires<b>${esc(d.waiting)} SOL</b>under the hourly hire cap</div>
<div class="card">Inus<b>${Object.values(d.rats).reduce((a, b) => a + b, 0)}</b>${esc(Object.entries(d.rats).map(([k, v]) => `${k} ${v}`).join(', '))}</div>
</div>
<h2>Ledger buckets and caps</h2>
<table><tr><th>Bucket</th><th>Available</th><th>Spent last hour</th><th>Cap / hour</th><th>Cap used</th><th>Open reservations</th></tr>
${d.buckets.map((b) => row([esc(b.bucket), `${esc(b.available)} SOL`, `${esc(b.spentLastHour)} SOL`, `${esc(b.cap)} SOL`, `${b.capPct}%`, b.openReservations])).join('\n')}
</table>
<h2>Errors</h2>
${d.errors.length === 0 ? '<div>None.</div>' : `<table><tr><th>Where</th><th>When</th><th>Message</th></tr>${d.errors.map((e) => row([esc(e.source), esc(e.at), `<span class="err">${esc(e.message)}</span>`])).join('\n')}</table>`}
<h2>Last transactions</h2>
<table><tr><th>When</th><th>Kind</th><th>Status</th><th>Signature</th><th>Error</th></tr>
${d.txs.map((t) => row([esc(t.at), esc(t.kind), esc(t.status), `<a href="${esc(t.url)}" rel="noreferrer" target="_blank">${esc(t.signature.slice(0, 12))}...</a>`, t.error ? `<span class="err">${esc(t.error)}</span>` : ''])).join('\n')}
</table>
<h2>Worker loops</h2>
<table><tr><th>Loop</th><th>Last run</th><th>Age</th><th>Last OK</th><th>Last error</th></tr>
${d.loops.map((l) => row([esc(l.loop), esc(l.lastRun), l.ageSec === null ? '' : `${l.ageSec}s`, esc(l.lastOk), l.lastError ? `<span class="err">${esc(l.lastError)}</span>` : ''])).join('\n')}
</table>
</body></html>`;
}
