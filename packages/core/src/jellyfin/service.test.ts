import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
// The core barrel (packages/core/src/index.ts) is imported once by
// packages/core/test/setup.ts before any test file runs, resolving the
// pre-existing config <-> tasks <-> logger circular dependency the same
// way production does (packages/server/src/app.ts pulls it in first).
import type { ParsedStream, Subtitle, UserData } from '../db/schemas.js';
import { JellyfinService } from './service.js';
import { settingsStore } from '../config/index.js';

const settings = {
  api: { jellyfinMaxCatalogItems: 1000 },
};
mock.getter(
  settingsStore,
  'current',
  () => settings as typeof settingsStore.current
);

const settle = () => new Promise((r) => setTimeout(r, 0));

function catalogService(size: number, pageSize: number, skip = true) {
  const svc = new JellyfinService({} as UserData);
  const catalog = {
    id: 'fixture',
    type: 'movie',
    extra: skip ? [{ name: 'skip' }] : [],
  };
  const data = Array.from({ length: size }, (_, i) => ({
    id: `tt${i}`,
    type: 'movie',
    name: `Movie ${i}`,
  }));
  const getCatalog = mock.fn(
    async (_type: string, _id: string, extras?: string) => {
      const offset = Number(new URLSearchParams(extras).get('skip') ?? 0);
      return { data: data.slice(offset, offset + pageSize) };
    }
  );
  (svc as unknown as { engine: unknown }).engine = { getCatalog };
  return { svc, catalog, getCatalog, data };
}

describe('JellyfinService catalog paging', () => {
  it('continues short pages until empty and reuses the page memo', async () => {
    const { svc, catalog, getCatalog, data } = catalogService(7, 2);
    const first = await svc.getCatalogPage(catalog, {
      startIndex: 0,
      limit: 5,
    });
    assert.deepEqual(first.items, data.slice(0, 5));
    assert.equal(first.hasMore, true);
    const calls = getCatalog.mock.callCount();
    assert.deepEqual(
      await svc.getCatalogPage(catalog, { startIndex: 0, limit: 5 }),
      first
    );
    assert.equal(getCatalog.mock.callCount(), calls);
    const last = await svc.getCatalogPage(catalog, { startIndex: 5, limit: 5 });
    assert.deepEqual(last.items, data.slice(5));
    assert.equal(last.hasMore, false);
  });

  it('reports buffered remainder for catalogs without skip', async () => {
    const { svc, catalog, data } = catalogService(7, 7, false);
    const first = await svc.getCatalogPage(catalog, {
      startIndex: 0,
      limit: 2,
    });
    assert.equal(first.hasMore, true);
    const last = await svc.getCatalogPage(catalog, { startIndex: 2, limit: 5 });
    assert.deepEqual(last.items, data.slice(2));
    assert.equal(last.hasMore, false);
  });

  it('marks the configured cap even at its exact boundary', async () => {
    const old = settings.api.jellyfinMaxCatalogItems;
    settings.api.jellyfinMaxCatalogItems = 3;
    try {
      const { svc, catalog, data } = catalogService(10, 10);
      const page = await svc.getCatalogPage(catalog, {
        startIndex: 0,
        limit: 3,
      });
      assert.deepEqual(page.items, data.slice(0, 3));
      assert.equal(page.hasMore, false);
      assert.equal(page.capped, true);
    } finally {
      settings.api.jellyfinMaxCatalogItems = old;
    }
  });

  it('keeps buffered items reachable when the upstream page crosses the cap', async () => {
    const { svc, catalog } = catalogService(1200, 1200);
    const page = await svc.getCatalogPage(catalog, { startIndex: 0, limit: 1 });
    assert.equal(page.items.length, 1);
    assert.equal(page.hasMore, true);
    assert.equal(page.capped, false);
  });

  it('resumes a request budget without treating it as a catalog cap', async () => {
    const { svc, catalog, getCatalog, data } = catalogService(100, 1);
    const first = await svc.getCatalogPage(catalog, {
      startIndex: 0,
      limit: 100,
      maxPages: 3,
    });
    assert.equal(first.items.length, 3);
    assert.equal(first.hasMore, true);
    assert.equal(first.capped, false);
    assert.equal(getCatalog.mock.callCount(), 3);
    const second = await svc.getCatalogPage(catalog, {
      startIndex: 3,
      limit: 3,
      maxPages: 3,
    });
    assert.deepEqual(second.items, data.slice(3, 6));
    assert.equal(getCatalog.mock.callCount(), 6);
    await svc.getCatalogPage(catalog, { startIndex: 0, limit: 3, maxPages: 3 });
    assert.equal(getCatalog.mock.callCount(), 6);
  });

  it('marks the request guard as resumable instead of an exhausted catalog', async () => {
    const { svc, catalog, getCatalog } = catalogService(100, 1);
    const page = await svc.getCatalogPage(catalog, {
      startIndex: 0,
      limit: 100,
    });
    assert.equal(page.items.length, 50);
    assert.equal(getCatalog.mock.callCount(), 50);
    assert.equal(page.capped, false);
    assert.equal(page.hasMore, true);
  });

  it('stops an addon that ignores skip without filling the snapshot with repeats', async () => {
    const { svc, catalog, getCatalog, data } = catalogService(30, 30);
    getCatalog.mock.mockImplementation(async () => ({ data }));
    const page = await svc.getCatalogPage(catalog, {
      startIndex: 0,
      limit: 100,
    });
    assert.deepEqual(page.items, data);
    assert.equal(getCatalog.mock.callCount(), 2);
    assert.equal(page.hasMore, false);
    assert.equal(page.capped, true);
  });
});

function fakeStream(): ParsedStream {
  return {
    id: 's-memo-1',
    url: 'https://torrentio.strem.fun/stream/movie/tt-memo.json',
    originalName: '1080p BluRay',
    originalDescription: 'Some Release',
    addon: { name: 'Bento', formatPassthrough: false },
  } as unknown as ParsedStream;
}

function fakeSubtitle(): Subtitle {
  return {
    id: 'sub-memo-1',
    url: 'https://example.com/sub.srt',
    lang: 'eng',
  } as unknown as Subtitle;
}

describe('JellyfinService.resolveStreams — subtitle-independent scrape memo', () => {
  it('shares one scrape across withSubtitles:false then withSubtitles:true for the same (type, videoId)', async () => {
    const svc = new JellyfinService({} as unknown as UserData);

    const fakeEngine = {
      getStreams: mock.fn(async () => ({
        data: { streams: [fakeStream()] },
        errors: [],
      })),
      getStreamContext: mock.fn(() => null),
      getSubtitles: mock.fn(async () => ({
        data: [fakeSubtitle()],
      })),
    };

    (svc as unknown as { engine: unknown }).engine = fakeEngine;

    const r1 = await svc.resolveStreams('movie', 'tt-memo', false);
    await settle();
    assert.deepEqual(r1.subtitles, []);
    assert.equal(r1.streams.length, 1);

    const r2 = await svc.resolveStreams('movie', 'tt-memo', true);
    await settle();
    assert.equal(r2.subtitles.length, 1);
    assert.equal(r2.streams.length, 1);

    assert.equal(fakeEngine.getStreams.mock.callCount(), 1);
    assert.equal(fakeEngine.getSubtitles.mock.callCount(), 1);
  });
});
