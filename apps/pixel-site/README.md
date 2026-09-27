# RAT RACE pixel site

An isometric pixel-art office building at night that you pan around and click into. Creator fees hire rats; each rat comes up the subway stairs, walks into the lobby and on to a desk in one of its stock's rooms, and types. Cheers when the stock is up, slumps when it is down, goes grey when frozen, and wears a better suit as it climbs tiers (partners move into the CEO corner office). Around 7% of the rats are always up and about: coffee, the water cooler, a chat, the bathroom queue, the copier, a meeting, a stroll, a box run, a smoke outside, a nap at the desk. Burns send cash bags flying into the HQ furnace.

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

Controls: drag to pan, mouse wheel or pinch to zoom, click a rat for its card (Esc closes). Click a hire in the feed or a leaderboard row to fly to that rat.

## What is on screen

| Piece | Source |
|---|---|
| Market cap | `coin.marketCapUsd` (shows "pre-launch" while null), price per RAT under it |
| Rats hired | `portfolio.ratCount`, frozen count under it |
| Total burned | `coin.burnedTokens` RAT, `treasury.totalBurnSpentSol` and `burnCount` under it |
| Portfolio PnL | `portfolio.pnlUsd` and `pnlPct`, green or red |
| Next hire ring | fills from `bot.lastClaimAt` to `bot.nextClaimAt` (each claim pays for the next hires), with a countdown |
| Live feed | the last 50 events from `/api/state`, then every new event: hires (click to fly to the rat), burns, claims, freezes, thaws, each with its Solscan tx link |
| Rat card | name, tier badge, stock, PnL %, value and cost, rank, status, hired, Solscan wallet link; a gold marker bobs over the rat |
| Leaderboard | `leaderboard.top` (best 10) and `leaderboard.bottom` (worst 10) |
| Banner | `bot.mode`: DRY RUN (yellow) or PAUSED (red); hidden when live |

Under 900 px wide the HUD compacts, the leaderboard starts folded and the card becomes a bottom sheet.

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
| `src/floor/plan.ts` | The building from the stock list: the room list (several stock rooms per big stock, break rooms, bathrooms, meeting, copy, server and storage rooms, the CEO corner office, HQ, the lobby), doors until every room is reachable, the street with the subway stairs and lamps. Pure, deterministic and tested. |
| `src/floor/pack.ts` | Packs the rooms into one square with no gaps (a slicing floor plan): 2-cell corridors at the top splits, shared walls below, splits chosen for near-square rooms, HQ pinned to the centre. |
| `src/floor/furnish.ts` | Fills each room: desk clusters in six layouts with jitter and mirrored orientations, props along walls, activity spots, clutter that never cuts off a chair, things hung on walls. |
| `src/floor/path.ts` | Walking routes: breadth-first distance fields (cached per target, windowed for short errands), walked with as few turns as possible. |
| `src/world/build.ts` | Tiles, walls, desks, chairs, props, wall pieces, stairs, furnace, lamp glows, blinking server lights, wall tickers (5x7 pixel font, pre-skewed onto either back wall). |
| `src/world/rats.ts` | One particle per rat: walk, type, slump, cheer, nap, stand, sit, frozen; errands to activity spots; box carrying; desk pools (CEO office for partners); chairs reappear when a rat gets up. |
| `src/gfx/sky.ts` | The night sky behind the building. |
| `src/world/effects.ts` | Burn: cash bags arc from desks into the furnace, furnace flares. |
| `src/gfx/layer.ts` | Depth-sorted, culled `ParticleContainer`. |
| `src/data/` | API client, store (roster once, state and events after), stress padding. |
| `src/ui/` | HUD, ring, feed, rat card, leaderboard, banner (DOM over the canvas; API text always set with `textContent`). |

### 3,000 rats at 60 fps

- Rats, desks, chairs, walls and props share **one texture** (rats.png and world.png joined at load) and **one `ParticleContainer`**, so they depth-sort together and draw in one batch.
- Painter's order is kept with an insertion sort (only walkers move, so the list is nearly sorted); off-screen items are **culled** by 256 px screen buckets before upload.
- The floor (tens of thousands of tiles) is a separate static `ParticleContainer`, uploaded once and never touched again.
- Measured here (headless Chromium with its software rasterizer, 1600x1000, `?perf=1`, `?perf=1&stress=3000`):

| View | Simulation | Whole frame on the CPU | Particles uploaded |
|---|---|---|---|
| mock (~560 rats, ~40 away), default zoom | 0.4 ms | 2.4 ms | 3.7k of 4.3k |
| 3,000 rats, ~90 away, zoom 1 | 1.1 ms | 7.2 ms | 4.7k of 21.5k |
| 3,000 rats, ~80 away, whole building | 1.6 ms | 5.9 ms (max 17) | 21.9k of 22.8k |

  The software renderer is most of that time (it shows 1 to 15 fps whatever the scene); a real GPU could not be measured here, see `NOTES.md`.

### Sources

- `ParticleContainer`: all particles share one texture source, `dynamicProperties` (position, vertex, uvs, color, rotation; only position is dynamic by default), `particleChildren` drawn in array order with `update()` after direct changes, `boundsArea` set by hand: VERIFIED in https://github.com/pixijs/pixijs/blob/dev/src/scene/particle-container/shared/ParticleContainer.ts
- `Particle` does not read a texture's default anchor (set `anchorX`/`anchorY` yourself): VERIFIED in https://github.com/pixijs/pixijs/blob/dev/src/scene/particle-container/shared/Particle.ts
- Spritesheet JSON with per-frame `anchor` and `animations`: VERIFIED in https://github.com/pixijs/pixijs/blob/dev/src/spritesheet/Spritesheet.ts
- `CanvasSource` with `scaleMode: 'nearest'`; the app renders at `UPDATE_PRIORITY.LOW`, so a `UTILITY` ticker callback runs after the render: VERIFIED in the installed pixi.js 8.21.0 (`lib/rendering/renderers/shared/texture/sources/`, `lib/app/TickerPlugin.mjs`, `lib/ticker/const.mjs`)
- pixijs.com docs are blocked by this environment's network policy, so the source was used instead.

Assets: see [assets/README.md](assets/README.md). The dense-floor props are in `assets/props2.png`, built by `tools/build_props2.py` (PixelLab prop sheets, kitbashes and clutter drawn in code); before/after shots in `assets/preview/dense_*.png`.
