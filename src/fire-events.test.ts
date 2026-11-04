import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFireEvents } from './fire-events';

const BR75 = 0x2b1824d5;

function push(bits: number[], value: number, count: number) {
  for (let i = count - 1; i >= 0; i--)
    bits.push(Math.floor(value / 2 ** i) % 2);
}

function fireRecord(
  unitIndex: number,
  family: number,
  trailingFlags = 0,
): Uint8Array {
  const bits: number[] = [];
  push(bits, 0b11, 2); // config, more
  push(bits, 36, 7);
  push(bits, 1, 1); // unit present
  push(bits, 1, 1); // probe
  push(bits, unitIndex, 9);
  push(bits, 1, 2); // generation
  push(bits, 0, 2); // absent references
  push(bits, 0, 2); // flags
  push(bits, 0, 8); // fire number
  push(bits, 0, 1); // shooter guard (0 = present)
  push(bits, 3, 5);
  push(bits, 0, 1); // field e guard
  push(bits, 0, 2);
  push(bits, 1, 1); // weapon high half present
  push(bits, family, 32);
  push(bits, 0, 32); // weapon low half
  push(bits, 0, 2 + 6 + 6); // i, j, empty target and component counts
  push(bits, trailingFlags, 2);
  push(bits, 0, 30); // aim: face +X, first cell
  push(bits, 0, 8);
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => {
    bytes[i >> 3] |= bit << (7 - (i & 7));
  });
  return bytes;
}

describe('readFireEvents', () => {
  it('reads the unit slot and weapon of a fire record', () => {
    const events = readFireEvents(fireRecord(5, BR75), 1234);
    assert.deepEqual(
      events.map((e) => [e.timeMs, e.slot, e.weapon]),
      [[1234, 517, 'BR75']],
    );
  });

  it('decodes the aim heading of a modal record', () => {
    const [event] = readFireEvents(fireRecord(5, BR75), 0);
    assert.ok(event.aimYawDeg !== undefined);
    // Direction (1, -1, -1) normalized: 45 degrees clockwise of +X.
    assert.ok(Math.abs(event.aimYawDeg - 315) < 0.5);
  });

  it('does not read an aim when a trailing flag is set', () => {
    const [event] = readFireEvents(fireRecord(5, BR75, 0b10), 0);
    assert.equal(event.aimYawDeg, undefined);
  });

  it('ignores records with an unknown weapon', () => {
    assert.deepEqual(readFireEvents(fireRecord(5, 0x12345678), 0), []);
  });
});
