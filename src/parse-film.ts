import {
  CHUNK_TYPE_REGISTRY,
  type FilmChunkSource,
  type FilmMetadata,
} from "./film-input";
import {
  inflateChunk,
  packetTypeName,
  PacketType,
  splitPackets,
  type FilmPacket,
} from "./packets";
import { parseRegistry, type ComponentRegistry } from "./registry";
import { parseRoster, type FilmPlayer } from "./roster";

export interface ParsedPacket {
  type: number;
  typeName: string;
  flags: [number, number];
  size: number;
  timestampMicros: number;
  /** Milliseconds since the first gameplay packet of the film. */
  timeMs: number;
}

export interface ParsedChunk {
  index: number;
  chunkType: number;
  startTimeOffsetMs: number;
  durationMs: number;
  compressedBytes: number;
  inflatedBytes: number;
  packetCounts: Record<string, number>;
  frames: {
    count: number;
    firstTimeMs: number | null;
    lastTimeMs: number | null;
  };
  packets?: ParsedPacket[];
}

export interface ParsedFilm {
  matchId: string;
  filmLengthMs: number;
  majorVersion: number;
  hasGameEnded: boolean;
  registry: ComponentRegistry;
  players: (FilmPlayer & { firstSeenChunk: number })[];
  chunks: ParsedChunk[];
}

export interface ParseFilmOptions {
  /** Include a per-packet header listing for every chunk (large). */
  includePackets?: boolean;
}

export async function parseFilm(
  metadata: FilmMetadata,
  chunkSource: FilmChunkSource,
  options: ParseFilmOptions = {},
): Promise<ParsedFilm> {
  let registry: ComponentRegistry = { header: 0, components: [], slotCount: 0 };
  const players = new Map<string, FilmPlayer & { firstSeenChunk: number }>();
  const chunks: ParsedChunk[] = [];
  let baseMicros: number | null = null;

  for await (const chunk of chunkSource) {
    const inflated = inflateChunk(chunk.data);
    const base: Omit<ParsedChunk, "packetCounts" | "frames"> = {
      index: chunk.index,
      chunkType: chunk.chunkType,
      startTimeOffsetMs: chunk.startTimeOffsetMs,
      durationMs: chunk.durationMs,
      compressedBytes: chunk.data.length,
      inflatedBytes: inflated.length,
    };

    // ChunkType 1 is the component registry, which is not packetized.
    if (chunk.chunkType === CHUNK_TYPE_REGISTRY) {
      registry = parseRegistry(inflated);
      chunks.push({
        ...base,
        packetCounts: {},
        frames: { count: 0, firstTimeMs: null, lastTimeMs: null },
      });
      continue;
    }

    const packets = splitPackets(inflated);
    baseMicros ??= packets[0]?.timestampMicros ?? 0;
    const toMs = (micros: number) => (micros - (baseMicros ?? 0)) / 1000;

    const packetCounts: Record<string, number> = {};
    const frameTimes: number[] = [];
    for (const packet of packets) {
      const name = packetTypeName(packet.type);
      packetCounts[name] = (packetCounts[name] ?? 0) + 1;
      if (packet.type === PacketType.Frame) {
        frameTimes.push(toMs(packet.timestampMicros));
      }
      if (packet.type === PacketType.PlayerMetadata) {
        for (const player of parseRoster(packet.payload)) {
          if (!players.has(player.xuid)) {
            players.set(player.xuid, { ...player,             firstSeenChunk: chunk.index });
          }
        }
      }
    }

    chunks.push({
      ...base,
      packetCounts,
      frames: {
        count: frameTimes.length,
        firstTimeMs: frameTimes[0] ?? null,
        lastTimeMs: frameTimes[frameTimes.length - 1] ?? null,
      },
      ...(options.includePackets
        ? {
            packets: packets.map((packet: FilmPacket) => ({
              type: packet.type,
              typeName: packetTypeName(packet.type),
              flags: packet.flags,
              size: packet.payload.length,
              timestampMicros: packet.timestampMicros,
              timeMs: toMs(packet.timestampMicros),
            })),
          }
        : {}),
    });
  }

  return {
    ...metadata,
    registry,
    players: [...players.values()].sort(
      (a, b) => a.playerIndex - b.playerIndex,
    ),
    chunks,
  };
}
