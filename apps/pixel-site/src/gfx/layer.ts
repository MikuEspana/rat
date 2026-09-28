// A ParticleContainer that paints in isometric depth order and only uploads what the camera can see.
//
// Every item has a depth (painter's order) and a screen bucket. The full list stays sorted by depth with an
// insertion sort (cheap: only walkers move, so it is almost always sorted already). Each sync, the visible list
// is the sorted list filtered by visible buckets, so it needs no sort of its own. ParticleContainer draws
// `particleChildren` in array order and wants update() after the array is changed directly:
// VERIFIED in https://github.com/pixijs/pixijs/blob/dev/src/scene/particle-container/shared/ParticleContainer.ts
import { Particle, ParticleContainer, Rectangle, type ParticleProperties, type TextureSource } from 'pixi.js';

export interface LayerItem {
  p: Particle;
  depth: number;
  x: number;
  y: number;
  bucket: number;
  /** false once removed */
  live: boolean;
}

const BUCKET = 256;
const MARGIN = 160; // sprites reach up and sideways from their anchor
const byDepth = (a: LayerItem, b: LayerItem): number => a.depth - b.depth;

export class SortedLayer {
  readonly container: ParticleContainer;
  private items: LayerItem[] = [];
  private visible: Uint8Array;
  private readonly cols: number;
  private readonly rows: number;
  private orderDirty = false;
  private listDirty = true;
  private viewKey = '';
  private everything = true;
  visibleCount = 0;

  constructor(
    texture: TextureSource,
    private readonly bounds: { x: number; y: number; w: number; h: number },
    dynamic: ParticleProperties & Record<string, boolean>,
  ) {
    this.container = new ParticleContainer({ dynamicProperties: dynamic, roundPixels: true });
    this.container.boundsArea = new Rectangle(bounds.x, bounds.y, bounds.w, bounds.h);
    this.cols = Math.max(1, Math.ceil(bounds.w / BUCKET));
    this.rows = Math.max(1, Math.ceil(bounds.h / BUCKET));
    this.visible = new Uint8Array(this.cols * this.rows).fill(1);
    void texture;
  }

  private bucketOf(x: number, y: number): number {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.bounds.x) / BUCKET)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.bounds.y) / BUCKET)));
    return r * this.cols + c;
  }

  add(p: Particle, depth: number): LayerItem {
    const item: LayerItem = { p, depth, x: p.x, y: p.y, bucket: this.bucketOf(p.x, p.y), live: true };
    this.items.push(item);
    this.orderDirty = true;
    return item;
  }

  remove(item: LayerItem): void {
    if (!item.live) return;
    item.live = false;
    const k = this.items.indexOf(item);
    if (k >= 0) this.items.splice(k, 1);
    this.listDirty = true;
  }

  has(item: LayerItem): boolean {
    return item.live;
  }

  /** Put a removed item back. */
  readd(item: LayerItem, depth: number): void {
    if (item.live) return;
    item.live = true;
    item.depth = depth;
    this.items.push(item);
    this.orderDirty = true;
  }

  /** Call after changing an item's particle position or depth. */
  moved(item: LayerItem, depth: number): void {
    item.x = item.p.x;
    item.y = item.p.y;
    item.bucket = this.bucketOf(item.x, item.y);
    if (depth !== item.depth) {
      item.depth = depth;
      this.orderDirty = true;
    }
    this.listDirty = true;
  }

  /** Camera rectangle in world coordinates. */
  setView(x: number, y: number, w: number, h: number): void {
    const c0 = Math.max(0, Math.floor((x - MARGIN - this.bounds.x) / BUCKET));
    const r0 = Math.max(0, Math.floor((y - MARGIN - this.bounds.y) / BUCKET));
    const c1 = Math.min(this.cols - 1, Math.floor((x + w + MARGIN - this.bounds.x) / BUCKET));
    const r1 = Math.min(this.rows - 1, Math.floor((y + h + MARGIN * 2 - this.bounds.y) / BUCKET));
    const key = `${c0},${r0},${c1},${r1}`;
    if (key === this.viewKey) return;
    this.viewKey = key;
    this.visible.fill(0);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.visible[r * this.cols + c] = 1;
    this.everything = c0 === 0 && r0 === 0 && c1 === this.cols - 1 && r1 === this.rows - 1;
    this.listDirty = true;
  }

  /**
   * Stable, and quick on a nearly sorted list. (An insertion sort was, too, until a big building with a thousand
   * applicants walking round it: then it took 90% of the frame.)
   */
  private sortItems(): void {
    this.items.sort(byDepth);
  }

  /** Rebuild the uploaded list if anything moved, changed depth or the view changed. Call once per frame. */
  sync(force = false): void {
    if (this.orderDirty) {
      this.sortItems();
      this.orderDirty = false;
      this.listDirty = true;
    }
    if (!this.listDirty && !force) return;
    const out = this.container.particleChildren;
    out.length = 0;
    if (this.everything) {
      for (const it of this.items) out.push(it.p);
    } else {
      for (const it of this.items) if (this.visible[it.bucket]) out.push(it.p);
    }
    this.visibleCount = out.length;
    this.container.update();
    this.listDirty = false;
  }

  /** Texture or scale changed on a static layer: re-upload. Dynamic layers pick this up every frame. */
  touch(): void {
    this.listDirty = true;
  }

  get size(): number {
    return this.items.length;
  }
}

export function makeParticle(frame: { texture: Particle['texture']; anchorX: number; anchorY: number }, x: number, y: number, mirror = false, scale = 1): Particle {
  return new Particle({
    texture: frame.texture,
    x,
    y,
    anchorX: frame.anchorX,
    anchorY: frame.anchorY,
    scaleX: mirror ? -scale : scale,
    scaleY: scale,
  });
}
