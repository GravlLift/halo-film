import type { BitReader } from './bit-reader';

/**
 * Components that follow the position block (i0) in a biped record, in
 * ascending mask-index order. Ported from LevelUp's offline_aim.go
 * (`scanRecordDirs`). Decoding stops at the first component whose width is not
 * modelled, because the cursor is unreliable beyond it.
 */

/** Cube-map packed direction width. */
const DIRECTION_BITS = 19;
const VELOCITY_MAGNITUDE_BITS = 10;
const ANGULAR_VELOCITY_BITS = 19 + 8;
const RAW_VEC3_BITS = 96;
const YAW_BITS = 12;
const PITCH_BITS = 11;
const BODY_BITS = 8;
const SHIELD_BITS = 8;
const SHIELD_MIN_BITS = 8 + 1 + 20;
/** Bits between the end of the xyz quanta and the start of i1 (the 'finite' field). */
export const I0_TAIL_BITS = 2;

export interface BipedComponents {
  /** Where the player is looking, degrees in the map's XY plane [0, 360). */
  aimYawDeg?: number;
  /** Look elevation in degrees; positive is up. */
  aimPitchDeg?: number;
  /** Body health fraction [0, 1]. */
  health?: number;
  /** Shield fraction; values above 1 are overshield. */
  shield?: number;
  /** Raw 8-bit shield quantum; overshield is any quantum above 64. */
  shieldQ?: number;
}

/**
 * Midpoint dequantization with exact endpoints (FUN_1406d84b4).
 * `exclusive` removes the top level and snaps the exact middle to its midpoint.
 */
function dequantEndpoint(
  q: number,
  min: number,
  max: number,
  bits: number,
  exclusive: boolean,
): number {
  let levels = 2 ** bits;
  if (exclusive) levels -= 1;
  let value: number;
  if (q === 0) value = min;
  else if (q === levels - 1) value = max;
  else {
    const step = (max - min) / (levels - 2);
    value = (q - 1) * step + (step * 0.5 + min);
  }
  if (exclusive && 2 * q === levels - 1) value = (min + max) / 2;
  return value;
}

export function yawDegrees(raw: number): number {
  return (360 * (raw + 0.5)) / 2 ** YAW_BITS;
}

export function pitchDegrees(raw: number): number {
  return (360 * (raw + 0.5)) / 2 ** PITCH_BITS - 180;
}

/**
 * @param at bit offset just after the xyz quanta of i0
 * @param maskIndices component indices declared by the record (first is 0)
 */
/** Reads `n` bits at `at`, or null if the payload ends first. */
function readGated(
  reader: BitReader,
  at: number,
  n: number,
): { value: number; at: number } | null {
  if (at + n > reader.bitLength) return null;
  return { value: reader.peek(at, n), at: at + n };
}

/** `R(1)` gate; when `present` matches the bit, `width` more bits follow. */
function skipGate(
  reader: BitReader,
  at: number,
  width: number,
  presentWhenSet: boolean,
): number | null {
  const gate = readGated(reader, at, 1);
  if (!gate) return null;
  const hasPayload = (gate.value === 1) === presentWhenSet;
  const end = gate.at + (hasPayload ? width : 0);
  return end > reader.bitLength ? null : end;
}

/**
 * End of component `index` that starts at `at`, or null when its width is not
 * modelled or the payload ends first. Widths come from LevelUp's deserializer
 * grammar (`unit_weaponstate.go`, `unit_control.go`).
 */
function skipLaterComponent(
  reader: BitReader,
  at: number,
  index: number,
): number | null {
  const total = reader.bitLength;
  const fixed = (bits: number) => (at + bits <= total ? at + bits : null);
  switch (index) {
    case 21: {
      const flag0 = readGated(reader, at, 1);
      if (!flag0) return null;
      return fixed(1 + 23 + 1 + (flag0.value === 0 ? 23 + 1 : 0));
    }
    case 22:
      return fixed(3 + 4 * 8);
    case 24: {
      // unit-low-frequency: R(1), gated id, R(3), R(1), counted ids, R(2).
      let cursor = skipVarWidthId(reader, at + 1);
      if (cursor === null) return null;
      cursor += 3 + 1;
      const count = readGated(reader, cursor, 4);
      if (!count) return null;
      cursor = count.at;
      for (let k = 0; k < count.value; k++) {
        const next = skipVarWidthId(reader, cursor);
        if (next === null) return null;
        cursor = next;
      }
      return fixed(cursor + 2 - at);
    }
    case 25: {
      // unit-command-tick
      let cursor = skipGate(reader, at, 8, true);
      if (cursor === null) return null;
      const g1 = readGated(reader, cursor, 1);
      if (!g1) return null;
      cursor = g1.at;
      if (g1.value === 1) {
        const g2 = readGated(reader, cursor, 1);
        if (!g2) return null;
        cursor = skipGate(reader, g2.at, 8, true);
        if (cursor === null) return null;
        if (g2.value === 0) {
          cursor = skipGate(reader, cursor, 8, true);
          if (cursor === null) return null;
        }
        const g3 = readGated(reader, cursor, 1);
        if (!g3) return null;
        cursor = g3.at + (g3.value === 0 ? 2 : 0);
      }
      return cursor <= total ? cursor : null;
    }
    case 26: {
      // unit-equipment
      const count = readGated(reader, at + 3, 3);
      if (!count) return null;
      let cursor = count.at;
      for (let k = 0; k < count.value; k++) {
        const next = skipVarWidthId(reader, cursor);
        if (next === null) return null;
        cursor = next;
      }
      return cursor;
    }
    case 27:
      return fixed(40);
    case 28: {
      // unit-active-camo-state
      let cursor = at + 3;
      const flag0 = readGated(reader, cursor, 1);
      if (!flag0) return null;
      cursor = flag0.at;
      if (flag0.value === 0) {
        const flag1 = readGated(reader, cursor, 1);
        if (!flag1) return null;
        cursor = flag1.at + (flag1.value === 0 ? 12 : 0);
      }
      for (let k = 0; k < 6; k++) {
        const next = skipGate(reader, cursor, 12, true);
        if (next === null) return null;
        cursor = next;
      }
      return cursor;
    }
    case 29:
      return fixed(11);
    default:
      break;
  }
  if (index >= 30 && index <= 41) {
    switch ((index - 30) % 3) {
      case 0: {
        const mag = skipGate(reader, at, 8, false);
        if (mag === null) return null;
        return skipGate(reader, mag, 12, false);
      }
      case 1:
        return fixed(WEAPON_RESERVE_BITS);
      default:
        return fixed(7 + 1 + 1);
    }
  }
  return null;
}

/** Optional 13-bit-valued handle: gate, 13 value bits, 2 generation bits. */
function skipVarWidthId(reader: BitReader, at: number): number | null {
  const gate = readGated(reader, at, 1);
  if (!gate) return null;
  if (gate.value === 0) return gate.at;
  return gate.at + 15 <= reader.bitLength ? gate.at + 15 : null;
}

export const WEAPON_RESERVE_BITS = 11;

export type ComponentVisitor = (index: number, bitStart: number) => void;

/**
 * @param at bit offset just after the xyz quanta of i0
 * @param maskIndices component indices declared by the record (first is 0)
 * @param visit called with each component's start bit before it is consumed,
 *   including those past i21 that only advance the cursor
 */
export function readBipedComponents(
  reader: BitReader,
  at: number,
  maskIndices: readonly number[],
  visit?: ComponentVisitor,
): BipedComponents {
  const total = reader.bitLength;
  const out: BipedComponents = {};
  at += I0_TAIL_BITS;
  for (const index of maskIndices.slice(1)) {
    visit?.(index, at);
    switch (index) {
      case 1: {
        // translational velocity
        if (at + 1 > total) return out;
        if (reader.bitAt(at) === 1) {
          at += 1 + RAW_VEC3_BITS;
          break;
        }
        at++;
        if (at + 1 > total) return out;
        if (reader.bitAt(at) === 1) {
          at++;
          break;
        }
        at += 1 + DIRECTION_BITS + VELOCITY_MAGNITUDE_BITS;
        break;
      }
      case 2: {
        // forward and up
        if (at + 1 > total) return out;
        const absent = reader.bitAt(at) === 1;
        at += 1 + (absent ? 0 : DIRECTION_BITS) + 8;
        break;
      }
      case 3: {
        if (at + 1 > total) return out;
        const absent = reader.bitAt(at) === 1;
        at += 1 + (absent ? 0 : ANGULAR_VELOCITY_BITS);
        break;
      }
      case 4: {
        if (at + BODY_BITS + 3 > total) return out;
        const q = reader.peek(at, BODY_BITS);
        const health = dequantEndpoint(q, -1, 1, BODY_BITS, true);
        out.health = Math.min(1, Math.max(0, health));
        at += BODY_BITS + 3;
        break;
      }
      case 5: {
        if (at + SHIELD_MIN_BITS > total) return out;
        const q = reader.peek(at, SHIELD_BITS);
        let cursor = at + SHIELD_BITS;
        if (reader.bitAt(cursor++) === 1) {
          for (let k = 0; k < 2; k++) {
            if (reader.bitAt(cursor++) === 1) cursor += 12;
          }
        }
        cursor += 16 + 4;
        if (cursor > total) return out;
        out.shieldQ = q;
        out.shield = Math.max(0, dequantEndpoint(q, 0, 4, SHIELD_BITS, false));
        at = cursor;
        break;
      }
      case 21: {
        // unit-desired-aiming-vector
        if (at + 1 + YAW_BITS + PITCH_BITS > total) return out;
        const yaw = reader.peek(at + 1, YAW_BITS);
        const pitch = reader.peek(at + 1 + YAW_BITS, PITCH_BITS);
        out.aimYawDeg = yawDegrees(yaw);
        out.aimPitchDeg = pitchDegrees(pitch);
        const end = skipLaterComponent(reader, at, index);
        if (end === null) return out;
        at = end;
        break;
      }
      default: {
        const end = skipLaterComponent(reader, at, index);
        if (end === null) return out;
        at = end;
        break;
      }
    }
  }
  return out;
}
