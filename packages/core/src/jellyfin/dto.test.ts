import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// The core barrel (packages/core/src/index.ts) is imported once by
// packages/core/test/setup.ts before any test file runs, resolving the
// pre-existing config <-> tasks <-> logger circular dependency the same
// way production does (packages/server/src/app.ts pulls it in first).
import type { MetaPreview } from '../db/schemas.js';
import {
  officialRatingFor,
  peopleFrom,
  providerIdsFor,
  stubMediaSources,
  type ItemBuildContext,
} from './dto.js';
import { recallImages } from './images.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

const ctx: ItemBuildContext = { uuid: 'u-dto-test', serverId: 'server' };

describe('peopleFrom', () => {
  it('uses app_extras.cast for photo and role, and remembers the photo', async () => {
    const meta = {
      id: 'tt1',
      type: 'movie',
      name: 'Movie',
      app_extras: {
        cast: [{ name: 'A', character: 'X', photo: 'https://p/a.jpg' }],
      },
    } as unknown as MetaPreview;

    const people = peopleFrom(ctx, meta);
    await settle();

    assert.equal(people.length, 1);
    assert.equal(people[0].Name, 'A');
    assert.equal(people[0].Type, 'Actor');
    assert.equal(people[0].Role, 'X');
    assert.ok(people[0].PrimaryImageTag);

    const remembered = await recallImages(ctx.uuid, people[0].Id);
    assert.equal(remembered?.images.Primary, 'https://p/a.jpg');
  });

  it('falls back to meta.cast without a photo tag when app_extras is absent', async () => {
    const meta = {
      id: 'tt2',
      type: 'movie',
      name: 'Movie 2',
      cast: ['B'],
    } as unknown as MetaPreview;

    const people = peopleFrom(ctx, meta);

    assert.equal(people.length, 1);
    assert.equal(people[0].Name, 'B');
    assert.equal(people[0].Type, 'Actor');
    assert.equal(people[0].PrimaryImageTag, undefined);
  });

  it('maps app_extras.directors objects to Director entries with photos', async () => {
    const meta = {
      id: 'tt3',
      type: 'movie',
      name: 'Movie 3',
      app_extras: {
        directors: [{ name: 'C', character: null, photo: 'https://p/c.jpg' }],
      },
    } as unknown as MetaPreview;

    const people = peopleFrom(ctx, meta);
    await settle();

    assert.equal(people.length, 1);
    assert.equal(people[0].Name, 'C');
    assert.equal(people[0].Type, 'Director');
    assert.ok(people[0].PrimaryImageTag);
  });

  it('keeps a person in both cast and directors as two distinct entries', () => {
    const meta = {
      id: 'tt4',
      type: 'movie',
      name: 'Movie 4',
      app_extras: {
        cast: [{ name: 'D', character: 'Lead' }],
        directors: [{ name: 'D' }],
      },
    } as unknown as MetaPreview;

    const people = peopleFrom(ctx, meta);

    assert.equal(people.length, 2);
    const types = people.map((p) => p.Type).sort();
    assert.deepEqual(types, ['Actor', 'Director']);
  });

  it('remembers a person photo once per uuid|personId within the memo TTL', async () => {
    const memoCtx: ItemBuildContext = { uuid: 'u-dto-memo', serverId: 'server' };
    const meta1 = {
      id: 'tt-memo-1',
      type: 'movie',
      name: 'Memo Movie 1',
      app_extras: {
        cast: [{ name: 'Memo Person', character: 'X', photo: 'https://p/first.jpg' }],
      },
    } as unknown as MetaPreview;

    const people1 = peopleFrom(memoCtx, meta1);
    await settle();
    const remembered1 = await recallImages(memoCtx.uuid, people1[0].Id);
    assert.equal(remembered1?.images.Primary, 'https://p/first.jpg');

    // Same person, built again for a different item with a different photo
    // within the memo TTL — the write should be skipped, so the cache still
    // holds the first photo.
    const meta2 = {
      id: 'tt-memo-2',
      type: 'movie',
      name: 'Memo Movie 2',
      app_extras: {
        cast: [{ name: 'Memo Person', character: 'Y', photo: 'https://p/second.jpg' }],
      },
    } as unknown as MetaPreview;
    const people2 = peopleFrom(memoCtx, meta2);
    await settle();
    const remembered2 = await recallImages(memoCtx.uuid, people2[0].Id);
    assert.equal(remembered2?.images.Primary, 'https://p/first.jpg');
  });
});

describe('officialRatingFor', () => {
  it('prefers app_extras.certification over certificationLocal', () => {
    const meta = {
      id: 'tt5',
      type: 'movie',
      name: 'Movie 5',
      app_extras: { certification: 'R', certificationLocal: 'TV-MA' },
    } as unknown as MetaPreview;
    assert.equal(officialRatingFor(meta), 'R');
  });
});

describe('providerIdsFor', () => {
  it('maps _tmdbId and _tvdbId to ProviderIds.Tmdb / Tvdb', () => {
    const meta = {
      id: 'tt6',
      type: 'movie',
      name: 'Movie 6',
      _tmdbId: 123,
      _tvdbId: 456,
    } as unknown as MetaPreview;
    const ids = providerIdsFor(meta);
    assert.equal(ids.Tmdb, '123');
    assert.equal(ids.Tvdb, '456');
  });
});

describe('stubMediaSources', () => {
  it('returns exactly one entry', () => {
    const sources = stubMediaSources('item-1', 'Movie');
    assert.equal(sources.length, 1);
    assert.equal(sources[0].Id, 'item-1');
  });
});
