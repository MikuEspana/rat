import type { z } from 'zod';
import type {
  BotModeSchema,
  ClaimEventSchema,
  EventSchema,
  EventsResponseSchema,
  FreezeEventSchema,
  HealthResponseSchema,
  HireEventSchema,
  PortfolioSchema,
  RatViewSchema,
  RatsResponseSchema,
  StateResponseSchema,
  StockViewSchema,
  TierSchema,
  UnfreezeEventSchema,
} from './schemas';

export type Tier = z.infer<typeof TierSchema>;
export type BotMode = z.infer<typeof BotModeSchema>;
export type RatView = z.infer<typeof RatViewSchema>;
export type StockView = z.infer<typeof StockViewSchema>;
export type Portfolio = z.infer<typeof PortfolioSchema>;
export type RatEvent = z.infer<typeof EventSchema>;
export type ClaimEvent = z.infer<typeof ClaimEventSchema>;
export type HireEvent = z.infer<typeof HireEventSchema>;
export type FreezeEvent = z.infer<typeof FreezeEventSchema>;
export type UnfreezeEvent = z.infer<typeof UnfreezeEventSchema>;
export type StateResponse = z.infer<typeof StateResponseSchema>;
export type RatsResponse = z.infer<typeof RatsResponseSchema>;
export type EventsResponse = z.infer<typeof EventsResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
