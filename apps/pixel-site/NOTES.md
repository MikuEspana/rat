# pixel-site notes

Running log of decisions and blockers. Newest first inside each section.

## Decisions

- **Round 2: close the gap with floor796 (owner, 2026-09-28).** Rooms were the problem more than the art, so most of it is code:
  - **Desk pods** (`src/floor/furnish.ts` `deskRoom`): pods of 2 to 4 desks facing each other on a grid with aisles round each one, plus rows along the two front walls. No random rotations: one pod direction per room. Every rat faces its own monitor; the far side of a pod and the front-wall rows face the camera over the back of their monitor (`desk_back`, the oak desk turned round in `tools/build_gen.py`), the near side shows its back and the screen. Rats fill a room pod by pod.
  - **Seated poses** (`tools/build_rats2.py`): `sit_front` and `sit_back` are the standing idle frames cut at the hips and set on a chair (the desk hides the legs); `sulk_*` sits lower for a falling stock and for naps.
  - **Cutaway walls:** walls are thin faces on cell edges instead of full blocks. Knee-high (10 px, light cut top) inside and on the front; tall (48 px) only on the building's back walls (night windows) and as panels where a ticker, whiteboard or TV hangs.
  - **Floors per room type** (`gen.png`): carpet, wood planks, checker, bath tile, raised server floor, concrete, marble, vinyl corridors, plus rugs and worn patches. Colours per type are kept so zones still read from far away.
  - **Empty pods** are taped-off building sites (hazard tape, boxes) until their first rat arrives, then the desks pop in with a dust puff.
  - **Rats:** fur grey, brown, white or black; accessory glasses, red or white headphones, bowler, cap or beanie (58%) or none; both picked from the avatar seed. Suits still carry the tier. Accessories are one overlay particle per rat, frame for frame.
  - **Vignettes** (`src/floor/vignettes.ts`): 18 authored scenes with a story and posed extras (server fire, red chart meeting, all-hands nap, nap on the copier, paper jam, smoking fax, crying in the WC, CEO counting cash, donut fight, birthday, pizza night, arcade, ping pong, foosball, aquarium, vault hoard, evil throne, wet floor). Code only picks one that fits the room type and finds a free spot; it never invents a layout. 80% of amenity rooms get one, no repeats within a ring while others fit.
  - **Rare props:** one easter egg per ring (disco ball, phone booth, UFO, rubber duck, treasure, golden rat). Common clutter stays everywhere.
  - **The city per stage** (`buildCity` in `src/world/build.ts`): suburb (grass, houses, trees, mailboxes, a driveway with the family car, the garage keeps an open roll-up door), downtown (shops, brick blocks, benches, hydrants, bus stops), towers (glass and art deco, scaled up per stage, two rows deep), the evil empire (black and red towers, red ground). Tall buildings only stand behind the office, never in front. Parked cars and traffic on the road ring.
  - **Idle feel:** lots of the current stage show a muted blueprint floor; the next few get a lock sign ("BREAK ROOM 367 RATS", "DESKS NEXT HIRES"). The HUD shows a bar to the next stage ("CORPORATE FLOOR: 104 / 500 rats"). A room going up gets scaffolding and a crane for a moment and a dust puff, then pops in.
  - **Server racks** at 72% of their art.

- **Idle game (owner, 2026-09-27):** the building grows with the rat count, deterministically: garage startup (under 25), small office (25+), full floor (100+), corporate floor (500+), megacorp (1500+), evil empire (3000+). `src/floor/plan.ts` draws a fixed master plan once (the garage in the middle, one ring of rooms per later stage, drawn for 5,200 rats); `src/floor/growth.ts` replays rats in id order: a new stage builds its ring corridor and lobby, amenities open at set counts, and a rat with no free desk in its stock's rooms gets the next desk-room slot built for that stock. Rooms never move or disappear. Before the full floor everyone shares the garage and open-plan offices. New stage: banner; every new room: a BUILD line in the live feed and its furniture pops in. Revert point before this work: branch `snapshot/pixel-dense-v1`.
- **Readable from far away (owner, 2026-09-27):** a floor colour per room type (blue desk rooms, orange break rooms, aqua WCs, lilac meeting rooms, deep blue servers, grey copy rooms, brown storage, green lobbies, gold CEO office, red war room), big pixel-font signs over every room that fade in and grow as you zoom out, the stage name over the building, and a light beam from the furnace that widens with each stage. The furnace itself grows (x1, x2, x3). The evil empire gets a red sky, red corridors and darker walls.
- **Fewer black chairs (owner, 2026-09-27):** empty desks have no chair at all; a light grey chair shows only while its rat is away. Desk rooms are built on demand, so few desks stand empty.
- **Debug slider:** `?rats=N` (1 to 5000) shows the company at N rats (synthetic roster), with a slider and stage jump buttons. Live hires are ignored in that mode.
- **Dense floor (owner, 2026-09-27):** the Phase 3 floor read as a spreadsheet. Rebuilt as one packed building (`src/floor/`): a slicing floor plan with 2-cell corridors only at the top splits and shared walls below, so rooms touch. HQ shrunk to about 10x10 in the centre. New room types: break room, bathroom, server room, copy room, meeting room, storage, lobby, the CEO corner office (partners sit there while it has desks). A big stock gets several stock rooms of different sizes, each laid out one of six ways (columns, rows, split, perimeter + island, pods, mixed) with jittered desks, mirrored clusters and clutter. About 7% of rats are away from their desks at any time: coffee, water cooler, vending, chats, bathroom queue, copier, filing, meetings, whiteboard, server checks, furnace watching, corridor strolls, box runs, smokers outside, naps at the desk. Night sky backdrop, street ring with lamps and the subway stairs outside the lobby.
- **Dense floor art budget (owner, 2026-09-27):** stay free; kitbash and draw clutter in code; PixelLab only for hero props. Before that message arrived 3 generations had gone on 3 prop sheets (vending machine and server rack among them); after it, 1 hero generation (coffee machine). Gold CEO desk is a free recolor. Everything else is kitbashed or drawn in `tools/build_props2.py`.
- **Data loading (owner, 2026-09-27):** `/api/rats` is about 1.7 MB at 3,000 rats. Load it once on page open, then follow `/api/events` (every 5 s) for new hires, freezes and claims. Never re-poll the full roster. Live PnL and tiers are recomputed in the browser from `/api/state` stock prices with the `@rat/contract` display math (`valueUsd = tokenAmount x priceUsd`). A rat hired after page load has no `tokenAmount` in its hire event, so its value is estimated as `costUsd x price_now / price_at_hire` (price at hire = the stock price in the latest `/api/state` when the hire event arrives). Small error from slippage; exact again after a reload.
- **Style (owner, 2026-09-27):** style A Blueprint. Tiers read by SUIT color, all free recolors of one rat: intern brown/khaki + red tie, analyst navy + red tie, associate forest green + gold tie, vp burgundy + gold tie, partner black with gold lapel trim + gold tie, frozen whole rat grey. No pale suits. 1px dark outer outline (#16182c) on every tier. Files: `style-samples/a-variants/`.
- **Final style (owner, 2026-09-27):** mix A3 + A2: A3 density (desk clutter, wall ticker, chairs, bin, paper pile) with A2 oak desk tops, plants and lamp glow. Tier tweaks: VP brighter crimson (was burgundy, read as intern brown), partner louder gold (wide gold tie, bright gold lapels, gold seams, gold collar from behind). Assets: `assets/` (see `assets/README.md`).
- **Phase 4 next-hire ring:** the API has no "next hire" timestamp, so the ring runs from `bot.lastClaimAt` to `bot.nextClaimAt` (claims fund the hires) and says "hiring..." once the claim is due.
- **Phase 4 leaderboard:** uses the server's `leaderboard.top` / `bottom` from `/api/state` (ranked on the server); the rat card's rank is recomputed in the browser from live PnL.
- **Phase 3 floor plan:** rooms in a grid of equal slots (4 x 3 for 10 stocks), HQ in a middle slot (fills it; marble plaza around the furnace, which scales by a whole number with the slot), subway in the front corner slot, stock rooms nearest HQ. A room is sized for `ceil(1.3 x rats) + 6` desks at page load; beyond that, new rats stand in the room's front walkway until a reload. Desks fill in a fixed shuffled order so a half-full room looks evenly busy. Desk pitch 3 x 3 cells; seated rat at desk + (-0.75, +0.5) cells, tuned on the sprites.
- **Phase 3 moods:** a stock's 24h change above +0.25% makes its seated rats cheer now and then (stand up, fists up, sit back); below -0.25% they slump; otherwise they type. Paused stocks: frozen rats, grey and still.
- **Phase 3 rendering:** one texture and one depth-sorted, culled `ParticleContainer` for everything that must overlap correctly (rats, desks, chairs, walls, props); floor in a static `ParticleContainer` uploaded once. Tried floor patches (one TilingSprite per room clipped by a mask): fewer quads but much slower in the software renderer (stencil and overdraw), so reverted.
- **Phase 2 facing plan:** walk and idle drawn for south-east and north-east; south-west and north-west are mirrors. Seated rats (type, slump) face screen right on their own chair; mirror to face left. Cheer is standing, facing south-east (arms read best toward the camera).

## Blockers

- **The deployed page cannot be checked from this container:** `mikuespana.github.io` is refused by the network policy (CONNECT 403). The build is tested locally (`VITE_SIM=1` build, same code) and pushed to `gh-pages`.

- **Git tags cannot be pushed through the git proxy (HTTP 403)**, so the revert point is a branch: `snapshot/pixel-dense-v1` (commit 6bc2627, the dense floor before the idle game).
- **CC0 asset hosts are blocked by the network policy** (itch.io, img.itch.zone, kenney.nl, opengameart.org all refused at CONNECT). No third-party props were used, so there are no outside licenses to log. To try CC0 props later, add those hosts under the environment's Network access settings.
- **Real-GPU frame rate for the dense floor is still unmeasured.** Measured here (headless Chromium, software rasterizer): whole frame on the CPU 2.4 ms with the mock's ~560 rats, 7.2 ms zoomed in and 5.9 ms (max 17) zoomed all the way out at 3,000 rats with about 80 walking. Our own per-frame code is 1 to 2 ms; the rest is the software renderer drawing about 22k sprites plus a 70k-tile floor. Confirm on a real machine with `?perf=1&stress=3000`.
- **PixelLab `animate_character` v3 (custom action) fails instantly** on this account's character ("Generation failed, try a lower frame_count or smaller character size" at 8 and 4 frames; failures uncharged). Worked around with `edit_image_pixen` (seated pose) + `animate_image` (type, slump, cheer) at the same cost, 1 generation each. PixelLab's help bot confirms v3 is not trial-locked; cause unknown.
- **60 fps on a real GPU is not measured here.** This container has no GPU; headless Chromium renders through its software rasterizer and shows 8 to 14 fps at 1600x1000 whatever the scene. What is measured: the whole frame costs the CPU 0.65 ms with the mock's 350 rats and 3.7 ms (max 5.4) with 3,020 rats, 20 walking, whole floor visible (`?perf=1&stress=3000&walkers=20`), inside the 16.7 ms budget. To confirm on a real machine: run the site and open `?perf=1&stress=3000&walkers=20`.
- **`pixijs.com` is blocked by the network policy.** PixiJS behavior is checked against its source on GitHub (raw.githubusercontent.com works) instead.

- **Host `backblaze.pixellab.ai` is blocked by the environment network policy (403).** `get_character` lists rotation and frame URLs on that host. Not blocking: the character ZIP from `https://api.pixellab.ai/mcp/characters/{id}/download` carries the same PNGs, so all downloads go through that. Allow `backblaze.pixellab.ai` only if a future tool returns files with no `api.pixellab.ai` alternative. Note: the ZIP returns an error JSON while any animation on the character is still rendering.
- **Resolved 19:10 UTC. 2026-09-27 18:57 UTC, PixelLab `create_character` failing.** Every character request (MCP and REST v2, standard mode, 4 or 8 directions, any size) failed within seconds with `Generation failed due to heavy load. Please try again in a moment.` for about 13 minutes while tiles and map objects worked. Failed jobs were not charged. A retry loop (every 90 s) got all 3 through on the 4th round.

## PixelLab setup

- The PixelLab MCP tools did not load into the Claude Code session, so every generation calls the PixelLab MCP server directly (`POST https://api.pixellab.ai/mcp`, JSON-RPC `tools/call`, bearer token from `PIXELLAB_API_KEY`). Same tools, same arguments, same credits. The key is never printed or committed.
- Downloads come back inline (base64 PNG) and as `https://api.pixellab.ai/mcp/.../download` links. No other host has been needed so far.
- `create_character` and `create_map_object` take no `seed` over MCP, so regenerating those gives a new variation, not the same pixels. `create_isometric_tile` does take a seed (recorded in the manifest).

## Budget

The account is on a trial: 40 generations total, 0 USD credits.

| Call | Cost (generations) |
|---|---|
| `create_character` standard, 4 or 8 directions | 1 |
| `create_character` v3 | 2 to 9 by size |
| `animate_character` template mode | 1 per direction |
| `animate_character` v3 custom action, 48px | about 1 per direction |
| `create_isometric_tile` | 1 |
| `create_map_object` (basic, any size up to 400x400) | 1 |
| `create_building_kit`, `create_tiles_pro`, `create_character_state`, objects | 20 to 40 (out of budget) |
| `pixelart_workbench` (recolor, edit, draw) | free |

### Round 2 (paid plan, cap 150 for this round): 31 used

`create_map_object`, 1 generation each: 22 prompts, 9 retries (props merged or missing; at most 2 retries per idea). Crops in `assets/raw/props3/crops/`, prompts and ids in `assets/raw/props3/log.json` and `assets/manifest.json`, atlas `props3.png` (`tools/build_props3.py`). Contact sheets: `assets/preview/props3_contact_1.png` (world) and `props3_contact_2.png` (vignette props). Accessories, seated poses, fur, floors and walls cost nothing (drawn in code).

### Idle game: assets per stage (before round 2)

Every stage works today with existing art, kitbashes and code-drawn pieces. Optional hero props, 1 generation each (`create_map_object`), waiting on the owner's go:

| Stage | Uses now (free) | Optional hero prop |
|---|---|---|
| Garage startup | concrete floor (tinted tile), boxes, sofa, coffee machine, small furnace | garage roll-up door, workbench |
| Small office | shared desks, break room, WC, lobby | none needed |
| Full floor | desk rooms with tickers, meeting, server, copy, storage | glass partition wall |
| Corporate floor | gold CEO desk (recolor), marble | elevator doors, gold rat statue |
| Megacorp | TV walls (kitbash), furnace x2 | security turnstiles |
| Evil empire | red sky, red corridors, dark walls, furnace x3 and a wide beam | evil throne |

7 candidates for 4 generations; suggested: garage door, gold rat statue, elevator, evil throne.

### Generation log

| When (UTC) | What | Generations | Total used |
|---|---|---|---|
| 2026-09-27 18:57 | Phase 1: 9 tiles and desks (3 styles) | 9 | 9 |
| 2026-09-27 19:10 | Phase 1: 3 rat characters (standard, 8 directions) | 3 | 12 |
| 2026-09-27 19:16 | Phase 1: 6 animations (idle + walk, south-east) | 6 | 18 |
| 2026-09-27 19:41 | Style A variations: props sheet, wall ticker, office chair (map objects) | 3 | 21 |
| 2026-09-27 19:41 | Style A variations: navy rat, 5 tier recolors, frozen, 3 desk edits (`pixelart_workbench`) | 0 | 21 |
| 2026-09-27 19:50 | Phase 2: walk NE, idle NE (templates), stairs, furnace, cash bag, subway floor, HQ floor | 7 | 28 |
| 2026-09-27 19:55 | Phase 2: seated pose (pixen edit), cheer, type, slump (animate_image) | 4 | 32 |
| 2026-09-27 20:02 | Phase 2: tier recolors, palette snaps, desks, blank ticker (`pixelart_workbench`, about 10 edits) | 0 | 32 |
| 2026-09-27 21:39 | Dense floor: 3 prop sheets (break + bath, work rooms, exec + street; 16 props) | 3 | 35 |
| 2026-09-27 21:50 | Dense floor: hero coffee machine | 1 | 36 |
| 2026-09-27 21:55 | Dense floor: kitbashes and code-drawn clutter (`tools/build_props2.py`) | 0 | 36 |

Left: 8.

Source: PixelLab MCP `agent_help` answers and tool descriptions (REPORTED), https://api.pixellab.ai/mcp/docs (VERIFIED for template and v3 animation pricing).
