import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindPlayers } from './bind-players';
import type { HighlightEvent } from '../decoders/highlight-events';
import type { SlotTrack } from '../decoders/positions';

const track = (slot: number, startMs: number, endMs: number): SlotTrack => ({
  slot,
  samples: [startMs, endMs].map((timeMs) => ({
    timeMs,
    q: [0, 0, 0],
    normalized: [0, 0, 0],
  })) as unknown as SlotTrack['samples'],
});

const death = (xuid: string, timeMs: number): HighlightEvent => ({
  xuid,
  gamertag: xuid,
  type: 'death',
  typeHint: 0,
  timeMs,
  isMedal: false,
  medalType: 0,
});

test('a body belongs to the owner named in its creation, whatever the timing', () => {
  // Slot 3 starts 1.6 s after B died and 3.6 s after A died, matching no respawn delay;
  // its creation record names B.
  const tracks = [
    track(1, 0, 10_000),
    track(2, 0, 12_000),
    track(3, 13_600, 40_000),
  ];
  const events = [death('a', 10_000), death('b', 12_000)];
  const roster = [
    { playerIndex: 0, xuid: 'a' },
    { playerIndex: 1, xuid: 'b' },
  ];
  const creations = [
    { timeMs: 5_000, slot: 1, generation: 1, participantIndex: 0 },
    { timeMs: 5_000, slot: 2, generation: 1, participantIndex: 1 },
    { timeMs: 13_000, slot: 3, generation: 1, participantIndex: 1 },
  ];
  const { actors } = bindPlayers(tracks, events, [], { creations, roster });
  const slotsOf = (xuid: string) =>
    actors.find((a) => a.xuid === xuid)?.lives.map((l) => l.slot);
  assert.deepEqual(slotsOf('a'), [1]);
  assert.deepEqual(slotsOf('b'), [2, 3]);
});

test('simultaneous deaths are told apart by when each player respawned', () => {
  // A and B die together at 60 s. B died earlier (10 s) so B's life starts at 20.1 s;
  // A died at 30 s so A's starts at 40.1 s. Matching the ends alone cannot separate them.
  const tracks = [
    track(1, 0, 10_000),
    track(2, 0, 30_000),
    track(3, 20_100, 60_000),
    track(4, 40_100, 60_010),
  ];
  const events = [
    death('a', 30_000),
    death('a', 60_000),
    death('b', 10_000),
    death('b', 60_000),
  ];
  const { actors } = bindPlayers(tracks, events);
  const slotsOf = (xuid: string) =>
    actors.find((a) => a.xuid === xuid)?.lives.map((l) => l.slot);
  assert.deepEqual(slotsOf('a'), [2, 4]);
  assert.deepEqual(slotsOf('b'), [1, 3]);
});

test('a track that stops sampling before its death still binds by its respawn', () => {
  // A's second life ends 1 s before A's death at 60 s, but it starts one respawn
  // delay after A's death at 10 s, which no other player's life does.
  const tracks = [
    track(1, 0, 10_000),
    track(2, 0, 30_000),
    track(3, 20_100, 59_000),
    track(4, 40_100, 70_000),
  ];
  const events = [death('a', 10_000), death('a', 60_000), death('b', 30_000)];
  const { actors } = bindPlayers(tracks, events);
  const slotsOf = (xuid: string) =>
    actors.find((a) => a.xuid === xuid)?.lives.map((l) => l.slot);
  assert.deepEqual(slotsOf('a'), [1, 3]);
  assert.deepEqual(slotsOf('b'), [2, 4]);
});
