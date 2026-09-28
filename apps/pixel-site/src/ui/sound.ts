// Little synth chimes (WebAudio, no files): a room unlocks, a stage unlocks, a rat is hired. Off until the viewer
// switches it on or clicks the page (browsers only start audio after a gesture); the choice is remembered.
let ctx: AudioContext | null = null;
let on = false;
try {
  on = localStorage.getItem('ratrace:sound') === 'on';
} catch {
  on = false;
}

function audio(): AudioContext | null {
  if (!on) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function note(a: AudioContext, freq: number, at: number, dur: number, type: OscillatorType, gain: number): void {
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, a.currentTime + at);
  g.gain.linearRampToValueAtTime(gain, a.currentTime + at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + at + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + at);
  o.stop(a.currentTime + at + dur + 0.05);
}

export const sound = {
  get on(): boolean {
    return on;
  },
  set(value: boolean): void {
    on = value;
    try {
      localStorage.setItem('ratrace:sound', value ? 'on' : 'off');
    } catch {
      /* private mode: remember for this visit only */
    }
    if (value) audio();
  },
  /** a room goes up: two quick notes */
  room(): void {
    const a = audio();
    if (!a) return;
    note(a, 880, 0, 0.18, 'triangle', 0.12);
    note(a, 1320, 0.08, 0.26, 'triangle', 0.1);
  },
  /** a new stage: a rising arpeggio */
  stage(): void {
    const a = audio();
    if (!a) return;
    [523, 659, 784, 1047, 1319].forEach((f, k) => note(a, f, k * 0.09, 0.5, 'square', 0.05));
    note(a, 262, 0, 0.9, 'triangle', 0.08);
  },
  /** a hire: a soft tick */
  hire(): void {
    const a = audio();
    if (!a) return;
    note(a, 1760, 0, 0.06, 'sine', 0.04);
  },
  /** a manhole lid pops up */
  pop(): void {
    const a = audio();
    if (!a) return;
    note(a, 220, 0, 0.08, 'square', 0.05);
    note(a, 440, 0.03, 0.08, 'triangle', 0.05);
  },
  /** the lid drops back: a heavy iron clank */
  clank(): void {
    const a = audio();
    if (!a) return;
    note(a, 140, 0, 0.18, 'square', 0.07);
    note(a, 610, 0, 0.12, 'triangle', 0.05);
    note(a, 1230, 0.01, 0.08, 'sine', 0.03);
  },
};
