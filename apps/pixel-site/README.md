# RAT RACE pixel site

An isometric pixel-art office floor you pan around and click into. Creator fees hire rats; each rat walks in from the subway, sits at a desk in its stock's room and types. Cheers when the stock is up, slumps when it is down, goes grey when frozen, and wears a better suit as it climbs tiers. Burns send cash bags flying into the HQ furnace.

## Run it

```sh
pnpm install
pnpm mock:api                                   # terminal 1: live-changing mock API on http://localhost:8787
pnpm --filter @rat/pixel-site dev               # terminal 2: http://localhost:5173
```

Point it at another API with `VITE_API_BASE` (build time) or `?api=<url>` (page URL):

```sh
VITE_API_BASE=https://api.example.com pnpm --filter @rat/pixel-site build   # static files in apps/pixel-site/dist
```

Controls: drag to pan, mouse wheel or pinch to zoom.

Debug URL flags: `?perf=1` (fps, simulation ms, frame CPU ms, particle counts), `?stress=3000` (pad the roster to 3,000 rats), `?walkers=20` (20 extra synthetic hires every 10 s).

## Data

Follows [CONTRACT.md](../../CONTRACT.md) and the owner's rule for the 1.7 MB roster:

- `/api/rats` is fetched **once** on page open.
- `/api/state` every 5 s: stocks, prices, bot. Every rat's PnL and tier are recomputed in the browser with `@rat/contract` (`computeRatView`), so the roster never needs a re-poll.
- `/api/events?afterId=` every 5 s: `hire` spawns a walker (its value is estimated from cost and today's price, exact again after a reload), `freeze`/`unfreeze` greys rats, `burn` fires the furnace.
- Responses are checked for `schemaVersion: 1`; unknown fields are ignored (the contract may add optional fields).

## How it is built

| File | What |
|---|---|
| `src/layout.ts` | The floor plan from the stock list: a grid of equal slots, HQ in the middle, subway in the front corner, one room per stock sized for its rats plus headroom, corridors between. Seats, decor and the walking route (stairs, subway junction, two corridor legs, the room's aisle, the seat). Pure and tested. |
| `src/world/build.ts` | Tiles, walls, desks, chairs, decor, stairs, furnace, lamp glows, wall tickers (5x7 pixel font, pre-skewed onto the wall). |
| `src/world/rats.ts` | One particle per rat: walk, type, slump, cheer, frozen; 4 walk directions from 2 drawn ones by mirroring; size by tier. |
| `src/world/effects.ts` | Burn: cash bags arc from desks into the furnace, furnace flares. |
| `src/gfx/layer.ts` | Depth-sorted, culled `ParticleContainer`. |
| `src/data/` | API client, store (roster once, state and events after), stress padding. |

### 3,000 rats at 60 fps

- Rats, desks, chairs, walls and props share **one texture** (rats.png and world.png joined at load) and **one `ParticleContainer`**, so they depth-sort together and draw in one batch.
- Painter's order is kept with an insertion sort (only walkers move, so the list is nearly sorted); off-screen items are **culled** by 256 px screen buckets before upload.
- The floor (tens of thousands of tiles) is a separate static `ParticleContainer`, uploaded once and never touched again.
- Measured here (headless Chromium, `?perf=1&stress=3000&walkers=20`, 1600x1000):

| View | Simulation | Whole frame on the CPU | Particles uploaded |
|---|---|---|---|
| 350 rats (mock), default zoom | 0.3 ms | 0.65 ms | 1.8k of 2.9k |
| 3,020 rats, 20 walking, zoomed in | 0.9 ms | 1.6 ms | 2.6k of 12.2k |
| 3,020 rats, 20 walking, whole floor | 1.0 ms | 3.7 ms (max 5.4) | 11.5k of 12.2k |

  The CPU side fits the 16.7 ms frame with room to spare. The fps shown in this container (8 to 14) is its software rasterizer (no GPU); it could not be measured on a real GPU here, see `NOTES.md`.

### Sources

- `ParticleContainer`: all particles share one texture source, `dynamicProperties` (position, vertex, uvs, color, rotation; only position is dynamic by default), `particleChildren` drawn in array order with `update()` after direct changes, `boundsArea` set by hand: VERIFIED in https://github.com/pixijs/pixijs/blob/dev/src/scene/particle-container/shared/ParticleContainer.ts
- `Particle` does not read a texture's default anchor (set `anchorX`/`anchorY` yourself): VERIFIED in https://github.com/pixijs/pixijs/blob/dev/src/scene/particle-container/shared/Particle.ts
- Spritesheet JSON with per-frame `anchor` and `animations`: VERIFIED in https://github.com/pixijs/pixijs/blob/dev/src/spritesheet/Spritesheet.ts
- `CanvasSource` with `scaleMode: 'nearest'`; the app renders at `UPDATE_PRIORITY.LOW`, so a `UTILITY` ticker callback runs after the render: VERIFIED in the installed pixi.js 8.21.0 (`lib/rendering/renderers/shared/texture/sources/`, `lib/app/TickerPlugin.mjs`, `lib/ticker/const.mjs`)
- pixijs.com docs are blocked by this environment's network policy, so the source was used instead.

Assets: see [assets/README.md](assets/README.md).
