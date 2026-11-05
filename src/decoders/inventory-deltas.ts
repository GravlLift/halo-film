import { BitReader } from '../core/bit-reader';
import { findRecordCandidates } from '../core/biped-records';
import { readBipedComponents, WEAPON_RESERVE_BITS } from '../core/components';
import { CHUNK_TYPE_GAMEPLAY, type FilmChunkSource } from '../core/film-input';
import type { I0Layout } from '../core/i0-layout';
import { WEAPON_FAMILY_NAMES, isGrenadeFamily } from '../core/weapon-catalog';
import { PacketType, inflateChunk, splitPackets } from '../core/packets';

/**
 * Inventory values that ride in frame (delta) packets, so they refresh between
 * the ~20 s keyframes. A biped record only carries a component when it
 * changed, which makes every field here optional.
 *
 * Layouts, from LevelUp's deserializer grammar:
 * - i22 unit-grenade-counts: R(3) = 4, then four R(8) counts (Frag, Plasma,
 *   Dynamo, Spike), each at most 2.
 * - i30/i33 weapon-state-ammo: gate (0 = present) + R(8) magazine, then gate +
 *   R(12) charge fraction. Weapon slots 0 and 1.
 * - i31/i34 weapon-state-rounds-inventory: R(11) reserve.
 */

const HELD_STATE_COMPONENT = 42;
const HELD_STATE_BITS = 7;
const HOLD_COMPONENT = 44;
const GRENADE_COMPONENT = 22;
const GRENADE_SLOTS = 4;
const GRENADE_MAX = 2;
const MAGAZINE_MAX = 80;
const RESERVE_MAX = 240;
/** Mask index of the first weapon slot's ammo component, and the stride between slots. */
const AMMO_COMPONENT_BASE = 30;
const AMMO_COMPONENT_STRIDE = 3;
const WEAPON_SLOTS_WITH_DELTAS = 2;

export interface WeaponSlotDelta {
  /** Weapon slot, 0 or 1; matches the index into a keyframe's `ammo`. */
  weaponSlot: number;
  mag?: number;
  reserve?: number;
}

export interface WeaponPickup {
  /** Weapon family id (high 32 bits of the weapon id). */
  family: number;
  /** Slot that received the weapon, when the same record updated one slot's ammo. */
  weaponSlot?: number;
}

export interface InventoryDelta {
  timeMs: number;
  /** Position-track slot of the biped. */
  slot: number;
  /** Frag, Plasma, Dynamo, Spike counts. */
  grenades?: number[];
  weapons?: WeaponSlotDelta[];
  /** A weapon taken from the ground. */
  pickup?: WeaponPickup;
}

/** Reads the inventory components a single biped record announces, if any. */
export function readInventoryDelta(
  reader: BitReader,
  i0End: number,
  maskIndices: readonly number[],
  timeMs: number,
  slot: number,
): InventoryDelta | undefined {
  const delta: InventoryDelta = { timeMs, slot };
  const weapons = new Map<number, WeaponSlotDelta>();
  const slotDelta = (weaponSlot: number) => {
    const existing = weapons.get(weaponSlot) ?? { weaponSlot };
    weapons.set(weaponSlot, existing);
    return existing;
  };
  readBipedComponents(reader, i0End, maskIndices, (index, at) => {
    if (index === HELD_STATE_COMPONENT) {
      const pickup = readPickup(reader, at, maskIndices);
      if (pickup) delta.pickup = pickup;
      return;
    }
    if (index === GRENADE_COMPONENT) {
      if (at + 3 + GRENADE_SLOTS * 8 > reader.bitLength) return;
      if (reader.peek(at, 3) !== GRENADE_SLOTS) return;
      const counts = Array.from({ length: GRENADE_SLOTS }, (_, k) =>
        reader.peek(at + 3 + 8 * k, 8),
      );
      if (counts.every((c) => c <= GRENADE_MAX)) delta.grenades = counts;
      return;
    }
    const offset = index - AMMO_COMPONENT_BASE;
    const weaponSlot = Math.floor(offset / AMMO_COMPONENT_STRIDE);
    if (offset < 0 || weaponSlot >= WEAPON_SLOTS_WITH_DELTAS) return;
    if (offset % AMMO_COMPONENT_STRIDE === 0) {
      if (at + 9 > reader.bitLength) return;
      if (reader.peek(at, 1) !== 0) {
        // Both the magazine and the charge gate absent: the weapon is empty.
        if (reader.peek(at, 2) === 0b11) slotDelta(weaponSlot).mag = 0;
        return;
      }
      const mag = reader.peek(at + 1, 8);
      if (mag >= 1 && mag <= MAGAZINE_MAX) slotDelta(weaponSlot).mag = mag;
    } else if (offset % AMMO_COMPONENT_STRIDE === 1) {
      if (at + WEAPON_RESERVE_BITS > reader.bitLength) return;
      const reserve = reader.peek(at, WEAPON_RESERVE_BITS);
      if (reserve <= RESERVE_MAX) slotDelta(weaponSlot).reserve = reserve;
    }
  });
  if (weapons.size > 0) delta.weapons = [...weapons.values()];
  if (delta.pickup && weapons.size === 1) {
    delta.pickup.weaponSlot = [...weapons.keys()][0];
  }
  return delta.grenades || delta.weapons || delta.pickup ? delta : undefined;
}

/**
 * Components 42 and 44 travel together when the unit takes hold of an object.
 * i42 is 7 bits; i44 opens with a gate bit (1 = taking, 0 = releasing) and the
 * object's 64-bit id, whose high half is the weapon family. Flags and the
 * skull arrive the same way with a family that is not a weapon.
 */
function readPickup(
  reader: BitReader,
  at: number,
  maskIndices: readonly number[],
): WeaponPickup | undefined {
  if (!maskIndices.includes(HOLD_COMPONENT) || maskIndices.includes(43)) {
    return undefined;
  }
  const gateAt = at + HELD_STATE_BITS;
  if (gateAt + 1 + 32 > reader.bitLength || reader.peek(gateAt, 1) !== 1) {
    return undefined;
  }
  const family = reader.peek(gateAt + 1, 32);
  if (!WEAPON_FAMILY_NAMES.has(family) || isGrenadeFamily(family)) {
    return undefined;
  }
  return { family };
}

/**
 * Decodes every inventory delta in the film, on the position time base.
 * @param slots position-track slots of the bipeds to read
 */
export async function extractInventoryDeltas(
  chunkSource: FilmChunkSource,
  layout: I0Layout,
  slots: ReadonlySet<number>,
): Promise<InventoryDelta[]> {
  const [wx, wy, wz] = layout.axisBits;
  const i0Bits = layout.gateBits + wx + wy + wz;
  let baseMicros: number | null = null;
  const out: InventoryDelta[] = [];
  for await (const chunk of chunkSource) {
    if (chunk.chunkType !== CHUNK_TYPE_GAMEPLAY) continue;
    for (const packet of splitPackets(inflateChunk(chunk.data))) {
      baseMicros ??= packet.timestampMicros;
      if (packet.type !== PacketType.Frame) continue;
      const timeMs = (packet.timestampMicros - baseMicros) / 1000;
      const reader = new BitReader(packet.payload);
      let nextFree = 0;
      for (const c of findRecordCandidates(packet.payload)) {
        if (c.headerBit < nextFree || !slots.has(c.slot)) continue;
        if (c.i0Bit + i0Bits > reader.bitLength) continue;
        nextFree = c.i0Bit + i0Bits;
        const delta = readInventoryDelta(
          reader,
          c.i0Bit + i0Bits,
          c.maskIndices,
          timeMs,
          c.slot,
        );
        if (delta) out.push(delta);
      }
    }
  }
  return out.sort((a, b) => a.timeMs - b.timeMs || a.slot - b.slot);
}
