import { extractDamageEvents, unitAtPredicate } from './decoders/damage-events';
import type { FilmChunkInput } from './core/film-input';
import { extractFireEvents } from './decoders/fire-events';
import { extractInventories } from './decoders/inventory';
import { extractInventoryDeltas } from './decoders/inventory-deltas';
import {
  filmLayoutFor,
  GameVariantCategory,
  mapBackgroundFor,
  mapObjectivesFor,
  normalizedPerMeter,
} from '@gravllift/halo-infinite-maps';
import type {
  MapBackground,
  MapObjective,
} from '@gravllift/halo-infinite-maps';
import { extractCarryEvents } from './decoders/carry-events';
import { extractBipedCreations } from './decoders/biped-creations';
import { buildPlayerStats } from './timeline/player-stats';
import { extractFilmPositions, readHighlightEvents } from './decoders/positions';
import { extractProjectiles } from './decoders/projectiles';
import type { ProjectileFlight } from './decoders/projectiles';
import { createReplay } from './timeline/replay';
import { extractHillControl, type HillInput } from './timeline/hill-state';
import {
  extractZoneCaptureSlots,
  extractZoneSecureSlots,
  type ZoneCapture,
  type ZoneShape,
} from './timeline/zone-state';
import type { ObjectiveCarries, Replay } from './timeline/replay';
import { buildScoreTimeline } from './timeline/score';
import { extractStatRecords } from './decoders/stat-records';
import { buildFlagObjects, buildSkullObject } from './timeline/flag-objects';
import { extractWorldObjectScan } from './decoders/world-object-births';

const DEFAULT_CONCURRENCY = 6;
/** How near a biped must be to an objective to pick it up. */
const CARRY_REACH_M = 4;

/** The `spectate` API response (`HaloInfinitClient.spectateMatch`). */
export interface FilmManifest {
  CustomData: {
    Chunks: {
      Index: number;
      ChunkStartTimeOffsetMilliseconds: number;
      DurationMilliseconds: number;
      ChunkType: number;
    }[];
    FilmMajorVersion: number;
  };
}

/** The match stats API response, or anything shaped like it (e.g. a match history entry). */
export interface FilmMatchStats {
  MatchInfo: {
    MapVariant: { AssetId: string };
    GameVariantCategory: number;
  };
  Players: {
    PlayerId: string;
    LastTeamId: number;
    PlayerTeamStats: {
      Stats: {
        CoreStats: {
          PersonalScore: number;
          Kills: number;
          Deaths: number;
          Assists: number;
        };
      };
    }[];
  }[];
  Teams: { TeamId: number; Stats: { CoreStats: { Score: number } } }[];
}

export interface ReplayProjectile {
  flight: ProjectileFlight;
  /** Actor that threw it, when the film names one. */
  actor?: number;
  /** A sphere left where it landed, e.g. a shroud screen. Radius is in film-normalized units. */
  lingering?: { untilMs: number; radius: number };
}

/** Shroud screens last this long after landing. */
const SHROUD_DURATION_MS = 7000;
/** Estimated from a screenshot of a placement; not read from game data. */
const SHROUD_RADIUS_M = 3.5;

/** A match replay: the film's timeline plus the static map information around it. */
export interface MatchReplay extends Replay {
  projectiles: ReplayProjectile[];
  map: {
    /** Zones and spawns of the game mode, in film coordinates. */
    objectives: MapObjective[];
    /** Top-down image of the map, when one has been calibrated. */
    background?: MapBackground;
  };
}

const xuidOf = (playerId: string) => /\d+/.exec(playerId)?.[0];

/** Number of `stage()` calls in `buildReplay`. */
const BUILD_STAGES = 7;

/** Lets the browser paint before the next synchronous stretch of parsing. */
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

/** Builds a replay from a film's chunks (still compressed, as the API serves them). */
export async function buildReplay(
  film: FilmManifest,
  chunks: readonly FilmChunkInput[],
  match: FilmMatchStats,
  onStage?: (stage: string) => void,
): Promise<MatchReplay> {
  let stageNumber = 0;
  const stage = async (name: string) => {
    stageNumber += 1;
    if (!onStage) return;
    onStage(`${name} (step ${stageNumber}/${BUILD_STAGES})`);
    await yieldToUi();
  };
  const { MapVariant, GameVariantCategory: category } = match.MatchInfo;
  const mapId = MapVariant.AssetId;
  const mapName =
    'PublicName' in MapVariant && typeof MapVariant.PublicName === 'string'
      ? MapVariant.PublicName
      : '';
  const objectives = mapObjectivesFor(mapId, category);
  const players = match.Players.flatMap((p) => {
    const xuid = xuidOf(p.PlayerId);
    return xuid ? [{ xuid, team: p.LastTeamId }] : [];
  });

  await stage('Decoding player positions...');
  const highlightEvents = await readHighlightEvents(
    chunks,
    film.CustomData.FilmMajorVersion,
  );
  const positions = await extractFilmPositions(chunks, {
    highlightEvents,
    players,
    bipedOwners: await extractBipedCreations(chunks),
    layout: filmLayoutFor(mapId),
  });
  if (!positions) throw new Error('No player positions found in film');

  await stage('Reading scores and stats...');
  const statRecords = await extractStatRecords(chunks);
  const scoreTimeline = buildScoreTimeline(
    statRecords,
    match.Teams.map((t) => ({
      team: t.TeamId,
      score: t.Stats.CoreStats.Score,
    })),
  );
  const playerStats = buildPlayerStats(
    statRecords,
    match.Players.flatMap((p) => {
      const xuid = xuidOf(p.PlayerId);
      const core = p.PlayerTeamStats[0]?.Stats.CoreStats;
      return xuid && core
        ? [
            {
              xuid,
              score: core.PersonalScore,
              kills: core.Kills,
              deaths: core.Deaths,
              assists: core.Assists,
            },
          ]
        : [];
    }),
  );
  await stage('Reading player inventories...');
  const inventories = await extractInventories(chunks);
  const inventoryDeltas = await extractInventoryDeltas(
    chunks,
    positions.layout,
    new Set(positions.tracks.map((t) => t.slot)),
  );
  await stage('Reading weapon fire and damage...');
  const fireEvents = await extractFireEvents(chunks);
  const damageEvents = await extractDamageEvents(
    chunks,
    unitAtPredicate(positions),
  );
  await stage('Tracing projectiles...');
  const flights = await extractProjectiles(chunks, positions.layout);
  await stage('Reading objectives...');

  const metersToFilm = normalizedPerMeter(mapId) ?? 0;
  const scan =
    category === GameVariantCategory.MultiplayerCtf ||
    category === GameVariantCategory.MultiplayerOddball
      ? await extractWorldObjectScan(chunks, positions.layout)
      : { births: [], samples: [], drops: [] };
  let carries: ObjectiveCarries = {};
  if (scan.births.length > 0 || scan.drops.length > 0) {
    const flagHomes = objectives
      .filter((o) => o.role === 'flag_spawn')
      .map((o) => ({ team: o.team, x: o.x, y: o.y }));
    const skull = buildSkullObject(scan);
    carries = {
      objects:
        category === GameVariantCategory.MultiplayerCtf
          ? buildFlagObjects(scan, flagHomes)
          : skull
            ? [skull]
            : [],
      carryEvents: await extractCarryEvents(
        chunks,
        new Set(positions.tracks.map((t) => t.slot)),
      ),
      reach: metersToFilm > 0 ? CARRY_REACH_M * metersToFilm : undefined,
    };
  }

  const teamEvents = (
    events: { timeMs: number; slot: number }[],
  ): ZoneCapture[] =>
    events.flatMap((c) => {
      const team = scoreTimeline.teams.find((t) => t.slot === c.slot)?.team;
      return team === undefined ? [] : [{ timeMs: c.timeMs, team }];
    });
  const zoneObjectives = objectives.filter(
    (o) => o.role === 'strongholds_zone',
  );
  const zoneInput =
    category === GameVariantCategory.MultiplayerStrongholds
      ? {
          zones: zoneObjectives.map(
            (o): ZoneShape => ({
              team: o.team,
              x: o.x,
              y: o.y,
              radius: o.radius,
              polygon: o.polygon,
            }),
          ),
          captures: teamEvents(extractZoneCaptureSlots(statRecords)),
          secures: teamEvents(extractZoneSecureSlots(statRecords)),
        }
      : undefined;

  const hillInput: HillInput | undefined =
    category === GameVariantCategory.MultiplayerKingOfTheHill
      ? {
          hills: objectives
            .filter((o) => o.role === 'hill')
            .map(
              (o): ZoneShape => ({
                team: o.team,
                x: o.x,
                y: o.y,
                radius: o.radius,
                polygon: o.polygon,
              }),
            ),
          control: extractHillControl(statRecords).flatMap(
            ({ slot, points }) => {
              const team = scoreTimeline.teams.find(
                (t) => t.slot === slot,
              )?.team;
              return team === undefined ? [] : [{ team, points }];
            },
          ),
          scores: scoreTimeline.teams.flatMap(({ team, points }) => {
            if (team === undefined) return [];
            let previous = 0;
            return points.flatMap((p) => {
              const scored = p.value > previous;
              previous = p.value;
              return scored ? [{ timeMs: p.timeMs, team }] : [];
            });
          }),
        }
      : undefined;

  await stage('Building replay...');
  const replay = createReplay(
    positions,
    scoreTimeline,
    playerStats,
    inventories,
    fireEvents,
    damageEvents,
    carries,
    film.CustomData.Chunks.filter((c) => c.ChunkType === 2).reduce(
      (end, c) =>
        Math.max(
          end,
          c.ChunkStartTimeOffsetMilliseconds + c.DurationMilliseconds,
        ),
      0,
    ),
    zoneInput,
    hillInput,
    inventoryDeltas,
  );
  return Object.assign(replay, {
    projectiles: flights.map((flight): ReplayProjectile => {
      const xuid =
        flight.thrower === undefined
          ? undefined
          : playerStats.players[flight.thrower]?.xuid;
      return {
        flight,
        actor: replay.players.find((p) => p.xuid === xuid)?.actor,
        lingering: flight.lingers
          ? {
              untilMs: flight.detonation.timeMs + SHROUD_DURATION_MS,
              radius: SHROUD_RADIUS_M * metersToFilm,
            }
          : undefined,
      };
    }),
    map: { objectives, background: mapBackgroundFor(mapName) },
  });
}

export interface LoadFilmOptions {
  film: FilmManifest;
  match: FilmMatchStats;
  /** Fetches one chunk's bytes, e.g. `client.getFilmChunk(film.BlobStoragePathPrefix, index)`. */
  fetchChunk: (index: number) => Promise<ArrayBuffer | Uint8Array>;
  /** Chunks fetched at once. */
  concurrency?: number;
  onProgress?: (downloaded: number, total: number) => void;
  /** Called as each processing step starts, after all chunks are downloaded. */
  onStage?: (stage: string) => void;
}

/** Downloads a film's chunks and builds its replay. */
export async function loadFilm(options: LoadFilmOptions): Promise<MatchReplay> {
  const { film, match, fetchChunk, onProgress, onStage } = options;
  const { Chunks } = film.CustomData;
  const chunks = new Array<FilmChunkInput>(Chunks.length);
  const pending = Chunks.map((chunk, i) => ({ chunk, i }));
  let downloaded = 0;
  const worker = async () => {
    for (let next = pending.shift(); next; next = pending.shift()) {
      const { chunk, i } = next;
      chunks[i] = {
        index: chunk.Index,
        chunkType: chunk.ChunkType,
        startTimeOffsetMs: chunk.ChunkStartTimeOffsetMilliseconds,
        durationMs: chunk.DurationMilliseconds,
        data: new Uint8Array(await fetchChunk(chunk.Index)),
      };
      downloaded += 1;
      onProgress?.(downloaded, Chunks.length);
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          options.concurrency ?? DEFAULT_CONCURRENCY,
          Chunks.length,
        ),
      },
      worker,
    ),
  );
  return buildReplay(film, chunks, match, onStage);
}
