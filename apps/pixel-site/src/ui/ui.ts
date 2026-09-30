// The data layer on top of the floor: HUD, next-hire ring, live feed, rat card, leaderboard, status banner.
// Plain DOM over the canvas. Everything from the API goes in with textContent, never as HTML.
import { Container, Graphics } from 'pixi.js';
import type { RatEvent, RatView, StateResponse } from '@rat/contract';
import type { Atlas } from '../gfx/atlas';
import type { Camera } from '../gfx/camera';
import type { RatRecord, Store } from '../data/store';
import { TIER_SCALE, type RatSystem } from '../world/rats';
import { DEBUG_MAX_RATS, SIM } from '../config';
import { now as clockNow } from '../now';
import { ringOfHires, STAGES } from '../floor/plan';
import { headlines, type NewsStats } from './news';
import type { Growth } from '../floor/growth';
import { sound } from './sound';
import { RoadmapPanel } from './roadmap';

type Progress = ReturnType<Growth['progress']>;

/** Badges by hire order: the ring whose rooms were opening when a rat was hired. */
const ERAS = ['GARAGE OG', 'SMALL OFFICE OG', 'FLOOR 1 OG', 'CORPORATE ERA', 'MEGACORP ERA', 'WALL STREET ERA'];
import {
  ago, BOT_STALE_SEC, bannerText, caView, describe, emptyBoardText, EXTRA_CARD, hireRing, pct, priceUsd, ratsSub, signClass, solAmount, TIER_COLOR, TIER_LABEL, usd, walletUrl,
  type ExtraKind,
} from './format';
import { copyText } from './clipboard';

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
  };
  private ringArc!: SVGCircleElement;
  private ringLabel = el('div', 'ring-label');
  private ringEl = el('div', 'ring');
  private hudEl: HTMLElement | null = null;
  private hudBottom = -1;
  /** the contract address: hidden until the coin has a mint */
  private ca = el('div', 'ca');
  private caAddr = el('a', 'ca-addr');
  private caCopy = el('button', 'ca-copy', 'COPY');
  private caMint: string | null = null;
  private caTimer = 0;
  private feedList = el('ol', 'feed-list');
  private feedEmpty = el('li', 'ev empty', 'Quiet so far. Claims and hires show up here as they happen.');
  private feedItems: Array<{ li: HTMLLIElement; time: HTMLElement; at: string }> = [];
  private boardList = el('ol', 'board-list');
  private boardMode: 'top' | 'bottom' = 'top';
  private card = el('div', 'card');
  private vaultCard = el('div', 'card vault-card');
  /** set by main: is a world point on the Vault's money pile? */
  vaultHit: ((x: number, y: number) => boolean) | null = null;
  /** set by main: the set-dressing rat (founder, applicant, crew...) under a world point, if any */
  extraHit: ((x: number, y: number, zoom: number) => ExtraKind | null) | null = null;
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
  /** a ?rat= / ?wallet= link: the room darkens round the rat it points at */
  private spot = el('div', 'spotlight');
  private spotOn = false;
  /** extra HUD buttons (timelapse) */
  readonly tools = el('div', 'hud-tools');
  /** the Company Roadmap: every stage and the SOL claimed it takes (bottom right, one line on a phone) */
  readonly roadmap = new RoadmapPanel();

  constructor(private readonly d: UiDeps) {
    document.body.appendChild(this.root);
    // the roadmap comes after the rat card: while a card is open the card has that corner (style.css)
    this.root.append(this.spot, this.banner, this.buildHud(), this.buildFeed(), this.buildBoard(), this.card, this.roadmap.el, this.vaultCard, this.milestoneEl, this.news);
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
      const id = d.rats.pick(w.x, w.y, d.camera.zoom);
      if (id === null && this.vaultHit?.(w.x, w.y)) {
        this.close();
        this.openVault();
        return;
      }
      this.closeVault();
      if (id !== null && id < 0) {
        this.openExtra('applicant'); // an applicant in the job-fair line
        return;
      }
      if (id !== null) {
        this.open(id, false);
        return;
      }
      const extra = this.extraHit?.(w.x, w.y, d.camera.zoom) ?? null;
      if (extra) this.openExtra(extra);
      else this.close();
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
    // zoom for a mouse (a trackpad pinches, a phone pinches; a plain scroll pans)
    for (const [text, factor, label] of [['+', 1.25, 'zoom in'], ['-', 0.8, 'zoom out']] as const) {
      const b = el('button', 'zoom-btn', text);
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.onclick = () => this.d.camera.zoomBy(factor);
      this.tools.append(b);
    }
    this.ca.hidden = true;
    this.caAddr.target = '_blank';
    this.caAddr.rel = 'noopener noreferrer';
    this.caCopy.type = 'button';
    this.caCopy.setAttribute('aria-label', 'copy the contract address');
    this.caCopy.onclick = () => {
      const mint = this.caMint;
      if (!mint) return;
      void copyText(mint).then((ok) => {
        this.caCopy.textContent = ok ? 'COPIED' : 'COPY FAILED';
        clearTimeout(this.caTimer);
        this.caTimer = window.setTimeout(() => (this.caCopy.textContent = 'COPY'), 1500);
      });
    };
    this.ca.append(this.caAddr, this.caCopy);
    title.append(el('div', 'brand', 'WALL STREET RATS'), el('div', 'tagline', 'The rat always loses. The fund always wins.'), this.ca, this.stageChip, this.tools);
    const grid = el('div', 'stats');
    for (const [key, label] of [
      ['mcap', 'Market cap'],
      ['rats', 'Rats hired'],
      ['portfolio', 'Portfolio value'],
    ] as const) {
      const box = el('div', 'stat');
      const value = el('div', 'stat-value', '--');
      const sub = el('div', 'stat-sub', '');
      box.append(el('div', 'stat-label', label), value, sub);
      grid.append(box);
      this.stats.set(key, { value, sub });
    }
    const ring = this.ringEl;
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
    this.hudEl = hud;
    return hud;
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
    set('mcap', s.coin.marketCapUsd === null ? 'pre-launch' : usd(s.coin.marketCapUsd), s.coin.priceUsd === null ? '' : `${priceUsd(s.coin.priceUsd)} / RAT`);
    const ca = caView(s.coin);
    this.ca.hidden = ca === null;
    if (ca && ca.copy !== this.caMint) {
      this.caMint = ca.copy;
      this.caAddr.textContent = ca.short;
      this.caAddr.href = ca.href;
      this.caAddr.title = `${ca.copy} on pump.fun`;
    } else if (!ca) this.caMint = null;
    set('rats', s.portfolio.ratCount.toLocaleString('en-US'), ratsSub(s.portfolio, s.bot.mode));
    const top = [...s.stocks].sort((a, b) => b.ratCount - a.ratCount).filter((x) => x.ratCount > 0).slice(0, 2);
    const holdings = top.map((x) => `${x.symbol} ${x.ratCount.toLocaleString('en-US')}`).join(', ');
    // the portfolio numbers glide between price updates (every 45 s) instead of jumping
    const portfolio = this.stats.get('portfolio');
    if (portfolio) portfolio.sub.textContent = holdings || 'no positions yet';
    this.glides.portfolio.set(s.portfolio.valueUsd);
    const banner = bannerText(s);
    this.banner.hidden = banner === null;
    this.banner.textContent = banner ?? '';
    this.banner.className = `banner ${s.bot.mode}`;
    this.renderBoard();
    if (this.selected !== null) this.renderCard();
  }

  private tick(): void {
    // the live feed (top right on desktop) starts under the HUD, whatever height the HUD has (banner, CA, wrapping)
    const hb = this.hudEl ? Math.round(this.hudEl.getBoundingClientRect().bottom) : -1;
    if (hb > 0 && hb !== this.hudBottom) {
      this.hudBottom = hb;
      this.root.style.setProperty('--hud-bottom', `${hb}px`);
    }
    const s = this.d.store.state;
    if (s) {
      const r = hireRing(s, clockNow(), SIM ? Number.POSITIVE_INFINITY : BOT_STALE_SEC);
      const len = 2 * Math.PI * 26;
      // waiting (clocking in, not launched yet): a quarter arc that turns slowly (CSS), not an empty ring
      this.ringArc.setAttribute('stroke-dashoffset', String(len * (1 - (r.waiting ? 0.25 : (r.progress ?? 0)))));
      this.ringEl.classList.toggle('waiting', r.waiting);
      this.ringLabel.textContent = r.label;
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
    this.feedList.append(this.feedEmpty);
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
    if (this.feedItems.length > 0) this.feedEmpty.remove();
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
    if (this.feedItems.length > 0) this.feedEmpty.remove();
    while (this.feedItems.length > 60) this.feedItems.pop()!.li.remove();
  }

  // ------------------------------------------------------------------ idle game
  /**
   * Stage name and three nested bars: the desk room filling up, the next room to unlock (both by rats hired), and the
   * next stage by SOL claimed ("FULL FLOOR: 0.62 / 1 SOL"). Bars that have nothing left to count hide. The roadmap
   * follows along.
   */
  setStage(stage: number, rats: number, sol: number, progress?: Progress): void {
    const name = STAGES[stage]?.name ?? '';
    this.roadmap.set(stage, sol);
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
    const next = STAGES[stage + 1];
    if (next) {
      const from = STAGES[stage]!.sol;
      row('stage', (sol - from) / Math.max(1e-9, next.sol - from), `${next.name}: ${solAmount(sol)} / ${solAmount(next.sol)} SOL`);
    } else row('stage', 1, `${name}: ${solAmount(sol)} SOL, the top`);
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

  /** The rat a shared link points at (?rat=<id> or ?wallet=<address>): by wallet (whole or the start of it), by #id, or by name. */
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

  /** Open a rat with the spotlight on it (a ?rat= link) and keep it in the address bar. */
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
    return ERAS[ringOfHires(before + 1)] ?? '';
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
    if (rows.length === 0) {
      this.boardList.replaceChildren(el('li', 'row empty', emptyBoardText(s)));
      return;
    }
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
      const url = walletUrl(w, !!this.d.simulated);
      if (url) row.append(link(url, short));
      else row.append(el('span', 'vault-addr', short));
      box.append(row);
    }
    if (holders.length > 25) box.append(el('div', 'card-note', `and ${(holders.length - 25).toLocaleString('en-US')} more (click a rat in the building to see its card)`));
    if (this.d.simulated) box.append(el('div', 'card-note', 'simulated rats: made-up wallets, nothing on chain'));
    return box;
  }

  // ------------------------------------------------------------------ rat card
  open(id: number, fly: boolean): void {
    this.card.classList.remove('extra-card');
    this.selected = id;
    this.renderCard();
    const pos = this.d.rats.positionOf(id);
    if (fly && pos) this.d.camera.flyTo(pos.x, pos.y - 20, Math.max(1.8, this.d.camera.zoom));
  }

  /** The small card for a rat that is not a hire (founder, applicant, crew): what it is, no wallet, no stock. */
  openExtra(kind: ExtraKind): void {
    this.close();
    const c = EXTRA_CARD[kind];
    const close = el('button', 'card-close', 'x');
    close.onclick = () => this.close();
    const head = el('div', 'card-head');
    const who = el('div', 'card-who');
    const badge = el('span', 'badge extra', c.badge);
    who.append(el('div', 'card-name', c.name), badge);
    head.append(this.sprite(kind === 'founder' ? 'partner' : 'intern'), who, close);
    this.card.replaceChildren(head, el('p', 'card-extra', c.line));
    this.card.classList.add('extra-card');
    this.card.hidden = false;
  }

  close(): void {
    this.card.classList.remove('extra-card');
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
    row('Value', usd(v.valueUsd));
    row('Rank', `#${this.rankOf(rec)} of ${this.d.store.rats.size.toLocaleString('en-US')}`);
    row('Status', v.status === 'frozen' ? 'frozen (stock paused or account frozen)' : 'at work');
    row('Hired', ago(v.hiredAt));
    const links = el('div', 'card-links');
    // the rat's own on-chain wallet (never a link to this site); the simulator's wallets are made up: no link
    const wallet = walletUrl(rec.facts.wallet, !!this.d.simulated);
    if (wallet) {
      const a = link(wallet, 'WALLET ON SOLSCAN');
      a.className = 'wallet-btn';
      a.title = `${rec.facts.wallet} on Solscan`;
      links.append(a);
    } else {
      const off = el('span', 'wallet-btn off', this.d.simulated ? 'WALLET: SIMULATION' : 'WALLET: NOT ON CHAIN');
      off.setAttribute('aria-disabled', 'true');
      off.title = this.d.simulated ? 'simulated rat: made-up wallet, nothing on chain' : 'no on-chain wallet for this rat';
      links.append(off);
    }
    if (rec.estimated) links.append(el('span', 'card-note', 'value estimated since hire; exact after reload'));
    this.card.replaceChildren(head, grid, links);
    this.card.hidden = false;
  }
}
