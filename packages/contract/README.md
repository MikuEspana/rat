# @rat/contract

The frontend contract (see `CONTRACT.md`). Browser safe: only depends on `zod`. Owned by WS02.

```ts
import { StateResponseSchema, type StateResponse, computeRatView, tierFor } from '@rat/contract';
import state from '@rat/contract/mock/state.json';
```

- `schemas.ts`: zod schemas for `/api/state`, `/api/rats`, `/api/events`, `/health` (strict: unknown fields are rejected)
- `types.ts`: TypeScript types inferred from the schemas
- `display.ts`: `computeRatView`, `rankRats`, `tierFor`, `sizeScaleFor`, `leaderboard`, `summarizePortfolio`, `summarizeStocks`
- `mock/`: `state.json`, `rats.json` (250 rats), `events.json`. Validated in CI and consistent with the display math.
