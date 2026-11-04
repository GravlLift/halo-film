import { PacketType, inflateChunk, splitPackets } from './packets';
import { CHUNK_TYPE_GAMEPLAY, type FilmChunkSource } from './film-input';
import { bitsAt } from './keyframe-world';
import type { LinkedFilmPositions } from './positions';

/**
 * `damage_aftermath` events (event type 0) at the head of a frame packet's
 * event list, after LevelUp's `weapon_hits_decode.go`. The record starts with
 * the injured unit and the responsible unit (both domain-1 references), then a
 * field walk ending in the damage magnitude.
 */

const UNIT_SLOT_BASE = 0x200;
/** A record needs at least its type, two references and the field walk. */
const MIN_RECORD_BITS = 120;

export interface DamageEvent {
  timeMs: number;
  /** Slot of the injured unit, when the record names one. */
  victimSlot?: number;
  /** Slot of the responsible unit, when the record names one. */
  attackerSlot?: number;
  /** Signed magnitude, 0..16 dequantized; negative for healing. */
  magnitude: number;
}

class Cursor {
  constructor(
    readonly payload: Uint8Array,
    public pos: number,
  ) {}
  read(n: number): number {
    const v = bitsAt(this.payload, this.pos, n);
    this.pos += n;
    return v;
  }
  skip(n: number) {
    this.pos += n;
  }
}

/** Domain-1 reference: guard, probe, index (9 or 13 bits), generation. */
function readUnitRef(c: Cursor): number | undefined {
  if (!c.read(1)) return undefined;
  const width = c.read(1) ? 9 : 13;
  const index = c.read(width);
  c.skip(2);
  return index;
}

function dequantize(raw: number, width: number, min: number, max: number) {
  const levels = 2 ** width;
  if (raw === 0) return min;
  if (raw === levels - 1) return max;
  return min + ((raw - 1 + 0.5) * (max - min)) / (levels - 2);
}

/**
 * Reads the damage record whose 7-bit type field starts at `bit`. Returns
 * undefined when the type is not 0 or the record overruns the payload.
 */
function readDamageAt(
  payload: Uint8Array,
  bit: number,
  timeMs: number,
): DamageEvent | undefined {
  if (bitsAt(payload, bit, 7) !== 0) return undefined;
  const c = new Cursor(payload, bit + 7);
  const victim = readUnitRef(c);
  const attacker = readUnitRef(c);
  if (c.read(1)) c.skip(13 + 2); // third reference, domain 7
  if (c.read(1)) c.skip(32); // source tag id
  if (c.read(1)) c.skip(5);
  c.skip(19);
  if (c.read(1)) c.skip(19 + 12);
  c.skip(5 + 5 + 6);
  if (c.read(1)) c.skip(5);
  let last = 0;
  for (let i = 0; i < 15; i++) last = c.read(1);
  if (last) c.skip(32);
  c.skip(1 + 3);
  const raw = c.read(5);
  c.skip(5);
  let magnitude = dequantize(raw, 5, 0, 16);
  if (c.read(1)) magnitude = -magnitude;
  if (c.pos > payload.length * 8) return undefined;
  return {
    timeMs,
    victimSlot: victim === undefined ? undefined : UNIT_SLOT_BASE + victim,
    attackerSlot:
      attacker === undefined ? undefined : UNIT_SLOT_BASE + attacker,
    magnitude,
  };
}

/**
 * Finds damage records in a frame payload. The head-of-list record is always
 * read; records further down the list cannot be reached without decoding the
 * events before them, so every bit following a continuation flag is tried and
 * kept only when `isUnitAt` accepts both the injured and responsible unit.
 */
/**
 * Builds the `isUnitAt` predicate for `readDamageEvents` from linked lives. A
 * slot can be reused by later lives, so the time is checked against every
 * life that ever held it.
 */
export function unitAtPredicate(
  positions: LinkedFilmPositions,
  toleranceMs = 500,
): (slot: number, timeMs: number) => boolean {
  const bySlot = new Map<number, { startMs: number; endMs: number }[]>();
  for (const actor of positions.actors)
    for (const life of actor.lives) {
      const list = bySlot.get(life.slot) ?? [];
      list.push(life);
      bySlot.set(life.slot, list);
    }
  return (slot, timeMs) =>
    (bySlot.get(slot) ?? []).some(
      (l) =>
        timeMs >= l.startMs - toleranceMs && timeMs <= l.endMs + toleranceMs,
    );
}

export function readDamageEvents(
  payload: Uint8Array,
  timeMs: number,
  isUnitAt: (slot: number, timeMs: number) => boolean,
): DamageEvent[] {
  const out: DamageEvent[] = [];
  const last = payload.length * 8 - MIN_RECORD_BITS;
  for (let bit = 1; bit <= last; bit++) {
    if (bitsAt(payload, bit - 1, 1) !== 1) continue;
    if (bitsAt(payload, bit, 7) !== 0) continue;
    const event = readDamageAt(payload, bit, timeMs);
    if (!event) continue;
    const head = bit === 2 && bitsAt(payload, 0, 1) === 1;
    const { victimSlot, attackerSlot } = event;
    const named =
      victimSlot !== undefined &&
      attackerSlot !== undefined &&
      isUnitAt(victimSlot, timeMs) &&
      isUnitAt(attackerSlot, timeMs);
    if (head || named) out.push(event);
  }
  return out;
}

/** Decodes every damage event in the film, on the position time base. */
export async function extractDamageEvents(
  chunkSource: FilmChunkSource,
  isUnitAt: (slot: number, timeMs: number) => boolean,
): Promise<DamageEvent[]> {
  let baseMicros: number | null = null;
  const out: DamageEvent[] = [];
  for await (const chunk of chunkSource) {
    if (chunk.chunkType !== CHUNK_TYPE_GAMEPLAY) continue;
    for (const packet of splitPackets(inflateChunk(chunk.data))) {
      baseMicros ??= packet.timestampMicros;
      if (packet.type !== PacketType.Frame) continue;
      out.push(
        ...readDamageEvents(
          packet.payload,
          (packet.timestampMicros - baseMicros) / 1000,
          isUnitAt,
        ),
      );
    }
  }
  return out;
}
