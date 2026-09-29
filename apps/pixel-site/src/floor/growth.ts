// The idle game: which rooms of the master plan stand, and which desk each rat has. Deterministic: rats are
// replayed in id order, so a page load and a live session that grew hire by hire end in the same building.
//
// - The stage follows the SOL claimed (plan.ts STAGES, given to setSol from stage-source.ts), so the building keeps
//   up with the fees. A new stage builds its ring corridor and lobby. A stage never closes.
// - Everything else goes by hires. Amenities open at their set rat count, once their ring is open.
// - Desks on demand: a rat takes a free desk in its stock's rooms; when there is none, the next desk-room slot is
//   built and handed to that stock. Until the full floor's planned hire count (STAGES[2].rats), or while the full
//   floor is not open yet, everyone shares the garage and open offices.
// - No desk left: the rat waits (in the job-fair line outside, rats.ts) and is seated as soon as a room is built
//   for it, usually when the next stage opens its ring. Once the last ring is full, the line only grows.
import { ROOM_LOOK, STAGES, stageOfSol } from './plan';
import { CORRIDOR_REGION, T, idx, type FloorLayout, type Room, type Seat } from './types';
import { hash32 } from './rng';

export type GrowthEvent = { kind: 'stage'; stage: number } | { kind: 'room'; room: Room; symbol: string | null };

/** From this many hires on (and with the full floor open), stocks get desk rooms of their own. */
const STOCK_ROOMS_FROM = STAGES[2]!.rats;

export class Growth {
  readonly built: Uint8Array;
  readonly symbolOf: Array<string | null>;
  /** seat id -> rat id (home desks) */
  readonly owner: Int32Array;
  readonly seatOfRat = new Map<number, number>();
  stage = -1;
  /** rats hired */
  count = 0;
  /** SOL claimed (what the stage goes by, from stage-source.ts); only ever goes up */
  sol = 0;
  private readonly roomsOf = new Map<string, Room[]>();
  private readonly order: number[][]; // per room: seat ids in fill order
  private readonly next: Int32Array; // per room: fill pointer
  private readonly amenities: Room[];
  private amenityAt = 0;
  private events: GrowthEvent[] = [];
  /** rats that found no desk, seated as soon as a room for them is built */
  private waiting: Array<{ id: number; stock: string }> = [];
  private lastSeat = -1;
  /** rats seated late (their desk changed after they were added) */
  readonly moved: number[] = [];

  constructor(readonly plan: FloorLayout) {
    const n = plan.rooms.length;
    this.built = new Uint8Array(n);
    this.symbolOf = new Array<string | null>(n).fill(null);
    this.owner = new Int32Array(plan.seats.length).fill(-1);
    this.next = new Int32Array(n);
    this.order = plan.rooms.map((r) => r.seats.map((s) => s.id).sort((a, b) => hash32(`${r.id}:${a}`) - hash32(`${r.id}:${b}`)));
    this.amenities = plan.rooms.filter((r) => r.unlockAt !== null).sort((a, b) => a.unlockAt! - b.unlockAt! || a.id - b.id);
    this.startStage(0);
    this.events = [];
  }

  /** rats with no desk yet (they stand in the job-fair line outside) */
  get waitingCount(): number {
    return this.waiting.length;
  }

  /**
   * SOL claimed (stage-source.ts): opens every stage it reaches, with the amenities and desks the hires so far are
   * owed in the rings it opens. A stage never closes (a lower value changes nothing). Returns what got built.
   */
  setSol(sol: number): GrowthEvent[] {
    if (Number.isFinite(sol)) this.sol = Math.max(this.sol, sol);
    this.events = [];
    const target = stageOfSol(this.sol);
    if (target > this.stage) {
      while (this.stage < target) this.startStage(this.stage + 1);
      this.openAmenities();
      this.seatWaiting(null);
    }
    const events = this.events;
    this.events = [];
    return events;
  }

  /** Stocks get desk rooms of their own (before that, everyone shares the garage and the open offices). */
  private get stockRooms(): boolean {
    return this.stage >= 2 && this.count >= STOCK_ROOMS_FROM;
  }

  /** Amenities whose hire count is reached, in rings that are open. */
  private openAmenities(): void {
    while (this.amenityAt < this.amenities.length) {
      const r = this.amenities[this.amenityAt]!;
      if (r.unlockAt! > this.count || r.ring > this.stage) break;
      this.build(r);
      this.amenityAt++;
    }
  }

  get stageName(): string {
    return STAGES[this.stage]!.name;
  }

  /** The three bars on the HUD: the desk room filling up now, the next room to unlock, the next stage. */
  progress(): {
    desk: { filled: number; total: number; label: string } | null;
    room: { from: number; at: number; label: string } | null;
    stage: { from: number; at: number; label: string } | null;
  } {
    const lastSeat = this.lastSeat >= 0 ? this.plan.seats[this.lastSeat] : undefined;
    let desk = null;
    if (lastSeat) {
      const r = this.plan.rooms[lastSeat.room]!;
      const filled = r.seats.filter((x) => this.owner[x.id]! >= 0).length;
      const what = this.symbolOf[r.id] ? `${this.symbolOf[r.id]} DESKS` : r.kind === 'garage' ? 'GARAGE DESKS' : 'DESKS';
      desk = { filled, total: r.seats.length, label: what };
    }
    const next = this.amenities[this.amenityAt];
    const prev = this.amenities[this.amenityAt - 1];
    const room = next && next.ring <= this.stage + 1
      ? { from: prev?.unlockAt ?? 0, at: next.unlockAt!, label: ROOM_LOOK[next.kind].label }
      : null;
    // the stage bar counts SOL claimed
    const ns = STAGES[this.stage + 1];
    const stage = ns ? { from: STAGES[this.stage]!.sol, at: ns.sol, label: ns.name } : null;
    return { desk, room, stage };
  }

  isBuilt(room: Room): boolean {
    return this.built[room.id] === 1;
  }

  private build(room: Room, symbol: string | null = null): void {
    if (this.built[room.id]) return;
    if (room.parent >= 0) this.build(this.plan.rooms[room.parent]!);
    this.built[room.id] = 1;
    if (symbol) this.assign(room, symbol);
    this.events.push({ kind: 'room', room, symbol });
  }

  private assign(room: Room, symbol: string): void {
    this.symbolOf[room.id] = symbol;
    const l = this.roomsOf.get(symbol) ?? [];
    l.push(room);
    this.roomsOf.set(symbol, l);
  }

  private startStage(k: number): void {
    this.stage = k;
    this.events.push({ kind: 'stage', stage: k });
    const ring = this.plan.rings[k];
    if (ring) this.build(this.plan.rooms[ring.lobby]!);
  }

  private take(room: Room, ratId: number): Seat | null {
    const order = this.order[room.id]!;
    for (let p = this.next[room.id]!; p < order.length; p++) {
      const id = order[p]!;
      if (this.owner[id] === -1) {
        this.owner[id] = ratId;
        this.next[room.id] = p + 1;
        this.seatOfRat.set(ratId, id);
        this.lastSeat = id;
        return this.plan.seats[id]!;
      }
    }
    this.next[room.id] = order.length;
    return null;
  }

  private sharedRooms(): Room[] {
    return this.plan.rooms.filter((r) => (r.kind === 'garage' || r.kind === 'open') && this.built[r.id]);
  }

  /** The next desk-room slot of a kind, in build order, rings up to the current stage. */
  private nextSlot(kind: 'open' | 'stock'): Room | null {
    let best: Room | null = null;
    for (const r of this.plan.rooms) {
      if (r.kind !== kind || r.ring > this.stage) continue;
      if (this.built[r.id] && (kind === 'open' || this.symbolOf[r.id] !== null)) continue;
      if (!best || r.ring < best.ring || (r.ring === best.ring && r.order < best.order)) best = r;
    }
    return best;
  }

  /** One more rat: grow if needed, give it a desk. Returns its desk and what got built. */
  add(ratId: number, stock: string): { seat: Seat | null; events: GrowthEvent[] } {
    this.events = [];
    this.count++;
    this.openAmenities();
    let seat: Seat | null = null;
    for (const r of this.roomsOf.get(stock) ?? []) if ((seat = this.take(r, ratId))) break;
    if (!seat && !this.stockRooms) {
      for (const r of this.sharedRooms()) if ((seat = this.take(r, ratId))) break;
      const slot = seat ? null : this.nextSlot('open');
      if (slot) {
        this.build(slot);
        seat = this.take(slot, ratId);
      }
    }
    if (!seat && this.stockRooms) {
      const slot = this.nextSlot('stock');
      if (slot) {
        if (this.built[slot.id]) this.assign(slot, stock);
        else this.build(slot, stock);
        seat = this.take(slot, ratId);
      }
    }
    if (!seat) for (const r of this.sharedRooms()) if ((seat = this.take(r, ratId))) break;
    if (!seat) this.waiting.push({ id: ratId, stock });
    this.seatWaiting(ratId);
    const events = this.events;
    this.events = [];
    return { seat, events };
  }

  /** Anyone still waiting gets a desk in a room that was just built for their stock (or a shared one). */
  private seatWaiting(newRat: number | null): void {
    if (!this.waiting.length || !this.events.some((e) => e.kind === 'room')) return;
    this.waiting = this.waiting.filter((w) => {
      let s: Seat | null = null;
      for (const r of this.roomsOf.get(w.stock) ?? []) if ((s = this.take(r, w.id))) break;
      if (!s && this.stockRooms) {
        const slot = this.nextSlot('stock');
        if (slot) {
          if (this.built[slot.id]) this.assign(slot, w.stock);
          else this.build(slot, w.stock);
          s = this.take(slot, w.id);
        }
      }
      if (!s) for (const r of this.sharedRooms()) if ((s = this.take(r, w.id))) break;
      if (s && w.id !== newRat) this.moved.push(w.id);
      return !s;
    });
  }

  /** Cells rats cannot walk on right now: the plan's walls and furniture plus everything not built yet. */
  blocked(): Uint8Array {
    const L = this.plan;
    const out = new Uint8Array(L.W * L.H);
    const ring = L.rings[this.stage]!;
    const m = 7;
    const open = (x: number): boolean => x === -2 || (x >= CORRIDOR_REGION ? x - CORRIDOR_REGION <= this.stage : this.built[x] === 1);
    for (let j = 0; j < L.H; j++) {
      for (let i = 0; i < L.W; i++) {
        const k = idx(L.W, i, j);
        const r = L.ringOf[k]!;
        if (r > this.stage) {
          const street = i >= ring.i0 - m && i <= ring.i1 + m && j >= ring.j0 - m && j <= ring.j1 + m;
          out[k] = street ? 0 : 1;
          continue;
        }
        const t = L.tile[k];
        if (t === T.ROOM) out[k] = this.built[L.roomOf[k]!] ? L.blocked[k]! : 1;
        else if (t === T.CORRIDOR) out[k] = L.blocked[k]!;
        else if (t === T.DOOR) {
          const s = L.doorSides.get(k);
          out[k] = s && open(s[0]) && open(s[1]) ? 0 : 1;
        } else out[k] = 1;
      }
    }
    return out;
  }
}
