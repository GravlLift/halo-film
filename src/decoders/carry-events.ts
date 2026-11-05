import { CHUNK_TYPE_GAMEPLAY } from '../core/film-input';
import type { FilmChunkSource } from '../core/film-input';
import { bitsAt } from '../core/keyframe-world';
import { inflateChunk, PacketType, splitPackets } from '../core/packets';

const DELTA_INDEX_BITS = 6;
const MASK_MAX_SPARSE = 7;
/** Biped component that carries its position. */
const POSITION_COMPONENT = 0;
/** Components that a biped replicates when it takes hold of, or lets go of, an object. */
const HOLD_COMPONENT = 42;
const HOLD_COMPANIONS = [44, 45];

/** A biped took hold of an object, or let go of one. */
export interface CarryEvent {
  timeMs: number;
  /** Biped slot. */
  slot: number;
}

/**
 * Finds the instants at which a biped picks up or puts down something it
 * holds. Both show up as the same pair of components in the biped's update
 * (42 with 44 or 45); which one it was, and of what, is told by the objects
 * themselves. Weapons use the pair too, so these are candidates only.
 */
export function readCarryEvents(
  payload: Uint8Array,
  timeMs: number,
  bipedSlots: ReadonlySet<number>,
): CarryEvent[] {
  const events: CarryEvent[] = [];
  const total = payload.length * 8;
  for (let p = 0; p + 21 < total; p++) {
    if (bitsAt(payload, p, 1) !== 1) continue;
    const slot = bitsAt(payload, p + 1, 13);
    if (!bipedSlots.has(slot) || bitsAt(payload, p + 16, 2) !== 0) continue;
    const count = bitsAt(payload, p + 18, 3);
    if (count < 1 || count > MASK_MAX_SPARSE) continue;
    const indices: number[] = [];
    let valid = true;
    for (let i = 0; i < count; i++) {
      const v = bitsAt(
        payload,
        p + 21 + i * DELTA_INDEX_BITS,
        DELTA_INDEX_BITS,
      );
      if (indices.length > 0 && v <= indices[indices.length - 1]) {
        valid = false;
        break;
      }
      indices.push(v);
    }
    if (
      valid &&
      indices.includes(POSITION_COMPONENT) &&
      indices.includes(HOLD_COMPONENT) &&
      HOLD_COMPANIONS.some((c) => indices.includes(c))
    ) {
      events.push({ timeMs, slot });
    }
  }
  return events;
}

export async function extractCarryEvents(
  chunkSource: FilmChunkSource,
  bipedSlots: ReadonlySet<number>,
): Promise<CarryEvent[]> {
  const events: CarryEvent[] = [];
  let baseMicros: number | null = null;
  for await (const chunk of chunkSource) {
    if (chunk.chunkType !== CHUNK_TYPE_GAMEPLAY) continue;
    for (const packet of splitPackets(inflateChunk(chunk.data))) {
      baseMicros ??= packet.timestampMicros;
      if (packet.type !== PacketType.Frame) continue;
      events.push(
        ...readCarryEvents(
          packet.payload,
          (packet.timestampMicros - baseMicros) / 1000,
          bipedSlots,
        ),
      );
    }
  }
  return events;
}
