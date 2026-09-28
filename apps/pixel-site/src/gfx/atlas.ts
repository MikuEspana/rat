// One texture for everything that has to depth-sort together (rats, desks, walls, props), so a single
// ParticleContainer can draw them in one batch. rats.png, world.png and props2.png are copied into one canvas at
// load time; frame rects and anchors come from their JSON. world and props2 frames share the 'world:' prefix.
//
// ParticleContainer needs every particle to share one texture source, and particles do not read a texture's
// default anchor, so anchors are kept here and applied per particle. VERIFIED in
// https://github.com/pixijs/pixijs/blob/dev/src/scene/particle-container/shared/ParticleContainer.ts and Particle.ts
import { CanvasSource, Rectangle, Texture, type TextureSource } from 'pixi.js';
import ratsPng from '../../assets/rats.png?url';
import worldPng from '../../assets/world.png?url';
import props2Png from '../../assets/props2.png?url';
import ratsJson from '../../assets/rats.json';
import worldJson from '../../assets/world.json';
import props2Json from '../../assets/props2.json';

export interface Frame {
  texture: Texture;
  /** position in the atlas canvas */
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
  w: number;
  h: number;
}

interface AtlasJson {
  frames: Record<string, { frame: { x: number; y: number; w: number; h: number }; anchor?: { x: number; y: number } }>;
  animations?: Record<string, string[]>;
}

export interface Atlas {
  source: TextureSource;
  /** the combined atlas image (floor patterns are cut from it) */
  canvas: HTMLCanvasElement;
  frame(name: string): Frame;
  anim(name: string): Frame[];
  has(name: string): boolean;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image ${url}`));
    img.src = url;
  });
}

export async function loadAtlas(): Promise<Atlas> {
  const [rats, world, props2] = await Promise.all([loadImage(ratsPng), loadImage(worldPng), loadImage(props2Png)]);
  const canvas = document.createElement('canvas');
  const worldX = rats.width + 2;
  const props2Y = world.height + 2;
  canvas.width = worldX + Math.max(world.width, props2.width);
  canvas.height = Math.max(rats.height, props2Y + props2.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d canvas unavailable');
  ctx.drawImage(rats, 0, 0);
  ctx.drawImage(world, worldX, 0);
  ctx.drawImage(props2, worldX, props2Y);
  const source = new CanvasSource({ resource: canvas, scaleMode: 'nearest', autoGenerateMipmaps: false });

  const frames = new Map<string, Frame>();
  const add = (json: AtlasJson, ox: number, oy: number, prefix: string): void => {
    for (const [name, f] of Object.entries(json.frames)) {
      const r = f.frame;
      frames.set(prefix + name, {
        texture: new Texture({ source, frame: new Rectangle(ox + r.x, oy + r.y, r.w, r.h) }),
        x: ox + r.x,
        y: oy + r.y,
        anchorX: f.anchor?.x ?? 0.5,
        anchorY: f.anchor?.y ?? 1,
        w: r.w,
        h: r.h,
      });
    }
  };
  add(ratsJson as AtlasJson, 0, 0, 'rat:');
  add(worldJson as AtlasJson, worldX, 0, 'world:');
  add(props2Json as AtlasJson, worldX, props2Y, 'world:');
  const anims = new Map<string, Frame[]>();
  for (const [name, list] of Object.entries((ratsJson as AtlasJson).animations ?? {})) {
    anims.set(name, list.map((k) => frames.get('rat:' + k)!));
  }
  return {
    source,
    canvas,
    frame(name: string): Frame {
      const f = frames.get(name);
      if (!f) throw new Error(`no frame ${name}`);
      return f;
    },
    anim(name: string): Frame[] {
      const a = anims.get(name);
      if (!a) throw new Error(`no animation ${name}`);
      return a;
    },
    has(name: string): boolean {
      return frames.has(name);
    },
  };
}
