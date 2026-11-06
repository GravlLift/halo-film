import { CHUNK_TYPE_GAMEPLAY } from '../core/film-input';
import type { FilmChunkSource } from '../core/film-input';
import { bitsAt, BIPED_TYPE_INDEX } from '../core/keyframe-world';
import { inflateChunk, PacketType, splitPackets } from '../core/packets';
import { parseRoster, type FilmPlayer } from './roster';
import { keyframeSlotBand } from './world-object-births';

const NEW_HEADER_BITS = 24;
const VERSION = 13;
/** `player-representation-name` word of every multiplayer Spartan biped. */
const BIPED_REPRESENTATION = 0x1876bda0;
const PARTICIPANT_INDEX_BITS = 5;
const PROLOGUE_BITS = 1 + 8 + 1 + 32 + 1 + PARTICIPANT_INDEX_BITS;

/** The creation of a biped: its default state names the participant that owns the body. */
export interface BipedCreation {
  timeMs: number;
  slot: number;
  generation: number;
  /** Index into the roster of the film (the 5 bits before each xuid in the player metadata). */
  participantIndex: number;
}

/**
 * Finds biped creation records in one frame payload. The default state opens
 * with `[1][version u8 = 13][1][representation u32][0][owner index u5]`, which
 * is 43 fixed bits after the creation header, so a match is not a guess.
 */
export function readBipedCreations(
  payload: Uint8Array,
  timeMs: number,
): BipedCreation[] {
  const out: BipedCreation[] = [];
  const total = payload.length * 8;
  for (let p = 0; p + NEW_HEADER_BITS + PROLOGUE_BITS <= total; p++) {
    if (bitsAt(payload, p, 3) !== 0b001) continue;
    if (bitsAt(payload, p + 18, 6) !== BIPED_TYPE_INDEX) continue;
    const slot = bitsAt(payload, p + 3, 13);
    let at = p + NEW_HEADER_BITS;
    if (
      bitsAt(payload, at, 1) !== 1 ||
      bitsAt(payload, at + 1, 8) !== VERSION
    ) {
      continue;
    }
    at += 9;
    if (bitsAt(payload, at, 1) !== 1) continue;
    if (bitsAt(payload, at + 1, 32) !== BIPED_REPRESENTATION) continue;
    at += 33;
    // The owner reference gate is inverted: a zero bit announces the index.
    if (bitsAt(payload, at, 1) !== 0) continue;
    out.push({
      timeMs,
      slot,
      generation: bitsAt(payload, p + 16, 2),
      participantIndex: bitsAt(payload, at + 1, PARTICIPANT_INDEX_BITS),
    });
    p += NEW_HEADER_BITS + PROLOGUE_BITS - 1;
  }
  return out;
}

export interface BipedCreations {
  creations: BipedCreation[];
  /** The players listed in the film, with the participant index each owns. */
  roster: FilmPlayer[];
  bipedSlotBand?: ReadonlySet<number>;
}

export async function extractBipedCreations(
  chunkSource: FilmChunkSource,
): Promise<BipedCreations> {
  const creations: BipedCreation[] = [];
  const keyframes: Uint8Array[] = [];
  let roster: FilmPlayer[] = [];
  let baseMicros: number | null = null;
  for await (const chunk of chunkSource) {
    if (chunk.chunkType !== CHUNK_TYPE_GAMEPLAY) continue;
    for (const packet of splitPackets(inflateChunk(chunk.data))) {
      baseMicros ??= packet.timestampMicros;
      if (packet.type === PacketType.PlayerMetadata && roster.length === 0) {
        roster = parseRoster(packet.payload);
      }
      if (packet.type === PacketType.Keyframe) keyframes.push(packet.payload);
      if (packet.type !== PacketType.Frame) continue;
      creations.push(
        ...readBipedCreations(
          packet.payload,
          (packet.timestampMicros - baseMicros) / 1000,
        ),
      );
    }
  }
  const bipedSlotBand = keyframeSlotBand(keyframes, BIPED_TYPE_INDEX);
  return {
    creations,
    roster,
    bipedSlotBand: bipedSlotBand.size > 0 ? bipedSlotBand : undefined,
  };
}
