import { PacketType, inflateChunk, splitPackets } from './packets';
import { CHUNK_TYPE_GAMEPLAY, type FilmChunkSource } from './film-input';
import {
  BIPED_TYPE_INDEX,
  bitsAt,
  walkKeyframe,
  type KeyframeRecord,
} from './keyframe-world';
import { WEAPON_FAMILY_NAMES, isGrenadeFamily } from './weapon-catalog';

/**
 * Per-biped inventory read from keyframes, ported from LevelUp's
 * `inventory_*.go`. Fields are located by bit patterns inside the record's
 * span rather than by a full schema, so every field may be missing.
 */

const SLOT_COUNT = 4;
const GRENADE_MAX = 2;
const ABILITY_ANCHOR = 0x8cac57a;
const ABILITY_PATTERN = 0x00012;
const AMMO_SEARCH_SPAN = 300;
const GRENADE_WINDOW_LO = -216;
const GRENADE_WINDOW_HI = -127;
const GRENADE_SELECTION_LO = 200;
const GRENADE_SELECTION_HI = 210;

export interface SlotAmmo {
  /** Rounds in the magazine; absent when not transmitted (full or non-magazine weapon). */
  mag?: number;
  /** Reserve rounds. */
  reserve?: number;
  /** Charge consumed, 0..1, for charge weapons. */
  gauge?: number;
  flags: number;
  overheat: number;
}

export interface InventorySnapshot {
  timeMs: number;
  /** Position-track slot of the biped. */
  slot: number;
  /** Weapon families carried, in stream order, without grenades. */
  weapons: number[];
  /** One entry per weapon slot; only the first two carry weapons. */
  ammo?: SlotAmmo[];
  /** Index into `ammo` of the drawn weapon. */
  drawnSlot?: number;
  /** Frag, Plasma, Dynamo, Spike counts. */
  grenades?: number[];
  selectedGrenade?: number;
  /** Equipment rank (16..23 only; the rest needs delta packets). */
  abilityRank?: number;
}

function parseAmmoBlock(
  pay: Uint8Array,
  start: number,
  limit: number,
): { ammo: SlotAmmo[]; sel: number; end: number } | undefined {
  let p = start;
  const rd = (n: number) => {
    const v = bitsAt(pay, p, n);
    p += n;
    return v;
  };
  const fits = (n: number) => p + n <= limit;
  const ammo: SlotAmmo[] = [];
  for (let k = 0; k < SLOT_COUNT; k++) {
    const slot: SlotAmmo = { flags: 0, overheat: 0 };
    if (!fits(1)) return undefined;
    if (rd(1) === 0) {
      if (!fits(8)) return undefined;
      slot.mag = rd(8);
    }
    if (!fits(1)) return undefined;
    if (rd(1) === 0) {
      if (!fits(12)) return undefined;
      slot.gauge = rd(12) / 4095;
    }
    if (!fits(20)) return undefined;
    slot.reserve = rd(11);
    slot.flags = rd(2);
    slot.overheat = rd(7);
    ammo.push(slot);
  }
  if (!fits(3)) return undefined;
  rd(3);
  let sel = -1;
  for (let i = 0; i < 2; i++) {
    if (!fits(1)) return undefined;
    if (rd(1) === 0) {
      if (!fits(2)) return undefined;
      sel = rd(2);
    }
  }
  return { ammo, sel, end: p };
}

function solveAmmoBlock(
  pay: Uint8Array,
  end: number,
  lo: number,
): number | undefined {
  for (let s = lo; s < end; s++) {
    const parsed = parseAmmoBlock(pay, s, end + 1);
    if (!parsed || parsed.end !== end) continue;
    const valid = parsed.ammo.every((a) => {
      if (a.mag !== undefined && a.gauge !== undefined) return false;
      if (a.mag === undefined && a.gauge === undefined) {
        return a.reserve === 0 && a.flags === 0 && a.overheat === 0;
      }
      return true;
    });
    // The longest reading (smallest start) wins.
    if (valid) return s;
  }
  return undefined;
}

function grenadeCountsAt(pay: Uint8Array, b: number): number[] | undefined {
  if (bitsAt(pay, b, 3) !== SLOT_COUNT) return undefined;
  const counts: number[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const v = bitsAt(pay, b + 3 + 8 * i, 8);
    if (v > GRENADE_MAX) return undefined;
    counts.push(v);
  }
  return counts;
}

function grenadesNearAmmo(
  pay: Uint8Array,
  ammoStart: number,
  from: number,
): number[] | undefined {
  const lo = Math.max(ammoStart + GRENADE_WINDOW_LO, from);
  for (let b = lo; b <= ammoStart + GRENADE_WINDOW_HI; b++) {
    const counts = grenadeCountsAt(pay, b);
    if (counts) return counts;
  }
  return undefined;
}

function grenadesAfterAbility(
  pay: Uint8Array,
  from: number,
  to: number,
): number[] | undefined {
  for (let b = from; b + 3 + 8 * SLOT_COUNT <= to; b++) {
    const counts = grenadeCountsAt(pay, b);
    if (counts && counts.some((c) => c > 0)) return counts;
  }
  return undefined;
}

function grenadeSelection(
  pay: Uint8Array,
  familyEnd: number,
  to: number,
  grenades: number[],
): number | undefined {
  let mask = 0;
  grenades.forEach((v, r) => {
    if (v > 0) mask |= 1 << r;
  });
  if (mask === 0) return undefined;
  let sel: number | undefined;
  for (let off = GRENADE_SELECTION_LO; off <= GRENADE_SELECTION_HI; off++) {
    const b = familyEnd + off;
    if (b + 9 > to) break;
    if (bitsAt(pay, b, 6) !== mask) continue;
    const s = bitsAt(pay, b + 6, 3);
    if (s < 1 || s > SLOT_COUNT || (mask & (1 << (s - 1))) === 0) continue;
    if (sel !== undefined && sel !== s - 1) return undefined;
    sel = s - 1;
  }
  return sel;
}

/** The ability anchor must occur exactly once in the span to be trusted. */
function abilityRank(
  pay: Uint8Array,
  from: number,
  to: number,
): { rank: number; anchorBit: number } | undefined {
  const hits: { rank: number; anchorBit: number }[] = [];
  for (let b = from; b + 28 <= to; b++) {
    if (bitsAt(pay, b, 28) !== ABILITY_ANCHOR) continue;
    for (let off = 0; off <= 60; off++) {
      const p = b + 28 + off;
      if (p + 20 > to) break;
      if (bitsAt(pay, p, 20) !== ABILITY_PATTERN) continue;
      hits.push({
        rank: ((ABILITY_PATTERN & 0x7) << 3) | bitsAt(pay, p + 20, 3),
        anchorBit: b,
      });
      break;
    }
  }
  return hits.length === 1 ? hits[0] : undefined;
}

/** Bit positions of every catalogued weapon family id in [from, to), in order. */
function findFamilies(
  pay: Uint8Array,
  from: number,
  to: number,
): { bit: number; family: number }[] {
  const out: { bit: number; family: number }[] = [];
  for (let b = from; b + 32 <= to; b++) {
    const w = bitsAt(pay, b, 32);
    if (WEAPON_FAMILY_NAMES.has(w)) out.push({ bit: b, family: w });
  }
  return out;
}

function readBiped(
  pay: Uint8Array,
  from: number,
  to: number,
  slot: number,
  timeMs: number,
): InventorySnapshot {
  const snap: InventorySnapshot = { timeMs, slot, weapons: [] };
  let grenadesByAbility = false;
  const ability = abilityRank(pay, from, to);
  if (ability) {
    snap.abilityRank = ability.rank;
    const g = grenadesAfterAbility(pay, ability.anchorBit, to);
    if (g) {
      snap.grenades = g;
      grenadesByAbility = true;
    }
  }
  const families = findFamilies(pay, from, to);
  // The same weapon is listed twice (an alias ~97 bits later); keep one per family.
  snap.weapons = [
    ...new Set(
      families.map((f) => f.family).filter((f) => !isGrenadeFamily(f)),
    ),
  ];
  if (families.length > 0) {
    const end = families[0].bit - 1;
    const start = solveAmmoBlock(
      pay,
      end,
      Math.max(end - AMMO_SEARCH_SPAN, from),
    );
    if (start !== undefined) {
      const parsed = parseAmmoBlock(pay, start, end + 1);
      if (parsed) {
        snap.ammo = parsed.ammo.slice(0, 2);
        if (parsed.sel >= 0) snap.drawnSlot = parsed.sel;
      }
      if (!grenadesByAbility) {
        const g = grenadesNearAmmo(pay, start, from);
        if (g) snap.grenades = g;
      }
    }
  }
  if (snap.grenades && families.length > 0) {
    const last = families[families.length - 1].bit;
    snap.selectedGrenade = grenadeSelection(pay, last + 32, to, snap.grenades);
  }
  return snap;
}

/** Reads every biped inventory out of one keyframe payload. */
export function readKeyframeInventories(
  payload: Uint8Array,
  timeMs: number,
): InventorySnapshot[] {
  const records: KeyframeRecord[] = walkKeyframe(payload);
  const total = payload.length * 8;
  const out: InventorySnapshot[] = [];
  records.forEach((rec, i) => {
    if (rec.typeIndex !== BIPED_TYPE_INDEX) return;
    const to = i + 1 < records.length ? records[i + 1].bit : total;
    out.push(readBiped(payload, rec.bit, to, rec.slot, timeMs));
  });
  return out;
}

/** Decodes every keyframe inventory in the film, on the position time base. */
export async function extractInventories(
  chunkSource: FilmChunkSource,
): Promise<InventorySnapshot[]> {
  let baseMicros: number | null = null;
  const out: InventorySnapshot[] = [];
  for await (const chunk of chunkSource) {
    if (chunk.chunkType !== CHUNK_TYPE_GAMEPLAY) continue;
    for (const packet of splitPackets(inflateChunk(chunk.data))) {
      baseMicros ??= packet.timestampMicros;
      if (packet.type !== PacketType.Keyframe) continue;
      out.push(
        ...readKeyframeInventories(
          packet.payload,
          (packet.timestampMicros - baseMicros) / 1000,
        ),
      );
    }
  }
  return out.sort((a, b) => a.timeMs - b.timeMs || a.slot - b.slot);
}
