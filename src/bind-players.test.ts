import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindPlayers } from './bind-players';
import type { HighlightEvent } from './highlight-events';
import type { SlotTrack } from './positions';

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

test('a trade does not give a player a life that overlaps their previous one', () => {
  // A dies at 10 s, respawns, and trades with B at 20 s. B's only life is slot 2, which
  // ends within a frame of A's second life; A cannot own it because A died at 10 s.
  const tracks = [
    track(1, 0, 10_000),
    track(2, 0, 20_000),
    track(5, 12_000, 20_010),
  ];
  const events = [death('a', 10_000), death('a', 20_000), death('b', 20_000)];
  const { actors } = bindPlayers(tracks, events);
  const slotsOf = (xuid: string) =>
    actors.find((a) => a.xuid === xuid)?.lives.map((l) => l.slot);
  assert.deepEqual(slotsOf('a'), [1, 5]);
  assert.deepEqual(slotsOf('b'), [2]);
});

test('a trade resolves when one death takes the life another death needs', () => {
  // Both die near 30 s. A's death fits slots 10 and 11, but B's fits only slot 10
  // (slot 11 ends 700 ms later). B must keep slot 10; A takes slot 11.
  const tracks = [
    track(1, 0, 10_000),
    track(2, 0, 10_000),
    track(10, 20_000, 30_000),
    track(11, 20_000, 30_700),
  ];
  const events = [
    death('a', 10_000),
    death('b', 10_000),
    death('a', 30_000),
    death('b', 30_100),
  ];
  const { actors } = bindPlayers(tracks, events);
  const owners = actors.map((a) => a.lives.map((l) => l.slot).sort());
  assert.equal(
    actors.filter((a) => a.lives.some((l) => l.slot === 10 || l.slot === 11))
      .length,
    2,
  );
  assert.equal(owners.flat().length, 4);
});
