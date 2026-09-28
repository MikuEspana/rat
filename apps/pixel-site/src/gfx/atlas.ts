// One texture for everything that has to depth-sort together (rats, desks, walls, props), so a single
// ParticleContainer can draw them in one batch. rats2.png (every tier x fur, trimmed, plus accessory overlays),
// world.png and props2.png are copied into one canvas at
// load time; frame rects and anchors come from their JSON. world, props2 and gen (code-drawn: floors, walls) frames
// share the 'world:' prefix. A few sprites are drawn in code into a strip below them (world:vault, world:bill), so
// they batch with the rest.
//
// ParticleContainer needs every particle to share one texture source, and particles do not read a texture's
// default anchor, so anchors are kept here and applied per particle. VERIFIED in
// https://github.com/pixijs/pixijs/blob/dev/src/scene/particle-container/shared/ParticleContainer.ts and Particle.ts
import { CanvasSource, Rectangle, Texture, type TextureSource } from 'pixi.js';
import ratsPng from '../../assets/rats2.png?url';
import worldPng from '../../assets/world.png?url';
import props2Png from '../../assets/props2.png?url';
import genPng from '../../assets/gen.png?url';
import props3Png from '../../assets/props3.png?url';
import ratsJson from '../../assets/rats2.json';
import worldJson from '../../assets/world.json';
import props2Json from '../../assets/props2.json';
import genJson from '../../assets/gen.json';
import props3Json from '../../assets/props3.json';

/** Rat accessories drawn as an overlay frame per pose (tools/build_rats2.py). */
export const ACCESSORIES = ['glasses', 'phones_red', 'phones_white', 'hat_bowler', 'hat_cap', 'hat_beanie', 'tie_stripes'] as const;
export type Accessory = (typeof ACCESSORIES)[number];

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

const VAULT_W = 64;
const VAULT_H = 74;
const BILL_W = 12;
const BILL_H = 7;
const DRAWN_H = VAULT_H + 2;

/**
 * The Vault: an isometric safe on a 2x2 cell footprint (64 x 32 px diamond), where the rats' money goes. Steel
 * faces with gold trim, a round door with a dial on the right face, bolts and a $ on the left.
 */
function drawVault(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
  const H = 42; // wall height
  const top = { t: [32, 0], r: [64, 16], b: [32, 32], l: [0, 16] } as const;
  const poly = (pts: ReadonlyArray<readonly [number, number]>, fill: string): void => {
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(ox + x, oy + y) : ctx.lineTo(ox + x, oy + y)));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  ctx.save();
  // left and right faces, then the lid
  poly([top.l, top.b, [32, 32 + H], [0, 16 + H]], '#5b6377');
  poly([top.b, top.r, [64, 16 + H], [32, 32 + H]], '#7a8398');
  poly([top.t, top.r, top.b, top.l], '#aab3c6');
  poly([[32, 4], [56, 16], [32, 28], [8, 16]], '#c2cadb');
  // gold trim along the edges
  ctx.strokeStyle = '#f0c040';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ox + 0, oy + 16);
  ctx.lineTo(ox + 32, oy + 32);
  ctx.lineTo(ox + 64, oy + 16);
  ctx.moveTo(ox + 32, oy + 32);
  ctx.lineTo(ox + 32, oy + 32 + H);
  ctx.moveTo(ox + 1, oy + 16 + H - 1);
  ctx.lineTo(ox + 32, oy + 32 + H - 1);
  ctx.lineTo(ox + 63, oy + 16 + H - 1);
  ctx.stroke();
  // right face: the round door, drawn in the face's own (sheared) plane
  ctx.setTransform(1, -0.5, 0, 1, ox + 32, oy + 32);
  ctx.fillStyle = '#c9a227';
  ctx.beginPath();
  ctx.arc(16, 20, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3a3f4f';
  ctx.beginPath();
  ctx.arc(16, 20, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#f0c040';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const a = (k * Math.PI) / 3;
    ctx.moveTo(16 - Math.cos(a) * 7, 20 - Math.sin(a) * 7);
    ctx.lineTo(16 + Math.cos(a) * 7, 20 + Math.sin(a) * 7);
  }
  ctx.stroke();
  ctx.fillStyle = '#ffe08a';
  ctx.fillRect(15, 19, 3, 3);
  // left face: bolts and a $
  ctx.setTransform(1, 0.5, 0, 1, ox, oy + 16);
  ctx.fillStyle = '#9aa3b8';
  for (const [x, y] of [[4, 6], [28, 6], [4, 36], [28, 36]] as const) ctx.fillRect(x, y, 3, 3);
  ctx.fillStyle = '#f0c040';
  ctx.font = 'bold 20px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('$', 16, 22);
  ctx.restore();
}

/** A dollar bill (12 x 7), for money flying into the Vault. */
function drawBill(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
  ctx.fillStyle = '#1f6b34';
  ctx.fillRect(ox, oy, BILL_W, BILL_H);
  ctx.fillStyle = '#57c26a';
  ctx.fillRect(ox + 1, oy + 1, BILL_W - 2, BILL_H - 2);
  ctx.fillStyle = '#2d8a45';
  ctx.fillRect(ox + 4, oy + 2, 4, 3);
  ctx.fillStyle = '#d8f5c8';
  ctx.fillRect(ox + 5, oy + 3, 2, 1);
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
  const [rats, world, props2, gen, props3] = await Promise.all([
    loadImage(ratsPng), loadImage(worldPng), loadImage(props2Png), loadImage(genPng), loadImage(props3Png),
  ]);
  const canvas = document.createElement('canvas');
  const worldX = rats.width + 2;
  const props2Y = world.height + 2;
  const genY = props2Y + props2.height + 2;
  const props3Y = genY + gen.height + 2;
  canvas.width = Math.max(worldX + Math.max(world.width, props2.width, gen.width, props3.width), VAULT_W + BILL_W + 4);
  const drawnY = Math.max(rats.height, props3Y + props3.height) + 2;
  canvas.height = drawnY + DRAWN_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d canvas unavailable');
  ctx.drawImage(rats, 0, 0);
  ctx.drawImage(world, worldX, 0);
  ctx.drawImage(props2, worldX, props2Y);
  ctx.drawImage(gen, worldX, genY);
  ctx.drawImage(props3, worldX, props3Y);
  drawVault(ctx, 0, drawnY);
  drawBill(ctx, VAULT_W + 2, drawnY);
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
  add(genJson as AtlasJson, worldX, genY, 'world:');
  add(props3Json as AtlasJson, worldX, props3Y, 'world:');
  add(
    {
      frames: {
        vault: { frame: { x: 0, y: 0, w: VAULT_W, h: VAULT_H } },
        bill: { frame: { x: VAULT_W + 2, y: 0, w: BILL_W, h: BILL_H }, anchor: { x: 0.5, y: 0.5 } },
      },
    },
    0,
    drawnY,
    'world:',
  );
  const anims = new Map<string, Frame[]>();
  for (const [name, list] of Object.entries((ratsJson as AtlasJson).animations ?? {})) {
    anims.set(name, list.map((k) => frames.get('rat:' + k)!));
    // accessory overlays follow the same poses: acc/<kind>/<anim>, frame for frame
    if (name.startsWith('analyst/')) {
      const anim = name.slice('analyst/'.length);
      for (const acc of [...ACCESSORIES, 'hat_hard']) anims.set(`acc/${acc}/${anim}`, list.map((k) => frames.get(`rat:acc/${acc}/${k.slice('analyst/'.length)}`)!));
    }
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
