# WALL STREET RATS: the film (`?film`)

A hidden mode of the pixel site that plays a 35.6 s product film on a fixed timeline: 128 BPM, 76 beats (19 bars),
60 fps. Every cut, hit and caption sits on a beat. All data is staged (mock roster, fake wallet on the rat card).
Branch `film/demo` only.

## Run it

```sh
pnpm install
pnpm --filter @rat/pixel-site dev          # then open one of:
```

| URL | What |
|---|---|
| `/?film&play` | the whole film in real time, on a loop (a slow machine drops frames; the recorder never does) |
| `/?film&shot=6&play` | shot 6 alone with 1 s handles, on a loop |
| `/?film&aspect=9x16` | the vertical cut: every shot is re-framed, not cropped (1080x1920) |
| `/?film&text=0` | no captions, counter or stage banners (clean plates) |
| `/?film&end=pile` | the alternative ending: the rats pile up into the logo |
| `/?film&frame=1990` | one frame, for stills |

Nothing of the live site runs in film mode: no API, HUD, feed, panels or debug UI.

## The timeline

| Shot | Beats | Seconds | What happens | Set |
|---|---|---|---|---|
| 1 Hook | 0-8 | 0.0-3.8 | a coin drops in the manhole's slot, the lid blasts off, the scruffy rat bursts out, looks around, hops out. "EVERY FEE HIRES A RAT" | street (hero scale) |
| 2 Suit up | 8-12 | 3.8-5.6 | the lid clangs back, smoke, the rat spins faster and faster, lands in a suit on beat 10, straightens its tie | street |
| 3 Clock in | 12-20 | 5.6-9.4 | walks in, sits, cracks its knuckles, types; its NVDAx coin lands on beat 18. "EACH RAT BUYS A STOCK" | office (hero scale) |
| 4 The team | 20-28 | 9.4-13.1 | a rat drops into a chair on beats 20, 22, 24, 25, 26, 26.5, 27 (each with its stock), snap zooms out | office |
| 5 The fund | 28-40 | 13.1-18.8 | the real game world: the Vault's door bursts open (32), bills pour in from every desk, the rats' fund counter races, rats flood out of the sewer. "NOBODY EVER SELLS" | world |
| 6 Expansion | 40-56 | 18.8-26.3 | BOOM on 40: CORPORATE FLOOR; BOOM on 48: WALL STREET (the megacorp build), the skyline lights up | world |
| 7 Proof | 56-64 | 26.3-30.0 | push in, a cursor clicks a rat, its card opens (RAT #0427, stock, shares, value, fake wallet, VIEW ON SOLSCAN). "EVERY RAT IS ON-CHAIN" | world |
| 8 End card | 64-76 | 30.0-35.6 | pull back: the Vault is a cathedral of money with rats at work on it; push in to its door; the logo slams onto the door on beat 70 while the hero straightens its tie; "EVERY FEE HIRES A RAT"; a coin rolls off the cash, down the street and into the manhole: the first frame of shot 1 | vault (world scale, then hero scale), street |

Code: `src/film/timeline.ts` (beats, shots, captions), `street.ts`, `office.ts`, `worldscene.ts`, `ending.ts`
(`VaultEnd`, `PileEnd`), `film.ts` (driver, captions, flags), `clock.ts` (fake clock, seeded randomness, imported
first by `src/main.ts`), `stage.ts` and `pixel.ts` (whole-number scaling, the bold pixel font).

## Pixel rules

- Hero sets are drawn in base pixels and scaled by a whole number (8x, 10x, 4x, 3x); zooms on hero sets are snap
  zooms on the beat. The world shots use the site's own renderer with eased (log-space) zooms.
- The hero is 128 px, redrawn from the game's own analyst rat, and never shares a frame with 48 px world rats.
- Lighting is banded (flat steps), baked into the plates by `tools/film_build.py`; glows in the film are banded too.

## Record it

```sh
pnpm --filter @rat/pixel-site dev                                       # or: vite build + vite preview
python3 apps/pixel-site/tools/film_record.py all OUT                    # everything (4 passes in parallel)
python3 apps/pixel-site/tools/film_record.py shot OUT 6                 # re-record one shot, text and no text
python3 apps/pixel-site/tools/film_record.py shot OUT 8 --aspect 9x16 --end pile
FILM_URL=http://localhost:4174/ python3 ...                             # record from another server
FILM_GPU=1 python3 apps/pixel-site/tools/film_record.py all OUT         # on your own computer: uses the graphics card
```

On a computer with a graphics card: `pip install playwright imageio-ffmpeg`, then `python -m playwright install chromium`
once. With `FILM_GPU=1` a Chrome window opens and steps through the frames; leave it alone until it closes.

Needs Python Playwright (Chromium from `PLAYWRIGHT_BROWSERS_PATH`) and `imageio-ffmpeg` (libx264). Each frame is
rendered once and captured twice (with and without captions), as JPEG q100, into H.264 (CRF 12, `-tune animation`,
yuv420p, 60 fps). Deterministic: the world scene sets its clock, random seed, camera and depth sort for every
simulation step, so a frame is identical whether a shot is rendered alone or inside the film (checked: 0 differing
pixels). Per-shot clips are the shot's frames from the full film with 1 s handles rendered on the shot's own set.

Exports (`all`):

```
wall-street-rats_16x9.mp4, wall-street-rats_9x16.mp4          the film, Vault ending
end-card_16x9.png, end-card_9x16.png                          the end card still
clean/                                                        the same without captions
shots/16x9/, shots/9x16/                                      shot1..8, _text and _notext, 1 s handles
loops/shot6_loop_10s_{16x9,9x16}_{text,notext}.mp4            10 s seamless loop of shot 6
alt-ending-pile/                                              the film with the pile ending, its shot 8 clips, stills
```

## Art

New for the film (PixelLab, every call in `assets/film/manifest.json` with its args and cost): the on-model hero
(suited, scruffy, 8 rotations each, burst, look around, spin via rotations, tie, walk, knuckle crack, typing,
tumble), the manhole hole and lid (and its spin), the coin (and its spin), the smoke puff, the BOOM cloud, the desk
and chair, the Vault's door bursting open, the gold cathedral, the Vault's front door. Raw files in `assets/film/raw/`,
baked frames in `assets/film/built/` (`python3 tools/film_build.py`, free).

Reused from the site: the game world, rats, desks, Vault stages, flying bills, sewer, cranes and scaffolding, city
and skyline (`src/world/`, `assets/*.png`), the sidewalk tile, the city towers in the backdrops, the mock roster
(`packages/contract/mock/`). Drawn in code: asphalt, curb, office wall and windows, ticker, captions, counter,
banners, cursor, the rat card, the logo letters and the plaque.
