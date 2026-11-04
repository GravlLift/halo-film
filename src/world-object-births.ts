import { CHUNK_TYPE_GAMEPLAY, CHUNK_TYPE_REGISTRY } from './film-input';
import type { FilmChunkSource } from './film-input';
import { bitsAt, walkKeyframe } from './keyframe-world';
import { inflateChunk, PacketType, splitPackets } from './packets';

/** Archetype of ground weapons, which is also what flags and skulls are. */
export const WORLD_OBJECT_TYPE_INDEX = 42;

/** `object-multiplayer-properties` identity of a CTF flag. */
export const FLAG_IDENTITY = 0x2a392328;
/** `object-multiplayer-properties` identity of the oddball skull. */
export const SKULL_IDENTITY = 0x0017592c;

const NEW_HEADER_BITS = 24;
const MPP_LEAD_BITS = 9;
const MPP_INDEX_BITS = 5;
const MPP_MAX_COUNT = 4;
const MASK_MAX_SPARSE = 7;
const REGISTRY_BASE = 8;
const REGISTRY_SLOT = 260;
const REGISTRY_BLOCK_SLOTS = 64;

class Cursor {
  constructor(
    private readonly buf: Uint8Array,
    public pos: number,
  ) {}

  get overflow(): boolean {
    return this.pos > this.buf.length * 8;
  }

  bit(): boolean {
    return this.bits(1) === 1;
  }

  bits(n: number): number {
    const v = bitsAt(this.buf, this.pos, n);
    this.pos += n;
    return v;
  }
}

function opt32(c: Cursor): void {
  if (c.bit()) c.bits(32);
}

/** Reads the object-multiplayer-properties block and returns its identity word. */
function readMppBlock(c: Cursor): {
  identity: number;
  variant: number | undefined;
  readable: boolean;
} {
  c.bits(MPP_LEAD_BITS);
  const identity = c.bits(32);
  const variant = c.bit() ? undefined : c.bits(32);
  if (c.bit()) c.bits(18);
  if (c.bit()) c.bits(13);
  c.bits(2);
  c.bits(MPP_INDEX_BITS);
  const count = c.bits(3);
  const readable = count <= MPP_MAX_COUNT;
  if (readable) {
    for (let i = 0; i < count; i++) {
      c.bits(5);
      opt32(c);
    }
  }
  if (c.bit()) {
    if (!c.bit()) c.bits(5);
    if (c.bit()) c.bits(8);
    c.bits(8);
    c.bits(8);
  }
  if (c.bit()) {
    c.bits(32);
    opt32(c);
    c.bits(14);
  }
  return { identity, variant, readable };
}

interface DefaultState {
  identity: number;
  /** Word after the identity that tells the two flags of a game apart. */
  variant: number | undefined;
}

/** Default state of a ground-weapon-class object; `undefined` when unreadable. */
function readDefaultState(c: Cursor): DefaultState | undefined {
  if (c.bit()) c.bits(8);
  if (c.bit()) c.bits(8);
  const { identity, variant, readable } = readMppBlock(c);
  c.bits(12);
  c.bits(7);
  if (!c.bit()) {
    if (c.bit()) c.bits(32);
  } else {
    const n = c.bits(4);
    for (let i = 0; i < n; i++) opt32(c);
  }
  if (!c.bit()) c.bits(5);
  return readable ? { identity, variant } : undefined;
}

function maskIsValid(c: Cursor, comps: number): boolean {
  if (c.bit()) {
    const lo = c.bits(32);
    const hi = c.bits(32);
    let any = false;
    for (let i = 0; i < 64; i++) {
      const word = i < 32 ? lo : hi;
      if (Math.floor(word / 2 ** (i % 32)) % 2 === 0) continue;
      if (i >= comps) return false;
      any = true;
    }
    return any;
  }
  const count = c.bits(3);
  if (count < 1 || count > MASK_MAX_SPARSE) return false;
  let prev = -1;
  for (let i = 0; i < count; i++) {
    const v = c.bits(6);
    if (v <= prev || v >= comps) return false;
    prev = v;
  }
  return true;
}

export interface WorldObjectBirthLayout {
  /** Components in the archetype; mask indices must be below it. */
  comps: number;
  /** Quantization width of each position axis. */
  axisBits: readonly [number, number, number];
  /** Width of the region index that precedes the axes. */
  regionBits: number;
}

export interface WorldObjectBirth {
  timeMs: number;
  slot: number;
  generation: number;
  /** `object-multiplayer-properties` word identifying what the object is. */
  identity: number;
  /** Word that tells the two flags of a game apart; absent when the default is used. */
  variant: number | undefined;
  region: number;
  q: [number, number, number];
  /** q / 2^width, as a fraction of the map bounds. */
  normalized: [number, number, number];
}

/**
 * Finds object creation records in one delta payload. A creation record has no
 * length prefix, so every bit position is tried and kept when the whole record
 * (header, default state, component mask, position) reads consistently.
 */
export function readWorldObjectBirths(
  payload: Uint8Array,
  timeMs: number,
  band: ReadonlySet<number>,
  layout: WorldObjectBirthLayout,
): WorldObjectBirth[] {
  const out: WorldObjectBirth[] = [];
  const total = payload.length * 8;
  const [wx, wy, wz] = layout.axisBits;
  let next = 0;
  for (let p = 0; p + NEW_HEADER_BITS < total; p++) {
    if (p < next) continue;
    if (bitsAt(payload, p, 3) !== 0b001) continue;
    if (bitsAt(payload, p + 18, 6) !== WORLD_OBJECT_TYPE_INDEX) {
      continue;
    }
    const slot = bitsAt(payload, p + 3, 13);
    if (!band.has(slot)) continue;
    const generation = bitsAt(payload, p + 16, 2);
    const c = new Cursor(payload, p + NEW_HEADER_BITS);
    const defaults = readDefaultState(c);
    if (defaults === undefined || c.overflow) continue;
    const { identity, variant } = defaults;
    c.bit(); // has-components gate
    if (!maskIsValid(c, layout.comps) || c.overflow) continue;
    if (c.bits(2) !== 0) continue;
    const region = c.bits(layout.regionBits);
    const q: [number, number, number] = [c.bits(wx), c.bits(wy), c.bits(wz)];
    if (c.overflow) continue;
    if (
      q[0] === 0 ||
      q[0] === 2 ** wx - 1 ||
      q[1] === 0 ||
      q[1] === 2 ** wy - 1 ||
      q[2] === 0 ||
      q[2] === 2 ** wz - 1
    ) {
      continue;
    }
    out.push({
      timeMs,
      slot,
      generation,
      identity,
      variant,
      region,
      q,
      normalized: [q[0] / 2 ** wx, q[1] / 2 ** wy, q[2] / 2 ** wz],
    });
    next = c.pos;
  }
  return out;
}

/** An object created without a position: it is placed by later position updates. */
export interface WorldObjectDrop {
  timeMs: number;
  slot: number;
  generation: number;
  identity: number;
  variant: number | undefined;
}

/**
 * Finds creations of the given kinds of object that carry no components. The
 * engine creates a flag or skull this way each time it is put down, and
 * replicates its position in updates afterwards.
 */
export function readWorldObjectDrops(
  payload: Uint8Array,
  timeMs: number,
  band: ReadonlySet<number>,
  identities: ReadonlySet<number>,
  comps: number,
): WorldObjectDrop[] {
  const out: WorldObjectDrop[] = [];
  const total = payload.length * 8;
  for (let p = 0; p + NEW_HEADER_BITS < total; p++) {
    if (bitsAt(payload, p, 3) !== 0b001) continue;
    if (bitsAt(payload, p + 18, 6) !== WORLD_OBJECT_TYPE_INDEX) continue;
    const slot = bitsAt(payload, p + 3, 13);
    if (!band.has(slot)) continue;
    const c = new Cursor(payload, p + NEW_HEADER_BITS);
    const defaults = readDefaultState(c);
    if (
      defaults === undefined ||
      c.overflow ||
      !identities.has(defaults.identity)
    ) {
      continue;
    }
    c.bit(); // has-components gate
    if (maskIsValid(c, comps)) continue;
    out.push({
      timeMs,
      slot,
      generation: bitsAt(payload, p + 16, 2),
      identity: defaults.identity,
      variant: defaults.variant,
    });
  }
  return out;
}

/** Number of components in archetype `typeIndex`, from the inflated registry chunk. */
export function archetypeComponentCount(
  registry: Uint8Array,
  typeIndex: number,
): number {
  const block = REGISTRY_SLOT * REGISTRY_BLOCK_SLOTS;
  const base = REGISTRY_BASE + typeIndex * block;
  let count = 0;
  for (let s = 0; s < REGISTRY_BLOCK_SLOTS; s++) {
    if (registry[base + s * REGISTRY_SLOT] === undefined) break;
    if (registry[base + s * REGISTRY_SLOT] === 0) break;
    count++;
  }
  return count;
}

/** Slots usable by `typeIndex`: the span seen in keyframes minus slots seen as other types. */
export function keyframeSlotBand(
  keyframes: Iterable<Uint8Array>,
  typeIndex: number,
): Set<number> {
  const seen = new Set<number>();
  const others = new Set<number>();
  for (const payload of keyframes) {
    for (const r of walkKeyframe(payload)) {
      (r.typeIndex === typeIndex ? seen : others).add(r.slot);
    }
  }
  const band = new Set<number>();
  if (seen.size > 0) {
    const lo = Math.min(...seen);
    const hi = Math.max(...seen);
    for (let s = lo; s <= hi; s++) if (!others.has(s)) band.add(s);
  }
  return band;
}

/** A position the engine replicated for a world object that is not being held. */
export interface WorldObjectSample {
  timeMs: number;
  slot: number;
  generation: number;
  /** q / 2^width, as a fraction of the map bounds. */
  normalized: [number, number, number];
}

const DELTA_HEADER_BITS = 21;
const DELTA_INDEX_BITS = 6;

/**
 * Finds position updates of band objects in one delta payload. A free object
 * replicates its absolute position every frame; a carried one stops.
 */
export function readWorldObjectSamples(
  payload: Uint8Array,
  timeMs: number,
  band: ReadonlySet<number>,
  layout: WorldObjectBirthLayout,
): WorldObjectSample[] {
  const out: WorldObjectSample[] = [];
  const total = payload.length * 8;
  const [wx, wy, wz] = layout.axisBits;
  const positionBits = 2 + layout.regionBits + wx + wy + wz + 2;
  for (
    let p = 0;
    p + DELTA_HEADER_BITS + DELTA_INDEX_BITS + positionBits <= total;
    p++
  ) {
    if (bitsAt(payload, p, 1) !== 1) continue;
    const slot = bitsAt(payload, p + 1, 13);
    if (!band.has(slot)) continue;
    if (bitsAt(payload, p + 16, 2) !== 0) continue;
    const count = bitsAt(payload, p + 18, 3);
    if (count < 1 || count > MASK_MAX_SPARSE) continue;
    const c = new Cursor(payload, p + DELTA_HEADER_BITS);
    let prev = -1;
    let valid = true;
    let first = -1;
    for (let i = 0; i < count; i++) {
      const v = c.bits(DELTA_INDEX_BITS);
      if (v <= prev || v >= layout.comps) {
        valid = false;
        break;
      }
      if (i === 0) first = v;
      prev = v;
    }
    // Component 0 is the position.
    if (!valid || first !== 0) continue;
    if (c.bits(2) !== 0 || c.bits(layout.regionBits) !== 0) continue;
    const q: [number, number, number] = [c.bits(wx), c.bits(wy), c.bits(wz)];
    if (
      c.overflow ||
      q[0] === 0 ||
      q[0] === 2 ** wx - 1 ||
      q[1] === 0 ||
      q[1] === 2 ** wy - 1 ||
      q[2] === 0 ||
      q[2] === 2 ** wz - 1
    ) {
      continue;
    }
    out.push({
      timeMs,
      slot,
      generation: bitsAt(payload, p + 14, 2),
      normalized: [q[0] / 2 ** wx, q[1] / 2 ** wy, q[2] / 2 ** wz],
    });
    p = c.pos - 1;
  }
  return out;
}

export interface WorldObjectScan {
  births: WorldObjectBirth[];
  samples: WorldObjectSample[];
  drops: WorldObjectDrop[];
}

/**
 * Every creation of a world object, plus the positions replicated for the
 * objects of its slot band, on the position time base.
 * The region index width follows from the position gate: it holds the spine
 * (3 bits) and use-default (1 bit) flags, and the rest is the region index.
 */
export async function extractWorldObjectScan(
  chunkSource: FilmChunkSource,
  layout: { gateBits: number; axisBits: readonly [number, number, number] },
): Promise<WorldObjectScan> {
  const regionBits = Math.max(layout.gateBits - 4, 0);
  let baseMicros: number | null = null;
  let registry: Uint8Array | undefined;
  const keyframes: Uint8Array[] = [];
  const deltas: { timeMs: number; payload: Uint8Array }[] = [];
  for await (const chunk of chunkSource) {
    if (chunk.chunkType === CHUNK_TYPE_REGISTRY) {
      registry = inflateChunk(chunk.data);
      continue;
    }
    if (chunk.chunkType !== CHUNK_TYPE_GAMEPLAY) continue;
    for (const packet of splitPackets(inflateChunk(chunk.data))) {
      baseMicros ??= packet.timestampMicros;
      if (packet.type === PacketType.Keyframe) keyframes.push(packet.payload);
      else if (packet.type === PacketType.Frame) {
        deltas.push({
          timeMs: (packet.timestampMicros - baseMicros) / 1000,
          payload: packet.payload,
        });
      }
    }
  }
  if (!registry) return { births: [], samples: [], drops: [] };
  const comps = archetypeComponentCount(registry, WORLD_OBJECT_TYPE_INDEX);
  const band = keyframeSlotBand(keyframes, WORLD_OBJECT_TYPE_INDEX);
  if (comps === 0 || band.size === 0) {
    return { births: [], samples: [], drops: [] };
  }
  const full = { comps, axisBits: layout.axisBits, regionBits };
  const droppable = new Set([FLAG_IDENTITY, SKULL_IDENTITY]);
  return {
    births: deltas.flatMap((d) =>
      readWorldObjectBirths(d.payload, d.timeMs, band, full),
    ),
    samples: deltas.flatMap((d) =>
      readWorldObjectSamples(d.payload, d.timeMs, band, full),
    ),
    drops: deltas.flatMap((d) =>
      readWorldObjectDrops(d.payload, d.timeMs, band, droppable, comps),
    ),
  };
}

/** Every creation of a world object, on the position time base. */
export async function extractWorldObjectBirths(
  chunkSource: FilmChunkSource,
  layout: { gateBits: number; axisBits: readonly [number, number, number] },
): Promise<WorldObjectBirth[]> {
  return (await extractWorldObjectScan(chunkSource, layout)).births;
}
