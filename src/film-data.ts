import type { BipedCreations } from './decoders/biped-creations';
import type { CarryEvent } from './decoders/carry-events';
import type { DamageEvent } from './decoders/damage-events';
import type { FireEvent } from './decoders/fire-events';
import type { HighlightEvent } from './decoders/highlight-events';
import type { InventorySnapshot } from './decoders/inventory';
import type { InventoryDelta } from './decoders/inventory-deltas';
import type {
  PlayerGameEvent,
  PlayerKilledEvent,
} from './decoders/kill-events';
import type { ProjectileFlight } from './decoders/projectiles';
import type { StatRecord } from './decoders/stat-records';
import type { extractWorldObjectScan } from './decoders/world-object-births';

export interface FilmChunkInput {
  index: number;
  chunkType: number;
  bytes: ArrayBuffer;
  fileRelativePath: string;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface FilmHeaderData {
  build: string | null;
  branch: string | null;
  started_at: number | null;
  map_asset_id: string | null;
  map_version_id: string | null;
  level: number | null;
}

export interface FilmPlayerData {
  id: number;
  kind:
    | { Human: { xuid: number; gamertag: string | null } }
    | { Bot: { bot_id: number; name: string } };
  team: number | null;
  present_at_start: boolean;
  joined: number | null;
  left: number | null;
}

export interface FilmPositionData {
  x: number;
  y: number;
  z: number | null;
}

export interface FilmSampleData {
  tick: number;
  raw: [number, number];
  position: FilmPositionData | null;
  yaw: number | null;
  speed: number | null;
  health: number | null;
  shield: number | null;
  in_vehicle: boolean;
  vehicle: number | null;
  pitch?: number | null;
  facing_yaw?: number | null;
  raw_z?: number;
}

export interface FilmLifeData {
  player: number | null;
  entity: number | null;
  died: boolean;
  death: number | null;
  samples: FilmSampleData[];
}

export interface FilmCoordinatesData {
  source: string;
  scale_x: number;
  scale_y: number;
  offset_x: number;
  offset_y: number;
  spawn_fit: [number, number] | null;
}

export interface FilmStatChangeData {
  tick: number;
  owner: { Player: number } | { Team: number };
  slot: number;
  value: number;
  round?: number;
}

export interface FilmScoreboardData {
  changes: FilmStatChangeData[];
  clock: { tick: number; limit: number; left: number; state: number }[];
  engine: JsonValue[];
}

export interface FilmKillData {
  victim: number;
  killer: number | null;
  killer_damage_percent: number;
  assistant: number | null;
  assistant_damage_percent: number;
  suicide: boolean;
  headshot: boolean | null;
  scored: boolean | null;
  cause: JsonValue;
  weapon: number | null;
  position: FilmPositionData | null;
}

export interface FilmGrenadeFlightData {
  player: number;
  grenade: string | null;
  path: [number, FilmPositionData][];
  end: number;
  deleted: boolean;
  explodes?: boolean;
  lingers?: boolean;
}

export interface FilmClockData {
  frameCount: number;
  frameTicks: number[];
  end: number;
  ticksPerFrame: number;
  highlightZero: number | null;
  hitches: [number, number][];
}

export interface FilmLevelData {
  id: JsonValue;
  name: string;
  structure: JsonValue;
  play: FilmLevelBoxData;
  indexBits: number;
  others: FilmLevelBoxData[];
}

export interface FilmLevelBoxData {
  index: number;
  min: [number, number, number];
  max: [number, number, number];
  widths: [number, number, number];
}

export interface FilmPlayerStateData {
  playerId: JsonValue;
  state: JsonValue;
}

export interface FilmRecordsData {
  roster: BipedCreations['roster'];
  highlightEvents: HighlightEvent[];
  statRecords: (Omit<StatRecord, 'comps'> & {
    comps: [number, { a: number; b: number }][];
  })[];
  inventories: InventorySnapshot[];
  inventoryDeltas: InventoryDelta[];
  fireEvents: FireEvent[];
  damageEvents: DamageEvent[];
  killEvents: PlayerKilledEvent[];
  playerGameEvents: PlayerGameEvent[];
  flights: ProjectileFlight[];
  worldObjects: Awaited<ReturnType<typeof extractWorldObjectScan>>;
  carryEvents: CarryEvent[];
}

export interface FilmData {
  header: FilmHeaderData;
  clock: FilmClockData;
  players: FilmPlayerData[];
  variant: JsonValue | null;
  mode: JsonValue;
  level: FilmLevelData | null;
  coordinates: FilmCoordinatesData | null;
  lives: FilmLifeData[];
  vehicles: JsonValue[];
  rides: JsonValue[];
  worldObjects: JsonValue[];
  groundWeapons: JsonValue[];
  grenadeFlights: FilmGrenadeFlightData[];
  zones: JsonValue[];
  hillScore: JsonValue | null;
  events: JsonValue[];
  kills: { tick: number; kill: FilmKillData }[];
  highlights: JsonValue[];
  medals: { tick: number | null; award: JsonValue }[];
  scoreboard: FilmScoreboardData;
  states: FilmPlayerStateData[];
  records?: FilmRecordsData;
}

export interface FilmParser {
  parseFilm(chunks: FilmChunkInput[]): FilmData | Promise<FilmData>;
}
