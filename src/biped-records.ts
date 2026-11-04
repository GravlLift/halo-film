import { BitReader } from "./bit-reader";

// Biped record header (relative to a record start at bit `p` in a frame payload):
//   [1 prefix = 1][13 slot][2 tag = 1][1 gate = 0][3 maskCount]
//   [6 * maskCount ascending component indices, first = 0]
// followed by component 0 (absolute position).
const HEADER_BITS = 21;
const INDEX_BITS = 6;
const MIN_MASK_COUNT = 2;
const MAX_MASK_COUNT = 7;
const SLOT_BITS = 13;

/** Component 0 starts with 5 control bits (all zero for an absolute position). */
export const I0_GATE_BITS = 5;

export interface RecordCandidate {
  slot: number;
  /** Bit offset of the record header within the payload. */
  headerBit: number;
  /** Bit offset of component 0 (the position block) within the payload. */
  i0Bit: number;
  maskIndices: number[];
}

/** Finds every position in a frame payload where a biped record header parses. */
export function findRecordCandidates(payload: Uint8Array): RecordCandidate[] {
  const reader = new BitReader(payload);
  const total = reader.bitLength;
  const found: RecordCandidate[] = [];
  for (let p = 0; p + HEADER_BITS + INDEX_BITS * MIN_MASK_COUNT < total; p++) {
    if (reader.bitAt(p) !== 1) continue;
    if (reader.peek(p + 14, 2) !== 1) continue;
    if (reader.peek(p + 16, 2) !== 0) continue;
    const maskCount = reader.peek(p + 18, 3);
    if (maskCount < MIN_MASK_COUNT || maskCount > MAX_MASK_COUNT) continue;

    const maskIndices: number[] = [];
    let previous = -1;
    let valid = true;
    for (let j = 0; j < maskCount; j++) {
      const index = reader.peek(p + HEADER_BITS + INDEX_BITS * j, INDEX_BITS);
      if ((j === 0 && index !== 0) || index <= previous) {
        valid = false;
        break;
      }
      maskIndices.push(index);
      previous = index;
    }
    if (!valid) continue;

    const i0Bit = p + HEADER_BITS + INDEX_BITS * maskCount;
    if (i0Bit + I0_GATE_BITS > total) continue;
    if (reader.peek(i0Bit, I0_GATE_BITS - 2) !== 0) continue;
    found.push({
      slot: reader.peek(p + 1, SLOT_BITS),
      headerBit: p,
      i0Bit,
      maskIndices,
    });
  }
  return found;
}

/**
 * Live biped slots cluster together, but dead slots leave gaps, while headers
 * that parse by coincidence are scattered far away. Anchors on slots seen in
 * at least `anchorShare` as often as the busiest slot and accepts any slot
 * seen in more than `minimumShare` of frames
 * within `reach` of an anchor.
 */
export function findBipedSlots(
  slotCounts: ReadonlyMap<number, number>,
  frameCount: number,
  anchorShare = 0.5,
  minimumShare = 0.05,
  reach = 24,
): Set<number> {
  const topCount = Math.max(0, ...slotCounts.values());
  const anchors = [...slotCounts]
    .filter(([, count]) => count >= topCount * anchorShare)
    .map(([slot]) => slot);
  const slots = new Set<number>();
  for (const [slot, count] of slotCounts) {
    if (count < frameCount * minimumShare) continue;
    if (anchors.some((anchor) => Math.abs(anchor - slot) <= reach)) {
      slots.add(slot);
    }
  }
  return slots;
}