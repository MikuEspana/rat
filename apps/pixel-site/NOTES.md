# pixel-site notes

Running log of decisions and blockers. Newest first inside each section.

## Decisions

- **Stages by SOL claimed, and the Company Roadmap (owner, 2026-09-29).**
  - The stage (which ring is open, the stage banner, the building sign, the NEXT FLOOR lots and their scaffolding at 90%, the HUD stage bar) goes by `treasury.totalClaimedSol`: 0, 0.25, 1, 5, 20 and 50 SOL. It is read in one place, `stageSourceSol` in `src/floor/stage-source.ts`, so a later change of source (a staging-only field) is one edit. A stage never closes.
  - Rooms, desks, landmarks and the sewer still go by rats hired: `STAGES[k].rats` keeps each ring's planned hire range (amenities open at even steps through it), and desks are handed out by hire count (shared garage and open offices until the 100th hire, then stock rooms) instead of by stage, so a page load (all the SOL first, then the roster) seats every rat where a live session did.
  - The job-fair line no longer counts toward the stage (fees in line are already claimed SOL).
  - `?rats=N` maps N to the SOL that shows the stage N rats used to (`solForRats`), or `&sol=X` pins it.
  - The Company Roadmap (`src/ui/roadmap.ts`) sits bottom right on a desktop, in the space the feed leaves free (the rat card takes the corner while open). Under 900 px it is one line between the feed and the news ticker; the feed gives up the rows it moved up, and a phone's establishing shot centres the building in the rows the panels leave free, so the Vault shows. Headless check: the panel never meets the Vault's pile, the JOB FAIR sign or any rat drawn in the line, at every stage, 1440x900 and 375x812 (`window.__site.onScreen()`).

- **Round 4: landmarks and layout variety (owner, 2026-09-28).** Every stage only added a ring of rooms.
  - **Landmark unlocks** (`src/floor/landmarks.ts`, drawn by `src/world/landmarks.ts`), one set piece per milestone:
    - 10 espresso shrine on the garage furnace plaza
    - 25 ping pong table in the small office lobby
    - 50 crypto trading pit in the first open-plan room
    - 100 glass elevator: the office tower goes up behind the back corner and gains a floor every 30 rats
    - 250 basement gym and nap pods, dug under a lot beside the office
    - 500 rooftop helipad with the CEO's helicopter on the tower
    - 1000 giant golden rat in the corporate lobby
    - 1500 rooftop pool party on the second tower
    - 2000 rat rocket on a launchpad across the cross street
    - 3000 evil throne room with a laser beam into the sky
  - Interior set pieces keep their space clear when the room is furnished (`plan.ts`), so desks never move for them. Before it unlocks, an outdoor landmark's lot is a fenced site with cones.
  - **Cinematic reveal:** on unlock the camera flies to the landmark (framed by its size, clear of the banner), shows "UNLOCKED: ROOFTOP HELIPAD" for 3.6 s, then eases back. A click or a key skips it. It never starts while the viewer is dragging or has moved the camera in the last 4 s. It shows the banner only.
  - **Growing up, not only out:** the tower rises every 30 rats and is drawn bigger every stage so it keeps towering over the office. The company name moves onto its roof. From megacorp a second tower joins it by a sky bridge. The basement gym sits below street level.
  - **Wing shapes:** each ring opens one side (wing) at a time in an L or T order that alternates per ring. Wings not open yet are city lots, not blueprints. From the corporate floor an annex stands across the avenue, reached by a sky bridge from a pylon at the office's front.
  - **Labels:** room names show only at mid zoom. Zoomed out, only landmark names and the company name show, sized to stay readable.
  - **Claim copy:** every claim now hires rats ("0.35 SOL in creator fees, all of it hires rats"). Fixed at the source: the mock API's claims and the shared contract fixtures (`packages/contract/mock/events.json`, `state.json`) still had the old 50/50 split.

- **Round 3: a real city and idle hooks (owner, 2026-09-28).** The ring of buildings read as a fence.
  - **Street hierarchy** (`src/floor/city.ts`, drawn fresh per stage): one avenue past the front with the subway on its near sidewalk, one cross street beside the office, one alley behind it. Big blocks get a footpath, so each side has 2 or 3 irregular blocks. Blocks split recursively into lots of mixed sizes; a quarter of the split decisions break the rules (a lot left big, or cut off-centre).
  - **Every lot has a purpose:** a building, park (trees, bench, fountain), parking lot (bay lines, parked cars), building site (fence, scaffold, crane, cement, portaloo, a hard-hat crew) or fenced vacant lot. No bare ground.
  - **Falloff and edge:** taller near the office, houses, parks and empty lots towards the edge. The edge is an irregular circle that dithers (4x4 ordered) and darkens into the night, with a faint far skyline behind (evil red at the last stage).
  - **Composition:** the establishing shot puts the office on the lower-left thirds point and the city's tallest building on the opposite diagonal. From the corporate floor on, our own tower rises behind the back corner and towers over everything by megacorp.
  - **Growth:** each stage converts 2 to 4 lots next to the office up a level (house, shop, office); the office absorbs the lots next to it as it grows. A building is rerolled when a neighbour has the same sprite or reads the same height.
  - **Street scenes:** street furniture by Poisson disk along the sidewalks, plus a food truck with a queue, a smoker outside a shop, a delivery with a box, and the crew on the building site. One-way traffic on the avenue and the cross street (every car drives the way its sprite points).
  - **Idle hooks:**
    - lots the office takes next are grey shells labelled "NEXT FLOOR AT n RATS"
    - at 90% of a stage they get scaffolding, a crane and a crew
    - unlocks drop in with a bounce, puff dust, hold a beat, shake 2 px and chime (sound toggle on the HUD, off until switched on)
    - 3 nested HUD bars (desk room filling up, next room, next stage)
    - a RAT NEWS ticker from the live numbers whose voice darkens every stage
    - a visitor every one to three minutes (pizza delivery, the inspector cat, a pigeon)
    - applicants queue in the lobby, and the founders hang about the garage from day one
  - **Find my rat:** search by wallet (or #id or name), the rat card opens with a spotlight, `?rat=<id>` or `?wallet=<address>` links straight to it (COPY LINK on the card), and an era badge from the stage the company was in at hire ("FLOOR 1 OG").
  - **Timelapse:** one click replays the company from its first rat to now and records the canvas (MP4 where the browser can, WebM otherwise) with a caption, then puts everything back. Hires that arrive meanwhile are picked up at the end.

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
- **Round 5: weak spots, THE VAULT, zoning, the sewer, WALL STREET RATS (owner, 2026-09-28).**
  - **Weak spots:**
    - Rats at pod desks really type. Facing the camera: the seated pose edited with `edit_image_pixen`, then a 7 frame `animate_image` typing loop, recoloured for every tier and fur with maps learned from the tier sheets (`tools/build_rats2.py`). Back to the camera: forearms forward, elbows and head moving (drawn in code; the generated back view failed twice).
    - Accessories redrawn about twice as big with bold outlines; walking rats carry a briefcase.
    - Rear views of all 8 cars, so traffic drives both ways.
    - Unbuilt rooms and shut wings are building sites (dirt, tape, material, cones, cranes, hard-hat crews).
    - 4 layer skyline with parallax; room signs hide below zoom 0.62.
  - **THE VAULT:** the money pile at the centre of the building replaces the furnace. It shows the Wall Street Rats portfolio (the sum of all the rats' stock holdings, USD) in 6 stages: $0 loose change, $50 cash on a desk, $500 a cash pallet, $5K a money mountain, $50K an overflowing glass vault, $500K a money bin with rats swimming. Hires fly bills in from the sewer with "+$X"; a burst rains bills; a new stage rises with a bounce and a VAULT UPGRADE reveal; it shimmers green while the portfolio is up and dims while down; clicking it opens the total, the breakdown by stock and the rat wallets. `?vault=USD` and `?vaultpnl=%` pin it for screenshots.
  - **Burn is gone:** no furnace, no burn visuals, feed lines, HUD fields or news. The simulator never burns (its burn rules and tests are gone; `rules.test.ts` still checks every number it uses against the worker). The dev mock API (`apps/api`) still emits burn events; the site ignores them.
  - **The espresso shrine** is a giant espresso machine in the garage's back corner, with steam and rats kneeling round it.
  - **Zoning** (`floor/zones.ts`, `floor/scene.ts`, `floor/signs.ts`): every tile has a zone and an area (interior, street, spawn, skyline) and every placement claims its tiles; what does not fit is skipped. Landmarks have fixed slots inside the building (towers in the first ring's corners, the gym in the full floor's lobby, the espresso machine in the garage corner); the rocket and the annex stand in lots of their own. The job-fair line is laid out with everything else, outside only. Every sign has a fixed spot and one layout keeps them apart at every zoom. `zones.test.ts` checks it all at 0, 10, 100, 1,000 and 2,000 rats and the stage edges.
  - **The sewer:** new rats come out of it instead of the subway stairs, in the owner's four steps: one manhole, two (50 hires), a steaming grate with vents (250), a big sewer entrance with a WALL ST RATS HIRING sign and a marching line (1,000). The job-fair line's applicants come up through it too; a hire walks in from the front of the line, or climbs out of the sewer when nobody is waiting.
  - **Name:** WALL STREET RATS everywhere a viewer reads it (a test fails if "RAT RACE" comes back).
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

### Round 4 (cap 40): 21 used

14 map objects used, 7 retries (the elevator came out as a glass shaft, the rocket too small, the launchpad with a rocket on it, the laser cannon read as a spire, the statue's rat too small, the vault door twice as a drum). No idea was retried more than twice. Log in `assets/raw/props5/log.json`, contact sheet `assets/preview/props5_contact.png`, reveals `assets/preview/landmark_reveals.png`. The towers, pylon and sky bridges are drawn in code (free). Notes: the pool party sheet duplicated the flamingo and had no tiki bar; the nap pods sheet made 2 pods and 2 beds.

### Round 3 (cap 100): 26 used

17 map objects plus 3 retries, 3 character creations (cat, pigeon, one pigeon retry) and 4 walk directions. Log in `assets/raw/props4/log.json`, contact sheet `assets/preview/props4_contact.png`. Notes: the corner store's generated sign read a rude word, repainted by hand to SHOP (free); the street name sign has gibberish text and is left out; the pigeon is an upright pigeon-person (a true bird body needs the 20 to 40 generation mode).

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

### Round 5 (caps about 25 + 15 + 15): 29 used

- 6 for the rats: 2 seated pose edits, 2 back view edits (rejected), 1 typing animation (used), 1 back typing animation (rejected: glowing eyes, arms down).
- 8 rear views of the cars (`edit_image_pixen` on each front sprite, all first try).
- 9 for the Vault: 6 pile stages, the flying bill, the giant espresso machine, the kneeling rat. The money bin had a solid background (cut out) and a person in a suit (painted over with coins).
- 6 for the sewer, all first try.

Log in `assets/raw/props6/log.json`, previews in `assets/preview/round5_weakspots.png`, `vault_stages.png`, `vault_live.png`, `zoning_stages.png`, `sewer_stages.png`.

### Round 6 (cap 20): 0 used

Rename, zoning, the manhole and the espresso machine reuse round 5 art (the espresso machine is `r5_espresso_giant` in `assets/manifest.json`); no new PixelLab generations.
