/**
 * Anchor walker for keyframe payloads, ported from LevelUp's
 * `keyframe_world.go`. A keyframe holds a table of entity records whose
 * 64-bit headers are `[id:32][field26:26][typeIndex:6]`; the bodies have no
 * length prefix, so records are found by hunting for the next valid header.
 */

const SENTINEL = 0xffffffff;
const TABLE_CAP = 8192;
const ARCHETYPE_MAX = 50;
const TYPE_INDEX_BIT = 58;
const SCAN_WINDOW_BITS = 120000;
export const BIPED_TYPE_INDEX = 35;

const TWO32 = 2 ** 32;
const POW2 = Array.from({ length: 33 }, (_, i) => 2 ** i);

/** Reads `n` (<= 32) bits at `pos`; bits outside the buffer read as zero. */
export function bitsAt(buf: Uint8Array, pos: number, n: number): number {
  if (n === 0) return 0;
  const byte = pos >> 3;
  const shift = pos & 7;
  let raw: number;
  if (byte >= 0 && byte + 4 < buf.length) {
    raw =
      buf[byte] * TWO32 +
      buf[byte + 1] * 16777216 +
      buf[byte + 2] * 65536 +
      buf[byte + 3] * 256 +
      buf[byte + 4];
  } else {
    raw = 0;
    for (let i = 0; i < 5; i++) {
      const j = byte + i;
      raw = raw * 256 + (j >= 0 && j < buf.length ? buf[j] : 0);
    }
  }
  const word = Math.floor(raw / POW2[8 - shift]) % TWO32;
  return Math.floor(word / POW2[32 - n]);
}

export interface KeyframeRecord {
  slot: number;
  typeIndex: number;
  generation: number;
  /** Bit offset of the record header within the payload. */
  bit: number;
}

interface Anchor {
  slot: number;
  typeIndex: number;
  generation: number;
}

function validAnchor(
  buf: Uint8Array,
  q: number,
  prevSlot: number,
  total: number,
): Anchor | undefined {
  if (q < 0 || q + 64 > total) return undefined;
  const id = bitsAt(buf, q, 32);
  if (id === SENTINEL) return undefined;
  const generation = Math.floor(id / 2 ** 30);
  if (generation === 0) return undefined;
  const slot = id % 2 ** 30;
  if (slot <= prevSlot || slot >= TABLE_CAP) return undefined;
  if (bitsAt(buf, q + 32, 32) >= ARCHETYPE_MAX) return undefined;
  return { slot, typeIndex: bitsAt(buf, q + TYPE_INDEX_BIT, 6), generation };
}

interface Candidate {
  consecutive: number;
  generation: number;
  slot: number;
  bit: number;
}

function better(c: Candidate, best: Candidate): boolean {
  if (c.consecutive !== best.consecutive)
    return c.consecutive > best.consecutive;
  if (c.generation !== best.generation) return c.generation < best.generation;
  if (c.slot !== best.slot) return c.slot < best.slot;
  return c.bit < best.bit;
}

/** Next record anchor at or after `from`, or -1: neighbour, exact biped header, then election. */
function nextAnchor(
  buf: Uint8Array,
  total: number,
  from: number,
  prevSlot: number,
): number {
  let best: Candidate | undefined;
  let elected = -1;
  let exact = -1;
  const end = Math.min(from + SCAN_WINDOW_BITS, total);
  const limit = Math.min(end, total - 63);
  for (let q = from; q < limit; q++) {
    // Cheap rejection before the full anchor check: generation bits must be set.
    if (bitsAt(buf, q, 2) === 0) continue;
    const a = validAnchor(buf, q, prevSlot, total);
    if (!a) continue;
    if (a.slot === prevSlot + 1 && a.generation === 1) return q;
    if (exact < 0 && a.generation === 1 && a.typeIndex === BIPED_TYPE_INDEX) {
      exact = q;
    }
    const cand: Candidate = {
      consecutive: a.slot === prevSlot + 1 ? 1 : 0,
      generation: a.generation,
      slot: a.slot,
      bit: q,
    };
    if (!best || better(cand, best)) {
      best = cand;
      elected = q;
    }
  }
  if (exact >= 0 && (elected < 0 || exact <= elected)) return exact;
  return elected;
}

function slidingAnchor(
  buf: Uint8Array,
  total: number,
  from: number,
  prevSlot: number,
): number {
  for (let f = from; f + 64 <= total; f += SCAN_WINDOW_BITS) {
    const at = nextAnchor(buf, total, f, prevSlot);
    if (at >= 0) return at;
  }
  return -1;
}

/** Walks a keyframe payload and returns its entity records in stream order. */
export function walkKeyframe(payload: Uint8Array): KeyframeRecord[] {
  const total = payload.length * 8;
  const records: KeyframeRecord[] = [];
  const widths = new Map<number, number>();
  const seen = new Map<number, number>();
  let pos = 1;
  let prev = -1;
  if (!validAnchor(payload, pos, prev, total)) {
    pos = slidingAnchor(payload, total, pos, prev);
  }
  while (pos >= 0) {
    const anchor = validAnchor(payload, pos, prev, total);
    if (!anchor) break;
    const { slot, typeIndex, generation } = anchor;
    const startState = pos + 64;
    let next = -1;
    const width = widths.get(typeIndex);
    if (width !== undefined) {
      const jump = validAnchor(payload, startState + width, slot, total);
      if (jump && jump.generation === 1) next = startState + width;
    }
    if (next < 0) next = slidingAnchor(payload, total, startState, slot);
    records.push({ slot, typeIndex, generation, bit: pos });
    prev = slot;
    if (next < 0) break;
    // A width is trusted once the same value is observed twice in a row.
    const w = next - startState;
    const prevW = seen.get(typeIndex);
    if (prevW === undefined) seen.set(typeIndex, w);
    else if (prevW === w) widths.set(typeIndex, w);
    else widths.delete(typeIndex);
    pos = next;
  }
  return records;
}
