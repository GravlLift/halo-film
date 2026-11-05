import { PacketType, inflateChunk, splitPackets } from '../core/packets';
import { CHUNK_TYPE_GAMEPLAY, type FilmChunkSource } from '../core/film-input';
import { bitsAt } from '../core/keyframe-world';
import { WEAPON_FAMILY_NAMES } from '../core/weapon-catalog';

/**
 * `action_weapon_fire` events (event type 36) from frame packets, after
 * LevelUp's `fire_events.go` / `weaponscan`. A record is
 * `[type:7][present:1][probe:1][index:9][gen:2][guards:2][flags:2][number:8]
 * [shooter guard + 5][e guard + 2][f guard][weapon:64]`. Only the canonical
 * layout (unit reference with probe, shooter and field e present) is
 * recognised, which is found by its fixed 10-bit prefix.
 */

/** `type = 36`, reference present, probe set, top bit of the 9-bit index clear. */
const FIRE_PREFIX = 0b0100100110;
const FIRE_PREFIX_BITS = 10;
const UNIT_INDEX_OFFSET = 9;
const WEAPON_FAMILY_OFFSET = 42;
const RECORD_BITS = WEAPON_FAMILY_OFFSET + 64;
/** Unit indices are relative to the first replicated-object slot. */
const UNIT_SLOT_BASE = 0x200;

const TYPE_BITS = 7;
const AIM_BITS = 30;
const GUARDED_REF_BITS = 13 + 2;

/**
 * Cubemap grid sizes by field width (6..30): `floor(sqrt(2^p / 6)) - 1`,
 * with face size `floor(2^p / 6)`.
 */
function cubemapParams(width: number): { face: number; grid: number } {
  return {
    face: Math.floor(2 ** width / 6),
    grid: Math.floor(Math.sqrt(2 ** width / 6)) - 1,
  };
}

/**
 * Dequantizes a packed cubemap direction (LevelUp's `DecodeAimVectorChecked`,
 * a port of the game's `FUN_1406d8288`). Returns undefined for an invalid
 * face, which also signals a misaligned bit cursor.
 */
export function decodeCubemapDirection(
  code: number,
  width: number,
): [number, number, number] | undefined {
  const { face: faceSize, grid } = cubemapParams(width);
  if (grid < 2) return undefined;
  const face = Math.floor(code / faceSize);
  if (face < 0 || face > 5) return undefined;
  const rem = code - faceSize * face;
  const iu = Math.floor(rem / grid);
  const iv = rem - grid * iu;
  const step = 2 / (grid - 1);
  const coord = (i: number) =>
    i * 2 === grid - 2 ? 0 : i * step - 1 + step * 0.5;
  const a = coord(iu);
  const b = coord(iv);
  let raw: [number, number, number];
  switch (face) {
    case 0:
      raw = [1, a, b];
      break;
    case 1:
      raw = [a, 1, b];
      break;
    case 2:
      raw = [a, b, 1];
      break;
    case 3:
      raw = [-1, a, b];
      break;
    case 4:
      raw = [a, -1, b];
      break;
    default:
      raw = [a, b, -1];
  }
  const length = Math.hypot(...raw);
  return [raw[0] / length, raw[1] / length, raw[2] / length];
}

export interface FireEvent {
  timeMs: number;
  /** Slot of the firing unit; a biped slot for on-foot weapons. */
  slot: number;
  /** High 32 bits of the weapon id. */
  family: number;
  weapon: string;
  /** World aim heading of the shot, atan2(y, x) in degrees, when decodable. */
  aimYawDeg?: number;
}

/**
 * Reads the aim direction of a fire record whose type field starts at `bit`.
 * Only the modal record (no targets, no damage components, no block
 * timestamp) is decoded, as in LevelUp's `fire_aim_modal.go`.
 */
export function readAimYaw(
  payload: Uint8Array,
  bit: number,
): number | undefined {
  let pos = bit + TYPE_BITS;
  const read = (n: number) => {
    const v = bitsAt(payload, pos, n);
    pos += n;
    return v;
  };
  // Unit reference: guard, probe, index, generation.
  if (read(1)) {
    const probe = read(1);
    pos += (probe ? 9 : 13) + 2;
  }
  // Two more guarded references, then the short and block flags.
  for (let i = 0; i < 2; i++) if (read(1)) pos += GUARDED_REF_BITS;
  const short = read(1);
  const block = read(1);
  pos += 8;
  if (read(1) === 0) pos += 5;
  if (read(1) === 0) pos += 2;
  if (read(1)) pos += 32;
  pos += 32 + 2;
  if (short) return undefined;
  if (block) {
    pos += 1;
    if (read(1)) return undefined;
  }
  let targets = 0;
  let components = 0;
  if (!read(1)) {
    targets = read(1) ? 1 : read(4);
    if (!read(1)) components = read(1) ? 1 : read(4);
  }
  if (targets !== 0 || components !== 0) return undefined;
  // The two trailing flags must both be clear. When the first is set the
  // field that follows is not the aim (it decodes to a near-constant heading);
  // with both clear, the aim agreed with the player's facing in 147 of 147
  // shots on the sample match, against 60 of 474 otherwise.
  if (read(2) !== 0) return undefined;
  if (pos + AIM_BITS > payload.length * 8) return undefined;
  const dir = decodeCubemapDirection(bitsAt(payload, pos, AIM_BITS), AIM_BITS);
  if (!dir) return undefined;
  const deg = (Math.atan2(dir[1], dir[0]) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

export function readFireEvents(
  payload: Uint8Array,
  timeMs: number,
): FireEvent[] {
  const out: FireEvent[] = [];
  const last = payload.length * 8 - RECORD_BITS;
  for (let bit = 0; bit <= last; bit++) {
    if (bitsAt(payload, bit, FIRE_PREFIX_BITS) !== FIRE_PREFIX) continue;
    const family = bitsAt(payload, bit + WEAPON_FAMILY_OFFSET, 32);
    const weapon = WEAPON_FAMILY_NAMES.get(family);
    if (!weapon) continue;
    out.push({
      timeMs,
      slot: UNIT_SLOT_BASE + bitsAt(payload, bit + UNIT_INDEX_OFFSET, 9),
      family,
      weapon,
      aimYawDeg: readAimYaw(payload, bit),
    });
  }
  return out;
}

/** Decodes every fire event in the film, on the position time base. */
export async function extractFireEvents(
  chunkSource: FilmChunkSource,
): Promise<FireEvent[]> {
  let baseMicros: number | null = null;
  const out: FireEvent[] = [];
  for await (const chunk of chunkSource) {
    if (chunk.chunkType !== CHUNK_TYPE_GAMEPLAY) continue;
    for (const packet of splitPackets(inflateChunk(chunk.data))) {
      baseMicros ??= packet.timestampMicros;
      if (packet.type !== PacketType.Frame) continue;
      out.push(
        ...readFireEvents(
          packet.payload,
          (packet.timestampMicros - baseMicros) / 1000,
        ),
      );
    }
  }
  return out;
}
