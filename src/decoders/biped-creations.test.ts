import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBipedCreations } from './biped-creations';

const bytesOf = (fields: [number, number][], leadBits = 0): Uint8Array => {
  const bits: number[] = Array(leadBits).fill(0);
  for (const [value, count] of fields) {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  }
  const bytes = new Uint8Array(Math.ceil(bits.length / 8) + 8);
  bits.forEach((bit, i) => {
    bytes[i >> 3] |= bit << (7 - (i & 7));
  });
  return bytes;
};

const creation = (slot: number, owner: number, representation = 0x1876bda0) =>
  [
    [0b001, 3],
    [slot, 13],
    [1, 2],
    [35, 6],
    [1, 1],
    [13, 8],
    [1, 1],
    [representation, 32],
    [0, 1],
    [owner, 5],
  ] as [number, number][];

test('reads the owner of a biped creation at an unaligned offset', () => {
  const payload = bytesOf(creation(530, 6), 5);
  assert.deepEqual(readBipedCreations(payload, 1234), [
    { timeMs: 1234, slot: 530, generation: 1, participantIndex: 6 },
  ]);
});

test('ignores a creation whose body is not a multiplayer Spartan', () => {
  assert.deepEqual(
    readBipedCreations(bytesOf(creation(530, 6, 0x12345678)), 0),
    [],
  );
});
