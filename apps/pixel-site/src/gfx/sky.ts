// The night behind the building: a dark gradient with a scatter of stars, redrawn at screen size on resize.
import { Sprite, Texture } from 'pixi.js';

export class Sky {
  readonly sprite = new Sprite(Texture.EMPTY);
  private tex: Texture | null = null;

  resize(w: number, h: number): void {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w / 2));
    c.height = Math.max(1, Math.ceil(h / 2));
    const ctx = c.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 0, c.height);
    g.addColorStop(0, '#03050c');
    g.addColorStop(0.55, '#0a1124');
    g.addColorStop(1, '#151d3a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    // stars: fixed pseudo-random field, denser and brighter near the top
    let s = 1234567;
    const rnd = (): number => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const n = Math.round((c.width * c.height) / 380);
    for (let k = 0; k < n; k++) {
      const x = Math.floor(rnd() * c.width);
      const y = Math.floor(rnd() ** 1.6 * c.height);
      const a = 0.25 + rnd() * 0.6 * (1 - y / c.height);
      ctx.fillStyle = rnd() < 0.15 ? `rgba(255,214,150,${a})` : `rgba(200,220,255,${a})`;
      ctx.fillRect(x, y, 1, 1);
    }
    const old = this.tex;
    this.tex = Texture.from(c);
    this.tex.source.scaleMode = 'nearest';
    this.sprite.texture = this.tex;
    this.sprite.width = w;
    this.sprite.height = h;
    if (old) old.destroy(true);
  }
}
