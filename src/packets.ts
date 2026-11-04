import { unzlibSync } from 'fflate';

export const PACKET_HEADER_SIZE = 16;

export const PacketType = {
  Frame: 0,
  ReplicationDataStart: 1,
  Keyframe: 2,
  Highlights: 3,
  Type6: 6,
  ChunkEnd: 7,
  PlayerMetadata: 8,
  Type9: 9,
  FrameTrailer: 10,
  BotMetadata: 12,
} as const;

const packetTypeNames = new Map<number, string>([
  [PacketType.Frame, 'frame'],
  [PacketType.ReplicationDataStart, 'replicationDataStart'],
  [PacketType.Keyframe, 'keyframe'],
  [PacketType.Highlights, 'highlights'],
  [PacketType.Type6, 'type6'],
  [PacketType.ChunkEnd, 'chunkEnd'],
  [PacketType.PlayerMetadata, 'playerMetadata'],
  [PacketType.Type9, 'type9'],
  [PacketType.FrameTrailer, 'frameTrailer'],
  [PacketType.BotMetadata, 'botMetadata'],
]);

export function packetTypeName(type: number): string {
  return packetTypeNames.get(type) ?? `unknown${type}`;
}

export interface FilmPacket {
  type: number;
  /** Header bytes 2 and 3; meaning unknown. */
  flags: [number, number];
  /** Microsecond timestamp from the packet header. */
  timestampMicros: number;
  /** Offset of the payload within the inflated chunk. */
  payloadOffset: number;
  payload: Uint8Array;
}

/** Chunks are zlib streams (header byte 0x78). */
const inflatedCache = new WeakMap<Uint8Array, Uint8Array>();
export function inflateChunk(raw: Uint8Array): Uint8Array {
  let result = inflatedCache.get(raw);
  if (!result) {
    result = unzlibSync(raw);
    inflatedCache.set(raw, result);
  }
  return result;
}

const splitCache = new WeakMap<Uint8Array, FilmPacket[]>();

/**
 * Splits an inflated gameplay chunk into packets:
 * `[type u16][b2 u8][b3 u8][size u32][timestamp µs u64]` + payload, until
 * a ChunkEnd packet (type 7).
 */
export function splitPackets(inflated: Uint8Array): FilmPacket[] {
  const cached = splitCache.get(inflated);
  if (cached) return cached;
  const view = new DataView(
    inflated.buffer,
    inflated.byteOffset,
    inflated.byteLength,
  );
  const packets: FilmPacket[] = [];
  let offset = 0;
  while (offset + PACKET_HEADER_SIZE <= inflated.length) {
    const type = view.getUint16(offset, true);
    const size = view.getUint32(offset + 4, true);
    const payloadOffset = offset + PACKET_HEADER_SIZE;
    if (payloadOffset + size > inflated.length) {
      throw new Error(
        `Packet at offset ${offset} (type ${type}) claims ${size} bytes but only ${
          inflated.length - payloadOffset
        } remain`,
      );
    }
    packets.push({
      type,
      flags: [inflated[offset + 2], inflated[offset + 3]],
      timestampMicros: Number(view.getBigUint64(offset + 8, true)),
      payloadOffset,
      payload: inflated.subarray(payloadOffset, payloadOffset + size),
    });
    offset = payloadOffset + size;
    if (type === PacketType.ChunkEnd) break;
  }
  splitCache.set(inflated, packets);
  return packets;
}
