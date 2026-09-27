# pixel-site notes

Running log of decisions and blockers. Newest first inside each section.

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

Source: PixelLab MCP `agent_help` answers and tool descriptions (REPORTED), https://api.pixellab.ai/mcp/docs (VERIFIED for template and v3 animation pricing).
