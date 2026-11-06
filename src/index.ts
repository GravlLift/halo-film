// High level: API responses in, a replay out.
export { buildReplay, loadFilm } from './load-film';
export type {
  FilmManifest,
  FilmMatchStats,
  LoadFilmOptions,
  MatchReplay,
  ReplayProjectile,
} from './load-film';
export type {
  ObjectiveState,
  PlayerLoadout,
  PlayerStatus,
  Replay,
  ReplayBounds,
  ReplayFire,
  ReplayGrave,
  ReplayPoint,
} from './timeline/replay';
export type { PlayerStatSnapshot } from './timeline/player-stats';
export type { ZoneState } from './timeline/zone-state';
export type { HillState, HillTeamProgress } from './timeline/hill-state';
export type { ProjectileFlight, ProjectilePoint } from './decoders/projectiles';
export type {
  MapBackground,
  MapObjective,
} from '@gravllift/halo-infinite-maps';

// Lower level: raw film files, for tooling that works below the replay.
export type {
  FilmChunkInput,
  FilmChunkSource,
  FilmMetadata,
} from './core/film-input';
export { parseFilm } from './parse-film';
export { inflateChunk, PacketType, splitPackets } from './core/packets';
export type { FilmPacket } from './core/packets';
export type { FireEvent } from './decoders/fire-events';
export {
  extractFilmPositions,
  extractPositions,
  readHighlightEvents,
} from './decoders/positions';
export { extractBipedCreations } from './decoders/biped-creations';
