import { CHUNK_TYPE_GAMEPLAY, CHUNK_TYPE_REGISTRY } from './film-input';
import type { FilmChunkSource } from './film-input';
import { bitsAt } from './keyframe-world';
import { inflateChunk, PacketType, splitPackets } from './packets';
import {
  archetypeComponentCount,
  readWorldObjectSamples,
} from './world-object-births';
import type { WorldObjectSample } from './world-object-births';

/** Archetype of thrown and launched projectiles (grenades, rockets, plasma). */
export const PROJECTILE_TYPE_INDEX = 41;
/** Projectile slot of detonation reference `idx` is `PROJECTILE_SLOT_BASE + idx`. */
const PROJECTILE_SLOT_BASE = 0x400;
const PROJECTILE_SLOT_COUNT = 256;
/** A projectile slot silent for longer than this has been reused by a new projectile. */
const PROJECTILE_GAP_MS = 250;
const MIN_FLIGHT_POINTS = 3;
/** A grenade with no replicated position is matched to a detonation this soon after its birth. */
const UNSEEN_DETONATION_MS = 500;
/** Detonations are looked up from just before to well after the last replicated position. */
const DETONATION_BEFORE_MS = 500;
const DETONATION_AFTER_MS = 4000;
/** Per-axis agreement (fraction of the bounds) between a detonation and its flight. */
const DETONATION_TOLERANCE = 0.003;

/** Position of the type index in a creation record, and of the primer that follows it. */
const BIRTH_TYPE_INDEX_BIT = 18;
/** The primer's low bit varies (it is a flag), so only its upper 23 bits are matched. */
const PRIMER_BITS = 23;
const GRENADE_PRIMER = 0x4c0c00 >> 1;
/** Offset of the thrower index from the primer (builds from 1.12 on). */
const THROWER_INDEX_BIT = 103;
/** A 16-bit marker sits just before the thrower index. */
const THROWER_MARKER = 0x8001;
const THROWER_MARKER_BITS = 16;
const TAG_ID_BITS = 32;
/** Tag id of the shroud screen projectile (seen in e4f0dcd3's creation records). */
export const SHROUD_TAG_ID = 0x2e22ae6e;
/** The 32-bit tag id, 24 bits after the start of the primer pattern. */
function tagIdAt(payload: Uint8Array, bit: number): number {
  return bitsAt(payload, bit, 16) * 65536 + bitsAt(payload, bit + 16, 16);
}
const THROWER_BIRTH_BEFORE_MS = 500;
const THROWER_BIRTH_AFTER_MS = 100;

const DETONATE_PREFIX = 0b10000101;
const DETONATE_PREFIX_BITS = 8;
const DETONATE_HEADER_BITS = 21;

export interface ProjectilePoint {
  timeMs: number;
  /** Fractions of the quantization bounds, like player positions. */
  x: number;
  y: number;
  z: number;
}

export interface ProjectileFlight {
  /** Roster index of the thrower, when the film's creation record was found. */
  thrower?: number;
  points: ProjectilePoint[];
  /** False for projectiles that just expire, like a spike grenade's shards. */
  explodes: boolean;
  /** True for a shroud screen: where it lands, a sphere stays for a while. */
  lingers: boolean;
  /**
   * Where and when it exploded. Read from the film's detonation message, or, when none
   * matches the flight, the last replicated position (`fromFilm` is false).
   */
  detonation: ProjectilePoint & { fromFilm: boolean };
}

interface ThrowerBirth {
  timeMs: number;
  slot: number;
  /** Roster index (the order of the match's players), not an entity slot. */
  thrower: number;
  /** A projectile released by another one (a spike grenade's shard), not thrown itself. */
  fragment: boolean;
  /** Tag id of the projectile, absent on fragments, which omit it. */
  tagId?: number;
}

interface Detonation extends ProjectilePoint {
  idx: number;
}

/** Reads the detonation messages of one frame. Gated on a projectile reference and a position. */
export function readDetonations(
  payload: Uint8Array,
  timeMs: number,
  layout: { gateBits: number; axisBits: readonly [number, number, number] },
): Detonation[] {
  const out: Detonation[] = [];
  const regionBits = Math.max(layout.gateBits - 4, 0);
  const widths = layout.axisBits.map((b) => b - 1);
  const total = payload.length * 8;
  for (let p = 0; p + DETONATE_HEADER_BITS < total; p++) {
    if (bitsAt(payload, p, DETONATE_PREFIX_BITS) !== DETONATE_PREFIX) continue;
    if (bitsAt(payload, p + 8, 1) !== 1) continue;
    if (bitsAt(payload, p + 19, 2) !== 0) continue;
    const idx = bitsAt(payload, p + 9, 8);
    let c = p + DETONATE_HEADER_BITS + 6;
    if (bitsAt(payload, c++, 1) === 0) {
      if (bitsAt(payload, c++, 1) === 1) c += 32;
      c += 32;
    }
    if (bitsAt(payload, c++, 1) === 1) c += 32;
    // Position gate: 1 is the default table, 0 is a region index and three axes.
    if (bitsAt(payload, c++, 1) !== 0) continue;
    if (bitsAt(payload, c, regionBits) !== 0) continue;
    c += regionBits;
    if (c + widths[0] + widths[1] + widths[2] > total) continue;
    const q = widths.map((width) => {
      const v = bitsAt(payload, c, width);
      c += width;
      return (v + 0.5) / 2 ** width;
    });
    out.push({ timeMs, idx, x: q[0], y: q[1], z: q[2] });
  }
  return out;
}

/** Splits one slot's samples into projectile lives. */
function splitLives(samples: WorldObjectSample[]): WorldObjectSample[][] {
  const lives: WorldObjectSample[][] = [];
  let current: WorldObjectSample[] = [];
  for (const s of samples) {
    const last = current.at(-1);
    if (last && s.timeMs - last.timeMs > PROJECTILE_GAP_MS) {
      lives.push(current);
      current = [];
    }
    current.push(s);
  }
  if (current.length > 0) lives.push(current);
  return lives;
}

/** Joins replicated projectile paths with the detonation messages of their slots. */
export function buildProjectileFlights(
  samples: readonly WorldObjectSample[],
  detonations: readonly Detonation[],
  births: readonly ThrowerBirth[] = [],
): ProjectileFlight[] {
  const bySlot = new Map<number, WorldObjectSample[]>();
  for (const s of samples) {
    const list = bySlot.get(s.slot) ?? [];
    list.push(s);
    bySlot.set(s.slot, list);
  }
  const flights: ProjectileFlight[] = [];
  const claimed = new Set<ThrowerBirth>();
  for (const [slot, list] of bySlot) {
    list.sort((a, b) => a.timeMs - b.timeMs);
    for (const life of splitLives(list)) {
      if (life.length < MIN_FLIGHT_POINTS) continue;
      const points = life.map((s) => ({
        timeMs: s.timeMs,
        x: s.normalized[0],
        y: s.normalized[1],
        z: s.normalized[2],
      }));
      const last = points[points.length - 1];
      let best: Detonation | undefined;
      let bestDistance = Infinity;
      for (const d of detonations) {
        if (d.idx !== slot - PROJECTILE_SLOT_BASE) continue;
        if (
          d.timeMs < last.timeMs - DETONATION_BEFORE_MS ||
          d.timeMs > last.timeMs + DETONATION_AFTER_MS
        ) {
          continue;
        }
        const dx = Math.abs(d.x - last.x);
        const dy = Math.abs(d.y - last.y);
        const dz = Math.abs(d.z - last.z);
        if (
          dx > DETONATION_TOLERANCE ||
          dy > DETONATION_TOLERANCE ||
          dz > DETONATION_TOLERANCE
        ) {
          continue;
        }
        const distance = dx * dx + dy * dy + dz * dz;
        if (distance < bestDistance) {
          best = d;
          bestDistance = distance;
        }
      }
      const birth = birthOf(slot, points[0].timeMs, births);
      if (birth) claimed.add(birth);
      flights.push({
        thrower: birth?.thrower,
        explodes: !birth?.fragment && birth?.tagId !== SHROUD_TAG_ID,
        lingers: birth?.tagId === SHROUD_TAG_ID,
        points,
        detonation: best
          ? {
              timeMs: best.timeMs,
              x: best.x,
              y: best.y,
              z: best.z,
              fromFilm: true,
            }
          : { ...last, fromFilm: false },
      });
    }
  }
  flights.push(...unseenDetonations(births, claimed, detonations));
  return flights.sort((a, b) => a.points[0].timeMs - b.points[0].timeMs);
}

/**
 * A grenade can detonate before it replicates a single position (one shot on its pedestal
 * does this). Its creation record and detonation message still exist, so the explosion is
 * placed from the message alone.
 */
function unseenDetonations(
  births: readonly ThrowerBirth[],
  claimed: ReadonlySet<ThrowerBirth>,
  detonations: readonly Detonation[],
): ProjectileFlight[] {
  const out: ProjectileFlight[] = [];
  for (const birth of births) {
    if (claimed.has(birth) || birth.fragment) continue;
    if (birth.tagId === SHROUD_TAG_ID) continue;
    const detonation = detonations
      .filter(
        (d) =>
          d.idx === birth.slot - PROJECTILE_SLOT_BASE &&
          d.timeMs >= birth.timeMs &&
          d.timeMs <= birth.timeMs + UNSEEN_DETONATION_MS,
      )
      .sort((a, b) => a.timeMs - b.timeMs)[0];
    if (!detonation) continue;
    const point = {
      timeMs: detonation.timeMs,
      x: detonation.x,
      y: detonation.y,
      z: detonation.z,
    };
    out.push({
      thrower: birth.thrower,
      points: [point],
      explodes: true,
      lingers: false,
      detonation: { ...point, fromFilm: true },
    });
  }
  return out;
}

/**
 * Reads grenade births of one frame. The creation record is
 * `[001][slot:13][gen:2][typeIndex:6]` followed, from the second type-index bit, by a fixed
 * primer pattern, the 32-bit grenade tag id and, 103 bits in, the thrower's roster index.
 */
export function readThrowerBirths(
  payload: Uint8Array,
  timeMs: number,
): ThrowerBirth[] {
  const out: ThrowerBirth[] = [];
  const total = payload.length * 8;
  for (let p = 0; p + THROWER_INDEX_BIT + 5 < total; p++) {
    if (bitsAt(payload, p, 3) !== 1) continue;
    if (
      bitsAt(payload, p + BIRTH_TYPE_INDEX_BIT, 6) !== PROJECTILE_TYPE_INDEX
    ) {
      continue;
    }
    const pattern = p + BIRTH_TYPE_INDEX_BIT + 1;
    if (bitsAt(payload, pattern, PRIMER_BITS) !== GRENADE_PRIMER) continue;
    const full = pattern + THROWER_INDEX_BIT;
    // Fragments (spike grenade shards) omit the 32-bit tag id, so the thrower comes earlier.
    const fragment =
      bitsAt(payload, full - THROWER_MARKER_BITS, THROWER_MARKER_BITS) !==
        THROWER_MARKER &&
      bitsAt(
        payload,
        full - TAG_ID_BITS - THROWER_MARKER_BITS,
        THROWER_MARKER_BITS,
      ) === THROWER_MARKER;
    out.push({
      timeMs,
      slot: bitsAt(payload, p + 3, 13),
      thrower: bitsAt(payload, fragment ? full - TAG_ID_BITS : full, 5),
      fragment,
      tagId: fragment ? undefined : tagIdAt(payload, pattern + PRIMER_BITS + 1),
    });
  }
  return out;
}

/** The creation record of a flight, from the birth of its slot just before it. */
function birthOf(
  slot: number,
  firstTimeMs: number,
  births: readonly ThrowerBirth[],
): ThrowerBirth | undefined {
  return births
    .filter(
      (b) =>
        b.slot === slot &&
        b.timeMs <= firstTimeMs + THROWER_BIRTH_AFTER_MS &&
        b.timeMs >= firstTimeMs - THROWER_BIRTH_BEFORE_MS,
    )
    .sort(
      (a, b) =>
        Math.abs(a.timeMs - firstTimeMs) - Math.abs(b.timeMs - firstTimeMs),
    )[0];
}

/** Every projectile flight in the film, on the position time base. */
export async function extractProjectiles(
  chunkSource: FilmChunkSource,
  layout: { gateBits: number; axisBits: readonly [number, number, number] },
): Promise<ProjectileFlight[]> {
  const regionBits = Math.max(layout.gateBits - 4, 0);
  let baseMicros: number | null = null;
  let registry: Uint8Array | undefined;
  const frames: { timeMs: number; payload: Uint8Array }[] = [];
  for await (const chunk of chunkSource) {
    if (chunk.chunkType === CHUNK_TYPE_REGISTRY) {
      registry = inflateChunk(chunk.data);
      continue;
    }
    if (chunk.chunkType !== CHUNK_TYPE_GAMEPLAY) continue;
    for (const packet of splitPackets(inflateChunk(chunk.data))) {
      baseMicros ??= packet.timestampMicros;
      if (packet.type !== PacketType.Frame) continue;
      frames.push({
        timeMs: (packet.timestampMicros - baseMicros) / 1000,
        payload: packet.payload,
      });
    }
  }
  if (!registry) return [];
  const comps = archetypeComponentCount(registry, PROJECTILE_TYPE_INDEX);
  if (comps === 0) return [];
  const band = new Set<number>();
  for (let i = 0; i < PROJECTILE_SLOT_COUNT; i++) {
    band.add(PROJECTILE_SLOT_BASE + i);
  }
  const full = { comps, axisBits: layout.axisBits, regionBits };
  // The first frame carries the initial world state, not events.
  const live = frames.slice(1);
  return buildProjectileFlights(
    live.flatMap((f) =>
      readWorldObjectSamples(f.payload, f.timeMs, band, full),
    ),
    live.flatMap((f) => readDetonations(f.payload, f.timeMs, layout)),
    live.flatMap((f) => readThrowerBirths(f.payload, f.timeMs)),
  );
}
