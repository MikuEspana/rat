// Public API client (CONTRACT.md, schemaVersion 1). Unknown fields are ignored on purpose: the contract may add
// optional fields without a version bump, so responses are not parsed strictly.
import type { EventsResponse, RatsResponse, StateResponse } from '@rat/contract';

export const SCHEMA_VERSION = 1;

export class ApiError extends Error {}

export class Api {
  constructor(readonly base: string) {}

  private async get<T extends { schemaVersion: number }>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { cache: 'no-store' });
    if (!res.ok) throw new ApiError(`${path}: HTTP ${res.status}`);
    const body = (await res.json()) as T;
    if (body.schemaVersion !== SCHEMA_VERSION) throw new ApiError(`${path}: schemaVersion ${body.schemaVersion}`);
    return body;
  }

  state(): Promise<StateResponse> {
    return this.get<StateResponse>('/api/state');
  }

  /** The full roster. Large (about 1.7 MB at 3,000 rats): the site loads it once per page view. */
  rats(): Promise<RatsResponse> {
    return this.get<RatsResponse>('/api/rats');
  }

  events(afterId: number): Promise<EventsResponse> {
    return this.get<EventsResponse>(`/api/events?afterId=${afterId}&limit=500`);
  }
}
