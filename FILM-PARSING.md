# Halo Infinite film parsing — working notes

Goal: turn film (theatre) chunks of completed matches into readable JSON, eventually to render an overhead minimap.
References: [JGtm/LevelUp](https://github.com/JGtm/LevelUp) (Go; RE notes in `.ai/V7.5/film_re/`, code in `apps/go-api/internal/analysis/filmdec/`) and dend/blog-comments#5.

## Usage

```
npm start -w match-downloader -- <matchId> [outputDir] [--force-download] [--force-parse] [--packets]
# downloads if chunks are missing/wrong size; parses if film.json/positions.json are missing or older than manifest.json
npm run typecheck -w match-downloader
npm test -w @gravllift/halo-film                                # node:test via tsx
npm run typecheck -w @gravllift/halo-film
```

It writes `film.json` (players, registry, chunk/frame timeline) and `positions.json`
(`layout`, `flipRates`, `tracks` per biped slot, `actors`). `films/` is gitignored.
Sample matches: `5a997c10-5ff3-42bf-99ca-e81bce97ef10` (8 players, use this one) and
`26d45816-3c2b-41ae-84b5-9e0cc1d1c096` (9 roster entries, one is likely an observer).

## Layout

- `libs/halo-film` (`@gravllift/halo-film`): the core data package. Public entry points are `loadFilm` (spectate + match stats + an injected `fetchChunk` in, `MatchReplay` out) and `buildReplay` (same, from chunks already downloaded). `MatchReplay` carries the timeline plus static map data (`map.objectives`, `map.background`, where `background.image` is a file name the renderer resolves). Lower-level entry points `parseFilm`, `extractFilmPositions` and `readHighlightEvents` take in-memory chunks (`FilmChunkInput`, sync or async iterable) and `FilmMetadata`. It does no I/O itself and uses `node:zlib`/`Buffer`, so it is Node-only (bundlers polyfill).
- `packages/halo-query/components/replay`: one renderer of a `MatchReplay` (canvas minimap and player cards).
- `packages/match-downloader`: downloading, manifest/chunk files (`src/film-files.ts` `openFilmDirectory`) and `src/ensure-film.ts` (download-if-missing, parse-if-stale) behind `index.mts`.

## Code map (`libs/halo-film/src/`)

| File                    | Purpose                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `core/bit-reader.ts`    | MSB-first bit reader (`bitAt`, `peek`, `read`, `peekLittleEndianBytes`)                                 |
| `core/packets.ts`       | `inflateChunk` (zlib), `splitPackets`, `PacketType`                                                     |
| `decoders/roster.ts`    | `parseRoster`: xuids at arbitrary bit offsets, gamertag UTF-16 152 bits + 16-bit terminator before xuid |
| `core/registry.ts`      | `parseRegistry`: ECS component registry (chunk 0)                                                       |
| `parse-film.ts`         | `parseFilm` -> film JSON                                                                                |
| `core/biped-records.ts` | bit-scan for biped record headers; `findBipedSlots`                                                     |
| `core/i0-layout.ts`     | detects position-block axis widths from bit flip-rate sawtooth                                          |
| `decoders/positions.ts` | `extractPositions` / `extractFilmPositions` (tracks + actors)                                           |
| `players/link-lives.ts` | `linkLives`: chains lives (slots) into anonymous actors                                                 |
| `film.test.ts`          | tests (bit reader, packets, roster, link-lives, slots, integration on sample film)                      |

Folders: `core/` (bit reader, packets, registry, record and layout primitives), `decoders/` (per-packet decoders:
positions, damage, fire, stat records, inventories, projectiles, world objects, roster, highlights), `players/`
(binding lives to players) and `timeline/` (derived state: score, zones, hills, flags, player stats, `replay`).
Entry points stay at the top level.

## Format facts (verified)

- Chunk = zlib stream. Packets: `[type u16 LE][b2][b3][size u32 LE][timestamp µs u64 LE]` + payload, ending at type 7.
- Chunk 0 (ChunkType 1) = component registry, not packetized. Chunks ChunkType 2 = ~20 s each of gameplay
  (type 1 start, 2 keyframe, 6, 8 player metadata, 12 bot metadata, then ~1199 pairs of type 0 frame/delta + type 10).
  Last chunk (ChunkType 3) = big type-9 footer (gamertags repeated, no biped binding).
- Time base: first gameplay packet's timestamp. The game clock runs during loading screen + intro cinematic;
  players do not move until ~0:37 in theatre (confirmed by user), which matches first tracks at ~39 s. Not a decode gap.
- Type-8 player metadata is identical in every chunk (no per-chunk info).
- **Biped record header** in type-0 frame payloads (bit offsets from record start p):
  `[1 prefix=1][13-bit slot][2-bit tag=1][2 bits 0][3-bit maskCount 2..7][6-bit ascending component indices, first 0]`;
  position block `i0 = p + 21 + 6*maskCount`: 5 gate bits (first 3 zero), then quantized X, Y, Z.
- Axis widths are per-map (match 5a99…: 15/15/17), found from the flip-rate sawtooth between consecutive records of a slot.
- Biped slots (archetype 35) start at 512 and increase as players respawn; a slot is ONE LIFE. Noise headers sit near 1000-3000.
  Dead slots leave gaps, so `findBipedSlots` anchors on the busiest slots and accepts any slot above 5% frames within 24 of an anchor.
- Dequantization needs the per-map BSP AABB (from game modules, unavailable): `W = min(26, ceilLog2(ceil(60*extent)))`,
  `world = min + step*(q+0.5)`. Without bounds only quanta/normalized [0,1) are emitted.
- Plot of all normalized x/y of match 5a99… traces a clean map layout (corridors/rooms), so decoding is right.

## Slot -> player mapping (partially solved)

Superseded: each biped creation record names its owner (see "Highlight events and player binding"). The notes below are the original timing-based attempt.
Film has no slot-to-player binding (LevelUp lists the same as unsolved: biped carries a RAM entity handle).
`linkLives` chains lives by the constant ~10.1 s respawn gap (first-died, first-respawned). On the sample match it
yields exactly 8 actors, ~130 respawns with a 10.1 s gap. Caveats:

- Two near-simultaneous deaths can swap actors; not flagged.
- Actor life counts (17,18,16,17,16,22,21,20) don't match stats deaths (17,16,16,15,20,13,20,23) → some tracks are split/spurious
  or chaining errors. Don't assign gamertags from counts.
- `MIN_LIFE_MS = 4000` drops post-match noise fragments (slots ~3000+ after the final whistle).

## Next steps

1. Name the actors: group by team via spawn positions + team from match stats (`getMatchStats`, `stats.json` can be saved next
   to the film), then disambiguate using kill/medal events in the film (LevelUp: damage records are type-0 packets with
   `payload[0]==0xd2`, attacker = R(5)>>1 at +0x0c; kill-feed events carry gamertag+xuid inline).
2. Investigate death-count mismatch (spurious/split tracks); add outlier filtering (isolated samples, teleports; LevelUp `DropIsolated`/`DropTeleports`).
3. World coordinates: per-map bounds (manual `--bounds`/lookup table), then meters = q \* extent / 2^W.
4. Decode further components after i0: i1 velocity, i2 aim, i4 health, i5 shield (see LevelUp `offline_biped.go`).
5. Tests for `i0-layout` and `findRecordCandidates` with synthetic bit data; integration test on match 5a99… (layout 15/15/17,
   slots 512-519 near t≈39 s, 8 actors).
6. Minimap renderer (anonymous colour per actor, team split is already enough to start).

## Environment gotchas

- Windows/PowerShell: don't do multi-line `-replace`; use the edit tool. Files may be LF.
- TypeScript style: no `as` casts, avoid `any`.
- LevelUp reference files can be re-fetched: `gh api repos/JGtm/LevelUp/contents/<path> -H "Accept: application/vnd.github.raw"`.

## Biped components after i0 (aim, health, shield)

`src/components.ts` (`readBipedComponents`) walks the record's mask indices in ascending order after the
position block (+2 tail bits), ported from LevelUp `grammar/offline_aim.go` / `vitality.go`
(JGtm/LevelUp, `apps/go-api/internal/games/halo_infinite/film/internal/grammar/`). Modelled: i1 velocity,
i2, i3 (skipped by width), i4 health (8-bit endpoint quantum, -1..1, clamp 0..1), i5 shield (8-bit, 0..4,
q=64 is a full shield, higher is overshield), i21 aim (12-bit yaw, 11-bit pitch). Decoding stops at the first
unmodelled index. Results land on `PositionSample` (`aimYawDeg`, `aimPitchDeg`, `health`, `shield`, `shieldQ`)
and are forwarded by `createReplay` (last value held).

Validation on match 5a997c10: shield quanta all <= 64 (no overshield); aim yaw vs 30-sample movement heading
has median error ~22 deg (p25 ~8; strafing explains the rest). Health only appears in records once damaged.
Not yet done: ADS zoom events (type 21 in the packet event list, see `zoom_events.go`), names/teams
binding for slots (`player_table.go`, `player_teams.go`, `killhealth.go`), inventory (`inventory_decode.go`),
dyn-prec i2/i3 variants for some archetypes.

## Highlight events and player binding

- Manifest chunk type 3 (last chunk) is the highlight-events feed: kill, death, medal and mode events with the player's xuid, gamertag and a film-clock time. Parsed by `parseHighlightEvents` (`src/highlight-events.ts`, port of SPNKr/LevelUp `highlight_events.go`); `readHighlightEvents(chunks, majorVersion)` finds the chunk.
- **Exact binding (preferred).** A biped's creation record (`decoders/biped-creations.ts`, LevelUp `biped_creation.go`) is `001 [slot 13][gen 2][type 6 = 35]` then `[1][version u8 = 13][1][representation u32 = 0x1876BDA0][0][owner u5]`. The 5-bit owner is the participant index, which is the 5 bits before each xuid in the player metadata packet (`parseRoster().playerIndex`). `extractBipedCreations(chunks)` returns both; pass it as `bipedOwners` to `extractFilmPositions`. On 047b96c8 it names 245 of 255 lives the same as the death model and fixes the 10 it got wrong (round-end respawns with short delays, swapped first lives).
- Fallback for lives without a creation record (noise tracks, unreadable films): `bindPlayers` (`src/players/bind-players.ts`) treats a player's death list as their whole timeline: the life after death k ends at death k+1 and starts one respawn delay (estimated from the film, ~10.1 s) after death k. Tracks are assigned to those lives in one minimum-cost assignment (Hungarian). Respawn delay shortens near round ends and rounds reset everyone without a death, so this fallback is imperfect there.
- Previously, `bindPlayers` named each biped life by the death that ends it. A constant clock offset between event time and track time is searched (±5 s, most matches then tightest gaps); on sample match 5a997c10 it is -60 ms and 137/140 deaths match a life end within 250 ms. Unnamed lives (survivors, final lives) go to the player who is dead at that time and died most recently.
- `extractFilmPositions(chunks, { highlightEvents, players })` returns bound actors (`xuid`, `gamertag`, `team`) when more than half the deaths match, else the old anonymous `linkLives` actors. `Replay.players` carries identity per actor id.
- Teams come from the caller (`stats.json` `LastTeamId` in match-downloader, `match.Players` in Halo Query). Reading the ti=9 managed-player team designator from keyframes (LevelUp `player_teams.go`) is not ported.
- Remaining: ADS zoom events (FOV), inventory, FOV cone/health bars/inventory on the canvas.

## Stat records and score

`stat-records.ts` finds entity "stat records" in frame packets by scanning every bit
offset for the measured header (`1`, 13-bit id, gen `0b10`, sparse/dense component
list) followed by `[5-bit round x2][A][B][flags][C?][D?]` components. Slots 6 and 8 are
the two teams, 10..24 (even) the players. Ported from LevelUp's `statborg.go`.
Component 0 channel A of a team slot is the mode score as displayed (CTF captures,
Slayer kills, ...). Times share the position time base.

`score.ts` keeps the longest strictly increasing run per (slot, round), sums rounds,
and maps slots to team ids using the final scores in the match stats. Verified on
5a997c10 (CTF, final 1-2) and a KOTH match.

The in-game clock is not decoded (LevelUp has not found it either); there is no clock in the UI.

### Per-player counters

Stat slots 10..24 (even) carry personal score (comp 1 B), kills/deaths (comp 2 A/B) and assists (comp 3 A). Slots have no identity, so uildPlayerStats matches them to players by final counters (verified 8/8 on the CTF sample), then by slot order.

### Keyframe inventory

Keyframe packets (about every 20 s) hold biped records (header `[id:32][field:26][type:6]`, type 35). `keyframe-world.ts` walks them; `inventory.ts` finds catalogued 32-bit weapon family ids (`weapon-catalog.ts`), the ammo block that ends just before the first family id (magazine, reserve, charge gauge), and the grenade counts (Frag, Plasma, Dynamo, Spike). Caveats: the drawn weapon slot to family mapping is a heuristic; equipment rank is often unread and its names depend on the match's ability palette; selected grenade is not yet read reliably. Between keyframes see "Live inventory from frames" below.

### Live inventory from frames (`inventory-deltas.ts`)

Biped delta records in Frame packets carry changed components only. `readBipedComponents` now walks the mask through i21 (full width), i22, i24 to i29 and the weapon-state components i30 to i41 (widths from LevelUp's `unit_weaponstate.go`), with a visitor callback that exposes each component's start bit. It stops at i23 (width depends on a record-state parameter we do not have) or any other unmodelled index.

- i22 `unit-grenade-counts`: R(3) = 4, then four R(8) counts (Frag, Plasma, Dynamo, Spike), each at most 2.
- i30 / i33 `weapon-state-ammo` (weapon slots 0 and 1): gate (0 = present) + R(8) magazine, then gate + R(12) charge fraction (not used).
- i31 / i34 `weapon-state-rounds-inventory`: R(11) reserve.

Validated on ac95a301: 57 of 57 grenade readings have count 4 and values at most 2, and magazine readings step down by one per shot (14, 13, 12, ...) and jump on a reload together with a reserve reading. `Replay.loadout` overlays readings newer than the last keyframe for the keyframe's drawn slot, and `atMs` becomes the newest reading used. Not decoded from deltas: drawn slot changes, the selected grenade (i47 sits behind the weapon-set components) and equipment.

**Weapon pickups (i42 + i44).** i42 is a 7-bit component that follows i41 in the mask. When a unit takes hold of an object the record also carries i44: a gate bit (1 = take, 0 = release) and the object's 64-bit id, whose high half is the weapon family (the same ids as `weapon-catalog.ts`). Flags use the same pair (family `2a392328`, release has gate 0 and 17 bits), so only catalogued non-grenade families count as weapon pickups. Verified on b7ecb729: CaStiLLoNN's SPNKr pickup at 41.8 s (slot 518, killed without firing), sniper pickups from the pads, and each pickup record also carries that slot's i33/i34 ammo, which tells which weapon slot received it. `Replay.loadout` treats a pickup newer than the keyframe as the weapon in hand (ammo then comes only from deltas after the pickup; an absent reserve reads as 0, which matched later keyframes for the SPNKr). Assumption: a picked-up weapon is drawn, until a shot of another weapon says otherwise; the drawn slot itself is not in the deltas.

**Holstered weapon.** `Replay.loadout().holstered` (name plus last known mag and reserve) replays the two weapon slots from the newest keyframe: delta records carry ammo for both slots (i30/i31 for slot 0, i33/i34 for slot 1) whether or not the slot is drawn, a pickup fills its slot and draws it, and a shot draws the slot holding the fired weapon (an unseen weapon takes the drawn slot). The other slot is the holstered one. Switches with no shot are invisible. Assumes the keyframe's weapon list is in slot order. Checked on b7ecb729 (Sir Churro2224: SPNKr picked up at about 0:48 shows Bandit 6 / 60 holstered, and after his shot at 0:52 the SPNKr shows 1 / 0 holstered).

### Game clock (not found)

The game clock (for example KOTH's countdown that pauses while a hill is occupied) was searched for and not found, so nothing here derives one. What was tried on ac95a301:

- The stat records on slots 6 to 24 hold no whole-match ticking series. Components 22 and 23 tick once a second but only while a hill is occupied.
- Slot 4 (a game-level entity) component 12 ticks about once a second for the whole match and does not pause, so it looks like raw elapsed time; components 3, 4, 25, 42 and 43 appear in mask-form records about every 3 s from 46 s on. They are not decoded.
- Searches for the 300 s start value (float, 16 or 32-bit integer, 16.16 fixed point) near the first hill activation found only a static 300 that recurs all match.
- Gameplay chunks only contain packet types 0, 1, 2, 6, 7, 8, 10 and 12; type 10 is 8 bytes per frame and never changes.
- LevelUp has no clock decoder.

Ideas left: decode slot 4's other components, or look for a start value plus a running flag. Ground-truth clock readings at known film times would make candidates testable. Film time runs about 1.5 s ahead of the game clock.

### Fire events

Weapon-fire records (event type 36) live in Frame packets and arrive every frame, so they are not limited by the keyframe cadence. `fire-events.ts` finds them by the 10-bit prefix `type(7)=36, unit present, probe, index msb 0` and reads the shooter unit (slot = 0x200 + 9-bit index, matching biped slots) and the weapon family (high 32 bits, 42 bits after the prefix). Only the canonical layout is recognised (as in LevelUp's `weaponscan`), so some shots are missed; on the CTF sample 1759 of 1771 shots attribute to the eight players. The replay uses the latest shot after a keyframe as the live weapon. Grenade, melee and other event types are not decoded yet.

## Flag objects (CTF)

Every flag state change creates a new world object whose default state holds `FLAG_IDENTITY` (`0x2a392328`), followed by a 32-bit `variant` word that tells the two flags apart (map a variant to a team by the nearest flag spawn of its positioned creations).

- **Home/reset creations** have a valid component mask and a position at the spawn. One is created at match start and again on every return, capture or fall out of the world.
- **Drop objects** are created each time a carrier puts the flag down (put down, thrown, or carrier death). They have a dense component mask of all zeros (no position) and then replicate their own position through ordinary delta samples, so a dropped flag's motion is recoverable.
- A carried flag has no world object; it is referenced from the carrier's biped record.
- Grabs have no object of their own; they come from the carrier's biped (below).

`flag-objects.ts` builds the per-object timeline (home / carried / dropped). Each reset or drop starts a free interval; the first carry event of a biped near the object (and, for a flag, not on its own team) in that interval is the grab, and the carry lasts until the next drop or reset. The oddball skull (`SKULL_IDENTITY` `0x0017592c`, no variant) works the same way: resets are its births, and quick pick-ups and throws that the stat counters cannot see are recovered. Carrier-death drops, the neutral flag and fall-off-map are not yet verified.

### Carrier biped carry events (`carry-events.ts`)

In a carrier's biped delta records (mask indices after `[1][slot13][01][00][count3]`), components 42 plus 44 or 45 appear at flag grab and drop instants (e.g. c65a805f slot 561 at 265.373 = grab, 266.340 = drop, matching the drop-object creation). They also appear for some non-flag interactions (weapon pickups), and the component payload (object handle) is not decoded, so events are only candidates, filtered by proximity to the object (about 4 m), team and timing.

## Strongholds zones

Zone owner and capture progress were not found in the film (zones are not among the replicated objects we can decode), so `zone-state.ts` combines real and derived data:

- **Real:** capture instants and capturing team. Each team slot (6, 8) carries a zone-capture counter in stat component 20, channel `b`; each increment is a capture.
- **Real:** secure (reset) instants. Stat component 21, channel `a` is the "Stronghold Secures" counter (per player and per team slot; validated against the API's `ZonesStats`). It increments when a holder stops an enemy capture in progress, and the zone's progress is cleared at that instant.
- **Derived:** which zone was taken and how far a capture has progressed. Player positions are tested against the zone shapes: a lone team inside a zone it does not hold fills it (up to 3 players count), leaving pauses it, a contest pauses it, and a different team entering resets it. The standing time of a full capture is the median over the captures, and progress is capped at 0.99 until the real capture instant flips ownership.

`Replay.zones(timeMs)` returns `{zone, owner, progress, capturingTeam}` in the order of the map's `strongholds_zone` objectives.

## King of the Hill

`hill-state.ts` builds `Replay.hills(timeMs)` (`{activeHill, controllingTeam, progress[]}`). As with Strongholds, hill objects are not decoded from the film.

- **Real:** team score is stat component 0, channel `a`, on team slots 6 and 8. Component 23, channel `a` is the team's cumulative hill-controlled seconds, ticking about once a second while the team is alone in the hill.
- **Real (validated 6 of 6 on ac95a301):** point progress is the component 23 value minus its value at the last point scored by either team. The scoring team is at exactly 40 s at each score (the median is used as seconds per point). The other team's banked progress is discarded at that instant.
- **Derived:** the active hill. Each segment between scores is assigned the hill that contained the ticking team's players. A handover gap of about 6 to 8 s follows each score, with no hill active; its length is learned from the first tick of each segment.
- **Not available:** a capture-start (initialization) delay. It is 0 in the sample match, so the outline fills as soon as the team's counter runs. A nonzero delay cannot be read from these records.
