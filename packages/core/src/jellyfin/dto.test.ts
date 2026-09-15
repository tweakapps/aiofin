import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// The core barrel (packages/core/src/index.ts) is imported once by
// packages/core/test/setup.ts before any test file runs, resolving the
// pre-existing config <-> tasks <-> logger circular dependency the same
// way production does (packages/server/src/app.ts pulls it in first).
import type { MetaPreview, ParsedStream } from '../db/schemas.js';
import {
  buildMediaSource,
  buildMetaItem,
  displayFilenameFor,
  officialRatingFor,
  peopleFrom,
  providerIdsFor,
  stubMediaSources,
  type ItemBuildContext,
  type MediaSourceBuildOptions,
} from './dto.js';
import { recallImages } from './images.js';
import { PLAYBACK_PATH_PREFIX } from '../debrid/utils.js';

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
  it('returns exactly two entries (Infuse needs 2+ to offer a version picker)', () => {
    const sources = stubMediaSources('item-1', 'Movie');
    assert.equal(sources.length, 2);
    assert.equal(sources[0].Id, 'item-1');
  });
});

describe('MediaSourceCount', () => {
  it('is not set on a stub-sourced list item (Infuse Direct must not show a version arrow for it)', () => {
    const meta = { id: 'tt1', type: 'movie', name: 'Movie' } as unknown as MetaPreview;
    const item = buildMetaItem(ctx, meta);
    assert.equal(item.MediaSources?.length, 2);
    assert.equal(item.MediaSourceCount, undefined);
  });
});

describe('EnableMediaSourceDisplay', () => {
  it('is true on a movie item (Infuse Direct reads this to show its version list)', () => {
    const meta = { id: 'tt1', type: 'movie', name: 'Movie' } as unknown as MetaPreview;
    const item = buildMetaItem(ctx, meta);
    assert.equal(item.EnableMediaSourceDisplay, true);
  });

  it('is not set on a series item', () => {
    const meta = { id: 'tt2', type: 'series', name: 'Series' } as unknown as MetaPreview;
    const item = buildMetaItem(ctx, meta);
    assert.equal(item.EnableMediaSourceDisplay, undefined);
  });
});

const OWNED_5_SEG_URL =
  'http://localhost:3000' +
  PLAYBACK_PATH_PREFIX +
  'storeAuth123/-/fileInfoABC/meta456/S01E01%20-%20Turning%20Point.mkv';

const buildOpts: MediaSourceBuildOptions = {
  baseUrl: 'http://localhost:3000',
  itemId: 'item-1',
  apiKey: 'apikey',
  encrypt: (plain: string) => plain,
  subtitles: [],
};

function ownedStream(overrides: Partial<ParsedStream> = {}): ParsedStream {
  return {
    id: 's-1',
    type: 'debrid',
    url: OWNED_5_SEG_URL,
    filename: 'S01E01 - Turning Point.mkv',
    ...overrides,
  } as unknown as ParsedStream;
}

describe('buildMediaSource — display segment decoration', () => {
  it('appends the formatted name as a trailing display segment, keeps the filename segment intact', () => {
    const stream = ownedStream();
    const source = buildMediaSource(
      stream,
      { name: '1080p BluRay · 627 MB · Bento · TorBox · Nyaa', description: '' },
      buildOpts
    );
    assert.ok(source);
    const expectedSuffix =
      '/S01E01%20-%20Turning%20Point.mkv/1080p%20BluRay%20%C2%B7%20627%20MB%20%C2%B7%20Bento%20%C2%B7%20TorBox%20%C2%B7%20Nyaa.mkv';
    assert.ok(source!.Path.endsWith(expectedSuffix), source!.Path);
    assert.ok(source!.DirectStreamUrl?.endsWith(expectedSuffix));
    assert.equal(source!.Name, '1080p BluRay · 627 MB · Bento · TorBox · Nyaa');
  });

  it('Id is unchanged regardless of decoration', () => {
    const stream = ownedStream();
    const withDecoration = buildMediaSource(
      stream,
      { name: 'Some Label', description: '' },
      buildOpts
    );
    const withoutDecoration = buildMediaSource(
      stream,
      { name: '', description: '' },
      buildOpts
    );
    assert.equal(withDecoration!.Id, withoutDecoration!.Id);
  });

  it('leaves Path unchanged for an external (non-owned) URL', () => {
    const stream = ownedStream({
      url: 'https://torrentio.strem.fun/stream/movie/tt123.json',
    });
    const source = buildMediaSource(
      stream,
      { name: '1080p BluRay · Bento', description: '' },
      buildOpts
    );
    assert.equal(source!.Path, stream.url);
    assert.equal(source!.DirectStreamUrl, stream.url);
  });
});

describe('displayFilenameFor', () => {
  it('sanitises newlines, slashes and percent signs', () => {
    const stream = ownedStream({ filename: 'file.mkv' });
    const label = displayFilenameFor(stream, 'a/b\\c%d\ne');
    assert.equal(label, 'a-b-c-d e.mkv');
  });

  it('caps a very long name at <= 164 chars including the extension', () => {
    const stream = ownedStream({ filename: 'file.mkv' });
    const longName = 'x'.repeat(300);
    const label = displayFilenameFor(stream, longName);
    assert.ok(label.length <= 164, `length was ${label.length}`);
    assert.ok(label.endsWith('.mkv'));
  });

  it('falls back to containerOf (mkv) when stream.filename is undefined', () => {
    const stream = ownedStream({ filename: undefined, url: OWNED_5_SEG_URL });
    const label = displayFilenameFor(stream, 'Some Label');
    assert.equal(label, 'Some Label.mkv');
  });

  it('uses the .mp4 extension from stream.filename when present', () => {
    const stream = ownedStream({ filename: 'movie.mp4' });
    const label = displayFilenameFor(stream, 'Some Label');
    assert.equal(label, 'Some Label.mp4');
  });

  it('returns an empty string for an empty formatted name (no decoration)', () => {
    const stream = ownedStream();
    assert.equal(displayFilenameFor(stream, ''), '');
    assert.equal(displayFilenameFor(stream, '   '), '');
  });
});
