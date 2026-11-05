/** One downloaded (still zlib-compressed) film chunk plus its manifest entry. */
export interface FilmChunkInput {
  index: number;
  chunkType: number;
  startTimeOffsetMs: number;
  durationMs: number;
  data: Uint8Array;
}

/** Chunks may be supplied lazily (e.g. read from disk one at a time). */
export type FilmChunkSource =
  | Iterable<FilmChunkInput>
  | AsyncIterable<FilmChunkInput>;

export interface FilmMetadata {
  matchId: string;
  filmLengthMs: number;
  majorVersion: number;
  hasGameEnded: boolean;
}

export const CHUNK_TYPE_REGISTRY = 1;
export const CHUNK_TYPE_GAMEPLAY = 2;
export const CHUNK_TYPE_HIGHLIGHTS = 3;
