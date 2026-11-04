import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SlotTrack } from './positions';
import { dropStagingTracks } from './staging-tracks';

function track(slot: number, startMs: number, endMs: number): SlotTrack {
  const sample = (timeMs: number) => ({
    timeMs,
    normalized: [0, 0, 0] as [number, number, number],
  });
  return { slot, samples: [sample(startMs), sample(endMs)] } as SlotTrack;
}

describe('dropStagingTracks', () => {
  it('drops a burst of short tracks starting together', () => {
    const burst = Array.from({ length: 8 }, (_, i) =>
      track(100 + i, 500000 + i * 300, 506000 + i * 300),
    );
    const real = [track(1, 0, 60000), track(2, 1000, 3000)];
    const kept = dropStagingTracks([...real, ...burst]);
    assert.deepEqual(
      kept.map((t) => t.slot),
      [1, 2],
    );
  });

  it('keeps a simultaneous match-start wave of long lives', () => {
    const wave = Array.from({ length: 8 }, (_, i) => track(i, 0, 60000 + i));
    assert.equal(dropStagingTracks(wave).length, 8);
  });
});
