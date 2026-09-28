// A hero-scale set: base-pixel art in one container scaled by a whole number, with a camera in base pixels.
// Sprites sit on whole base pixels; the camera may move by fractions of a base pixel (the whole picture slides
// together, so every pixel stays a square block).
import { Container, Sprite, type Texture } from 'pixi.js';
import { noise } from './timeline';

export interface View {
  w: number;
  h: number;
  tall: boolean;
}

export class HeroStage {
  readonly root = new Container();
  readonly world = new Container();
  S = 8;
  camX = 0;
  camY = 0;
  /** screen px */
  shakeAmp = 0;

  constructor(readonly view: View) {
    this.root.addChild(this.world);
  }

  /** Place the camera: centre on (x, y) at scale S. frame: for shake noise. */
  apply(frame: number): void {
    const sx = this.shakeAmp ? Math.round(noise(frame, 1) * this.shakeAmp) : 0;
    const sy = this.shakeAmp ? Math.round(noise(frame, 2) * this.shakeAmp) : 0;
    this.world.scale.set(this.S);
    this.world.position.set(Math.round(this.view.w / 2 - this.camX * this.S) + sx, Math.round(this.view.h / 2 - this.camY * this.S) + sy);
  }

  add<T extends Container>(c: T, parent: Container = this.world): T {
    parent.addChild(c);
    return c;
  }
}

/** Set a sprite at whole base pixels. */
export function at(s: Sprite, x: number, y: number): void {
  s.position.set(Math.round(x), Math.round(y));
}

/** Pick the frame of an animation playing from b0 at fps (frames per beat when perBeat). */
export function frameAt(frames: Texture[], b: number, b0: number, perBeat: number, loop = false): Texture {
  const i = Math.floor((b - b0) * perBeat);
  if (loop) return frames[((i % frames.length) + frames.length) % frames.length]!;
  return frames[Math.max(0, Math.min(frames.length - 1, i))]!;
}
