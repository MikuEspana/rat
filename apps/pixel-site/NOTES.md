# pixel-site notes

Running log of decisions and blockers. Newest first inside each section.

## Decisions

- **Dense floor (owner, 2026-09-27):** the Phase 3 floor read as a spreadsheet. Rebuilt as one packed building (`src/floor/`): a slicing floor plan with 2-cell corridors only at the top splits and shared walls below, so rooms touch. HQ shrunk to about 10x10 in the centre. New room types: break room, bathroom, server room, copy room, meeting room, storage, lobby, the CEO corner office (partners sit there while it has desks). A big stock gets several stock rooms of different sizes, each laid out one of six ways (columns, rows, split, perimeter + island, pods, mixed) with jittered desks, mirrored clusters and clutter. About 7% of rats are away from their desks at any time: coffee, water cooler, vending, chats, bathroom queue, copier, filing, meetings, whiteboard, server checks, furnace watching, corridor strolls, box runs, smokers outside, naps at the desk. Night sky backdrop, street ring with lamps and the subway stairs outside the lobby.
- **Dense floor art budget (owner, 2026-09-27):** stay free; kitbash and draw clutter in code; PixelLab only for hero props. Before that message arrived 3 generations had gone on 3 prop sheets (vending machine and server rack among them); after it, 1 hero generation (coffee machine). Gold CEO desk is a free recolor. Everything else is kitbashed or drawn in `tools/build_props2.py`.
- **Data loading (owner, 2026-09-27):** `/api/rats` is about 1.7 MB at 3,000 rats. Load it once on page open, then follow `/api/events` (every 5 s) for new hires, freezes and burns. Never re-poll the full roster. Live PnL and tiers are recomputed in the browser from `/api/state` stock prices with the `@rat/contract` display math (`valueUsd = tokenAmount x priceUsd`). A rat hired after page load has no `tokenAmount` in its hire event, so its value is estimated as `costUsd x price_now / price_at_hire` (price at hire = the stock price in the latest `/api/state` when the hire event arrives). Small error from slippage; exact again after a reload.
- **Style (owner, 2026-09-27):** style A Blueprint. Tiers read by SUIT color, all free recolors of one rat: intern brown/khaki + red tie, analyst navy + red tie, associate forest green + gold tie, vp burgundy + gold tie, partner black with gold lapel trim + gold tie, frozen whole rat grey. No pale suits. 1px dark outer outline (#16182c) on every tier. Files: `style-samples/a-variants/`.
- **Final style (owner, 2026-09-27):** mix A3 + A2: A3 density (desk clutter, wall ticker, chairs, bin, paper pile) with A2 oak desk tops, plants and lamp glow. Tier tweaks: VP brighter crimson (was burgundy, read as intern brown), partner louder gold (wide gold tie, bright gold lapels, gold seams, gold collar from behind). Assets: `assets/` (see `assets/README.md`).
- **Phase 4 next-hire ring:** the API has no "next hire" timestamp, so the ring runs from `bot.lastClaimAt` to `bot.nextClaimAt` (claims fund the hires) and says "hiring..." once the claim is due.
- **Phase 4 leaderboard:** uses the server's `leaderboard.top` / `bottom` from `/api/state` (ranked on the server); the rat card's rank is recomputed in the browser from live PnL.
- **Phase 3 floor plan:** rooms in a grid of equal slots (4 x 3 for 10 stocks), HQ in a middle slot (fills it; marble plaza around the furnace, which scales by a whole number with the slot), subway in the front corner slot, stock rooms nearest HQ. A room is sized for `ceil(1.3 x rats) + 6` desks at page load; beyond that, new rats stand in the room's front walkway until a reload. Desks fill in a fixed shuffled order so a half-full room looks evenly busy. Desk pitch 3 x 3 cells; seated rat at desk + (-0.75, +0.5) cells, tuned on the sprites.
- **Phase 3 moods:** a stock's 24h change above +0.25% makes its seated rats cheer now and then (stand up, fists up, sit back); below -0.25% they slump; otherwise they type. Paused stocks: frozen rats, grey and still.
- **Phase 3 rendering:** one texture and one depth-sorted, culled `ParticleContainer` for everything that must overlap correctly (rats, desks, chairs, walls, props); floor in a static `ParticleContainer` uploaded once. Tried floor patches (one TilingSprite per room clipped by a mask): fewer quads but much slower in the software renderer (stencil and overdraw), so reverted.
- **Phase 2 facing plan:** walk and idle drawn for south-east and north-east; south-west and north-west are mirrors. Seated rats (type, slump) face screen right on their own chair; mirror to face left. Cheer is standing, facing south-east (arms read best toward the camera).

## Blockers

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
