import { bitsAt } from '../core/keyframe-world';
import { CHUNK_TYPE_GAMEPLAY, type FilmChunkSource } from '../core/film-input';
import { PacketType, inflateChunk, splitPackets } from '../core/packets';

const PLAYER_KILLED_HEADER = (1 << 7) | 85;
const PLAYER_GAME_EVENT_HEADER = (1 << 7) | 82;
const KILL_EVENT_REFERENCE_WIDTH = 13;
const MIN_VALID_CHAIN_EVENTS = 3;
const MAX_CHAIN_EVENTS = 12;
const EVENT_REFERENCE_CATEGORIES = new Map<number, readonly number[]>([
  [0, [1, 1, 7]],
  [1, [1, 8, 7]],
  [3, [0, 8, 7]],
  [4, [0, 8, 7]],
  [5, [5, 8, 7]],
  [6, [5, 8, 7]],
  [7, [1, 8, 7]],
  [9, [2, 8, 7]],
  [12, [8, 8, 7]],
  [15, [8, 8, 7]],
  [21, [4, 8, 7]],
  [23, [0, 8, 7]],
  [24, [0, 2, 7]],
  [25, [0, 2, 7]],
  [26, [0, 2, 7]],
  [33, [3, 4, 7]],
  [34, [8, 8, 7]],
  [38, [2, 8, 7]],
  [40, [2, 0, 7]],
  [49, [3, 2, 7]],
  [54, [1, 1, 7]],
  [57, [2, 0, 7]],
  [59, [0, 8, 7]],
  [75, [1, 8, 7]],
  [76, [1, 8, 7]],
  [82, [0, 8, 7]],
  [85, [8, 8, 7]],
  [92, [6, 8, 7]],
  [103, [0, 0, 7]],
]);
const EVENT_STUBS = new Set([
  3, 4, 23, 24, 25, 26, 33, 49, 54, 57, 59, 92, 103,
]);
const EVENT_FIXED_BODY_BITS = new Map([
  [5, 111],
  [6, 93],
  [7, 118],
  [9, 36],
  [12, 94],
  [21, 2],
  [34, 59],
  [38, 10],
  [40, 78],
  [75, 54],
  [76, 104],
]);
const PRESENCE_RANGES = [7679, 7679, 256, 256, 512, 256, 512, 8191, 8191, 0];

function readBits(
  payload: Uint8Array,
  bit: number,
  width: number,
): number | undefined {
  return bit >= 0 && bit + width <= payload.length * 8
    ? bitsAt(payload, bit, width)
    : undefined;
}

function readEventPresence(
  payload: Uint8Array,
  bit: number,
  code: number,
): number | undefined {
  const categories = EVENT_REFERENCE_CATEGORIES.get(code);
  if (!categories) return undefined;
  for (let category of categories) {
    const present = readBits(payload, bit, 1);
    if (present === undefined) return undefined;
    bit++;
    if (present === 0) continue;
    if (category === 1) {
      const probe = readBits(payload, bit, 1);
      if (probe === undefined) return undefined;
      bit++;
      if (probe === 1) category = 4;
    }
    const range = PRESENCE_RANGES[category];
    const width = range === 0 ? 0 : Math.floor(Math.log2(range)) + 1;
    bit += width + 2;
    if (bit > payload.length * 8) return undefined;
  }
  return bit;
}

class EventBodyCursor {
  constructor(
    private readonly payload: Uint8Array,
    private bit: number,
  ) {}

  read(width: number): number | undefined {
    const value = readBits(this.payload, this.bit, width);
    if (value !== undefined) this.bit += width;
    return value;
  }

  skip(width: number): boolean {
    if (this.bit + width > this.payload.length * 8) return false;
    this.bit += width;
    return true;
  }

  get position() {
    return this.bit;
  }
}

function skipKillBody(payload: Uint8Array, bit: number): number | undefined {
  const victim = readOptionalPlayerIndex(payload, bit);
  const killer = victim && readOptionalPlayerIndex(payload, victim.nextBit);
  if (!victim || !killer) return undefined;
  const end = killer.nextBit + 33;
  if (end + 1 > payload.length * 8) return undefined;
  const assister = readOptionalPlayerIndex(payload, end);
  return assister && assister.nextBit + 32 <= payload.length * 8
    ? assister.nextBit + 32
    : undefined;
}

function skipDamageBody(payload: Uint8Array, bit: number): number | undefined {
  const cursor = new EventBodyCursor(payload, bit);
  const gate32 = cursor.read(1);
  if (gate32 === undefined || (gate32 === 1 && !cursor.skip(32)))
    return undefined;
  const gate5 = cursor.read(1);
  if (gate5 === undefined || (gate5 === 0 && !cursor.skip(5))) return undefined;
  if (!cursor.skip(19)) return undefined;
  const direction = cursor.read(1);
  if (direction === undefined || (direction === 1 && !cursor.skip(31)))
    return undefined;
  if (!cursor.skip(16)) return undefined;
  const optional5 = cursor.read(1);
  if (optional5 === undefined || (optional5 === 1 && !cursor.skip(5)))
    return undefined;
  if (!cursor.skip(14)) return undefined;
  const gate32b = cursor.read(1);
  if (gate32b === undefined || (gate32b === 1 && !cursor.skip(32)))
    return undefined;
  if (!cursor.skip(1 + 3 + 5 + 5 + 1 + 4)) return undefined;
  const gate10 = cursor.read(1);
  if (gate10 === undefined || (gate10 === 0 && !cursor.skip(10)))
    return undefined;
  const field58 = cursor.read(4);
  const gate32c = cursor.read(1);
  if (field58 === undefined || gate32c === undefined) return undefined;
  if (gate32c === 1 && !cursor.skip(32)) return undefined;
  if (field58 === 1 && !cursor.skip(8)) return undefined;
  if (!cursor.skip(4)) return undefined;
  const victim = cursor.read(1);
  if (victim === undefined || (victim === 1 && !cursor.skip(15)))
    return undefined;
  return cursor.position;
}

interface ParsedPlayerGameEventBody {
  nextBit: number;
  type: number;
  killerIndex?: number;
  victimIndex?: number;
  recipientMask: number;
}

function parsePlayerGameEventBody(
  payload: Uint8Array,
  bit: number,
): ParsedPlayerGameEventBody | undefined {
  const cursor = new EventBodyCursor(payload, bit);
  const type = cursor.read(32);
  if (type === undefined || !cursor.skip(8)) return undefined;
  const propertyCount = cursor.read(3);
  if (propertyCount === undefined) return undefined;
  for (let i = 0; i < propertyCount; i++) {
    if (!cursor.skip(32)) return undefined;
    const valueType = cursor.read(3);
    if (valueType === undefined) return undefined;
    if ([1, 2, 3, 6].includes(valueType) && !cursor.skip(32)) return undefined;
    if (valueType === 4 && !cursor.skip(1)) return undefined;
    if (valueType === 5) {
      let terminated = false;
      for (let byte = 0; byte < 16; byte++) {
        const value = cursor.read(8);
        if (value === undefined) return undefined;
        if (value === 0) {
          terminated = true;
          break;
        }
      }
      if (!terminated) return undefined;
    }
    if (valueType === 7) return undefined;
  }

  const textPresent = cursor.read(1);
  if (textPresent === undefined) return undefined;
  let participants: number[] = [];
  if (textPresent === 1) {
    if (!cursor.skip(32)) return undefined;
    const entryCount = cursor.read(3);
    if (entryCount === undefined) return undefined;
    participants = [];
    for (let i = 0; i < entryCount; i++) {
      const subtype = cursor.read(3);
      if (subtype === undefined) return undefined;
      if (subtype === 1) {
        const participant = readOptionalPlayerIndex(payload, cursor.position);
        if (!participant) return undefined;
        if (participant.index !== undefined)
          participants.push(participant.index);
        if (!cursor.skip(participant.nextBit - cursor.position))
          return undefined;
      } else if (subtype === 2) {
        const quantized = cursor.read(1);
        if (quantized === undefined || !cursor.skip(quantized === 1 ? 24 : 32))
          return undefined;
      } else if (subtype === 3 || subtype >= 4) {
        if (!cursor.skip(32)) return undefined;
      }
    }
  }
  const recipientMask = cursor.read(32);
  if (recipientMask === undefined) return undefined;
  return {
    nextBit: cursor.position,
    type,
    ...(textPresent === 1 && participants.length === 2
      ? { killerIndex: participants[0], victimIndex: participants[1] }
      : {}),
    recipientMask,
  };
}

function skipEvent82Body(payload: Uint8Array, bit: number): number | undefined {
  return parsePlayerGameEventBody(payload, bit)?.nextBit;
}

function skipEventBody(
  payload: Uint8Array,
  bit: number,
  code: number,
  gate15: boolean,
): number | undefined {
  if (EVENT_STUBS.has(code)) return bit;
  if (EVENT_FIXED_BODY_BITS.has(code)) {
    const width = EVENT_FIXED_BODY_BITS.get(code);
    return width !== undefined && bit + width <= payload.length * 8
      ? bit + width
      : undefined;
  }
  if (code === 0) return skipDamageBody(payload, bit);
  if (code === 82) return skipEvent82Body(payload, bit);
  if (code === 85) return skipKillBody(payload, bit);
  if (code === 15) {
    const cursor = new EventBodyCursor(payload, bit);
    if (gate15 && !cursor.skip(15)) return undefined;
    if (!cursor.skip(13)) return undefined;
    const length = cursor.read(10);
    return length !== undefined && cursor.skip(length)
      ? cursor.position
      : undefined;
  }
  if (code === 1) {
    const cursor = new EventBodyCursor(payload, bit);
    if (!cursor.skip(5)) return undefined;
    const optional = cursor.read(1);
    if (optional === undefined || (optional === 0 && !cursor.skip(4)))
      return undefined;
    if (!cursor.skip(3)) return undefined;
    const hasTail = cursor.read(1);
    if (hasTail === undefined || (hasTail === 1 && !cursor.skip(19)))
      return undefined;
    return cursor.position;
  }
  return undefined;
}

function hasValidatedEventChain(
  payload: Uint8Array,
  bit: number,
  gate15: boolean,
): boolean {
  let count = 0;
  for (let attempt = 0; attempt < MAX_CHAIN_EVENTS; attempt++) {
    const continuation = readBits(payload, bit, 1);
    if (continuation === undefined) return false;
    bit++;
    if (continuation === 0) return count >= MIN_VALID_CHAIN_EVENTS;
    const code = readBits(payload, bit, 7);
    if (code === undefined || code >= 123) return false;
    bit += 7;
    const bodyStart = readEventPresence(payload, bit, code);
    if (bodyStart === undefined) return false;
    const next = skipEventBody(payload, bodyStart, code, gate15);
    if (next === undefined) return false;
    bit = next;
    count++;
  }
  return count >= MIN_VALID_CHAIN_EVENTS;
}

/** Values read directly from the PlayerKilledEvent (genre 85) message body. */
export interface PlayerKilledEvent {
  timeMs: number;
  victimIndex: number;
  killerIndex: number;
  assisterIndex?: number;
  killerDamagePercent: number;
  assisterDamagePercent?: number;
}

/** PlayerGameEventSmall (genre 82) fields read from its text bag and recipient mask. */
export interface PlayerGameEvent {
  timeMs: number;
  type: number;
  killerIndex: number;
  victimIndex: number;
  recipientMask: number;
}

export function readPlayerGameEvents(
  payload: Uint8Array,
  timeMs: number,
  gate15 = false,
): PlayerGameEvent[] {
  const events: PlayerGameEvent[] = [];
  const totalBits = payload.length * 8;
  for (let start = 1; start + 8 <= totalBits; start++) {
    if (bitsAt(payload, start, 8) !== PLAYER_GAME_EVENT_HEADER) continue;
    const bodyStart = readEventPresence(payload, start + 8, 82);
    if (bodyStart === undefined) continue;
    const body = parsePlayerGameEventBody(payload, bodyStart);
    if (
      !body ||
      body.killerIndex === undefined ||
      body.victimIndex === undefined ||
      body.killerIndex === body.victimIndex ||
      !hasValidatedEventChain(payload, body.nextBit, gate15)
    )
      continue;
    events.push({
      timeMs,
      type: body.type,
      killerIndex: body.killerIndex,
      victimIndex: body.victimIndex,
      recipientMask: body.recipientMask,
    });
  }
  return events;
}

/** Extracts couple-bearing PlayerGameEventSmall messages from gameplay frames. */
export async function extractPlayerGameEvents(
  chunkSource: FilmChunkSource,
): Promise<PlayerGameEvent[]> {
  let baseMicros: number | null = null;
  const frames: { payload: Uint8Array; timeMs: number }[] = [];
  for await (const chunk of chunkSource) {
    if (chunk.chunkType !== CHUNK_TYPE_GAMEPLAY) continue;
    for (const packet of splitPackets(inflateChunk(chunk.data))) {
      baseMicros ??= packet.timestampMicros;
      if (packet.type !== PacketType.Frame) continue;
      frames.push({
        payload: packet.payload,
        timeMs: (packet.timestampMicros - baseMicros) / 1000,
      });
    }
  }
  const chainCounts = [false, true].map((gate15) =>
    frames.reduce(
      (sum, frame) =>
        sum + readPlayerGameEvents(frame.payload, frame.timeMs, gate15).length,
      0,
    ),
  );
  const gate15 = chainCounts[1] > chainCounts[0];
  return frames.flatMap((frame) =>
    readPlayerGameEvents(frame.payload, frame.timeMs, gate15),
  );
}

function readOptionalPlayerIndex(
  payload: Uint8Array,
  bit: number,
): { index?: number; nextBit: number } | undefined {
  const totalBits = payload.length * 8;
  if (bit + 1 > totalBits) return undefined;
  if (bitsAt(payload, bit, 1) === 1) return { nextBit: bit + 1 };
  if (bit + 6 > totalBits) return undefined;
  return { index: bitsAt(payload, bit + 1, 5), nextBit: bit + 6 };
}

/** Reads the exact kill-event fields from a frame payload. */
export function readPlayerKilledEvents(
  payload: Uint8Array,
  timeMs: number,
  gate15 = false,
): PlayerKilledEvent[] {
  const totalBits = payload.length * 8;
  const events: PlayerKilledEvent[] = [];
  for (let start = 1; start + 8 <= totalBits; start++) {
    if (bitsAt(payload, start, 8) !== PLAYER_KILLED_HEADER) continue;

    let bit = start + 8;
    let valid = true;
    // Genre 85 declares reference domains 8, 8, and 7. Each has a 13-bit
    // value and 2-bit generation on the supported film grammar.
    for (let reference = 0; reference < 3; reference++) {
      if (bit + 1 > totalBits) {
        valid = false;
        break;
      }
      const present = bitsAt(payload, bit++, 1) === 1;
      if (present) bit += KILL_EVENT_REFERENCE_WIDTH + 2;
      if (bit > totalBits) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;

    const victim = readOptionalPlayerIndex(payload, bit);
    if (!victim?.index && victim?.index !== 0) continue;
    const killer = readOptionalPlayerIndex(payload, victim.nextBit);
    if (!killer?.index && killer?.index !== 0) continue;
    bit = killer.nextBit;
    if (bit + 33 > totalBits) continue;
    const killerDamagePercent = bitsAt(payload, bit, 32);
    bit += 33; // R(32) killer share and R(1) flag
    const assister = readOptionalPlayerIndex(payload, bit);
    if (!assister || assister.nextBit + 32 > totalBits) continue;
    bit = assister.nextBit;
    const assisterDamagePercent = bitsAt(payload, bit, 32);
    if (victim.index === killer.index) continue;
    if (!hasValidatedEventChain(payload, bit + 32, gate15)) continue;

    events.push({
      timeMs,
      victimIndex: victim.index,
      killerIndex: killer.index,
      assisterIndex: assister.index,
      killerDamagePercent,
      ...(assister.index === undefined ? {} : { assisterDamagePercent }),
    });
  }
  return events;
}

/** Extracts PlayerKilledEvent messages on the same packet clock as replay positions. */
export async function extractPlayerKilledEvents(
  chunkSource: FilmChunkSource,
): Promise<PlayerKilledEvent[]> {
  let baseMicros: number | null = null;
  const frames: { payload: Uint8Array; timeMs: number }[] = [];
  for await (const chunk of chunkSource) {
    if (chunk.chunkType !== CHUNK_TYPE_GAMEPLAY) continue;
    for (const packet of splitPackets(inflateChunk(chunk.data))) {
      baseMicros ??= packet.timestampMicros;
      if (packet.type !== PacketType.Frame) continue;
      frames.push({
        payload: packet.payload,
        timeMs: (packet.timestampMicros - baseMicros) / 1000,
      });
    }
  }
  const chainCounts = [false, true].map((gate15) =>
    frames.reduce(
      (sum, frame) =>
        sum +
        readPlayerKilledEvents(frame.payload, frame.timeMs, gate15).length,
      0,
    ),
  );
  const gate15 = chainCounts[1] > chainCounts[0];
  return frames.flatMap((frame) =>
    readPlayerKilledEvents(frame.payload, frame.timeMs, gate15),
  );
}
