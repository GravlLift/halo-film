import { BitReader } from '../core/bit-reader';
import { BIPED_TYPE_INDEX, walkKeyframe } from '../core/keyframe-world';
import { decodeCubemapDirection } from './fire-events';

export interface KeyframeBipedPosition {
  slot: number;
  generation: number;
  world: [number, number, number];
  facingYawDeg?: number;
}

function readFacingYaw(read: (width: number) => number): number | undefined {
  read(2);
  if (read(1)) read(96);
  else if (!read(1)) read(29);
  const up = read(1) ? [0, 0, 1] : decodeCubemapDirection(read(19), 19);
  const roll = read(8);
  if (!up) return undefined;
  const forward =
    Math.abs(up[0]) < Math.abs(up[1]) ? [0, up[2], -up[1]] : [up[2], 0, -up[0]];
  const length = Math.hypot(...forward);
  if (length < 0.0001) return undefined;
  const base = forward.map((value) => value / length);
  const crossX = up[1] * base[2] - up[2] * base[1];
  const crossY = up[2] * base[0] - up[0] * base[2];
  const angle = ((roll + 0.5) * 2 * Math.PI) / 256 - Math.PI;
  const headingX = base[0] * Math.cos(angle) + crossX * Math.sin(angle);
  const headingY = base[1] * Math.cos(angle) + crossY * Math.sin(angle);
  if (Math.hypot(headingX, headingY) < 0.0001) return undefined;
  return ((Math.atan2(headingY, headingX) * 180) / Math.PI + 360) % 360;
}

export function readKeyframeBipedPositions(
  payload: Uint8Array,
): KeyframeBipedPosition[] {
  const records = walkKeyframe(payload);
  const positions: KeyframeBipedPosition[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.typeIndex !== BIPED_TYPE_INDEX) continue;
    const end = records[index + 1]?.bit ?? payload.length * 8;
    const reader = new BitReader(payload);
    reader.position = record.bit + 108;
    const read = (width: number) => {
      if (reader.position + width > end)
        throw new RangeError('Truncated keyframe');
      return reader.read(width);
    };
    const optional32 = () => {
      if (read(1)) read(32);
    };
    try {
      const defaultSize = read(32);
      if (defaultSize === 0 || defaultSize > 65536) continue;
      const version = read(1) ? read(8) : 13;
      optional32();
      if (version > 10 && !read(1)) read(5);
      read(9);
      read(32);
      if (!read(1)) read(32);
      if (read(1)) read(18);
      if (read(1)) read(13);
      read(2);
      read(5);
      const count = read(3);
      if (count > 4) continue;
      for (let item = 0; item < count; item++) {
        read(5);
        optional32();
      }
      if (read(1)) {
        if (!read(1)) read(5);
        if (read(1)) read(8);
        read(8);
        read(8);
      }
      if (read(1)) {
        read(32);
        optional32();
        read(14);
      }
      if (read(1)) read(6);
      read(1);
      optional32();
      read(19);
      if (version > 5) read(1);
      if (version >= 12) optional32();
      const size = read(32);
      if (size === 0 || size > 65536 || read(2) !== 0 || read(1) !== 0)
        continue;
      const words = [read(32), read(32), read(32)];
      const view = new DataView(new ArrayBuffer(4));
      const floats = words.map((word) => {
        view.setUint32(0, word);
        return view.getFloat32(0, true);
      });
      if (!floats.every(Number.isFinite)) continue;
      const position: KeyframeBipedPosition = {
        slot: record.slot,
        generation: record.generation,
        world: [floats[0], floats[1], floats[2]],
      };
      try {
        position.facingYawDeg = readFacingYaw(read);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
      positions.push(position);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  return positions;
}
