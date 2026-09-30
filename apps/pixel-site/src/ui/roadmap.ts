// The Company Roadmap: every stage of the building in order and the SOL claimed each one takes. Stages done are
// checked, the next one fills a bar ("0.62 / 1 SOL"), the rest are locked with their target. It folds to one line
// ("NEXT: CORPORATE 3.2 / 5 SOL"), always on a phone. After the last stage two unnamed teaser rows ("???" at 100 SOL,
// "??????" at 200 SOL) stay locked: roadmap only, the building has no such stages. Plain DOM, textContent only.
import { STAGES } from '../floor/plan';
import { solAmount } from './format';

export type RoadmapStatus = 'done' | 'next' | 'locked';

/** Teasers after WALL STREET: always locked and unnamed. Only the roadmap shows them (no stage, floor or world change). */
export const ROADMAP_TEASERS: ReadonlyArray<{ name: string; sol: number }> = [
  { name: '???', sol: 100 },
  { name: '??????', sol: 200 },
];

export interface RoadmapRow {
  name: string;
  status: RoadmapStatus;
  /** SOL claimed the stage opens at */
  target: number;
  /** the next stage only: SOL claimed so far over its target, 0..1 */
  progress: number | null;
  /** "0.62 / 1 SOL" for the next stage, the target ("5 SOL") for the others */
  text: string;
  /** a teaser row after the last stage: locked, never next, never done */
  teaser?: boolean;
}

export interface RoadmapModel {
  rows: RoadmapRow[];
  /** the one-line summary: "NEXT: CORPORATE 3.2 / 5 SOL", or "WALL STREET: 72.4 SOL" at the top */
  line: string;
}

/** The roadmap for the stage the building is at (it never closes) and the SOL claimed so far. */
export function roadmapModel(stage: number, sol: number): RoadmapModel {
  const at = Math.max(0, Math.min(STAGES.length - 1, stage));
  const rows = STAGES.map((st, k): RoadmapRow => {
    const status: RoadmapStatus = k <= at ? 'done' : k === at + 1 ? 'next' : 'locked';
    if (status !== 'next') return { name: st.name, status, target: st.sol, progress: null, text: `${solAmount(st.sol)} SOL` };
    return {
      name: st.name,
      status,
      target: st.sol,
      progress: Math.max(0, Math.min(1, sol / st.sol)),
      text: `${solAmount(sol)} / ${solAmount(st.sol)} SOL`,
    };
  });
  for (const t of ROADMAP_TEASERS) rows.push({ name: t.name, status: 'locked', target: t.sol, progress: null, text: `${solAmount(t.sol)} SOL`, teaser: true });
  const next = STAGES[at + 1];
  const line = next ? `NEXT: ${next.short} ${solAmount(sol)} / ${solAmount(next.sol)} SOL` : `${STAGES[at]!.name}: ${solAmount(sol)} SOL`;
  return { rows, line };
}

/**
 * Up to this width the roadmap starts as one line (tap it for the list): phones, and every screen where the feed
 * moves to the bottom (style.css, 900 px).
 */
export const ROADMAP_ONE_LINE_MAX_WIDTH = 900;
const KEY = 'wsr:roadmap';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function stored(): 'open' | 'folded' | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'open' || v === 'folded' ? v : null;
  } catch {
    return null;
  }
}

function store(v: 'open' | 'folded'): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* private window or blocked storage: the choice lasts this visit only */
  }
}

export class RoadmapPanel {
  readonly el = el('section', 'roadmap panel');
  private readonly head = el('button', 'rm-head');
  private readonly title = el('span', 'rm-title', 'COMPANY ROADMAP');
  private readonly line = el('span', 'rm-line', '');
  private readonly fold = el('span', 'rm-fold', '');
  private readonly list = el('ol', 'rm-list');
  private key = '';

  constructor() {
    this.head.type = 'button';
    this.head.append(this.title, this.line, this.fold);
    this.el.append(this.head, this.list);
    // a small screen starts on the one line; a desktop keeps the viewer's last choice (open by default)
    const narrow = typeof matchMedia === 'function' ? matchMedia(`(max-width: ${ROADMAP_ONE_LINE_MAX_WIDTH}px)`) : null;
    const fit = (): void => this.setOpen(narrow?.matches ? false : stored() !== 'folded', false);
    fit();
    narrow?.addEventListener?.('change', fit);
    this.head.onclick = () => this.setOpen(this.el.classList.contains('folded'), true);
  }

  get open(): boolean {
    return !this.el.classList.contains('folded');
  }

  setOpen(open: boolean, remember: boolean): void {
    this.el.classList.toggle('folded', !open);
    this.head.setAttribute('aria-expanded', String(open));
    this.head.title = open ? 'Fold the roadmap to one line' : 'Show every stage';
    this.fold.textContent = open ? 'hide' : 'show';
    if (remember) store(open ? 'open' : 'folded');
  }

  /** The building's stage and the SOL claimed so far. */
  set(stage: number, sol: number): void {
    const m = roadmapModel(stage, sol);
    this.line.textContent = m.line;
    const key = m.rows.map((r) => `${r.status}:${r.text}`).join('|');
    if (key === this.key) return;
    this.key = key;
    this.list.replaceChildren(
      ...m.rows.map((r) => {
        const li = el('li', `rm-row ${r.status}${r.teaser ? ' teaser' : ''}`);
        li.append(el('span', 'rm-mark'), el('span', 'rm-name', r.name), el('span', 'rm-sol', r.text));
        if (r.progress !== null) {
          const bar = el('span', 'rm-bar');
          const fill = el('i');
          fill.style.width = `${(r.progress * 100).toFixed(1)}%`;
          bar.append(fill);
          li.append(bar);
        }
        li.title = r.teaser ? `${r.name}: locked. What comes after Wall Street is still under wraps.` : r.status === 'done' ? `${r.name}: open` : r.status === 'next' ? `${r.name}: ${r.text} claimed` : `${r.name}: opens at ${r.text} claimed`;
        return li;
      }),
    );
  }
}
