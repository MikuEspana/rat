// The data layer on top of the floor: HUD, next-hire ring, live feed, rat card, leaderboard, DRY RUN banner.
// Plain DOM over the canvas. Everything from the API goes in with textContent, never as HTML.
import { Container, Graphics } from 'pixi.js';
import type { RatEvent, RatView, StateResponse } from '@rat/contract';
import type { Atlas } from '../gfx/atlas';
import type { Camera } from '../gfx/camera';
import type { RatRecord, Store } from '../data/store';
import { TIER_SCALE, type RatSystem } from '../world/rats';
import { now as clockNow } from '../now';
import { ago, claimProgress, describe, pct, signClass, TIER_COLOR, TIER_LABEL, tokens, usd } from './format';

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
}

export class Ui {
  private root = el('div', 'ui');
  private banner = el('div', 'banner');
  private stats = new Map<string, { value: HTMLElement; sub: HTMLElement }>();
  private ringArc!: SVGCircleElement;
  private ringLabel = el('div', 'ring-label');
  private feedList = el('ol', 'feed-list');
  private feedItems: Array<{ li: HTMLLIElement; time: HTMLElement; at: string }> = [];
  private boardList = el('ol', 'board-list');
  private boardMode: 'top' | 'bottom' = 'top';
  private card = el('div', 'card');
  private stageChip = el('div', 'stage-chip', '');
  private milestoneEl = el('div', 'milestone');
  private milestoneTimer = 0;
  private selected: number | null = null;
  private marker = new Graphics();

  constructor(private readonly d: UiDeps) {
    document.body.appendChild(this.root);
    this.root.append(this.banner, this.buildHud(), this.buildFeed(), this.buildBoard(), this.card, this.milestoneEl);
    this.milestoneEl.hidden = true;
    this.card.hidden = true;
    this.banner.hidden = true;
    this.marker.poly([-6, -10, 6, -10, 0, 0]).fill(0xffd23f).stroke({ color: 0x16182c, width: 2 });
    this.marker.visible = false;
    d.markerLayer.addChild(this.marker);

    d.camera.onClick = (sx, sy) => {
      const w = d.camera.toWorld(sx, sy);
      const id = d.rats.pick(w.x, w.y);
      if (id === null) this.close();
      else this.open(id, false);
    };
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    d.store.on((e) => {
      if (e.kind === 'state') this.onState(e.state);
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
    title.append(el('div', 'brand', 'RAT RACE'), el('div', 'tagline', 'The rat always loses. The fund always wins.'), this.stageChip);
    const grid = el('div', 'stats');
    for (const [key, label] of [
      ['mcap', 'Market cap'],
      ['rats', 'Rats hired'],
      ['burned', 'Total burned'],
      ['pnl', 'Portfolio PnL'],
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
    set('burned', `${tokens(s.coin.burnedTokens)} RAT`, `${s.treasury.totalBurnSpentSol.toFixed(2)} SOL, ${s.treasury.burnCount} burns`);
    set('pnl', usd(s.portfolio.pnlUsd), pct(s.portfolio.pnlPct), signClass(s.portfolio.pnlUsd));
    const mode = s.bot.mode;
    this.banner.hidden = mode === 'live';
    this.banner.textContent =
      mode === 'dry_run' ? 'DRY RUN: simulated trades, nothing on this page is real money.' : mode === 'paused' ? 'PAUSED: the kill switch is on. No hires, no burns.' : '';
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
  setStage(name: string, rats: number): void {
    this.stageChip.textContent = `${name} . ${rats.toLocaleString('en-US')} rats`;
  }

  /** Big banner for a new stage; fades out on its own. */
  milestone(title: string, sub: string): void {
    this.milestoneEl.replaceChildren(el('div', 'ms-kicker', 'NEW STAGE UNLOCKED'), el('div', 'ms-title', title), el('div', 'ms-sub', sub));
    this.milestoneEl.hidden = false;
    this.milestoneEl.classList.remove('show');
    void this.milestoneEl.offsetWidth;
    this.milestoneEl.classList.add('show');
    clearTimeout(this.milestoneTimer);
    this.milestoneTimer = window.setTimeout(() => (this.milestoneEl.hidden = true), 4200);
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
    input.max = '5000';
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

  // ------------------------------------------------------------------ rat card
  open(id: number, fly: boolean): void {
    this.selected = id;
    this.renderCard();
    const pos = this.d.rats.positionOf(id);
    if (fly && pos) this.d.camera.flyTo(pos.x, pos.y - 20, Math.max(1.8, this.d.camera.zoom));
  }

  close(): void {
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
    who.append(el('div', 'card-name', v.name), badge);
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
    links.append(link(v.solscanUrl, 'Wallet on Solscan'));
    if (rec.estimated) links.append(el('span', 'card-note', 'value estimated since hire; exact after reload'));
    this.card.replaceChildren(head, grid, links);
    this.card.hidden = false;
  }
}
