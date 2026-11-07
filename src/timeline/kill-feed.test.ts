import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  HighlightEvent,
  HighlightEventType,
} from '../decoders/highlight-events';
import type { Actor } from '../players/link-lives';
import { buildKillFeed } from './kill-feed';

const event = (
  type: HighlightEventType,
  xuid: string,
  timeMs: number,
): HighlightEvent => ({
  type,
  xuid,
  gamertag: xuid,
  timeMs,
  typeHint: 0,
  isMedal: false,
  medalType: 0,
});
const actor = (
  xuid: string,
  slot: number,
  team: number,
  endMs = 11000,
): Actor => ({
  actor: slot,
  xuid,
  gamertag: xuid,
  team,
  lives: [{ slot, startMs: 0, endMs, sampleCount: 1 }],
});

test('pairs the closest highlights without reusing deaths and retains unmatched events', () => {
  const entries = buildKillFeed(
    [
      event('kill', 'a', 1002),
      event('kill', 'b', 1000),
      event('death', 'c', 1000),
      event('death', 'd', 1002),
      event('death', 'e', 2000),
      event('kill', 'f', 3000),
    ],
    { actors: [], highlightClockOffsetMs: 500 },
    [],
  );
  assert.deepEqual(
    entries.map((entry) => [
      entry.timeMs,
      entry.killer?.xuid,
      entry.victim?.xuid,
    ]),
    [
      [1500, 'b', 'c'],
      [1502, 'a', 'd'],
      [2500, undefined, 'e'],
      [3500, 'f', undefined],
    ],
  );
});

test('attributes positive damage within the victim life to distinct teammates', () => {
  const entries = buildKillFeed(
    [event('kill', 'killer', 10000), event('death', 'victim', 10000)],
    {
      actors: [
        actor('killer', 1, 0),
        actor('victim', 2, 1, 10500),
        actor('assist', 3, 0),
        actor('enemy', 4, 1),
      ],
      highlightClockOffsetMs: 500,
    },
    [
      { timeMs: 9000, victimSlot: 2, attackerSlot: 3, magnitude: 1 },
      { timeMs: 9500, victimSlot: 2, attackerSlot: 3, magnitude: 1 },
      { timeMs: 9900, victimSlot: 2, attackerSlot: 4, magnitude: 1 },
      { timeMs: 10000, victimSlot: 2, attackerSlot: 1, magnitude: 1 },
      { timeMs: 10100, victimSlot: 2, attackerSlot: 4, magnitude: -1 },
      { timeMs: 10600, victimSlot: 2, attackerSlot: 4, magnitude: 1 },
    ],
  );
  assert.equal(entries[0].timeMs, 10500);
  assert.deepEqual(
    entries[0].damageAssists.map((player) => player.xuid),
    ['assist'],
  );
  assert.equal(entries[0].killerDamagePercent, 33);
  assert.equal(entries[0].damageAssists[0].damagePercent, 67);
});

test('leaves the killer percentage unknown when no killer damage was recorded', () => {
  const [entry] = buildKillFeed(
    [event('kill', 'killer', 10000), event('death', 'victim', 10000)],
    {
      actors: [
        actor('killer', 1, 0),
        actor('victim', 2, 1, 10000),
        actor('assist', 3, 0),
      ],
    },
    [{ timeMs: 9000, victimSlot: 2, attackerSlot: 3, magnitude: 2 }],
  );
  assert.equal(entry.killerDamagePercent, undefined);
  assert.equal(entry.damageAssists[0].damagePercent, 100);
});

test('shares recorded damage among the killer and multiple contributors', () => {
  const [entry] = buildKillFeed(
    [event('kill', 'killer', 10000), event('death', 'victim', 10000)],
    {
      actors: [
        actor('killer', 1, 0),
        actor('victim', 2, 1, 10000),
        actor('first', 3, 0),
        actor('second', 4, 0),
      ],
    },
    [
      { timeMs: 9000, victimSlot: 2, attackerSlot: 1, magnitude: 5 },
      { timeMs: 9000, victimSlot: 2, attackerSlot: 3, magnitude: 3 },
      { timeMs: 9000, victimSlot: 2, attackerSlot: 4, magnitude: 2 },
    ],
  );
  assert.equal(entry.killerDamagePercent, 50);
  assert.deepEqual(
    entry.damageAssists.map((player) => player.damagePercent),
    [30, 20],
  );
});
