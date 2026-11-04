import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProjectileFlights } from './projectiles';

const sample = (slot: number, timeMs: number, x: number) => ({
  timeMs,
  slot,
  generation: 0,
  normalized: [x, 0.5, 0.5] as [number, number, number],
});

test('joins a flight with the detonation of its slot', () => {
  const samples = [0, 17, 34, 51].map((t, i) =>
    sample(0x401, 1000 + t, 0.1 + i * 0.01),
  );
  const flights = buildProjectileFlights(samples, [
    { idx: 1, timeMs: 2500, x: 0.13, y: 0.5, z: 0.5 },
    { idx: 2, timeMs: 1100, x: 0.13, y: 0.5, z: 0.5 },
    { idx: 1, timeMs: 1100, x: 0.9, y: 0.5, z: 0.5 },
  ]);
  assert.equal(flights.length, 1);
  assert.equal(flights[0].detonation.fromFilm, true);
  assert.equal(flights[0].detonation.timeMs, 2500);
});

test('falls back to the last position and splits reused slots', () => {
  const first = [0, 17, 34].map((t) => sample(0x400, t, 0.2));
  const second = [5000, 5017, 5034].map((t) => sample(0x400, t, 0.3));
  const flights = buildProjectileFlights([...first, ...second], []);
  assert.equal(flights.length, 2);
  assert.equal(flights[0].detonation.fromFilm, false);
  assert.equal(flights[1].detonation.timeMs, 5034);
});

test('the thrower is read from the creation record of the flight slot', () => {
  const samples = [0, 17, 34].map((t) => sample(0x400, 1000 + t, 0.5));
  const [flight] = buildProjectileFlights(
    samples,
    [],
    [
      { timeMs: 984, slot: 0x400, thrower: 3, fragment: false },
      { timeMs: 984, slot: 0x401, thrower: 5, fragment: false },
      { timeMs: 100, slot: 0x400, thrower: 7, fragment: false },
    ],
  );
  assert.equal(flight.thrower, 3);
  assert.equal(flight.explodes, true);
  assert.equal(buildProjectileFlights(samples, [])[0].thrower, undefined);
});

test('a fragment flight does not explode', () => {
  const samples = [0, 17, 34].map((t) => sample(0x400, 1000 + t, 0.5));
  const [flight] = buildProjectileFlights(
    samples,
    [],
    [{ timeMs: 984, slot: 0x400, thrower: 3, fragment: true }],
  );
  assert.equal(flight.explodes, false);
});

test('a grenade that detonates before replicating a position still explodes', () => {
  const flights = buildProjectileFlights(
    [],
    [
      { idx: 0x73, timeMs: 1030, x: 0.37, y: 0.33, z: 0.77 },
      { idx: 0x73, timeMs: 5000, x: 0.9, y: 0.9, z: 0.9 },
    ],
    [
      { timeMs: 1000, slot: 0x473, thrower: 0, fragment: false },
      { timeMs: 1000, slot: 0x474, thrower: 0, fragment: true },
    ],
  );
  assert.equal(flights.length, 1);
  assert.equal(flights[0].thrower, 0);
  assert.equal(flights[0].explodes, true);
  assert.equal(flights[0].detonation.timeMs, 1030);
  assert.equal(flights[0].detonation.x, 0.37);
});

test('drops flights with too few points', () => {
  assert.equal(
    buildProjectileFlights([sample(0x400, 0, 0.2), sample(0x400, 17, 0.2)], [])
      .length,
    0,
  );
});
