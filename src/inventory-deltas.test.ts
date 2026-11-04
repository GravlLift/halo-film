import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BitReader } from './bit-reader';
import { readInventoryDelta } from './inventory-deltas';

function push(bits: number[], value: number, count: number) {
  for (let i = count - 1; i >= 0; i--)
    bits.push(Math.floor(value / 2 ** i) % 2);
}

function reader(bits: number[]): BitReader {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8) + 1);
  bits.forEach((bit, i) => {
    bytes[i >> 3] |= bit << (7 - (i & 7));
  });
  return new BitReader(bytes);
}

describe('readInventoryDelta', () => {
  it('reads grenade counts and ammo past i25', () => {
    const bits: number[] = [];
    push(bits, 0, 2); // i0 tail
    push(bits, 4, 3); // i22: four counts
    for (const count of [1, 0, 2, 0]) push(bits, count, 8);
    push(bits, 0, 1); // i25 gateR8 absent
    push(bits, 0, 1); // i25 g1 absent
    push(bits, 0, 1); // i30 gate: magazine present
    push(bits, 12, 8);
    push(bits, 1, 1); // charge fraction absent
    push(bits, 87, 11); // i31 reserve
    const delta = readInventoryDelta(
      reader(bits),
      0,
      [0, 22, 25, 30, 31],
      1000,
      512,
    );
    assert.deepEqual(delta?.grenades, [1, 0, 2, 0]);
    assert.deepEqual(delta?.weapons, [{ weaponSlot: 0, mag: 12, reserve: 87 }]);
  });

  it('reads a weapon pickup and the slot it landed in', () => {
    const bits: number[] = [];
    push(bits, 0, 2); // i0 tail
    push(bits, 0, 1); // i25 gateR8 absent
    push(bits, 0, 1); // i25 g1 absent
    push(bits, 0, 1); // i33 gate: magazine present
    push(bits, 4, 8);
    push(bits, 1, 1); // charge fraction absent
    push(bits, 0b0010011, 7); // i42
    push(bits, 1, 1); // i44: taking hold
    push(bits, 0x71ab0a2c, 32); // M41 SPNKr
    const delta = readInventoryDelta(
      reader(bits),
      0,
      [0, 25, 33, 42, 44],
      41841,
      518,
    );
    assert.deepEqual(delta?.pickup, { family: 0x71ab0a2c, weaponSlot: 1 });
  });

  it('ignores a release and a non-weapon object', () => {
    for (const [gate, family] of [
      [0, 0x71ab0a2c],
      [1, 0x2a392328],
    ]) {
      const bits: number[] = [];
      push(bits, 0, 2);
      push(bits, 0b0010011, 7);
      push(bits, gate, 1);
      push(bits, family, 32);
      assert.equal(
        readInventoryDelta(reader(bits), 0, [0, 42, 44], 0, 512),
        undefined,
      );
    }
  });

  it('rejects an implausible grenade reading', () => {
    const bits: number[] = [];
    push(bits, 0, 2);
    push(bits, 4, 3);
    for (const count of [9, 0, 0, 0]) push(bits, count, 8);
    assert.equal(
      readInventoryDelta(reader(bits), 0, [0, 22], 0, 512),
      undefined,
    );
  });
});
