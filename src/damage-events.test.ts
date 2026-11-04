import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readDamageEvents } from './damage-events';

function push(bits: number[], value: number, count: number) {
  for (let i = count - 1; i >= 0; i--)
    bits.push(Math.floor(value / 2 ** i) % 2);
}

function damageRecord(victim: number, attacker: number): Uint8Array {
  const bits: number[] = [];
  push(bits, 0b11, 2); // config, more
  push(bits, 0, 7); // type
  for (const index of [victim, attacker]) {
    push(bits, 1, 1); // present
    push(bits, 1, 1); // probe
    push(bits, index, 9);
    push(bits, 0, 2);
  }
  push(bits, 0, 1); // third reference absent
  push(bits, 0, 1); // no source
  push(bits, 0, 1);
  push(bits, 0, 19);
  push(bits, 0, 1);
  push(bits, 0, 16);
  push(bits, 0, 1);
  push(bits, 0, 15); // flags
  push(bits, 0, 4);
  push(bits, 16, 5); // magnitude code
  push(bits, 0, 5);
  push(bits, 0, 64);
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => {
    bytes[i >> 3] |= bit << (7 - (i & 7));
  });
  return bytes;
}

describe('readDamageEvents', () => {
  it('reads the victim, attacker and magnitude', () => {
    const known = (slot: number) => slot === 515 || slot === 519;
    const events = readDamageEvents(damageRecord(3, 7), 99, known);
    assert.equal(events.length, 1);
    assert.equal(events[0].victimSlot, 515);
    assert.equal(events[0].attackerSlot, 519);
    assert.ok(events[0].magnitude > 0);
  });

  it('keeps head records but drops mid-list ones that name no known unit', () => {
    assert.equal(
      readDamageEvents(damageRecord(3, 7), 0, () => false).length,
      1,
    );
  });
});
