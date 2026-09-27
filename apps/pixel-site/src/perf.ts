// ?perf=1: frames per second, JS time per frame (simulation + layer sync), rat and particle counts.
export class PerfMeter {
  private el: HTMLDivElement;
  private frames = 0;
  private jsTotal = 0;
  private jsMax = 0;
  private cpuTotal = 0;
  private cpuMax = 0;
  private since = performance.now();
  last = { fps: 0, jsAvg: 0, jsMax: 0, cpuAvg: 0, cpuMax: 0 };

  constructor(visible: boolean) {
    this.el = document.createElement('div');
    this.el.id = 'perf';
    this.el.hidden = !visible;
    document.body.appendChild(this.el);
  }

  /** jsMs: simulation + layer sync. cpuMs: the whole frame on the CPU, including Pixi's render submission. */
  frame(jsMs: number, cpuMs: number, info: string): void {
    this.frames++;
    this.jsTotal += jsMs;
    this.jsMax = Math.max(this.jsMax, jsMs);
    this.cpuTotal += cpuMs;
    this.cpuMax = Math.max(this.cpuMax, cpuMs);
    const now = performance.now();
    if (now - this.since < 1000) return;
    const secs = (now - this.since) / 1000;
    this.last = { fps: this.frames / secs, jsAvg: this.jsTotal / this.frames, jsMax: this.jsMax, cpuAvg: this.cpuTotal / this.frames, cpuMax: this.cpuMax };
    this.el.textContent = `${this.last.fps.toFixed(0)} fps | sim ${this.last.jsAvg.toFixed(2)} ms | frame cpu ${this.last.cpuAvg.toFixed(2)} ms (max ${this.last.cpuMax.toFixed(1)}) | ${info}`;
    (window as unknown as { __perf?: unknown }).__perf = { ...this.last, info };
    this.frames = 0;
    this.jsTotal = 0;
    this.jsMax = 0;
    this.cpuTotal = 0;
    this.cpuMax = 0;
    this.since = now;
  }
}
