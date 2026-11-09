import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPlayerGameEvents, readPlayerKilledEvents } from './kill-events';

class BitWriter {
  private readonly bits: number[] = [];

  write(value: number, count: number): this {
    for (let bit = count - 1; bit >= 0; bit--) {
      this.bits.push(Math.floor(value / 2 ** bit) % 2);
    }
    return this;
  }

  bytes(): Uint8Array {
    const output = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, index) => {
      output[index >> 3] |= bit << (7 - (index & 7));
    });
    return output;
  }
}

function killMessage(
  assister?: number,
  validChain = true,
  damageEventInChain = false,
  gate15Script = false,
) {
  const writer = new BitWriter().write(1, 1).write(0b11010101, 8);
  writer.write(1, 1).write(1, 13).write(0, 2);
  writer.write(0, 1);
  writer.write(1, 1).write(3, 13).write(1, 2);
  writer.write(0, 1).write(2, 5); // victim
  writer.write(0, 1).write(1, 5); // killer
  writer.write(61, 32).write(0, 1); // killer share and flag
  if (assister === undefined) writer.write(1, 1);
  else writer.write(0, 1).write(assister, 5);
  writer.write(149, 32); // ignored when the assister field is absent
  if (validChain) {
    if (damageEventInChain) {
      writer.write(1, 1).write(0, 7); // damage_aftermath
      writer.write(0, 1).write(0, 1).write(0, 1); // absent refs
      writer.write(0, 1).write(1, 1).write(0, 19).write(0, 1);
      writer.write(0, 5).write(0, 5).write(0, 6).write(0, 1);
      writer.write(0, 14).write(0, 1);
      writer.write(0, 1).write(0, 3).write(0, 5).write(0, 5);
      writer
        .write(0, 1)
        .write(0, 4)
        .write(1, 1)
        .write(0, 4)
        .write(0, 1)
        .write(0, 4)
        .write(0, 1);
    }
    if (gate15Script) {
      writer.write(1, 1).write(15, 7).write(0, 3);
      writer.write(0, 15).write(0, 13).write(0, 10);
    }
    const stubCount = damageEventInChain || gate15Script ? 2 : 3;
    for (let index = 0; index < stubCount; index++) {
      writer.write(1, 1).write(3, 7).write(0, 3);
    }
    writer.write(0, 1); // end of event chain
  }
  return writer.bytes();
}

function playerGameEvent(killer: number, victim: number, recipients: number[]) {
  const mask = recipients.reduce(
    (value, index) => value + 2 ** (31 - index),
    0,
  );
  const writer = new BitWriter().write(1, 1).write(1, 1).write(82, 7);
  writer.write(0, 3); // absent references
  writer.write(70, 32).write(0, 8).write(0, 3); // type, header byte, empty property bag
  writer.write(1, 1).write(0x1234, 32).write(2, 3); // text bag with two participants
  writer.write(1, 3).write(0, 1).write(killer, 5);
  writer.write(1, 3).write(0, 1).write(victim, 5);
  writer.write(mask, 32);
  for (let index = 0; index < 3; index++) {
    writer.write(1, 1).write(3, 7).write(0, 3);
  }
  writer.write(0, 1);
  return writer.bytes();
}

test('reads exact killer, victim, assister, and integer damage shares', () => {
  const events = readPlayerKilledEvents(killMessage(4), 1234);
  assert.deepEqual(events, [
    {
      timeMs: 1234,
      victimIndex: 2,
      killerIndex: 1,
      assisterIndex: 4,
      killerDamagePercent: 61,
      assisterDamagePercent: 149,
    },
  ]);
});

test('preserves the no-assister sentinel and ignores truncated candidates', () => {
  const payload = killMessage();
  const events = readPlayerKilledEvents(payload, 2000);
  assert.equal(events.length, 1);
  assert.equal(events[0].assisterIndex, undefined);
  assert.equal(events[0].assisterDamagePercent, undefined);
  assert.deepEqual(readPlayerKilledEvents(payload.subarray(0, 10), 2000), []);
});

test('rejects a plausible kill header that does not continue as a valid event chain', () => {
  assert.deepEqual(readPlayerKilledEvents(killMessage(4, false), 3000), []);
});

test('validates damage_aftermath length before accepting later kill events', () => {
  const events = readPlayerKilledEvents(killMessage(4, true, true), 4000);
  assert.equal(events.length, 1);
  assert.equal(events[0].killerDamagePercent, 61);
});

test('supports the film-wide gate-15 event-chain variant', () => {
  const payload = killMessage(4, true, false, true);
  assert.deepEqual(readPlayerKilledEvents(payload, 5000), []);
  assert.equal(readPlayerKilledEvents(payload, 5000, true).length, 1);
});

test('reads the type, ordered participant pair, and recipient mask of genre 82', () => {
  assert.deepEqual(readPlayerGameEvents(playerGameEvent(3, 7, [1, 5]), 6000), [
    {
      timeMs: 6000,
      type: 70,
      killerIndex: 3,
      victimIndex: 7,
      recipientMask: 2 ** 30 + 2 ** 26,
    },
  ]);
});
