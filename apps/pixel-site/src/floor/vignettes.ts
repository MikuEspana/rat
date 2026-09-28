// Hand-made vignettes: small authored scenes, each with a tiny story, dropped whole into rooms. The procedural side
// only picks a template that fits the room and finds a free spot for it; it never invents the layout.
// Extras (the rats in a scene) are not on the roster: they are set dressing, posed and animated in place.
// Plus the rare props: one easter egg per ring, somewhere in that ring.
import type { Fit } from './furnish';
import type { Actor, RoomKind } from './types';

interface Item {
  kind: string;
  u: number;
  v: number;
  mirror?: boolean;
  scale?: number;
  dx?: number;
  dy?: number;
  /** stands on something else (no footprint of its own) */
  on?: boolean;
  flat?: boolean;
}

interface Extra {
  anim: string;
  u: number;
  v: number;
  mirror?: boolean;
  dx?: number;
  dy?: number;
  tier?: string;
  tears?: boolean;
  zzz?: boolean;
}

export interface Vignette {
  id: string;
  story: string;
  rooms: RoomKind[];
  w: number;
  h: number;
  items: Item[];
  extras: Extra[];
}

export const VIGNETTES: Vignette[] = [
  {
    id: 'copier_nap', story: 'A rat fell asleep on the copier', rooms: ['copy'], w: 3, h: 3,
    items: [{ kind: 'copier', u: 1, v: 1 }, { kind: 'paper_stack', u: 2, v: 2, flat: true }],
    extras: [{ anim: 'slump', u: 1, v: 1, dy: -26, dx: -6, zzz: true }],
  },
  {
    id: 'paper_jam', story: 'Paper jam, again', rooms: ['copy', 'storage'], w: 3, h: 3,
    items: [{ kind: 'copier_jam', u: 1, v: 0 }, { kind: 'papers', u: 0, v: 2, flat: true }, { kind: 'paper_stack', u: 2, v: 1 }],
    extras: [{ anim: 'idle_ne', u: 1, v: 2, mirror: true }],
  },
  {
    id: 'fax_smoke', story: 'The fax machine is smoking', rooms: ['copy', 'storage'], w: 3, h: 2,
    items: [{ kind: 'fax_smoke', u: 0, v: 0 }, { kind: 'extinguisher', u: 2, v: 0 }],
    extras: [{ anim: 'cheer', u: 1, v: 1 }],
  },
  {
    id: 'server_fire', story: 'Server room on fire, one rat with an extinguisher', rooms: ['server'], w: 3, h: 3,
    items: [{ kind: 'rack_fire', u: 0, v: 0, scale: 0.8 }, { kind: 'wet_floor', u: 2, v: 2 }, { kind: 'extinguisher', u: 2, v: 0 }],
    extras: [{ anim: 'cheer', u: 1, v: 1, mirror: true }, { anim: 'walk_se', u: 1, v: 2 }],
  },
  {
    id: 'wc_crying', story: 'Someone is crying in the WC (their stock is down 90%)', rooms: ['bath'], w: 2, h: 2,
    items: [{ kind: 'toilet', u: 0, v: 0 }],
    extras: [{ anim: 'sulk_front', u: 1, v: 1, tears: true }],
  },
  {
    id: 'red_chart', story: 'Quarterly review: the chart only goes down', rooms: ['meeting', 'war'], w: 4, h: 4,
    items: [{ kind: 'chart_crash', u: 0, v: 0 }, { kind: 'round_table', u: 2, v: 2 }, { kind: 'water_jug', u: 3, v: 0 }],
    extras: [{ anim: 'idle_se', u: 1, v: 0 }, { anim: 'sulk_back', u: 2, v: 3, mirror: true }, { anim: 'sulk_back', u: 3, v: 3 }, { anim: 'sulk_front', u: 1, v: 1 }],
  },
  {
    id: 'meeting_nap', story: 'Hour three of the all-hands', rooms: ['meeting'], w: 4, h: 3,
    items: [{ kind: 'projector', u: 2, v: 1 }, { kind: 'chart_up', u: 0, v: 0 }],
    extras: [{ anim: 'slump', u: 3, v: 2, zzz: true }, { anim: 'slump', u: 1, v: 2, mirror: true, zzz: true }, { anim: 'idle_se', u: 1, v: 0 }],
  },
  {
    id: 'ceo_cash', story: 'The CEO counting cash', rooms: ['ceo', 'vault'], w: 4, h: 3,
    items: [{ kind: 'money_counter', u: 0, v: 0 }, { kind: 'cash_pile', u: 2, v: 0 }, { kind: 'gold_bars', u: 3, v: 2 }],
    extras: [{ anim: 'idle_ne', u: 1, v: 1, tier: 'partner' }],
  },
  {
    id: 'donut_fight', story: 'Two rats, one donut left', rooms: ['break'], w: 3, h: 3,
    items: [{ kind: 'round_table', u: 1, v: 1 }, { kind: 'donut_box', u: 1, v: 1, on: true, dy: -14, dx: -4 }],
    extras: [{ anim: 'idle_ne', u: 1, v: 2, mirror: true }, { anim: 'idle_se', u: 0, v: 0 }, { anim: 'cheer', u: 2, v: 0 }],
  },
  {
    id: 'birthday', story: 'Office birthday, nobody knows whose', rooms: ['break', 'meeting'], w: 4, h: 3,
    items: [{ kind: 'round_table', u: 1, v: 1 }, { kind: 'cake', u: 1, v: 1, on: true, dy: -14, dx: -4 }, { kind: 'balloons', u: 3, v: 0 }],
    extras: [{ anim: 'cheer', u: 0, v: 2 }, { anim: 'cheer', u: 2, v: 2, mirror: true }, { anim: 'idle_ne', u: 3, v: 2 }],
  },
  {
    id: 'pizza_night', story: 'Crunch week pizza', rooms: ['break', 'storage', 'copy'], w: 3, h: 2,
    items: [{ kind: 'pizza_boxes', u: 0, v: 0 }, { kind: 'bin', u: 2, v: 0 }],
    extras: [{ anim: 'idle_se', u: 1, v: 1 }, { anim: 'idle_ne', u: 2, v: 1, mirror: true }],
  },
  {
    id: 'arcade', story: 'Research break at the arcade', rooms: ['break', 'lobby'], w: 3, h: 3,
    items: [{ kind: 'arcade', u: 0, v: 0 }, { kind: 'beanbag', u: 2, v: 2 }],
    extras: [{ anim: 'idle_ne', u: 1, v: 1, mirror: true }],
  },
  {
    id: 'ping_pong', story: 'Ping pong during market hours', rooms: ['break'], w: 5, h: 3,
    items: [{ kind: 'ping_pong', u: 2, v: 1 }],
    extras: [{ anim: 'cheer', u: 0, v: 1 }, { anim: 'idle_ne', u: 4, v: 1, mirror: true }],
  },
  {
    id: 'foosball', story: 'Foosball grudge match', rooms: ['break', 'lobby'], w: 4, h: 3,
    items: [{ kind: 'foosball', u: 1, v: 1 }],
    extras: [{ anim: 'idle_se', u: 0, v: 0 }, { anim: 'idle_ne', u: 2, v: 2, mirror: true }, { anim: 'cheer', u: 3, v: 0 }],
  },
  {
    id: 'aquarium', story: 'Staring at the fish instead of the charts', rooms: ['lobby', 'ceo'], w: 3, h: 3,
    items: [{ kind: 'aquarium', u: 0, v: 0 }, { kind: 'plant', u: 2, v: 0 }],
    extras: [{ anim: 'idle_ne', u: 0, v: 2 }],
  },
  {
    id: 'hoard', story: 'The vault is full (for now)', rooms: ['vault'], w: 4, h: 3,
    items: [{ kind: 'gold_bars', u: 0, v: 0 }, { kind: 'coin_stack', u: 2, v: 0 }, { kind: 'treasure', u: 3, v: 2 }, { kind: 'cash_pile', u: 1, v: 2 }],
    extras: [{ anim: 'cheer', u: 2, v: 1 }],
  },
  {
    id: 'evil_throne', story: 'The boss on the throne, finger near the red button', rooms: ['war'], w: 5, h: 4,
    items: [{ kind: 'throne', u: 2, v: 0 }, { kind: 'red_button', u: 3, v: 1 }, { kind: 'shark_tank', u: 0, v: 2 }, { kind: 'skull_flag', u: 4, v: 0 }],
    extras: [{ anim: 'idle_se', u: 2, v: 0, tier: 'partner', dy: -6 }, { anim: 'idle_ne', u: 3, v: 3, mirror: true }],
  },
  {
    id: 'wet_floor', story: 'Coffee spill, nobody cleans it', rooms: ['break', 'bath', 'lobby'], w: 2, h: 2,
    items: [{ kind: 'wet_floor', u: 0, v: 0 }, { kind: 'spill', u: 1, v: 1, flat: true }],
    extras: [{ anim: 'idle_se', u: 1, v: 0 }],
  },
];

/** Rare props: one per ring, somewhere in it. */
export const EASTER_EGGS = ['disco_ball', 'phone_booth', 'ufo', 'rubber_duck', 'treasure', 'rat_statue'];

const TIERS = ['intern', 'analyst', 'associate', 'vp', 'intern', 'analyst'];
const FURS = ['', '', '.brown', '.white', '.black'];

/** Try to put one vignette (of the ones that fit this room) into the room. Returns its id or null. */
export function placeVignette(f: Fit, used: Set<string>, actors: Actor[]): string | null {
  const r = f.r;
  const fits = VIGNETTES.filter((v) => v.rooms.includes(r.kind) && v.w + 2 <= r.w && v.h + 2 <= r.h);
  if (!fits.length) return null;
  const fresh = fits.filter((v) => !used.has(v.id));
  const pool = f.rng.shuffle(fresh.length ? fresh : fits);
  for (const v of pool) {
    const spots: Array<[number, number]> = [];
    for (let u = 1; u + v.w <= r.w - 1; u++) for (let w = 1; w + v.h <= r.h - 1; w++) spots.push([u, w]);
    for (const [u0, v0] of f.rng.shuffle(spots).slice(0, 40)) {
      const i0 = r.i0 + u0;
      const j0 = r.j0 + v0;
      let clear = true;
      for (let a = -1; a <= v.w && clear; a++) for (let b = -1; b <= v.h && clear; b++) if (!f.free(i0 + a, j0 + b)) clear = false;
      if (!clear) continue;
      const placed = f.scene(
        v.items.map((it) => ({ ...it, i: i0 + it.u, j: j0 + it.v })),
        v.extras.map((x) => ({ i: i0 + x.u, j: j0 + x.v })),
      );
      if (!placed) continue;
      for (const x of v.extras) {
        const tier = x.tier ?? f.rng.pick(TIERS);
        actors.push({
          room: r.id, look: `${tier}${tier === 'partner' ? '' : f.rng.pick(FURS)}`, anim: x.anim, mirror: !!x.mirror,
          i: i0 + x.u, j: j0 + x.v, dx: x.dx ?? 0, dy: x.dy ?? 0, tears: !!x.tears, zzz: !!x.zzz, story: v.story,
        });
      }
      used.add(v.id);
      return v.id;
    }
  }
  return null;
}
