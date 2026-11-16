import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as film from './index';
import type { FilmParser } from './film-data';

describe('parseFilm contract', () => {
  it('exports only the parser at runtime', () => {
    assert.deepEqual(Object.keys(film), ['parseFilm']);
    const parser: FilmParser = film;
    assert.equal(typeof parser.parseFilm, 'function');
  });

  it('rejects duplicate chunk indexes', async () => {
    const chunk = { index: 0, chunkType: 1, bytes: new ArrayBuffer(0) };
    await assert.rejects(
      film.parseFilm([chunk, chunk]),
      /Duplicate film chunk 0/,
    );
  });

  it('rejects unsupported chunk types and invalid indexes', async () => {
    await assert.rejects(
      film.parseFilm([{ index: 0, chunkType: 99, bytes: new ArrayBuffer(0) }]),
      /Unknown film chunk type/,
    );
    await assert.rejects(
      film.parseFilm([{ index: -1, chunkType: 1, bytes: new ArrayBuffer(0) }]),
      /index must be/,
    );
  });
});
