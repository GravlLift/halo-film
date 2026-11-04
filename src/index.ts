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
} from './replay';
export type { PlayerStatSnapshot } from './player-stats';
export type { ZoneState } from './zone-state';
export type { HillState, HillTeamProgress } from './hill-state';
export type { ProjectileFlight, ProjectilePoint } from './projectiles';
export type {
  MapBackground,
  MapObjective,
} from '@gravllift/halo-infinite-maps';

// Lower level: raw film files, for tooling that works below the replay.
export type {
  FilmChunkInput,
  FilmChunkSource,
  FilmMetadata,
} from './film-input';
export { parseFilm } from './parse-film';
export { extractFilmPositions, readHighlightEvents } from './positions';
