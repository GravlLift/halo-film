import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readKeyframeInventories } from './inventory';
import { walkKeyframe } from '../core/keyframe-world';
import { WEAPON_FAMILY_NAMES } from '../core/weapon-catalog';
import {
  readKeyframeBipedPositions,
  type KeyframeBipedPosition,
} from './keyframe-positions';
import { seedInitialKeyframe, type PositionSample } from './positions';
import type { I0Layout } from '../core/i0-layout';
import { createReplay } from '../timeline/replay';

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

function positionedBipedPayload(
  velocity: 'stationary' | 'packed' | 'raw' = 'stationary',
  upCode?: number,
  truncateFacing = false,
): Uint8Array {
  const bits: number[] = [0];
  push(bits, 2 ** 30 + 512, 32);
  push(bits, 35, 32);
  push(bits, 0, 44);
  push(bits, 152, 32);
  push(bits, 1, 1);
  push(bits, 13, 8);
  push(bits, 1, 1);
  push(bits, 0x1876bda0, 32);
  push(bits, 0, 1);
  push(bits, 2, 5);
  push(bits, 0, 9 + 32);
  push(bits, 1, 1);
  push(bits, 0, 1 + 1 + 2 + 5 + 3 + 1 + 1);
  push(bits, 0, 1 + 1 + 1 + 19 + 1 + 1);
  push(bits, 5088, 32);
  push(bits, 0, 3);
  const view = new DataView(new ArrayBuffer(4));
  for (const value of [-7.125, 23.25, -0.75]) {
    view.setFloat32(0, value, true);
    push(bits, view.getUint32(0), 32);
  }
  if (truncateFacing) return bitsToBytes(bits);
  push(bits, 0, 2);
  if (velocity === 'raw') {
    push(bits, 1, 1);
    push(bits, 0, 96);
  } else {
    push(bits, 0, 1);
    push(bits, velocity === 'stationary' ? 1 : 0, 1);
    if (velocity === 'packed') push(bits, 0, 29);
  }
  push(bits, upCode === undefined ? 1 : 0, 1);
  if (upCode !== undefined) push(bits, upCode, 19);
  push(bits, 160, 8);
  push(bits, 0, 32);
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

describe('readKeyframeBipedPositions', () => {
  it('reads little-endian world coordinates from the full state', () => {
    assert.deepEqual(readKeyframeBipedPositions(positionedBipedPayload()), [
      {
        slot: 512,
        generation: 1,
        world: [-7.125, 23.25, -0.75],
        facingYawDeg: 45.703125,
      },
    ]);
  });

  it('ignores a truncated full state', () => {
    assert.deepEqual(
      readKeyframeBipedPositions(positionedBipedPayload().subarray(0, 40)),
      [],
    );
  });

  it('reads facing after each velocity encoding and a packed up vector', () => {
    const upCode = 2 * 87381 + 146 * 294 + 146;
    const velocities: ('stationary' | 'packed' | 'raw')[] = [
      'stationary',
      'packed',
      'raw',
    ];
    for (const velocity of velocities) {
      const [position] = readKeyframeBipedPositions(
        positionedBipedPayload(velocity, upCode),
      );
      assert.ok(position.facingYawDeg !== undefined);
      assert.ok(Math.abs(position.facingYawDeg - 45.703125) < 1);
    }
  });

  it('keeps the position when the facing data is truncated or invalid', () => {
    for (const payload of [
      positionedBipedPayload('stationary', undefined, true),
      positionedBipedPayload('stationary', 524287),
    ]) {
      const [position] = readKeyframeBipedPositions(payload);
      assert.deepEqual(position.world, [-7.125, 23.25, -0.75]);
      assert.equal(position.facingYawDeg, undefined);
    }
  });
});

describe('seedInitialKeyframe', () => {
  const layout: I0Layout = { gateBits: 6, axisBits: [12, 12, 11] };
  const bounds: {
    min: [number, number, number];
    max: [number, number, number];
  } = {
    min: [0, 0, 0],
    max: [10, 10, 10],
  };
  const position: KeyframeBipedPosition = {
    slot: 512,
    generation: 1,
    world: [2, 4, 6],
    facingYawDeg: 45,
  };
  const keyframe = { timeMs: 10000, positions: [position] };
  const owners = {
    roster: [{ playerIndex: 2, xuid: 'player' }],
    creations: [
      { timeMs: 3000, slot: 512, generation: 1, participantIndex: 2 },
    ],
  };
  const newTracks = () =>
    new Map<number, PositionSample[]>([
      [
        512,
        [
          {
            timeMs: 30000,
            q: [1000, 2000, 1200],
            normalized: [0.25, 0.5, 0.6],
          },
        ],
      ],
    ]);

  it('uses the keyframe position for the same life', () => {
    const tracks = newTracks();
    seedInitialKeyframe(tracks, keyframe, layout, bounds, owners, []);
    assert.deepEqual(tracks.get(512)?.[0], {
      timeMs: 10000,
      normalized: [0.2, 0.4, 0.6],
      facingYawDeg: 45,
      q: [819, 1638, 1228],
    });
  });

  it('preserves facing separately from later aim updates', () => {
    const samples = newTracks().get(512) ?? [];
    samples.push({
      timeMs: 31000,
      q: [1000, 2000, 1200],
      normalized: [0.25, 0.5, 0.6],
      aimYawDeg: 70,
    });
    const tracks = new Map([[512, samples]]);
    seedInitialKeyframe(tracks, keyframe, layout, bounds, owners, []);
    const replay = createReplay({
      layout,
      flipRates: [],
      tracks: [{ slot: 512, samples }],
      actors: [
        {
          actor: 0,
          lives: [
            {
              slot: 512,
              startMs: 10000,
              endMs: 31000,
              sampleCount: samples.length,
            },
          ],
        },
      ],
    });
    assert.equal(replay.at(20000)[0].facingYawDeg, 45);
    assert.equal(replay.at(20000)[0].aimYawDeg, undefined);
    assert.equal(replay.at(31000)[0].aimYawDeg, 70);
  });

  it('does not attach a prior generation or bridge a death', () => {
    const reused = newTracks();
    seedInitialKeyframe(
      reused,
      keyframe,
      layout,
      bounds,
      {
        ...owners,
        creations: [
          ...owners.creations,
          { timeMs: 25000, slot: 512, generation: 2, participantIndex: 2 },
        ],
      },
      [],
    );
    assert.equal(reused.get(512)?.length, 1);
    const dead = newTracks();
    seedInitialKeyframe(dead, keyframe, layout, bounds, owners, [
      {
        xuid: 'player',
        gamertag: 'player',
        type: 'death',
        typeHint: 20,
        timeMs: 20000,
        isMedal: false,
        medalType: 0,
      },
    ]);
    assert.equal(dead.get(512)?.length, 1);
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
