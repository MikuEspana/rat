// The launch simulator behind the same interface as the HTTP API client: the site polls it exactly like
// /api/state, /api/rats and /api/events, and gets the same response shapes (CONTRACT.md).
import type { EventsResponse, RatsResponse, StateResponse } from '@rat/contract';
import type { ApiLike } from '../data/api';
import type { LaunchSim } from './engine';

export class SimApi implements ApiLike {
  constructor(private readonly sim: LaunchSim) {}

  state(): Promise<StateResponse> {
    return Promise.resolve(this.sim.stateResponse());
  }

  rats(): Promise<RatsResponse> {
    return Promise.resolve(this.sim.ratsResponse());
  }

  events(afterId: number): Promise<EventsResponse> {
    return Promise.resolve(this.sim.eventsResponse(afterId, 500));
  }
}
