import { inflateChunk } from "../core/packets";

/**
 * The highlight-events chunk (manifest chunk type 3) lists every kill, death,
 * medal and mode event with the xuid of the player concerned and a timestamp.
 * Format from SPNKr (acurtis166) via LevelUp's `highlight_events.go`: the stream
 * is bit-packed, each event is `[xuid u64 LE][0x2d|0x25][0xc0] ... [60 bytes][00 00 2e e0]`.
 */
export type HighlightEventType = "kill" | "death" | "medal" | "mode";

export interface HighlightEvent {
  xuid: string;
  gamertag: string;
  type: HighlightEventType;
  typeHint: number;
  /** Time on the film clock, the same base as `PositionSample.timeMs` before offsetting. */
  timeMs: number;
  isMedal: boolean;
  medalType: number;
}

const MIN_XUID = 2e15;
const MAX_XUID = 3e15;
const WINDOW_BITS = 20_000;
const EVENT_BYTES = 60;
const END_MARKER = [0x00, 0x00, 0x2e, 0xe0];
const MEDAL_HINTS = new Set([
  50, 51, 52, 100, 101, 150, 200, 205, 210, 220, 225, 230, 235, 240, 245, 250,
]);

function byteAt(data: Uint8Array, bit: number): number {
  const i = bit >> 3;
  const s = bit & 7;
  if (s === 0) return data[i] ?? 0;
  return (((data[i] ?? 0) << s) | ((data[i + 1] ?? 0) >> (8 - s))) & 0xff;
}

function findMarker(data: Uint8Array, from: number, to: number): number {
  for (let bit = Math.max(0, from); bit <= to - 32; bit++) {
    if (
      byteAt(data, bit) === END_MARKER[0] &&
      byteAt(data, bit + 8) === END_MARKER[1] &&
      byteAt(data, bit + 16) === END_MARKER[2] &&
      byteAt(data, bit + 24) === END_MARKER[3]
    ) {
      return bit;
    }
  }
  return -1;
}

function utf16le(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const unit = bytes[i] | (bytes[i + 1] << 8);
    if (unit === 0) break;
    out += String.fromCharCode(unit);
  }
  return out;
}

function eventType(hint: number, isMedal: boolean): HighlightEventType | null {
  if (isMedal && MEDAL_HINTS.has(hint)) return "medal";
  if (hint === 10) return "mode";
  if (hint === 20) return "death";
  if (hint === 50) return "kill";
  return null;
}

function decode(
  block: Uint8Array,
  xuid: bigint,
  version: number,
): HighlightEvent | null {
  const typeHint = block[47];
  const isMedal = block[55] === 1;
  const type = eventType(typeHint, isMedal);
  if (!type) return null;
  const nameBytes =
    version <= 38 || version >= 41 ? block.subarray(0, 32) : block.subarray(12, 44);
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  return {
    xuid: xuid.toString(),
    gamertag: utf16le(nameBytes),
    type,
    typeHint,
    timeMs: view.getUint32(48, false),
    isMedal,
    medalType: block[59],
  };
}

export function parseHighlightEvents(
  compressed: Uint8Array,
  filmMajorVersion: number,
): HighlightEvent[] {
  const data = inflateChunk(compressed);
  const total = data.length * 8;
  const events: HighlightEvent[] = [];
  // One end marker is one event: keep the candidate xuid closest to the marker.
  const byMarker = new Map<number, { index: number; xuidBit: number }>();

  for (let marker = 72; marker <= total - 8; marker++) {
    if (byteAt(data, marker) !== 0xc0) continue;
    const prefix = byteAt(data, marker - 8);
    if (prefix !== 0x2d && prefix !== 0x25) continue;
    const xuidBit = marker - 72;
    let xuid = 0n;
    for (let k = 7; k >= 0; k--) {
      xuid = (xuid << 8n) | BigInt(byteAt(data, xuidBit + k * 8));
    }
    if (xuid <= BigInt(MIN_XUID) || xuid >= BigInt(MAX_XUID)) continue;

    const windowEnd = Math.min(xuidBit + WINDOW_BITS, total);
    let searchFrom = xuidBit;
    for (;;) {
      const end = findMarker(data, searchFrom, windowEnd);
      if (end < 0) break;
      searchFrom = end + 1;
      const start = end - EVENT_BYTES * 8;
      if (start < xuidBit) continue;
      const block = new Uint8Array(EVENT_BYTES);
      for (let i = 0; i < EVENT_BYTES; i++) block[i] = byteAt(data, start + i * 8);
      const event = decode(block, xuid, filmMajorVersion);
      if (!event) continue;
      const previous = byMarker.get(end);
      if (!previous) {
        byMarker.set(end, { index: events.length, xuidBit });
        events.push(event);
      } else if (xuidBit > previous.xuidBit) {
        events[previous.index] = event;
        byMarker.set(end, { index: previous.index, xuidBit });
      }
      break;
    }
  }
  return events.sort((a, b) => a.timeMs - b.timeMs);
}
