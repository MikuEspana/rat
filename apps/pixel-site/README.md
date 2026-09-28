# RAT RACE pixel site

An idle game: an isometric pixel-art office building at night that grows with the rat count, from a garage startup (under 25 rats) to a small office, a full floor, a corporate floor, a megacorp and, past 3,000 rats, an evil empire. Pan around and click into it. Creator fees hire rats; each rat comes up the subway stairs, walks into the lobby and on to a desk in one of its stock's rooms, and types. Cheers when the stock is up, slumps when it is down, goes grey when frozen, and wears a better suit as it climbs tiers (partners move into the CEO corner office). Around 7% of the rats are always up and about: coffee, the water cooler, a chat, the bathroom queue, the copier, a meeting, a stroll, a box run, a smoke outside, a nap at the desk. Burns send cash bags flying into the HQ furnace.

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

## Launch simulator (no server)

A whole launch, simulated in the browser: the coin goes live, the market cap climbs, volume makes creator fees, and the bot's rules turn every fee into rats holding stocks. The site reads it through the same interface as the API, in the same response shapes, so every piece on screen (hires walking in, stage banners, rooms being built, BUILD lines, burns into the furnace) is the real rendering code.

```sh
pnpm --filter @rat/pixel-site dev                           # then open http://localhost:5173/?sim
VITE_SIM=1 pnpm --filter @rat/pixel-site build              # static demo in apps/pixel-site/dist (any static host)
```

- "Simulate launch", then Start / Pause / Reset, speed 1x, 10x, 60x or 300x, and a scenario:
  - **Normal**: pumps to about $1.8M over 3 hours, then cools off. About 4,900 rats (evil empire), a fund worth about $23K.
  - **Mega**: runs to about $10M in 4 hours. Hiring maxes out at the 30 SOL/h cap: about 4,900 rats after 5 hours, with about 45 SOL still waiting.
  - **Rug**: pumps to about $300K, then dumps 80%. About 720 rats (corporate floor).
- Page flags: `?sim&scenario=mega&speed=300&autostart=1`. `?api=<url>` always uses a real API.
- A yellow SIMULATION banner stays on screen the whole time. Events carry no transaction signature and link to nothing.
- `src/sim/rules.ts` holds the bot's rules (every fee to hires, 0.03 SOL per rat, at most 10 hires per 35 s loop, 30 SOL per hour; with a lower split, burn rounds 8 to 12 minutes apart, chunks of at most 1 SOL, at most 5 SOL per round). `rules.test.ts` compares every number with the worker's real default config. Stock picks use the worker's own picker (`packages/core/src/picker.ts`).
- `src/sim/scenarios.ts`: the market cap curves, the volume model and the creator fee tiers. Volume and fee rates are rough models (the fee tiers approximate pump.fun's, which are set on-chain and can change), tuned so Normal pays about 145 SOL of fees. The building is drawn for about 5,200 rats (`PLAN_RATS`); rats beyond that stand in HQ.
- `src/sim/engine.test.ts` runs every scenario to the end: every response passes the contract's zod schemas, and the rules hold (split, per-loop limit, hourly cap, chunk and round sizes, round spacing, never spending more than was claimed).
- Live demo: https://wallstreetrats.world . `.github/workflows/pages.yml` rebuilds it on every push to `main` (with `VITE_BASE=/`, served from the root) and publishes it to the `gh-pages` branch with a `CNAME` file, so the custom domain survives every deploy; GitHub Pages serves it. The same folder is kept as the `rat-race-demo` workflow artifact (drag it onto Netlify Drop or Vercel). Social preview image: `public/og.png` (1200x630).

## What is on screen

| Piece | Source |
|---|---|
| Market cap | `coin.marketCapUsd` (shows "pre-launch" while null), price per RAT under it |
| Rats hired | `portfolio.ratCount`, frozen count under it |
| Fund value | `portfolio.valueUsd` (what all the rats' stocks are worth), the two biggest positions under it (for example `AMZNx 312`); RAT burned instead, if burns are ever turned on |
| Portfolio PnL | `portfolio.pnlUsd` and `pnlPct`, green or red |
| Next hire ring | fills from `bot.lastClaimAt` to `bot.nextClaimAt` (each claim pays for the next hires), with a countdown |
| Live feed | the last 50 events from `/api/state`, then every new event: hires (click to fly to the rat), burns, claims, freezes, thaws, each with its Solscan tx link |
| Rat card | name, tier badge, stock, PnL %, value and cost, rank, status, hired, Solscan wallet link; a gold marker bobs over the rat |
| Leaderboard | `leaderboard.top` (best 10) and `leaderboard.bottom` (worst 10) |
| Banner | `bot.mode`: DRY RUN (yellow) or PAUSED (red); hidden when live |

Under 900 px wide the HUD compacts, the leaderboard starts folded and the card becomes a bottom sheet.

Debug URL flags: `?rats=N` (run the idle game at exactly N rats, 1 to 5000, with a slider and stage buttons), `?perf=1` (fps, simulation ms, frame CPU ms, particle counts), `?stress=3000` (pad the roster to 3,000 rats), `?walkers=20` (20 extra synthetic hires every 10 s).

### Stages

| Rats | Stage | What gets built |
|---|---|---|
| under 25 | Garage startup | the garage: furnace, shared desks, couch, boxes, coffee |
| 25+ | Small office | ring 1: open-plan offices (shared desks), break room, WC, lobby |
| 100+ | Full floor | ring 2: a desk room per stock (on demand), meeting, server, copy, storage |
| 500+ | Corporate floor | ring 3: the CEO office (partners move in), more of everything |
| 1500+ | Megacorp | ring 4 |
| 3000+ | Evil empire | ring 5: war room, vaults, red sky |

Screenshots: `assets/preview/idle_stages_*.png` (every stage at zoom 0.4 and 0.9, and the whole building), `assets/preview/idle_milestone.png`.

## Data

Follows [CONTRACT.md](../../CONTRACT.md) and the owner's rule for the 1.7 MB roster:

- `/api/rats` is fetched **once** on page open.
- `/api/state` every 5 s: stocks, prices, bot. Every rat's PnL and tier are recomputed in the browser with `@rat/contract` (`computeRatView`), so the roster never needs a re-poll.
- `/api/events?afterId=` every 5 s: `hire` spawns a walker (its value is estimated from cost and today's price, exact again after a reload), `freeze`/`unfreeze` greys rats, `burn` fires the furnace.
- Responses are checked for `schemaVersion: 1`; unknown fields are ignored (the contract may add optional fields).

## How it is built

| File | What |
|---|---|
| `src/floor/plan.ts` | The master plan, drawn once: the garage, then one ring per stage (ring corridor, four strips of rooms with shared walls, a lobby with the subway outside), doors that keep each ring connected on its own, amenity thresholds, the build order of desk-room slots. Pure, deterministic and tested. |
| `src/floor/growth.ts` | The idle game: replays rats in id order, builds stages, amenities and desk rooms on demand, gives every rat a desk, and the walk mask of what stands. |
| `src/floor/pack.ts` | Packs rooms into a rectangle with no gaps (a slicing floor plan), splits chosen for near-square rooms. |
| `src/floor/furnish.ts` | Fills each room: desk clusters in six layouts with jitter and mirrored orientations, props along walls, activity spots, clutter that never cuts off a chair, things hung on walls. |
| `src/floor/path.ts` | Walking routes: breadth-first distance fields (cached per target, windowed for short errands), walked with as few turns as possible. |
| `src/world/build.ts` | What stands: tiles in room-type colours, empty lots, the street, walls, desks, props, wall pieces, furnace and light beam, glows, blinking server lights, wall tickers, room signs. Rebuilt when something gets built; new rooms pop in. |
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
