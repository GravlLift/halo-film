import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readKeyframeInventories } from './inventory';
import { walkKeyframe } from '../core/keyframe-world';
import { WEAPON_FAMILY_NAMES } from '../core/weapon-catalog';

function bitsToBytes(bits: number[]): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => {
    bytes[i >> 3] |= bit << (7 - (i & 7));
  });
  return bytes;
}

function push(bits: number[], value: number, count: number) {
  for (let i = count - 1; i >= 0; i--)
    bits.push(Math.floor(value / 2 ** i) % 2);
}

const BR75 = 0x2b1824d5;

function bipedPayload(): Uint8Array {
  const bits: number[] = [0];
  // Header: id (generation 1, slot 512), then field26 = 0 and type index 35.
  push(bits, 2 ** 30 + 512, 32);
  push(bits, 35, 32);
  push(bits, 0, 40);
  // Ammo block: slot 0 has a 15-round magazine and 45 in reserve; the rest are empty.
  push(bits, 0, 1);
  push(bits, 15, 8);
  push(bits, 1, 1);
  push(bits, 45, 11);
  push(bits, 0, 9);
  for (let k = 0; k < 3; k++) {
    push(bits, 1, 2);
    push(bits, 0, 20);
  }
  push(bits, 0, 3);
  push(bits, 0, 1);
  push(bits, 1, 2);
  push(bits, 1, 1);
  push(bits, 0, 1);
  push(bits, BR75, 32);
  push(bits, 0, 64);
  return bitsToBytes(bits);
}

describe('walkKeyframe', () => {
  it('finds a biped record header', () => {
    const records = walkKeyframe(bipedPayload());
    assert.deepEqual(
      records.map((r) => [r.slot, r.typeIndex, r.generation]),
      [[512, 35, 1]],
    );
  });
});

describe('readKeyframeInventories', () => {
  it('reads weapon family and ammo of a biped', () => {
    assert.equal(WEAPON_FAMILY_NAMES.get(BR75), 'BR75');
    const [snap] = readKeyframeInventories(bipedPayload(), 20000);
    assert.equal(snap.slot, 512);
    assert.deepEqual(snap.weapons, [BR75]);
  });
});
