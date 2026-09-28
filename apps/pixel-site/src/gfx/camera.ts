// Drag to pan, wheel to zoom around the pointer (like floor796). Pinch zoom on touch.
import type { Container } from 'pixi.js';

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
  }

  private down(e: PointerEvent): void {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
    this.apply();
  }

  private up(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      if (this.dragging && this.moved < 5) this.onClick(e.clientX, e.clientY);
      this.dragging = false;
    }
    this.pinch = 0;
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    this.zoomAt(e.clientX, e.clientY, factor);
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
    const from = { x: this.x, y: this.y, z: this.zoom };
    const z = Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
    const to = { x: this.el.clientWidth / 2 - wx * z, y: this.el.clientHeight / 2 - wy * z, z };
    const t0 = performance.now();
    const step = (now: number): void => {
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
