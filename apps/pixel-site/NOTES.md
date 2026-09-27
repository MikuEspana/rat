# pixel-site notes

Running log of decisions and blockers. Newest first inside each section.

## Decisions

- **Data loading (owner, 2026-09-27):** `/api/rats` is about 1.7 MB at 3,000 rats. Load it once on page open, then follow `/api/events` (every 5 s) for new hires, freezes and burns. Never re-poll the full roster. Live PnL and tiers are recomputed in the browser from `/api/state` stock prices with the `@rat/contract` display math (`valueUsd = tokenAmount x priceUsd`). A rat hired after page load has no `tokenAmount` in its hire event, so its value is estimated as `costUsd x price_now / price_at_hire` (price at hire = the stock price in the latest `/api/state` when the hire event arrives). Small error from slippage; exact again after a reload.
- **Style (owner, 2026-09-27):** style A Blueprint. Tiers read by SUIT color, all free recolors of one rat: intern brown/khaki + red tie, analyst navy + red tie, associate forest green + gold tie, vp burgundy + gold tie, partner black with gold lapel trim + gold tie, frozen whole rat grey. No pale suits. 1px dark outer outline (#16182c) on every tier. Files: `style-samples/a-variants/`.
- **Variations shown (A1 Contrast, A2 Warm, A3 Dense):** waiting on the owner's pick. A3 uses 3-block walls so the wall ticker fits.

## Blockers

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

Left: 19. Phase 2 plan with the recolor approach fits in about 13 to 16.

Source: PixelLab MCP `agent_help` answers and tool descriptions (REPORTED), https://api.pixellab.ai/mcp/docs (VERIFIED for template and v3 animation pricing).
