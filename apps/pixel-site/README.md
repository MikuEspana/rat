# WALL STREET RATS pixel site

An idle game: an isometric pixel-art office building at night that grows with the creator fees claimed, from a garage startup to a small office (0.25 SOL claimed), a full floor (1 SOL), a corporate floor (5 SOL), a megacorp (20 SOL) and, from 50 SOL, Wall Street; its rooms, desks, landmarks and sewer grow with the rats hired. Pan around and click into it. Creator fees hire rats; each rat climbs out of the sewer in front of the lobby (one manhole at first, two from 50 hires, a steaming grate from 250, a big sewer entrance from 1,000), shakes itself off, walks into the lobby and on to a desk in one of its stock's rooms, and types. Cheers when the stock is up, slumps when it is down, goes grey when frozen, and wears a better suit as it climbs tiers (partners move into the CEO corner office). Around 7% of the rats are always up and about: coffee, the water cooler, a chat, the bathroom queue, the copier, a meeting, a stroll, a box run, a smoke outside, a nap at the desk. Money is always moving: every claim and every hire sends bills flying into THE VAULT, the money pile in the middle of the building that shows the Wall Street Rats portfolio in 6 stages, and "+$X" pops up where they land. Nothing is ever burned: every fee hires rats.

Every claim shows its rats at once. Hires are paced (at most 40 Jupiter calls a minute, 60 SOL an hour), so when fees come in faster than the bot can hire, one applicant per 0.03 SOL waiting to be spent lines up outside the lobby in a job-fair line around the block, under a "JOB FAIR: N IN LINE" sign. Each hire turns the rat at the front of the line into the new hire, who walks straight in to a desk. Applicants come up through the sewer too and walk round the outside to the back of the line; the line only ever stands outside (the apron round the office and the sidewalks, never the road or a tile something else stands on), and past its last place the rest are counted on the sign, not stacked. Early on, with no backlog, a hire just climbs out of the sewer and walks to its desk. When every desk is taken (about 5,800 rats), a hired rat stays in line until a desk is built for it.

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

A whole launch, simulated in the browser: the coin goes live, the market cap climbs, volume makes creator fees, and the bot's rules turn every fee into rats holding stocks. The site reads it through the same interface as the API, in the same response shapes, so every piece on screen (hires walking in, stage banners, rooms being built, BUILD lines, the job-fair line) is the real rendering code.

```sh
pnpm --filter @rat/pixel-site dev                           # then open http://localhost:5173/?sim
VITE_SIM=1 pnpm --filter @rat/pixel-site build              # static demo in apps/pixel-site/dist (any static host)
```

- "Simulate launch", then Start / Pause / Reset, speed 1x, 10x, 60x or 300x, and a scenario:
  - **Normal**: pumps to about $1.8M over 3 hours, then cools off. About 4,900 rats (Wall Street), a portfolio worth about $23K. Everyone gets a desk.
  - **Mega**: runs to about $10M in 4 hours. About 6,400 rats after 5 hours: every desk is taken and about 550 line up outside.
  - **Rug**: pumps to about $300K, then dumps 80%. About 820 rats (corporate floor).
  - **Rush**: the backend's 3-hour launch (`SIMULATION.md`): 90 SOL of fees in the first 30 minutes, 180 SOL in all. The job-fair line swells to about 2,000 applicants while the Jupiter budget paces the hires, then drains. About 6,000 rats.
- Page flags: `?sim&scenario=mega&speed=300&autostart=1`. `?api=<url>` always uses a real API.
- A yellow SIMULATION banner stays on screen the whole time. Events carry no transaction signature and link to nothing.
- `src/sim/rules.ts` holds the bot's rules (every fee to hires, 0.03 SOL per rat, at most 20 hires per 35 s loop, 60 SOL per hour, at most 40 Jupiter calls in any minute with prices every 45 s; nothing is bought back or burned). `rules.test.ts` compares every number with the worker's real default config. Stock picks use the worker's own picker (`packages/core/src/picker.ts`).
- `src/sim/scenarios.ts`: the market cap curves, the volume model and the creator fee tiers. Volume and fee rates are rough models (the fee tiers approximate pump.fun's, which are set on-chain and can change), tuned so Normal pays about 145 SOL of fees. The building has desks for about 5,800 rats; the rest line up outside (`queueCells` in `src/floor/plan.ts`).
- `src/sim/engine.test.ts` runs every scenario to the end: every response passes the contract's zod schemas, and the rules hold (every claim to hires, per-loop limit, hourly cap, never spending more than was claimed). A 3x Mega run checks that the limits bind (the 40-call Jupiter budget a little before the 60 SOL/h cap) and the rest waits.
- Live demo: https://wallstreetrats.world . `.github/workflows/pages.yml` rebuilds it on every push to `main` (with `VITE_BASE=/`, served from the root) and publishes it to the `gh-pages` branch with a `CNAME` file, so the custom domain survives every deploy; GitHub Pages serves it. The same folder is kept as the `rat-race-demo` workflow artifact (drag it onto Netlify Drop or Vercel). Social preview image: `public/og.png` (1200x630).

## What is on screen

| Piece | Source |
|---|---|
| Market cap | `coin.marketCapUsd` (shows "pre-launch" while null), price per RAT under it |
| Rats hired | `portfolio.ratCount`, frozen count under it |
| Portfolio value | `portfolio.valueUsd` (what all the rats' stocks are worth; not holders' money), the two biggest positions under it (for example `AMZNx 312`). Glides to each new value over 2 s: prices refresh every 45 s |
| The Vault | the money pile in the middle of the building, in 6 stages from loose change to a money bin (`portfolio.valueUsd`); shimmers green when the portfolio is up, dims when it is down; click it for the total, the breakdown by stock and the rat wallets. Bills fly in from the sewer on every claim (a gold "+$X") and every hire (a green "+$X" each); a burst of hires rains bills from above |
| Next hire ring | fills from `bot.lastClaimAt` to `bot.nextClaimAt` (each claim pays for the next hires), with a countdown |
| Stage chip | the stage the building is at, and three bars: the desk room filling up and the next room (by rats hired), and the next stage by SOL claimed ("CORPORATE FLOOR: 1.9 / 5 SOL") |
| Company Roadmap | bottom right: every stage in order with the SOL claimed it takes (`treasury.totalClaimedSol`, read through `src/floor/stage-source.ts`); done ones checked, the next one with a bar ("0.62 / 1 SOL"), the rest locked. "hide" folds it to one line ("NEXT: CORPORATE 3.2 / 5 SOL"), remembered in the browser. Under 900 px wide it is that one line between the feed and the news ticker (tap for the list). It never sits on the Vault or the job-fair line, and gives the corner to an open rat card |
| Live feed | the last 50 events from `/api/state`, then every new event: hires (click to fly to the rat), claims, freezes, thaws, each with its Solscan tx link |
| Rat card | name, tier badge, stock, PnL %, value, rank, status, hired, and a WALLET ON SOLSCAN button to the rat's real wallet; a gold marker bobs over the rat. Founders, applicants and other extras open a short card saying what they are (no wallet) |
| Market cap | the API's `coin.marketCapUsd`; right after the launch (a mint, no market cap yet) the browser reads Jupiter's price API, then DexScreener (`src/data/market.ts`), until the API has its own |
| CA | `coin.mint`, shortened, links to pump.fun, with COPY; hidden before the launch |
| Leaderboard | `leaderboard.top` (best 10) and `leaderboard.bottom` (worst 10) |
| Banner | `bot.mode`: DRY RUN (yellow) or PAUSED (red); hidden when live |

Under 900 px wide the HUD compacts, the leaderboard starts folded and the card becomes a bottom sheet.

Debug URL flags: `?rats=N` (run the idle game at exactly N rats, 1 to 7000, with a slider and stage buttons; 6500 shows the job-fair line; needs the API, for example `pnpm mock:api`. N maps to the SOL claimed that shows the stage N rats used to, so 25, 100, 500, 1500 and 3000 are the stage edges; add `&sol=X` to pin the SOL claimed instead), `?perf=1` (fps, simulation ms, frame CPU ms, particle counts), `?stress=3000` (pad the roster to 3,000 rats), `?walkers=20` (20 extra synthetic hires every 10 s).

### Stages

The stage goes by the SOL claimed (`treasury.totalClaimedSol`, read in one place: `stageSourceSol` in `src/floor/stage-source.ts`) and never closes. A stage opens its ring (corridor and lobby), the building sign, the stage banner ("1 SOL claimed") and the NEXT FLOOR lots; within 10% of the next stage's SOL those lots get scaffolding and a crane. Everything inside still goes by rats hired: each ring's rooms open at their hire counts (the ring's planned range below), desks are handed out hire by hire (everyone shares the garage and open offices until the 100th hire), and the landmarks and the sewer keep their rat counts.

| SOL claimed | Stage | Rooms planned for (hires) | What gets built |
|---|---|---|---|
| under 0.25 | Garage startup | under 25 | the garage: the Vault, shared desks, couch, boxes, coffee |
| 0.25+ | Small office | 25 to 100 | ring 1: open-plan offices (shared desks), break room, WC, lobby |
| 1+ | Full floor | 100 to 500 | ring 2: a desk room per stock (on demand), meeting, server, copy, storage |
| 5+ | Corporate floor | 500 to 1,500 | ring 3: the CEO office (partners move in), more of everything |
| 20+ | Megacorp | 1,500 to 3,000 | ring 4 |
| 50+ | Wall Street | 3,000 on | ring 5: war room, vaults, red sky |

Screenshots of every stage in the simulator with the roadmap: `assets/preview/sol_stages/`.

Screenshots: `assets/preview/idle_stages_*.png` (every stage at zoom 0.4 and 0.9, and the whole building), `assets/preview/idle_milestone.png`.

### Landmarks

Each milestone unlocks one set piece. The camera flies to it, holds 3.6 s under an "UNLOCKED" banner and eases back (click or any key skips; never while you drag).

| Rats | Landmark | Where |
|---|---|---|
| 10 | Espresso shrine | on the garage's furnace plaza |
| 25 | Ping pong table | small office lobby |
| 50 | Crypto trading pit | first open-plan room |
| 100 | Glass elevator | up the office tower behind the back corner; the tower gains a floor every 30 rats |
| 250 | Basement gym and nap pods | dug under a lot beside the office |
| 500 | Rooftop helipad | on the tower, with the CEO's helicopter |
| 1000 | Giant golden rat | corporate lobby |
| 1500 | Rooftop pool party | on the second tower (megacorp), joined to the first by a sky bridge |
| 2000 | Rat rocket launchpad | a big lot across the cross street |
| 3000 | Evil throne room | the war room, with a laser beam into the sky |

Each ring also opens one wing at a time (L or T shapes; closed wings stay city lots), and from the corporate floor an annex stands across the avenue, reached by a sky bridge. Reveals: `assets/preview/landmark_reveals.png`.

## Data

Follows [CONTRACT.md](../../CONTRACT.md) and the owner's rule for the 1.7 MB roster:

- `/api/rats` is fetched **once** on page open.
- `/api/state` every 5 s: stocks, prices, bot. Every rat's PnL and tier are recomputed in the browser with `@rat/contract` (`computeRatView`), so the roster never needs a re-poll.
- `/api/events?afterId=` every 5 s: `hire` spawns a walker (its value is estimated from cost and today's price, exact again after a reload), `freeze`/`unfreeze` greys rats.
- Responses are checked for `schemaVersion: 2`; unknown fields are ignored (the contract may add optional fields).

## How it is built

| File | What |
|---|---|
| `src/floor/plan.ts` | The master plan, drawn once: the garage, then one ring per stage (ring corridor, four strips of rooms with shared walls, a lobby with the subway outside), doors that keep each ring connected on its own, amenity thresholds, the build order of desk-room slots. Pure, deterministic and tested. |
| `src/floor/growth.ts` | The idle game: opens the stages the SOL claimed reaches (`setSol`), replays rats in id order, builds amenities and desk rooms on demand by hires, gives every rat a desk, and the walk mask of what stands. |
| `src/floor/stage-source.ts` | `stageSourceSol(treasury)`: the one place that says what the stage goes by (`treasury.totalClaimedSol`). |
| `src/floor/pack.ts` | Packs rooms into a rectangle with no gaps (a slicing floor plan), splits chosen for near-square rooms. |
| `src/floor/furnish.ts` | Fills each room: desk pods facing each other and rows along the front walls, props along walls, activity spots, rugs, worn patches, clutter that never cuts off a chair, things hung on walls. |
| `src/floor/city.ts` | The city round the office per stage: avenue, cross street and alley, irregular blocks split into lots with a purpose each, falloff and a dithered edge, street furniture by Poisson disk, street scenes, traffic, the landmark on the opposite diagonal. Pure, deterministic, tested. |
| `src/floor/landmarks.ts`, `src/world/landmarks.ts` | The 10 landmark unlocks (thresholds, tower floors and footprints) and how each is drawn: interior set pieces in their kept-clear spots, the towers, helipad, pool, sky bridges, the annex, the basement gym and the rocket. |
| `src/ui/news.ts`, `src/ui/sound.ts` | The RAT NEWS ticker (headlines from the live numbers, darker each stage) and the unlock chimes (WebAudio, off until switched on). |
| `src/floor/vignettes.ts` | 18 authored scenes with posed extras, dropped whole into rooms that fit them, and the easter eggs. |
| `src/floor/path.ts` | Walking routes: breadth-first distance fields (cached per target, windowed for short errands), walked with as few turns as possible. |
| `src/world/build.ts` | What stands: floors per room type, blueprint lots with lock signs, thin cutaway walls, desk pods (or their building sites), props, vignette extras, wall pieces, the Vault (with its glow, sign and a flare when money lands) and light beam, glows, blinking server lights, wall tickers, room signs, the JOB FAIR sign, and the city round the building (per stage, with traffic). Rebuilt when something gets built; new rooms get scaffolding, a crane and a dust puff. |
| `src/world/rats.ts` | One particle per rat (plus one for its accessory): fur and accessory from the avatar seed; seated facing the camera or its screen, sulking, cheering, napping, walking, frozen; errands to activity spots; box carrying; desk pools (CEO office for partners); chairs reappear when a rat gets up; the job-fair line outside: applicants (shown as interns; up to 2,000 drawn, the rest counted; the first 60 of a claim walk up from the subway) and hired rats with no desk; a hire takes the front applicant and walks it in, and the line moves up. |
| `src/world/money.ts` | Bills flying in an arc into the Vault (at most 160 in the air) and the "+$X" popups. Display only. |
| `src/world/effects.ts` | Dust puffs where something just got built. |
| `tools/build_gen.py`, `tools/build_rats2.py`, `tools/build_props3.py` | Art drawn in code (floors, walls, desk_back, rugs, tape, tower storeys, sky bridge and pylon), every rat look (tiers x furs, seated poses, accessory overlays), and the PixelLab props (rounds 2 to 4). |
| `src/gfx/sky.ts` | The night sky behind the building. |
| `src/gfx/layer.ts` | Depth-sorted, culled `ParticleContainer`. |
| `src/data/` | API client, store (roster once, state and events after), stress padding. |
| `src/ui/` | HUD, ring, feed, rat card, leaderboard, Company Roadmap (`roadmap.ts`), banner (DOM over the canvas; API text always set with `textContent`). |

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
