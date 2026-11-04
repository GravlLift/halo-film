import { BitReader } from "./bit-reader";

export interface FilmPlayer {
  /** Per-match slot index (5 bits preceding the player's first xuid). */
  playerIndex: number;
  xuid: string;
  gamertag: string;
}

// In the player metadata packet the gamertag (UTF-16LE, null terminated) is
// followed by 152 bits and then the player's xuid again.
const BITS_BETWEEN_NAME_TERMINATOR_AND_XUID = 152;
const MAX_GAMERTAG_CHARS = 20;
const PLAYER_INDEX_BITS = 5;

/**
 * Xuids are 64-bit little-endian integers of the form 0x0009xxxxxxxxxxxx,
 * stored at arbitrary bit offsets.
 */
function findXuids(reader: BitReader): Map<bigint, number[]> {
  const found = new Map<bigint, number[]>();
  for (let pos = 0; pos + 64 <= reader.bitLength; pos++) {
    if (reader.peek(pos + 56, 8) !== 0 || reader.peek(pos + 48, 8) !== 9) {
      continue;
    }
    if (reader.peek(pos + 40, 8) >= 0x10) continue;
    const xuid = reader.peekLittleEndianBytes(pos, 8);
    const positions = found.get(xuid);
    if (positions) positions.push(pos);
    else found.set(xuid, [pos]);
  }
  return found;
}

function gamertagBefore(reader: BitReader, xuidPos: number): string | null {
  const terminatorPos = xuidPos - BITS_BETWEEN_NAME_TERMINATOR_AND_XUID - 16;
  if (terminatorPos < 0 || reader.peek(terminatorPos, 16) !== 0) return null;
  const units: number[] = [];
  let boundedByZero = false;
  for (let i = 1; i <= MAX_GAMERTAG_CHARS; i++) {
    const pos = terminatorPos - i * 16;
    if (pos < 0) break;
    const unit = reader.peek(pos, 8) | (reader.peek(pos + 8, 8) << 8);
    if (unit === 0) {
      boundedByZero = true;
      break;
    }
    if (unit < 0x20) break;
    units.unshift(unit);
  }
  // A genuine name is preceded by a zero unit; anything else is noise.
  return boundedByZero && units.length > 0 ? String.fromCharCode(...units) : null;
}

export function parseRoster(payload: Uint8Array): FilmPlayer[] {
  const reader = new BitReader(payload);
  const players: FilmPlayer[] = [];
  for (const [xuid, positions] of findXuids(reader)) {
    let gamertag: string | null = null;
    for (const pos of positions) {
      gamertag = gamertagBefore(reader, pos);
      if (gamertag) break;
    }
    if (!gamertag) continue;
    const first = Math.min(...positions);
    if (first < PLAYER_INDEX_BITS) continue;
    players.push({
      playerIndex: reader.peek(first - PLAYER_INDEX_BITS, PLAYER_INDEX_BITS),
      xuid: xuid.toString(),
      gamertag,
    });
  }
  return players.sort((a, b) => a.playerIndex - b.playerIndex);
}
