/**
 * MSB-first bit reader. Film payloads are bit-packed (not byte-aligned), so
 * most fields have to be read at arbitrary bit offsets.
 */
export class BitReader {
  public position = 0;

  constructor(public readonly data: Uint8Array) {}

  public get bitLength(): number {
    return this.data.length * 8;
  }

  public bitAt(pos: number): number {
    return (this.data[pos >> 3] >> (7 - (pos & 7))) & 1;
  }

  /** Reads up to 48 bits starting at `pos` without moving the cursor. */
  public peek(pos: number, bits: number): number {
    let value = 0;
    for (let i = 0; i < bits; i++) {
      value = value * 2 + this.bitAt(pos + i);
    }
    return value;
  }

  public read(bits: number): number {
    const value = this.peek(this.position, bits);
    this.position += bits;
    return value;
  }

  /** Reads `byteCount` bytes (as a little-endian integer) starting at bit `pos`. */
  public peekLittleEndianBytes(pos: number, byteCount: number): bigint {
    let value = 0n;
    for (let k = 0; k < byteCount; k++) {
      value |= BigInt(this.peek(pos + k * 8, 8)) << BigInt(8 * k);
    }
    return value;
  }
}
