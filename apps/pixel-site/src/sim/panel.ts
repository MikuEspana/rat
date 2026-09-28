// Launch simulator controls: the SIMULATION banner, the "Simulate launch" start screen and the control panel
// (start / pause / reset, speed, scenario, and a readout of sim time, market cap, rats, stage and burns).
// It also drives the simulator's clock. Plain DOM, textContent only.
import { compact, usd } from '../ui/format';
import type { Ui } from '../ui/ui';
import type { LaunchSim } from './engine';
import { SCENARIOS, type ScenarioId } from './scenarios';

export const SPEEDS = [1, 10, 60, 300] as const;
const TICK_MS = 50;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** "T+2:05:30" */
export function simClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `T+${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export interface PanelDeps {
  sim: LaunchSim;
  ui: Ui;
  speed: number;
  autostart: boolean;
  /** current stage name of the building */
  stage: () => string;
  /** the coin went live: the site frames the building */
  onLaunch: () => void;
}

export class SimPanel {
  private readonly root = el('div', 'ui sim-ui');
  private readonly banner = el('div', 'sim-banner', 'SIMULATION: a fake launch running in your browser. No real coin, no real money, no transactions.');
  private readonly intro = el('div', 'sim-intro');
  private readonly panel = el('div', 'sim-panel');
  private readonly readout = el('div', 'sim-readout');
  private readonly playBtn = el('button', 'sim-play', 'Pause');
  private readonly speedBtns = new Map<number, HTMLButtonElement>();
  private readonly status = el('div', 'sim-status');
  private speed: number;
  private running = false;
  private simT = 0;
  private last = performance.now();
  private announcedEnd = false;

  constructor(private readonly d: PanelDeps) {
    this.speed = (SPEEDS as readonly number[]).includes(d.speed) ? d.speed : 60;
    document.body.classList.add('sim-mode');
    document.body.appendChild(this.root);
    this.root.append(this.banner, this.buildIntro(), this.buildPanel());
    this.panel.hidden = true;
    window.addEventListener('resize', () => this.place());
    setInterval(() => this.tick(), TICK_MS);
    if (d.autostart) this.start();
    this.render();
    requestAnimationFrame(() => this.place());
  }

  private scenarioId(): ScenarioId {
    return this.d.sim.scenario.id;
  }

  /** Reload with a clean simulator (a new world, no leftovers): the only reliable reset for the whole site. */
  private reload(scenario: ScenarioId, autostart: boolean): void {
    const q = new URLSearchParams(location.search);
    q.set('sim', '1');
    q.set('scenario', scenario);
    q.set('speed', String(this.speed));
    if (autostart) q.set('autostart', '1');
    else q.delete('autostart');
    location.search = q.toString();
  }

  private scenarioSelect(onPick: (id: ScenarioId) => void): HTMLSelectElement {
    const sel = el('select', 'sim-select');
    for (const s of Object.values(SCENARIOS)) {
      const o = el('option', '', `${s.label}: ${s.blurb}`);
      o.value = s.id;
      o.selected = s.id === this.scenarioId();
      sel.append(o);
    }
    sel.onchange = () => onPick(sel.value as ScenarioId);
    return sel;
  }

  private speedRow(): HTMLElement {
    const row = el('div', 'sim-speeds');
    for (const s of SPEEDS) {
      const b = el('button', 'tab', `${s}x`);
      b.onclick = () => {
        this.speed = s;
        this.render();
      };
      this.speedBtns.set(s, b);
      row.append(b);
    }
    return row;
  }

  private buildIntro(): HTMLElement {
    const box = this.intro;
    box.className = 'sim-intro panel';
    const go = el('button', 'sim-go', 'SIMULATE LAUNCH');
    go.onclick = () => this.start();
    const pick = this.scenarioSelect((id) => {
      if (id !== this.scenarioId()) this.reload(id, false);
    });
    const speedLabel = el('div', 'sim-label', 'Speed');
    box.append(
      el('div', 'sim-kicker', 'RAT RACE LAUNCH SIMULATOR'),
      el('div', 'sim-lede', 'Watch a whole launch in minutes: the coin goes live, fees come in, rats get hired, the company grows, burns fire.'),
      el('div', 'sim-label', 'Scenario'),
      pick,
      speedLabel,
      this.speedRow(),
      go,
      el('div', 'sim-fine', 'Runs entirely in your browser with the bot\'s real rules. Nothing here is real money.'),
    );
    return box;
  }

  private buildPanel(): HTMLElement {
    const box = this.panel;
    box.className = 'sim-panel panel';
    const head = el('div', 'panel-head');
    head.append(el('span', 'sim-tag', 'SIMULATION'), this.status);
    const controls = el('div', 'sim-controls');
    this.playBtn.onclick = () => {
      if (this.d.sim.finished) return;
      this.running = !this.running;
      this.last = performance.now();
      this.render();
    };
    const reset = el('button', 'sim-reset', 'Reset');
    reset.onclick = () => this.reload(this.scenarioId(), false);
    const speeds = el('div', 'sim-speeds');
    for (const s of SPEEDS) {
      const b = el('button', 'tab', `${s}x`);
      b.onclick = () => {
        this.speed = s;
        this.render();
      };
      b.dataset.speed = String(s);
      speeds.append(b);
    }
    const pick = this.scenarioSelect((id) => this.reload(id, true));
    controls.append(this.playBtn, reset, speeds);
    box.append(head, controls, pick, this.readout);
    return box;
  }

  /** Keep the control panel just under the HUD (its height changes with the screen width). */
  private place(): void {
    const hud = document.querySelector('.hud');
    const bottom = hud ? hud.getBoundingClientRect().bottom : 90;
    this.panel.style.top = `${Math.round(bottom + 8)}px`;
  }

  start(): void {
    const sim = this.d.sim;
    if (!sim.isLaunched) {
      sim.launch();
      this.d.ui.pushLocal([{ tag: 'LAUNCH', text: `RAT is live on pump.fun (simulated, ${SCENARIOS[this.scenarioId()].label} scenario). Creator fees start flowing.` }]);
      this.d.onLaunch();
    }
    this.intro.hidden = true;
    this.panel.hidden = false;
    this.running = true;
    this.last = performance.now();
    this.render();
    requestAnimationFrame(() => this.place());
  }

  private tick(): void {
    const t = performance.now();
    const dt = Math.min(250, t - this.last); // a background tab slows the launch down instead of jumping ahead
    this.last = t;
    const sim = this.d.sim;
    if (this.running && sim.isLaunched && !sim.finished) {
      this.simT = Math.min(sim.endMs, this.simT + dt * this.speed);
      sim.advanceTo(this.simT);
      if (sim.finished) this.running = false;
    }
    if (sim.finished && !this.announcedEnd) {
      this.announcedEnd = true;
      const s = sim.stats();
      this.d.ui.pushLocal([{ tag: 'SIM', text: `Scenario finished: ${s.rats.toLocaleString('en-US')} rats hired, ${s.burnSpentSol.toFixed(1)} SOL burned. Reset to run it again.` }]);
    }
    this.render();
  }

  private render(): void {
    const s = this.d.sim.stats();
    for (const [sp, b] of this.speedBtns) b.classList.toggle('on', sp === this.speed);
    this.panel.querySelectorAll<HTMLButtonElement>('button[data-speed]').forEach((b) => b.classList.toggle('on', Number(b.dataset.speed) === this.speed));
    this.playBtn.textContent = s.finished ? 'Done' : this.running ? 'Pause' : 'Start';
    this.playBtn.disabled = s.finished;
    this.status.textContent = s.finished ? 'finished' : this.running ? `running ${this.speed}x` : s.launched ? 'paused' : 'ready';
    const rows: Array<[string, string]> = [
      ['Sim time', simClock(s.t)],
      ['Market cap', s.mcap === null ? 'pre-launch' : usd(s.mcap)],
      ['Rats', s.rats.toLocaleString('en-US')],
      ['Stage', this.d.stage()],
      ['Burned', `${compact(s.burnedTokens)} RAT (${s.burnSpentSol.toFixed(2)} SOL)`],
      ['Fees', `${s.feesSol.toFixed(2)} SOL`],
    ];
    this.readout.replaceChildren(
      ...rows.map(([k, v]) => {
        const r = el('div', 'sim-row');
        r.append(el('span', 'sim-k', k), el('span', 'sim-v', v));
        return r;
      }),
    );
  }

  /** For headless tests: where the launch is. */
  get state(): { running: boolean; speed: number; t: number; finished: boolean } {
    return { running: this.running, speed: this.speed, t: this.d.sim.time, finished: this.d.sim.finished };
  }

  setSpeed(s: number): void {
    this.speed = s;
    this.render();
  }

  /** Pause or resume (the Start / Pause button). */
  setRunning(on: boolean): void {
    if (!this.d.sim.isLaunched || this.d.sim.finished) return;
    this.running = on;
    this.last = performance.now();
    this.render();
  }
}
