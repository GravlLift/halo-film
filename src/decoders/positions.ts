import { BitReader } from '../core/bit-reader';
import {
  findRecordCandidates,
  findBipedSlots,
  type RecordCandidate,
} from '../core/biped-records';
import {
  detectI0Layout,
  flipProfile,
  readProfileSample,
  type I0Layout,
  type ProfileSample,
} from '../core/i0-layout';
import {
  CHUNK_TYPE_GAMEPLAY,
  CHUNK_TYPE_HIGHLIGHTS,
  type FilmChunkInput,
  type FilmChunkSource,
} from '../core/film-input';
import { inflateChunk, PacketType, splitPackets } from '../core/packets';
import { readBipedComponents, type BipedComponents } from '../core/components';
import { linkLives, type Actor } from '../players/link-lives';
import { dropStagingTracks } from '../players/staging-tracks';
import { bindPlayers, type PlayerIdentity } from '../players/bind-players';
import { parseHighlightEvents, type HighlightEvent } from './highlight-events';

export interface PositionSample extends BipedComponents {
  timeMs: number;
  /** Raw quantum indices. Only meaningful relative to the map bounds. */
  q: [number, number, number];
  /** q / 2^width, in [0, 1): the position as a fraction of the map's bounding box. */
  normalized: [number, number, number];
}

export interface SlotTrack {
  /** Entity slot. A slot is one life: it can change when a player respawns. */
  slot: number;
  samples: PositionSample[];
}

export interface FilmPositions {
  layout: I0Layout;
  /** Flip rate of each position-block bit, kept as evidence for the layout. */
  flipRates: number[];
  tracks: SlotTrack[];
}

interface FramePayload {
  timeMs: number;
  payload: Uint8Array;
}

function loadFrames(
  chunk: FilmChunkInput,
  baseMicros: { value: number | null },
): FramePayload[] {
  const packets = splitPackets(inflateChunk(chunk.data));
  const frames: FramePayload[] = [];
  for (const packet of packets) {
    baseMicros.value ??= packet.timestampMicros;
    if (packet.type !== PacketType.Frame) continue;
    frames.push({
      timeMs: (packet.timestampMicros - baseMicros.value) / 1000,
      payload: packet.payload,
    });
  }
  return frames;
}

export interface LinkedFilmPositions extends FilmPositions {
  /** Anonymous players; each owns the lives (slots) that respawn chain together. */
  actors: Actor[];
}

export interface ExtractOptions {
  /**
   * The map's real position layout, when known. Detection cannot see a region
   * index wider than one bit (Live Fire's is two) and folds it into the X field.
   */
  layout?: I0Layout;
  /** Death feed from `readHighlightEvents`; enables binding lives to real players. */
  highlightEvents?: readonly HighlightEvent[];
  /** Roster with teams, used for names and team ids. */
  players?: readonly PlayerIdentity[];
}

/** Finds the highlight-events chunk and parses it. */
export async function readHighlightEvents(
  chunkSource: FilmChunkSource,
  majorVersion: number,
): Promise<HighlightEvent[]> {
  for await (const chunk of chunkSource) {
    if (chunk.chunkType === CHUNK_TYPE_HIGHLIGHTS) {
      return parseHighlightEvents(chunk.data, majorVersion);
    }
  }
  return [];
}

/**
 * Extracts positions and links lives into actors: bound to real players when
 * a death feed is supplied, otherwise anonymous respawn chains.
 */
export async function extractFilmPositions(
  chunkSource: FilmChunkSource,
  options: ExtractOptions = {},
): Promise<LinkedFilmPositions | null> {
  const raw = await extractPositions(chunkSource, options.layout);
  if (!raw) return null;
  const positions = { ...raw, tracks: dropStagingTracks(raw.tracks) };
  const events = options.highlightEvents ?? [];
  if (events.some((e) => e.type === 'death')) {
    const bound = bindPlayers(positions.tracks, events, options.players);
    if (bound.matchedDeaths > bound.totalDeaths / 2) {
      return { ...positions, actors: bound.actors };
    }
  }
  return { ...positions, actors: linkLives(positions.tracks) };
}

export async function extractPositions(
  chunkSource: FilmChunkSource,
  knownLayout?: I0Layout,
): Promise<FilmPositions | null> {
  const baseMicros: { value: number | null } = { value: null };

  // Pass 1: per chunk, find the biped slot set (slots migrate as players
  // respawn, so it is local in time) and collect samples for layout detection.
  interface ChunkScan {
    slots: Set<number>;
    frames: {
      timeMs: number;
      reader: BitReader;
      candidates: RecordCandidate[];
    }[];
  }
  const scans: ChunkScan[] = [];
  const profileSamples: ProfileSample[] = [];
  for await (const chunk of chunkSource) {
    if (chunk.chunkType !== CHUNK_TYPE_GAMEPLAY) continue;
    const frames = loadFrames(chunk, baseMicros).map((frame) => ({
      timeMs: frame.timeMs,
      reader: new BitReader(frame.payload),
      candidates: findRecordCandidates(frame.payload),
    }));
    const slotCounts = new Map<number, number>();
    for (const frame of frames) {
      for (const c of frame.candidates) {
        slotCounts.set(c.slot, (slotCounts.get(c.slot) ?? 0) + 1);
      }
    }
    const slots = findBipedSlots(slotCounts, frames.length);
    if (slots.size === 0) continue;
    scans.push({ slots, frames });
    for (const frame of frames) {
      for (const c of frame.candidates) {
        if (!slots.has(c.slot)) continue;
        const sample = readProfileSample(frame.reader, c.slot, c.i0Bit);
        if (sample) profileSamples.push(sample);
      }
    }
  }
  if (scans.length === 0) return null;

  const { rates } = flipProfile(profileSamples);
  const layout = knownLayout ?? detectI0Layout(rates);
  if (!layout) return null;

  // Pass 2: decode every record in each chunk's band.
  const [wx, wy, wz] = layout.axisBits;
  const i0Bits = layout.gateBits + wx + wy + wz;
  const tracks = new Map<number, PositionSample[]>();
  for (const { slots, frames } of scans) {
    for (const frame of frames) {
      const { reader } = frame;
      let nextFree = 0;
      for (const c of frame.candidates) {
        if (c.headerBit < nextFree) continue;
        if (!slots.has(c.slot)) continue;
        if (c.i0Bit + i0Bits > reader.bitLength) continue;
        const x = reader.peek(c.i0Bit + layout.gateBits, wx);
        const y = reader.peek(c.i0Bit + layout.gateBits + wx, wy);
        const z = reader.peek(c.i0Bit + layout.gateBits + wx + wy, wz);
        // Extreme buckets are clipped values, not real positions.
        if (
          x === 0 ||
          x === 2 ** wx - 1 ||
          y === 0 ||
          y === 2 ** wy - 1 ||
          z === 0 ||
          z === 2 ** wz - 1
        ) {
          continue;
        }
        nextFree = c.i0Bit + i0Bits;
        const samples = tracks.get(c.slot) ?? [];
        samples.push({
          timeMs: frame.timeMs,
          q: [x, y, z],
          normalized: [x / 2 ** wx, y / 2 ** wy, z / 2 ** wz],
          ...readBipedComponents(reader, c.i0Bit + i0Bits, c.maskIndices),
        });
        tracks.set(c.slot, samples);
      }
    }
  }

  return {
    layout,
    flipRates: rates,
    tracks: [...tracks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([slot, samples]) => ({ slot, samples })),
  };
}
