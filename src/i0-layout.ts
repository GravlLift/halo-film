import { BitReader } from "./bit-reader";
import { I0_GATE_BITS } from "./biped-records";

/**
 * Bit widths of the quantized X/Y/Z fields in the position block. They are a
 * per-map constant that is not stored in the film, but they can be measured:
 * a quantized field that changes slowly flips its low bit ~50% of the time
 * between consecutive samples, with the flip rate roughly doubling toward the
 * low bit and collapsing at the next field's high bit (a sawtooth).
 */
export interface I0Layout {
  gateBits: number;
  axisBits: [number, number, number];
}

const PROFILE_BITS = 72;
const FIELD_PEAK_RATE = 0.1;
const FIELD_RESET_RATE = 0.03;
const MIN_FIELD_BITS = 8;
const MAX_FIELD_BITS = 26;

export interface ProfileSample {
  slot: number;
  /** First PROFILE_BITS bits of the position block. */
  bits: Uint8Array;
}

export function readProfileSample(
  reader: BitReader,
  slot: number,
  i0Bit: number,
): ProfileSample | null {
  if (i0Bit + PROFILE_BITS > reader.bitLength) return null;
  const bits = new Uint8Array(PROFILE_BITS);
  for (let k = 0; k < PROFILE_BITS; k++) bits[k] = reader.bitAt(i0Bit + k);
  return { slot, bits };
}

/** Per-bit flip rate between consecutive samples of the same slot. */
export function flipProfile(samples: ProfileSample[]): {
  rates: number[];
  pairs: number;
} {
  const flips = new Array<number>(PROFILE_BITS).fill(0);
  const last = new Map<number, Uint8Array>();
  let pairs = 0;
  for (const sample of samples) {
    const previous = last.get(sample.slot);
    if (previous) {
      pairs++;
      for (let k = 0; k < PROFILE_BITS; k++) {
        if (previous[k] !== sample.bits[k]) flips[k]++;
      }
    }
    last.set(sample.slot, sample.bits);
  }
  return { rates: flips.map((f) => (pairs ? f / pairs : 0)), pairs };
}

/** Reads the three field widths off the sawtooth in the flip-rate profile. */
export function detectI0Layout(rates: number[]): I0Layout | null {
  const widths: number[] = [];
  let start = I0_GATE_BITS;
  for (let k = start; k + 1 < rates.length && widths.length < 3; k++) {
    const width = k - start + 1;
    if (
      width >= MIN_FIELD_BITS &&
      rates[k] >= FIELD_PEAK_RATE &&
      rates[k + 1] < FIELD_RESET_RATE
    ) {
      widths.push(width);
      start = k + 1;
    }
  }
  if (widths.length !== 3) return null;
  if (widths.some((w) => w < MIN_FIELD_BITS || w > MAX_FIELD_BITS)) {
    return null;
  }
  return {
    gateBits: I0_GATE_BITS,
    axisBits: [widths[0], widths[1], widths[2]],
  };
}
