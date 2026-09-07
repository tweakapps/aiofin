import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JellyfinItemDescriptor } from '../db/repositories/jellyfin.js';
import {
  canonicalDescriptor,
  dashedGuid,
  hashJellyfinId,
  normaliseJellyfinId,
  packJellyfinId,
  unpackJellyfinId,
  uuidToJellyfinUserId,
} from './ids-codec.js';

const encodeJellyfinId = (d: JellyfinItemDescriptor) =>
  packJellyfinId(d) ?? hashJellyfinId(d);
const decodeJellyfinId = async (raw: string) => unpackJellyfinId(raw);

const PACKABLE: JellyfinItemDescriptor[] = [
  { k: 'movie', t: 'movie', i: 'tt0111161' },
  { k: 'series', t: 'series', i: 'tt9288030' },
  { k: 'series', t: 'anime', i: 'kitsu:1376' },
  { k: 'movie', t: 'movie', i: 'tmdb:550' },
  { k: 'series', t: 'series', i: 'tvdb:81189' },
  { k: 'season', t: 'series', i: 'tt9288030', s: 2 },
  { k: 'season', t: 'series', i: 'tt9288030', s: 0 },
  {
    k: 'episode',
    t: 'series',
    i: 'tt9288030',
    s: 1,
    e: 3,
    v: 'tt9288030:1:3',
  },
  { k: 'episode', t: 'anime', i: 'mal:5114', s: 1, e: 13, v: 'mal:5114:13' },
];

describe('jellyfin id codec', () => {
  it('packs standard ids into valid 32-hex GUIDs and round-trips them', async () => {
    for (const d of PACKABLE) {
      const id = encodeJellyfinId(d);
      assert.match(id, /^a1[0-9a-f]{30}$/);
      const decoded = await decodeJellyfinId(id);
      assert.deepEqual(decoded, d);
      const decoded2 = await decodeJellyfinId(dashedGuid(id).toUpperCase());
      assert.deepEqual(decoded2, d);
    }
  });

  it('is deterministic', () => {
    const d: JellyfinItemDescriptor = {
      k: 'movie',
      t: 'movie',
      i: 'tt0111161',
    };
    assert.deepEqual(encodeJellyfinId(d), encodeJellyfinId(d));
  });

  it('gives distinct ids to distinct descriptors', () => {
    const ids = new Set(PACKABLE.map(encodeJellyfinId));
    assert.equal(ids.size, PACKABLE.length);
  });

  it('falls back to hashed ids for non-numeric or exotic ids', () => {
    const exotic: JellyfinItemDescriptor[] = [
      {
        k: 'movie',
        t: 'movie',
        i: 'aiostreams::library.realdebrid.torrent.abc',
      },
      { k: 'view', t: 'movie', c: 'catalog.popular' },
      { k: 'genre', t: 'movie', c: 'catalog.popular', g: 'Action' },
      { k: 'person', n: 'Alan Ritchson' },
      {
        k: 'episode',
        t: 'series',
        i: 'tt9288030',
        s: 1,
        e: 3,
        v: 'weird-video-id',
      },
    ];
    for (const d of exotic) {
      const id = encodeJellyfinId(d);
      assert.match(id, /^b2[0-9a-f]{30}$/);
    }
  });

  it('keeps imdb leading zeros intact', async () => {
    const d: JellyfinItemDescriptor = {
      k: 'movie',
      t: 'movie',
      i: 'tt0000001',
    };
    const id = encodeJellyfinId(d);
    assert.match(id, /^a1/);
    assert.deepEqual(await decodeJellyfinId(id), d);
  });

  it('hashes imdb ids longer than 7 digits with leading zeros ambiguity safely', async () => {
    const d: JellyfinItemDescriptor = {
      k: 'movie',
      t: 'movie',
      i: 'tt37287335',
    };
    const id = encodeJellyfinId(d);
    if (id.startsWith('a1')) {
      assert.deepEqual(await decodeJellyfinId(id), d);
    } else {
      assert.match(id, /^b2/);
    }
  });

  it('normalises and formats guids', () => {
    const hex = 'a1210200000000d17affffffff000000';
    assert.equal(normaliseJellyfinId(dashedGuid(hex)), hex);
    assert.match(
      dashedGuid(hex),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('maps config uuids to jellyfin user ids', () => {
    assert.equal(
      uuidToJellyfinUserId('01234567-89ab-cdef-0123-456789abcdef'),
      '0123456789abcdef0123456789abcdef'
    );
  });

  it('rejects garbage', async () => {
    assert.equal(await decodeJellyfinId('not-a-guid'), null);
    assert.equal(await decodeJellyfinId('a1'.padEnd(32, 'z')), null);
  });

  it('canonical descriptors are unique per field set', () => {
    assert.notEqual(
      canonicalDescriptor({ k: 'season', t: 'series', i: 'x', s: 1 }),
      canonicalDescriptor({ k: 'season', t: 'series', i: 'x', s: 2 })
    );
  });
});
