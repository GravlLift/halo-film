import { PacketType, inflateChunk, splitPackets } from "./packets";
import { CHUNK_TYPE_GAMEPLAY, type FilmChunkSource } from "./film-input";

/**
 * Entity "stat records" found in frame packets: sparse lists of score
 * components for the two team entities (slots 6 and 8) and the player
 * entities (slots 10..24, even). Grammar measured by LevelUp
 * (`grammar/signaux/statborg.go`):
 *
 *   [1 bit =1][13 bit id][2 bit gen =0b10][1 bit gate]
 *   gate 0: [3 bit n][n x 6 bit component index, strictly increasing]
 *   gate 1: [64 bit mask]
 *   per component: [5 bit round][5 bit round][A][B][2 flags][optional C][optional D]
 *   value: [2 bit selector -> width 8<<sel][signed value]
 */
export interface StatValue {
  a: number;
  b: number;
  c?: number;
  d?: number;
}

export interface StatRecord {
  /** Same time base as position samples. */
  timeMs: number;
  slot: number;
  round: number;
  comps: Map<number, StatValue>;
}

const ID_BITS = 14;
const GEN_VALUE = 0b10;
const HEADER_BITS = 5;
const MASK_BITS = 64;
const MAX_COMPONENT = 58;
const COMPONENT_INDEX_BITS = 6;
const MAX_COMPONENTS_PER_RECORD = 7;
const SLOT_MIN = 6;
const SLOT_MAX = 24;
const TAIL_BITS = 64;
const MAX_ROUND = 7;
const MAX_COUNTER = 1 << 20;

/** Reads up to 32 bits MSB first, stopping (without padding) at the end of the buffer. */
function bits(data: Uint8Array, pos: number, n: number): number {
  const available = data.length * 8 - pos;
  if (pos < 0 || available <= 0) return 0;
  const count = Math.min(n, available);
  let value = 0;
  for (let i = 0; i < count; i++) {
    const p = pos + i;
    value = value * 2 + ((data[p >> 3] >> (7 - (p & 7))) & 1);
  }
  return value;
}

function readVarWidth(
  data: Uint8Array,
  pos: number,
): { value: number; width: number } | null {
  if (pos < 0 || pos + 2 > data.length * 8) return null;
  const width = 8 << bits(data, pos, 2);
  if (width > 32 || pos + 2 + width > data.length * 8) return null;
  const raw = bits(data, pos + 2, width);
  const value = width < 32 && raw >= 2 ** (width - 1) ? raw - 2 ** width : raw | 0;
  return { value, width: 2 + width };
}

function readComponent(
  data: Uint8Array,
  pos: number,
): { value: StatValue; width: number } | null {
  let q = pos + 2 * HEADER_BITS;
  const a = readVarWidth(data, q);
  if (!a) return null;
  const b = readVarWidth(data, q + a.width);
  if (!b) return null;
  q += a.width + b.width;
  if (q + 2 > data.length * 8) return null;
  const flags = [bits(data, q, 1), bits(data, q + 1, 1)];
  q += 2;
  const value: StatValue = { a: a.value, b: b.value };
  for (let i = 0; i < 2; i++) {
    if (flags[i] !== 1) continue;
    const extra = readVarWidth(data, q);
    if (!extra) return null;
    if (i === 0) value.c = extra.value;
    else value.d = extra.value;
    q += extra.width;
  }
  return { value, width: q - pos };
}

function readHeader(
  data: Uint8Array,
  b: number,
): { slot: number; indices: number[]; componentsAt: number } | null {
  if (bits(data, b - 1, 1) !== 1) return null;
  const slot = bits(data, b, ID_BITS);
  if (slot < SLOT_MIN || slot > SLOT_MAX || slot % 2 !== 0) return null;
  if (bits(data, b + ID_BITS, 2) !== GEN_VALUE) return null;
  const m = b + ID_BITS + 2;
  if (bits(data, m, 1) !== 0) {
    const p = m + 1;
    if (p + MASK_BITS > data.length * 8) return null;
    const hi = bits(data, p, 32);
    const lo = bits(data, p + 32, 32);
    if (hi === 0 && lo === 0) return null;
    // Bits above the archetype's component count must be clear.
    if (hi >>> (MAX_COMPONENT - 32) !== 0) return null;
    const indices: number[] = [];
    for (let i = 0; i < MAX_COMPONENT; i++) {
      const word = i < 32 ? lo : hi;
      if ((word >>> i % 32) & 1) indices.push(i);
    }
    return { slot, indices, componentsAt: p + MASK_BITS };
  }
  const n = bits(data, m + 1, 3);
  if (n < 1 || n > MAX_COMPONENTS_PER_RECORD) return null;
  const indices: number[] = [];
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const idx = bits(data, m + 4 + COMPONENT_INDEX_BITS * i, COMPONENT_INDEX_BITS);
    if (idx >= MAX_COMPONENT || idx <= prev) return null;
    indices.push(idx);
    prev = idx;
  }
  return { slot, indices, componentsAt: m + 4 + COMPONENT_INDEX_BITS * n };
}

function countersInDomain(comps: Map<number, StatValue>): boolean {
  for (const v of comps.values()) {
    if (Math.abs(v.a) > MAX_COUNTER || Math.abs(v.b) > MAX_COUNTER) return false;
  }
  return true;
}

/** Scans one frame payload at every bit offset for stat records. */
export function scanStatRecords(
  payload: Uint8Array,
  timeMs: number,
): StatRecord[] {
  const out: StatRecord[] = [];
  const limit = payload.length * 8 - TAIL_BITS;
  for (let b = 1; b < limit; b++) {
    const header = readHeader(payload, b);
    if (!header) continue;
    const h1 = bits(payload, header.componentsAt, HEADER_BITS);
    const h2 = bits(payload, header.componentsAt + HEADER_BITS, HEADER_BITS);
    if (h1 !== h2 || h1 > MAX_ROUND) continue;
    const comps = new Map<number, StatValue>();
    let q = header.componentsAt;
    for (const index of header.indices) {
      const component = readComponent(payload, q);
      if (!component) break;
      comps.set(index, component.value);
      q += component.width;
    }
    if (comps.size === 0 || !countersInDomain(comps)) continue;
    out.push({ timeMs, slot: header.slot, round: h1, comps });
  }
  return out;
}

/** Decodes every stat record in the film, on the position time base. */
export async function extractStatRecords(
  chunkSource: FilmChunkSource,
): Promise<StatRecord[]> {
  let baseMicros: number | null = null;
  const records: StatRecord[] = [];
  for await (const chunk of chunkSource) {
    if (chunk.chunkType !== CHUNK_TYPE_GAMEPLAY) continue;
    for (const packet of splitPackets(inflateChunk(chunk.data))) {
      baseMicros ??= packet.timestampMicros;
      if (packet.type !== PacketType.Frame) continue;
      records.push(
        ...scanStatRecords(
          packet.payload,
          (packet.timestampMicros - baseMicros) / 1000,
        ),
      );
    }
  }
  return records.sort((x, y) => x.timeMs - y.timeMs || x.slot - y.slot);
}
