// Drag to pan. A trackpad's two-finger scroll pans too; a pinch zooms around the pointer (browsers report a trackpad
// pinch as a wheel event with ctrlKey set, Safari as gesture events). Mouse users zoom with ctrl + wheel or the
// + and - buttons in the HUD (zoomBy). Touch: drag pans, two-finger pinch zooms.
import type { Container } from 'pixi.js';

/** What a wheel event does to the camera: a pinch (ctrlKey) zooms by `factor`, anything else pans by (dx, dy). */
export type WheelAction = { kind: 'zoom'; factor: number } | { kind: 'pan'; dx: number; dy: number };

/** px per line and per page for wheel events that count in lines (Firefox with a mouse) or pages */
const LINE_PX = 16;

export function wheelAction(e: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'ctrlKey' | 'shiftKey'>, pageH = 800): WheelAction {
  const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? pageH : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  if (e.ctrlKey) {
    // a pinch sends small deltas many times a second; ctrl + a mouse wheel sends big steps: cap each step
    const d = Math.max(-60, Math.min(60, dy));
    return { kind: 'zoom', factor: Math.exp(-d * 0.01) };
  }
  // shift + a mouse wheel scrolls sideways
  if (e.shiftKey && dx === 0) return { kind: 'pan', dx: -dy, dy: 0 };
  return { kind: 'pan', dx: -dx, dy: -dy };
}

/** A tap that moved less than this (CSS px) is a click, not a drag; fingers wobble more than a mouse. */
export const CLICK_SLOP = { mouse: 6, touch: 12 };

export interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class Camera {
  zoom = 1;
  x = 0; // screen position of world origin
  y = 0;
  minZoom = 0.2;
  maxZoom = 4;
  private dragging = false;
  private moved = 0;
  private last = { x: 0, y: 0 };
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private touchDown = false;
  /** Safari's trackpad pinch (gesture events): the scale at the last step */
  private gestureScale = 0;
  onChange: () => void = () => {};
  /** a click that was not a drag, in screen coordinates */
  onClick: (x: number, y: number) => void = () => {};

  constructor(
    private readonly world: Container,
    private readonly el: HTMLElement,
  ) {
    el.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', (e) => this.up(e));
    el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    // Safari (macOS) reports a trackpad pinch as gesture events, not ctrl + wheel. On a touch screen the pointer
    // events already run the pinch, so gestures are only stopped there (no page zoom), never applied twice.
    type Gesture = Event & { scale?: number; clientX?: number; clientY?: number };
    el.addEventListener('gesturestart', (e: Gesture) => {
      e.preventDefault();
      this.gestureScale = e.scale ?? 1;
    });
    el.addEventListener('gesturechange', (e: Gesture) => {
      e.preventDefault();
      if (this.touchDown || !this.gestureScale || !e.scale) return;
      this.lastInput = performance.now();
      this.flight++;
      const box = el.getBoundingClientRect();
      this.zoomAt(e.clientX ?? box.left + box.width / 2, e.clientY ?? box.top + box.height / 2, e.scale / this.gestureScale);
      this.gestureScale = e.scale;
    });
    el.addEventListener('gestureend', (e: Gesture) => {
      e.preventDefault();
      this.gestureScale = 0;
    });
  }

  /** when the viewer last touched the camera (ms, performance.now) */
  lastInput = -1e9;
  /** true while the viewer drags or has just moved the camera: automatic flights stay out of the way */
  get userBusy(): boolean {
    return this.dragging || performance.now() - this.lastInput < 4000;
  }
  private flight = 0;

  private down(e: PointerEvent): void {
    this.lastInput = performance.now();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.touchDown = e.pointerType === 'touch';
    this.dragging = true;
    this.moved = 0;
    this.last = { x: e.clientX, y: e.clientY };
    if (this.pointers.size === 2) this.pinch = this.pinchDistance();
  }

  private pinchDistance(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private move(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const d = this.pinchDistance();
      if (this.pinch > 0 && d > 0) {
        const [a, b] = [...this.pointers.values()];
        this.zoomAt((a!.x + b!.x) / 2, (a!.y + b!.y) / 2, d / this.pinch);
      }
      this.pinch = d;
      this.moved += 10;
      return;
    }
    if (!this.dragging) return;
    const dx = e.clientX - this.last.x;
    const dy = e.clientY - this.last.y;
    this.moved += Math.abs(dx) + Math.abs(dy);
    this.last = { x: e.clientX, y: e.clientY };
    this.x += dx;
    this.y += dy;
    this.lastInput = performance.now();
    if (this.moved > CLICK_SLOP.mouse) this.flight++; // dragging stops any flight
    this.apply();
  }

  private up(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      if (this.dragging && this.moved < (e.pointerType === 'touch' ? CLICK_SLOP.touch : CLICK_SLOP.mouse)) this.onClick(e.clientX, e.clientY);
      this.dragging = false;
      this.touchDown = false;
    }
    this.pinch = 0;
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    this.lastInput = performance.now();
    this.flight++; // a wheel stops any flight
    if (this.gestureScale && e.ctrlKey) return; // Safari: the gesture events run this pinch
    const a = wheelAction(e, this.el.clientHeight);
    if (a.kind === 'zoom') this.zoomAt(e.clientX, e.clientY, a.factor);
    else {
      this.x += a.dx;
      this.y += a.dy;
      this.apply();
    }
  }

  /** Zoom in (factor > 1) or out around the middle of the screen: the HUD's + and - buttons. */
  zoomBy(factor: number): void {
    this.lastInput = performance.now();
    this.flight++;
    const box = this.el.getBoundingClientRect();
    this.zoomAt(box.left + box.width / 2, box.top + box.height / 2, factor);
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const z = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    const wx = (sx - this.x) / this.zoom;
    const wy = (sy - this.y) / this.zoom;
    this.zoom = z;
    this.x = sx - wx * z;
    this.y = sy - wy * z;
    this.apply();
  }

  centerOn(wx: number, wy: number, zoom = this.zoom): void {
    this.zoom = zoom;
    this.x = this.el.clientWidth / 2 - wx * zoom;
    this.y = this.el.clientHeight / 2 - wy * zoom;
    this.apply();
  }

  /** Glide to centre a world point at a zoom level. */
  flyTo(wx: number, wy: number, zoom: number, ms = 450): void {
    const id = ++this.flight;
    const from = { x: this.x, y: this.y, z: this.zoom };
    const z = Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
    const to = { x: this.el.clientWidth / 2 - wx * z, y: this.el.clientHeight / 2 - wy * z, z };
    const t0 = performance.now();
    const step = (now: number): void => {
      if (id !== this.flight) return; // a newer flight or the viewer took over
      const u = Math.min(1, (now - t0) / ms);
      const e = u * u * (3 - 2 * u);
      this.zoom = from.z + (to.z - from.z) * e;
      this.x = from.x + (to.x - from.x) * e;
      this.y = from.y + (to.y - from.y) * e;
      this.apply();
      if (u < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private shakeLeft = 0;
  private shakePx = 0;

  /** Screen shake (px on screen, seconds). */
  shake(px: number, seconds: number): void {
    this.shakePx = px;
    this.shakeLeft = seconds;
  }

  /** Call every frame: runs the shake. */
  tick(dt: number): void {
    if (this.shakeLeft <= 0) return;
    this.shakeLeft -= dt;
    const s = this.shakeLeft > 0 ? this.shakePx : 0;
    this.world.position.set(Math.round(this.x + (Math.random() * 2 - 1) * s), Math.round(this.y + (Math.random() * 2 - 1) * s));
  }

  /** The world point at the centre of the screen now. */
  centre(): { x: number; y: number; zoom: number } {
    return { x: (this.el.clientWidth / 2 - this.x) / this.zoom, y: (this.el.clientHeight / 2 - this.y) / this.zoom, zoom: this.zoom };
  }

  apply(): void {
    this.world.scale.set(this.zoom);
    this.world.position.set(Math.round(this.x), Math.round(this.y));
    this.onChange();
  }

  view(): View {
    return {
      x: -this.x / this.zoom,
      y: -this.y / this.zoom,
      w: this.el.clientWidth / this.zoom,
      h: this.el.clientHeight / this.zoom,
    };
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.x) / this.zoom, y: (sy - this.y) / this.zoom };
  }
}
