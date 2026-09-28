// The data layer on top of the floor: HUD, next-hire ring, live feed, rat card, leaderboard, DRY RUN banner.
// Plain DOM over the canvas. Everything from the API goes in with textContent, never as HTML.
import { Container, Graphics } from 'pixi.js';
import type { RatEvent, RatView, StateResponse } from '@rat/contract';
import type { Atlas } from '../gfx/atlas';
import type { Camera } from '../gfx/camera';
import type { RatRecord, Store } from '../data/store';
import { TIER_SCALE, type RatSystem } from '../world/rats';
import { DEBUG_MAX_RATS } from '../config';
import { now as clockNow } from '../now';
import { STAGES, stageOf } from '../floor/plan';
import { headlines, type NewsStats } from './news';
import type { Growth } from '../floor/growth';
import { sound } from './sound';

type Progress = ReturnType<Growth['progress']>;

/** Badges by the stage the company was in when a rat was hired. */
const ERAS = ['GARAGE OG', 'SMALL OFFICE OG', 'FLOOR 1 OG', 'CORPORATE ERA', 'MEGACORP ERA', 'WALL STREET ERA'];
import { ago, claimProgress, describe, pct, signClass, TIER_COLOR, TIER_LABEL, usd } from './format';

type Look = keyof typeof TIER_COLOR;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function link(href: string, text: string): HTMLAnchorElement {
  const a = el('a', 'ext', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

export interface UiDeps {
  store: Store;
  rats: RatSystem;
  camera: Camera;
  atlas: Atlas;
  /** world-space layer for the selection marker */
  markerLayer: Container;
  /** the launch simulator feeds the site: wallets are made up, so no Solscan links */
  simulated?: boolean;
}

/**
 * A HUD number that glides to each new value over a couple of seconds. Stock prices refresh every 45 s (one
 * batched Jupiter call, to stay far under the Free tier), so the portfolio numbers would otherwise jump.
 */
class Glide {
  private from = 0;
  private to = 0;
  private start = 0;
  private started = false;
  private running = false;

  constructor(
    private readonly ms: number,
    private readonly render: (v: number) => void,
  ) {}

  private now(): number {
    const u = Math.min(1, (performance.now() - this.start) / this.ms);
    return this.from + (this.to - this.from) * (1 - (1 - u) ** 3);
  }

  set(v: number): void {
    if (!this.started) {
      this.started = true;
      this.from = this.to = v;
      this.render(v);
      return;
    }
    if (v === this.to) return;
    this.from = this.now();
    this.to = v;
    this.start = performance.now();
    if (this.running) return;
    this.running = true;
    const step = (): void => {
      this.render(this.now());
      if (performance.now() - this.start < this.ms) requestAnimationFrame(step);
      else this.running = false;
    };
    requestAnimationFrame(step);
  }
}

export class Ui {
  private root = el('div', 'ui');
  private banner = el('div', 'banner');
  private stats = new Map<string, { value: HTMLElement; sub: HTMLElement }>();
  private readonly glides = {
    portfolio: new Glide(2000, (v) => this.statText('portfolio', usd(v))),
    pnl: new Glide(2000, (v) => this.statText('pnl', usd(v))),
    pnlPct: new Glide(2000, (v) => {
      const st = this.stats.get('pnl');
      if (st) st.sub.textContent = pct(v);
    }),
  };
  private ringArc!: SVGCircleElement;
  private ringLabel = el('div', 'ring-label');
  private feedList = el('ol', 'feed-list');
  private feedItems: Array<{ li: HTMLLIElement; time: HTMLElement; at: string }> = [];
  private boardList = el('ol', 'board-list');
  private boardMode: 'top' | 'bottom' = 'top';
  private card = el('div', 'card');
  private vaultCard = el('div', 'card vault-card');
  /** set by main: is a world point on the Vault's money pile? */
  vaultHit: ((x: number, y: number) => boolean) | null = null;
  /** set by main: the Vault's stage name for a value */
  vaultStage: ((usd: number) => string) | null = null;
  private vaultOpen: string | null = null;
  private stageChip = el('div', 'stage-chip', '');
  private milestoneEl = el('div', 'milestone');
  private milestoneTimer = 0;
  private selected: number | null = null;
  private marker = new Graphics();
  /** the news ticker along the bottom */
  private news = el('div', 'news');
  private newsText = el('div', 'news-text');
  /** find my rat: the room darkens round the rat you looked up */
  private spot = el('div', 'spotlight');
  private spotOn = false;
  /** extra HUD buttons (timelapse) */
  readonly tools = el('div', 'hud-tools');

  constructor(private readonly d: UiDeps) {
    document.body.appendChild(this.root);
    this.root.append(this.spot, this.banner, this.buildHud(), this.buildFeed(), this.buildBoard(), this.card, this.vaultCard, this.milestoneEl, this.news);
    this.vaultCard.hidden = true;
    this.spot.hidden = true;
    this.milestoneEl.hidden = true;
    this.card.hidden = true;
    this.banner.hidden = true;
    this.marker.poly([-6, -10, 6, -10, 0, 0]).fill(0xffd23f).stroke({ color: 0x16182c, width: 2 });
    this.marker.visible = false;
    d.markerLayer.addChild(this.marker);

    d.camera.onClick = (sx, sy) => {
      const w = d.camera.toWorld(sx, sy);
      const id = d.rats.pick(w.x, w.y);
      if (id === null && this.vaultHit?.(w.x, w.y)) {
        this.close();
        this.openVault();
        return;
      }
      this.closeVault();
      if (id === null) this.close();
      else this.open(id, false);
    };
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.close();
        this.closeVault();
      }
    });
    d.store.on((e) => {
      if (e.kind === 'state') {
        this.onState(e.state);
        if (!this.vaultCard.hidden) this.renderVault();
      }
      else if (e.kind === 'feed') this.pushFeed(e.events, true);
      else if (e.kind === 'tiers' || e.kind === 'freeze' || e.kind === 'unfreeze') {
        if (this.selected !== null && e.ratIds.includes(this.selected)) this.renderCard();
      }
    });
    if (d.store.state) {
      this.onState(d.store.state);
      this.pushFeed([...d.store.state.events].reverse(), false);
    }
    setInterval(() => this.tick(), 250);
  }

  // ------------------------------------------------------------------ HUD + ring
  private buildHud(): HTMLElement {
    const hud = el('div', 'hud panel');
    const title = el('div', 'title');
    const find = el('form', 'find');
    const input = el('input', 'find-input');
    input.placeholder = 'find my rat: wallet or #id';
    input.setAttribute('aria-label', 'find my rat by wallet or rat number');
    const go = el('button', 'find-go', 'FIND');
    const note = el('span', 'find-note', '');
    find.append(input, go, note);
    find.onsubmit = (e) => {
      e.preventDefault();
      const id = this.find(input.value);
      note.textContent = id === null ? 'no rat found' : '';
      if (id !== null) this.spotlight(id);
    };
    title.append(el('div', 'brand', 'WALL STREET RATS'), el('div', 'tagline', 'The rat always loses. The fund always wins.'), this.stageChip, find, this.tools);
    const grid = el('div', 'stats');
    for (const [key, label] of [
      ['mcap', 'Market cap'],
      ['rats', 'Rats hired'],
      ['portfolio', 'Portfolio value'],
      ['pnl', 'Portfolio PnL'],
      ['line', 'Job fair'],
    ] as const) {
      const box = el('div', 'stat');
      const value = el('div', 'stat-value', '--');
      const sub = el('div', 'stat-sub', '');
      box.append(el('div', 'stat-label', label), value, sub);
      grid.append(box);
      this.stats.set(key, { value, sub });
    }
    const ring = el('div', 'ring');
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 64 64');
    const track = document.createElementNS(svgNs, 'circle');
    const arc = document.createElementNS(svgNs, 'circle');
    for (const c of [track, arc]) {
      c.setAttribute('cx', '32');
      c.setAttribute('cy', '32');
      c.setAttribute('r', '26');
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke-width', '8');
    }
    track.setAttribute('class', 'ring-track');
    arc.setAttribute('class', 'ring-arc');
    arc.setAttribute('transform', 'rotate(-90 32 32)');
    arc.setAttribute('stroke-dasharray', String(2 * Math.PI * 26));
    svg.append(track, arc);
    this.ringArc = arc;
    ring.append(svg, this.ringLabel);
    hud.append(title, grid, ring);
    return hud;
  }

  /** The job-fair line: rats waiting outside for their buy (or, with the building full, a desk). */
  setLine(n: number): void {
    const st = this.stats.get('line');
    if (!st) return;
    st.value.textContent = n.toLocaleString('en-US');
    st.value.className = `stat-value ${n > 0 ? 'hype' : ''}`;
    st.sub.textContent = n === 1 ? 'rat in line' : n > 0 ? 'rats in line' : 'no line: walk right in';
  }

  private statText(key: string, text: string): void {
    const st = this.stats.get(key);
    if (st) st.value.textContent = text;
  }

  private onState(s: StateResponse): void {
    const set = (k: string, v: string, sub = '', cls = ''): void => {
      const st = this.stats.get(k);
      if (!st) return;
      st.value.textContent = v;
      st.value.className = `stat-value ${cls}`;
      st.sub.textContent = sub;
    };
    set('mcap', s.coin.marketCapUsd === null ? 'pre-launch' : usd(s.coin.marketCapUsd), s.coin.priceUsd === null ? '' : `$${s.coin.priceUsd} / RAT`);
    set('rats', s.portfolio.ratCount.toLocaleString('en-US'), s.portfolio.frozenCount ? `${s.portfolio.frozenCount} frozen` : 'all at work');
    const top = [...s.stocks].sort((a, b) => b.ratCount - a.ratCount).filter((x) => x.ratCount > 0).slice(0, 2);
    const holdings = top.map((x) => `${x.symbol} ${x.ratCount.toLocaleString('en-US')}`).join(', ');
    // the portfolio numbers glide between price updates (every 45 s) instead of jumping
    const portfolio = this.stats.get('portfolio');
    if (portfolio) portfolio.sub.textContent = holdings || 'no positions yet';
    this.glides.portfolio.set(s.portfolio.valueUsd);
    const pnl = this.stats.get('pnl');
    if (pnl) pnl.value.className = `stat-value ${signClass(s.portfolio.pnlUsd)}`;
    this.glides.pnl.set(s.portfolio.pnlUsd);
    this.glides.pnlPct.set(s.portfolio.pnlPct);
    const mode = s.bot.mode;
    this.banner.hidden = mode === 'live';
    this.banner.textContent =
      mode === 'dry_run' ? 'DRY RUN: simulated trades, nothing on this page is real money.' : mode === 'paused' ? 'PAUSED: the kill switch is on. No claims, no hires.' : '';
    this.banner.className = `banner ${mode}`;
    this.renderBoard();
    if (this.selected !== null) this.renderCard();
  }

  private tick(): void {
    const s = this.d.store.state;
    if (s) {
      const p = claimProgress(s.bot.lastClaimAt, s.bot.nextClaimAt);
      const len = 2 * Math.PI * 26;
      this.ringArc.setAttribute('stroke-dashoffset', String(len * (1 - (p ?? 0))));
      const next = s.bot.nextClaimAt ? Math.round((Date.parse(s.bot.nextClaimAt) - clockNow()) / 1000) : null;
      this.ringLabel.textContent = s.bot.mode === 'paused' ? 'paused' : next === null ? 'next hire --' : next > 0 ? `next hire ${next}s` : 'hiring...';
    }
    const now = clockNow();
    for (const it of this.feedItems) it.time.textContent = ago(it.at, now);
    if (this.selected !== null) {
      const pos = this.d.rats.positionOf(this.selected);
      const rec = this.d.store.rats.get(this.selected);
      if (pos && rec) {
        this.marker.visible = true;
        this.marker.position.set(pos.x, pos.y - 54 * TIER_SCALE[rec.view.tier] - 4 + Math.sin(performance.now() / 160) * 2);
        if (this.spotOn) {
          const cam = this.d.camera;
          const sx = pos.x * cam.zoom + cam.x;
          const sy = (pos.y - 24) * cam.zoom + cam.y;
          const r = Math.max(40, 46 * cam.zoom);
          this.spot.style.background = `radial-gradient(circle at ${sx.toFixed(0)}px ${sy.toFixed(0)}px, rgba(7,10,20,0) ${r.toFixed(0)}px, rgba(7,10,20,0.72) ${(r * 2.4).toFixed(0)}px)`;
        }
      }
    }
  }

  // ------------------------------------------------------------------ feed
  private buildFeed(): HTMLElement {
    const box = el('section', 'feed panel');
    const head = el('div', 'panel-head');
    head.append(el('span', '', 'LIVE FEED'), el('span', 'dot'));
    const toggle = el('button', 'fold', 'hide');
    toggle.onclick = () => {
      box.classList.toggle('folded');
      toggle.textContent = box.classList.contains('folded') ? 'show' : 'hide';
    };
    head.append(toggle);
    box.append(head, this.feedList);
    return box;
  }

  /** events oldest first */
  private pushFeed(events: RatEvent[], live: boolean): void {
    for (const e of events) {
      const d = describe(e);
      if (!d) continue;
      const li = el('li', `ev ${e.type}${live ? ' fresh' : ''}`);
      const time = el('span', 'ev-time', ago(e.at));
      const body = el('span', 'ev-text', d.text);
      li.append(el('span', `ev-tag ${e.type}`, d.tag), body, time);
      if (e.txUrl) li.append(link(e.txUrl, 'tx'));
      if (e.dryRun) li.append(el('span', 'ev-dry', 'dry'));
      if (e.type === 'hire') {
        li.classList.add('clickable');
        li.onclick = (ev) => {
          if ((ev.target as HTMLElement).tagName === 'A') return;
          this.open(e.data.ratId, true);
        };
      }
      this.feedList.prepend(li);
      this.feedItems.unshift({ li, time, at: e.at });
    }
    while (this.feedItems.length > 60) this.feedItems.pop()!.li.remove();
  }

  /** Local lines (things the company built), newest last. */
  pushLocal(lines: Array<{ tag: string; text: string }>): void {
    const at = new Date(clockNow()).toISOString();
    for (const d of lines) {
      const li = el('li', `ev ${d.tag.toLowerCase()} fresh`);
      const time = el('span', 'ev-time', ago(at));
      li.append(el('span', `ev-tag ${d.tag.toLowerCase()}`, d.tag), el('span', 'ev-text', d.text), time);
      this.feedList.prepend(li);
      this.feedItems.unshift({ li, time, at });
    }
    while (this.feedItems.length > 60) this.feedItems.pop()!.li.remove();
  }

  // ------------------------------------------------------------------ idle game
  /**
   * Stage name and three nested bars: the desk room filling up, the next room to unlock, the next stage
   * ("FULL FLOOR: 88 / 100 rats"). Bars that have nothing left to count hide.
   */
  setStage(name: string, rats: number, progress?: Progress): void {
    const bars = el('div', 'stage-bars');
    const row = (cls: string, fill: number, label: string): void => {
      const r = el('div', `stage-row ${cls}`);
      const bar = el('div', 'stage-bar');
      const inner = el('i', '');
      inner.style.width = `${(Math.max(0, Math.min(1, fill)) * 100).toFixed(1)}%`;
      bar.append(inner);
      r.append(bar, el('span', 'stage-next', label));
      bars.append(r);
    };
    const n = (v: number): string => v.toLocaleString('en-US');
    const p = progress;
    if (p?.desk) row('desk', p.desk.filled / Math.max(1, p.desk.total), `${p.desk.label}: ${n(p.desk.filled)} / ${n(p.desk.total)} seats`);
    if (p?.room) row('room', (rats - p.room.from) / Math.max(1, p.room.at - p.room.from), `${p.room.label}: ${n(rats)} / ${n(p.room.at)} rats`);
    if (p?.stage) row('stage', (rats - p.stage.from) / Math.max(1, p.stage.at - p.stage.from), `${p.stage.label}: ${n(rats)} / ${n(p.stage.at)} rats`);
    else if (!p) {
      const k = Math.max(0, STAGES.findIndex((s) => s.name === name));
      const next = STAGES[k + 1];
      if (next) row('stage', (rats - STAGES[k]!.min) / (next.min - STAGES[k]!.min), `${next.name}: ${n(rats)} / ${n(next.min)} rats`);
    } else row('stage', 1, `${name}: ${n(rats)} rats, the top`);
    this.stageChip.replaceChildren(el('span', 'stage-now', name), bars, this.soundBtn);
  }

  private soundBtn = ((): HTMLButtonElement => {
    const b = el('button', 'sound-toggle', sound.on ? 'SOUND ON' : 'SOUND OFF');
    b.addEventListener('click', () => {
      sound.set(!sound.on);
      b.textContent = sound.on ? 'SOUND ON' : 'SOUND OFF';
      if (sound.on) sound.room();
    });
    return b;
  })();

  /** New headlines for the ticker (the voice follows the stage). */
  setNews(stats: NewsStats): void {
    const lines = headlines(stats);
    this.newsText.textContent = lines.join('   ///   ');
    this.news.className = `news stage-${stats.stage}`;
    if (!this.newsText.isConnected) this.news.append(el('span', 'news-tag', 'RAT NEWS'), this.newsText);
    // speed: about 60 px a second whatever the length
    this.newsText.style.animationDuration = `${Math.max(20, this.newsText.textContent.length * 0.14)}s`;
  }

  /** Find my rat: by wallet (whole or the start of it), by #id, or by name. */
  find(query: string): number | null {
    const q = query.trim();
    if (!q) return null;
    const idm = q.match(/^#?(\d+)$/);
    if (idm) {
      const id = Number(idm[1]);
      return this.d.store.rats.has(id) ? id : null;
    }
    const low = q.toLowerCase();
    for (const r of this.d.store.rats.values()) if (r.facts.wallet === q) return r.facts.id;
    for (const r of this.d.store.rats.values()) if (q.length >= 4 && r.facts.wallet.startsWith(q)) return r.facts.id;
    for (const r of this.d.store.rats.values()) if (r.facts.name.toLowerCase() === low) return r.facts.id;
    return null;
  }

  /** Open a rat with the spotlight on it and put it in the address bar (a link you can share). */
  spotlight(id: number): void {
    this.open(id, true);
    this.spotOn = true;
    this.spot.hidden = false;
    const url = new URL(location.href);
    url.searchParams.set('rat', String(id));
    history.replaceState(null, '', url.toString());
  }

  /** The era a rat was hired in, from its place in the hiring order: "FLOOR 1 OG". */
  eraOf(id: number): string {
    let before = 0;
    for (const r of this.d.store.rats.keys()) if (r < id) before++;
    return ERAS[stageOf(before + 1)] ?? '';
  }

  /** Big banner for a new stage (or a landmark: kicker 'UNLOCKED'); fades out on its own. */
  milestone(title: string, sub: string, kicker = 'NEW STAGE UNLOCKED', ms?: number): void {
    this.milestoneEl.replaceChildren(el('div', 'ms-kicker', kicker), el('div', 'ms-title', title), el('div', 'ms-sub', sub));
    if (ms) this.milestoneEl.style.animationDuration = `${ms / 1000}s`;
    else this.milestoneEl.style.animationDuration = '';
    this.milestoneEl.hidden = false;
    this.milestoneEl.classList.remove('show');
    void this.milestoneEl.offsetWidth;
    this.milestoneEl.classList.add('show');
    clearTimeout(this.milestoneTimer);
    this.milestoneTimer = window.setTimeout(() => (this.milestoneEl.hidden = true), ms ?? 4200);
  }

  setRats(rats: RatSystem): void {
    this.d.rats = rats;
    this.close();
  }

  /** Debug: a slider for the rat count (?rats=N), with jumps to each stage. */
  debugSlider(n: number, onChange: (n: number) => void, marks: number[]): void {
    const box = el('div', 'debug panel');
    const label = el('div', 'debug-label', `rats: ${n}`);
    const input = el('input');
    input.type = 'range';
    input.min = '1';
    input.max = String(DEBUG_MAX_RATS);
    input.value = String(n);
    input.oninput = () => (label.textContent = `rats: ${input.value}`);
    input.onchange = () => onChange(Number(input.value));
    const jumps = el('div', 'debug-jumps');
    for (const m of marks) {
      const b = el('button', 'tab', String(m));
      b.onclick = () => {
        input.value = String(m);
        label.textContent = `rats: ${m}`;
        onChange(m);
      };
      jumps.append(b);
    }
    box.append(label, input, jumps);
    this.root.append(box);
  }

  // ------------------------------------------------------------------ leaderboard
  private buildBoard(): HTMLElement {
    const box = el('section', 'board panel');
    const head = el('div', 'panel-head');
    const top = el('button', 'tab on', 'TOP RATS');
    const bottom = el('button', 'tab', 'BOTTOM');
    top.onclick = () => {
      this.boardMode = 'top';
      top.classList.add('on');
      bottom.classList.remove('on');
      this.renderBoard();
    };
    bottom.onclick = () => {
      this.boardMode = 'bottom';
      bottom.classList.add('on');
      top.classList.remove('on');
      this.renderBoard();
    };
    const toggle = el('button', 'fold', 'hide');
    toggle.onclick = () => {
      box.classList.toggle('folded');
      toggle.textContent = box.classList.contains('folded') ? 'show' : 'hide';
    };
    head.append(top, bottom, toggle);
    box.append(head, this.boardList);
    if (window.innerWidth < 900) {
      box.classList.add('folded'); // small screens: keep the floor visible, open on demand
      toggle.textContent = 'show';
    }
    return box;
  }

  private renderBoard(): void {
    const s = this.d.store.state;
    if (!s) return;
    const rows: RatView[] = this.boardMode === 'top' ? s.leaderboard.top : s.leaderboard.bottom;
    this.boardList.replaceChildren(
      ...rows.map((r) => {
        const li = el('li', 'row clickable');
        const look: Look = r.status === 'frozen' ? 'frozen' : r.tier;
        const sw = el('span', 'swatch');
        sw.style.background = TIER_COLOR[look];
        sw.dataset.tier = look;
        li.append(el('span', 'rank', `#${r.rank}`), sw, el('span', 'name', r.name), el('span', 'stock', r.stock), el('span', `pnl ${signClass(r.pnlPct)}`, pct(r.pnlPct)));
        li.onclick = () => this.open(r.id, true);
        return li;
      }),
    );
  }

  // ------------------------------------------------------------------ the Vault
  /** The Vault's panel: the Wall Street Rats portfolio in total and by stock, and the wallets of the rats that hold it. */
  openVault(): void {
    this.vaultCard.hidden = false;
    this.renderVault();
  }

  closeVault(): void {
    this.vaultCard.hidden = true;
    this.vaultOpen = null;
  }

  private renderVault(): void {
    const st = this.d.store.state;
    if (!st) return;
    const p = st.portfolio;
    const close = el('button', 'card-close', 'x');
    close.onclick = () => this.closeVault();
    const head = el('div', 'card-head');
    const who = el('div', 'card-who');
    who.append(el('div', 'card-name', 'THE VAULT'), el('div', 'vault-sub', 'the Wall Street Rats portfolio'));
    head.append(who, close);
    const total = el('div', 'vault-total', usd(p.valueUsd));
    const line = el('div', `vault-pnl ${signClass(p.pnlPct)}`, `${pct(p.pnlPct)}  ${usd(p.pnlUsd)} on ${usd(p.costUsd)} paid`);
    const stage = el('div', 'vault-stage', `${this.vaultStage?.(p.valueUsd) ?? ''}  .  ${p.ratCount.toLocaleString('en-US')} rats, each holding its stock in its own wallet`);
    const list = el('div', 'vault-stocks');
    const stocks = [...st.stocks].filter((s) => s.ratCount > 0).sort((a, b) => b.valueUsd - a.valueUsd);
    const most = Math.max(1, ...stocks.map((s) => s.valueUsd));
    for (const s of stocks) {
      const row = el('button', 'vault-row');
      const bar = el('span', 'vault-bar');
      bar.style.width = `${Math.max(2, Math.round((s.valueUsd / most) * 100))}%`;
      row.append(
        el('span', 'vault-sym', s.symbol),
        el('span', 'vault-barbox', ''),
        el('span', 'vault-val', usd(s.valueUsd)),
        el('span', `vault-chg ${signClass(s.pnlPct)}`, pct(s.pnlPct)),
        el('span', 'vault-n', `${s.ratCount} rats`),
      );
      row.children[1]!.append(bar);
      row.onclick = () => {
        this.vaultOpen = this.vaultOpen === s.symbol ? null : s.symbol;
        this.renderVault();
      };
      list.append(row);
      if (this.vaultOpen === s.symbol) list.append(this.walletList(s.symbol));
    }
    const note = el('div', 'card-note', 'Every fee hires rats. Tap a stock to see the rat wallets that hold it.');
    this.vaultCard.replaceChildren(head, total, line, stage, list, note);
  }

  private walletList(symbol: string): HTMLElement {
    const box = el('div', 'vault-wallets');
    const holders = [...this.d.store.rats.values()].filter((r) => r.view.stock === symbol).sort((a, b) => b.view.valueUsd - a.view.valueUsd);
    for (const r of holders.slice(0, 25)) {
      const row = el('div', 'vault-wallet');
      const name = el('button', 'vault-rat', r.view.name);
      name.onclick = () => {
        this.closeVault();
        this.open(r.facts.id, true);
      };
      const w = r.facts.wallet;
      const short = `${w.slice(0, 4)}...${w.slice(-4)}`;
      row.append(name, el('span', 'vault-v', usd(r.view.valueUsd)));
      if (this.d.simulated) row.append(el('span', 'vault-addr', short));
      else row.append(link(r.view.solscanUrl, short));
      box.append(row);
    }
    if (holders.length > 25) box.append(el('div', 'card-note', `and ${(holders.length - 25).toLocaleString('en-US')} more (find any rat by wallet in the search box)`));
    if (this.d.simulated) box.append(el('div', 'card-note', 'simulated rats: made-up wallets, nothing on chain'));
    return box;
  }

  // ------------------------------------------------------------------ rat card
  open(id: number, fly: boolean): void {
    this.selected = id;
    this.renderCard();
    const pos = this.d.rats.positionOf(id);
    if (fly && pos) this.d.camera.flyTo(pos.x, pos.y - 20, Math.max(1.8, this.d.camera.zoom));
  }

  close(): void {
    this.spotOn = false;
    this.spot.hidden = true;
    this.selected = null;
    this.card.hidden = true;
    this.marker.visible = false;
  }

  private rankOf(rec: RatRecord): number {
    let better = 0;
    for (const r of this.d.store.rats.values()) if (r.view.pnlPct > rec.view.pnlPct) better++;
    return better + 1;
  }

  private sprite(look: Look): HTMLCanvasElement {
    const f = this.d.atlas.frame(`rat:${look}/rot_s`);
    const r = f.texture.frame;
    const c = el('canvas', 'card-sprite');
    const k = 2;
    c.width = r.width * k;
    c.height = r.height * k;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.d.atlas.canvas, r.x, r.y, r.width, r.height, 0, 0, r.width * k, r.height * k);
    return c;
  }

  private renderCard(): void {
    const id = this.selected;
    const rec = id === null ? undefined : this.d.store.rats.get(id);
    if (id === null || !rec) {
      this.card.hidden = true;
      return;
    }
    const v = rec.view;
    const look: Look = v.status === 'frozen' ? 'frozen' : v.tier;
    const stock = this.d.store.stocks.get(v.stock);
    const close = el('button', 'card-close', 'x');
    close.onclick = () => this.close();
    const head = el('div', 'card-head');
    const who = el('div', 'card-who');
    const badge = el('span', 'badge', TIER_LABEL[look]);
    badge.style.background = TIER_COLOR[look];
    badge.dataset.tier = look;
    const era = el('span', 'badge era', this.eraOf(id));
    who.append(el('div', 'card-name', v.name), badge, era);
    head.append(this.sprite(look), who, close);
    const grid = el('dl', 'card-grid');
    const row = (k: string, val: string, cls = ''): void => {
      grid.append(el('dt', '', k), el('dd', cls, val));
    };
    row('Stock', `${v.stock}${stock?.name ? ` (${stock.name})` : ''}`);
    row('PnL', `${pct(v.pnlPct)}  ${usd(v.pnlUsd)}`, signClass(v.pnlPct));
    row('Value', `${usd(v.valueUsd)} (cost ${usd(v.costUsd)})`);
    row('Rank', `#${this.rankOf(rec)} of ${this.d.store.rats.size.toLocaleString('en-US')}`);
    row('Status', v.status === 'frozen' ? 'frozen (stock paused or account frozen)' : 'at work');
    row('Hired', ago(v.hiredAt));
    const links = el('div', 'card-links');
    if (this.d.simulated) links.append(el('span', 'card-note', 'simulated rat: made-up wallet, nothing on chain'));
    else links.append(link(v.solscanUrl, 'Wallet on Solscan'));
    if (rec.estimated) links.append(el('span', 'card-note', 'value estimated since hire; exact after reload'));
    const share = el('button', 'card-share', 'COPY LINK');
    share.onclick = () => {
      const url = new URL(location.href);
      url.searchParams.set('rat', String(id));
      void navigator.clipboard?.writeText(url.toString()).then(
        () => (share.textContent = 'LINK COPIED'),
        () => (share.textContent = url.toString()),
      );
    };
    links.append(share);
    this.card.replaceChildren(head, grid, links);
    this.card.hidden = false;
  }
}
