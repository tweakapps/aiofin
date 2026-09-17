import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  JellyfinItemDescriptor,
  JellyfinPlaystateRow,
  MetaPreview,
  ParsedMeta,
  CatalogPageOptions,
} from '@aiostreams/core';
import type { JellyfinRequestContext } from './context.js';

const mocks = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SECRET_KEY ??= '0'.repeat(64);
  process.env.BASE_URL = 'http://localhost:3000';
  process.env.LOG_LEVEL = 'error';
  return {
    context: {} as JellyfinRequestContext,
    getPlaystates: vi.fn(),
    listForSeries: vi.fn(),
    listRecentEpisodesBySeries: vi.fn(),
    listFavorites: vi.fn(),
    getCatalogPage: vi.fn(),
    search: vi.fn(),
  };
});

vi.mock('../../../../core/src/jellyfin/ids.js', async () => {
  const codec = await import('../../../../core/src/jellyfin/ids-codec.js');
  const descriptors = new Map<string, JellyfinItemDescriptor>();
  return {
    ...codec,
    encodeJellyfinId: (d: JellyfinItemDescriptor) => {
      const id = codec.packJellyfinId(d) ?? codec.hashJellyfinId(d);
      descriptors.set(id, d);
      return id;
    },
    decodeJellyfinId: async (id: string) =>
      descriptors.get(id) ?? codec.unpackJellyfinId(id),
  };
});
vi.mock('../../../../core/src/jellyfin/images.js', () => ({
  rememberImages: vi.fn(),
  recallImages: vi.fn(),
}));
vi.mock('../../../../core/src/debrid/utils.js', () => ({
  withPlaybackDisplaySegment: vi.fn(),
}));
vi.mock('@aiostreams/core', async () => ({
  ...(await import('../../../../core/src/jellyfin/dto.js')),
  ...(await import('../../../../core/src/jellyfin/ids.js')),
  ...(await import('../../../../core/src/utils/concurrency.js')),
  config: {
    bootstrap: {},
    api: { jellyfinMaxCatalogItems: 1000, jellyfinLookupConcurrency: 8 },
  },
  createLogger: () => ({ error: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
  encryptString: vi.fn(),
  recallImages: vi.fn(),
  JellyfinRepository: {
    getPlaystates: mocks.getPlaystates,
    listForSeries: mocks.listForSeries,
    listRecentEpisodesBySeries: mocks.listRecentEpisodesBySeries,
    listFavorites: mocks.listFavorites,
  },
}));

import * as core from '@aiostreams/core';
import { config, encodeJellyfinId } from '@aiostreams/core';
import router from './library.js';
import type { ItemList } from './items.js';

const api = config.api as { jellyfinMaxCatalogItems: number };

type Catalog = {
  id: string;
  type: string;
  name: string;
  extra: { name: string; isRequired?: boolean }[];
};
const catalogs: Catalog[] = [];
const fixtures = new Map<string, MetaPreview[]>();
const metadata = new Map<string, ParsedMeta>();
const states = new Map<string, JellyfinPlaystateRow>();
let server: Server;
let baseUrl: string;
let previousCap: number;

function catalog(id: string, names: string[], type = 'movie') {
  const c = {
    id,
    type,
    name: id,
    extra: [{ name: 'skip' }, { name: 'search' }],
  };
  catalogs.push(c);
  fixtures.set(
    id,
    names.map(
      (name, i) =>
        ({
          id: `tt${10000 + catalogs.length * 1000 + i}`,
          type,
          name,
        }) as MetaPreview
    )
  );
  return encodeJellyfinId({ k: 'view', t: type, c: id });
}

function series(id: string) {
  const meta = {
    id,
    type: 'series',
    name: id,
    videos: [
      { id: `${id}:0:1`, season: 0, episode: 1, title: 'Special' },
      ...[1, 2, 3, 4].map((e) => ({
        id: `${id}:1:${e}`,
        season: 1,
        episode: e,
        title: `Episode ${e}`,
        released: e === 3 ? '2999-01-01' : '2020-01-01',
      })),
    ],
  } as ParsedMeta;
  metadata.set(id, meta);
  return encodeJellyfinId({ k: 'series', t: 'series', i: id });
}

function episodeState(
  id: string,
  episode: number,
  played: boolean,
  positionTicks = 0
) {
  const payload: JellyfinItemDescriptor = {
    k: 'episode',
    t: 'series',
    i: id,
    s: 1,
    e: episode,
    v: `${id}:1:${episode}`,
  };
  const row = {
    itemId: encodeJellyfinId(payload),
    payload,
    played,
    positionTicks,
    runtimeTicks: 100000,
    playCount: Number(played),
    favorite: false,
    updatedAt: 10 - episode,
    lastPlayedAt: null,
  };
  states.set(row.itemId, row);
  return row;
}

async function request(
  path: string,
  query: Record<string, string | number | boolean | undefined> = {}
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return fetch(`${baseUrl}${path}?${params}`);
}

async function get(
  path: string,
  query: Record<string, string | number | boolean | undefined> = {}
): Promise<ItemList> {
  const response = await request(path, query);
  expect(response.status).toBe(200);
  return (await response.json()) as ItemList;
}

beforeEach(async () => {
  vi.clearAllMocks();
  catalogs.length = 0;
  fixtures.clear();
  metadata.clear();
  states.clear();
  previousCap = api.jellyfinMaxCatalogItems;
  api.jellyfinMaxCatalogItems = 1000;
  mocks.getPlaystates.mockImplementation(
    async (_uuid: string, ids: string[]) =>
      new Map(
        ids.filter((id) => states.has(id)).map((id) => [id, states.get(id)!])
      )
  );
  mocks.listForSeries.mockImplementation(
    async (_uuid: string, _type: string, id: string) =>
      [...states.values()].filter((r) => 'i' in r.payload && r.payload.i === id)
  );
  mocks.listRecentEpisodesBySeries.mockImplementation(
    async (_uuid: string, limit: number) => {
      const seen = new Set<string>();
      return [...states.values()]
        .filter((r) => r.played || r.positionTicks > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .filter((r) => {
          const id = 'i' in r.payload ? r.payload.i : '';
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        .slice(0, limit);
    }
  );
  mocks.getCatalogPage.mockImplementation(
    async (c: Catalog, opts: CatalogPageOptions) => {
      const all = fixtures.get(c.id) ?? [];
      const end = Math.min(
        opts.startIndex + opts.limit,
        api.jellyfinMaxCatalogItems || Infinity
      );
      return {
        items: all.slice(opts.startIndex, end),
        hasMore: end < all.length,
        capped: false,
      };
    }
  );
  mocks.search.mockImplementation(
    async (_term: string, types: string[] | undefined, limit: number) =>
      [...fixtures.values()]
        .flat()
        .filter((p) => !types || types.includes(p.type))
        .slice(0, limit)
  );
  mocks.context = {
    uuid: 'library-test',
    serverId: 'server',
    build: { uuid: 'library-test', serverId: 'server' },
    service: {
      getCatalogs: async () => catalogs,
      findCatalog: async (type: string, id: string) =>
        catalogs.find((c) => c.type === type && c.id === id),
      getCatalogPage: mocks.getCatalogPage,
      search: mocks.search,
      getMetaLoose: async (_type: string, id: string) =>
        metadata.get(id) ??
        [...fixtures.values()].flat().find((p) => p.id === id),
      isKnownEmpty: () => false,
    },
  } as unknown as JellyfinRequestContext;
  const app = express();
  app.use(
    '/jellyfin',
    (req, _res, next) => {
      req.jf = mocks.context;
      next();
    },
    router
  );
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jellyfin`;
});

afterEach(async () => {
  api.jellyfinMaxCatalogItems = previousCap;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

describe('mounted NextUp with real metadata and DTOs', () => {
  it.each([true, false])(
    'skips an already watched immediate successor, scoped=%s',
    async (scoped) => {
      const id = series('tt100');
      episodeState('tt100', 1, true);
      episodeState('tt100', 2, true);
      const body = await get('/Shows/NextUp', scoped ? { SeriesId: id } : {});
      expect(body.Items.map((i) => i.IndexNumber)).toEqual([4]);
    }
  );

  it.each([true, false])(
    'excludes all resumable candidates when disabled, scoped=%s',
    async (scoped) => {
      const id = series('tt101');
      episodeState('tt101', 1, false, 50);
      episodeState('tt101', 2, false, 25);
      const body = await get('/Shows/NextUp', {
        EnableResumable: false,
        ...(scoped ? { SeriesId: id } : {}),
      });
      expect(body.Items.map((i) => i.IndexNumber)).toEqual([4]);
    }
  );

  it('keeps resumable episodes enabled by default', async () => {
    const id = series('tt102');
    episodeState('tt102', 1, false, 50);
    const body = await get('/Shows/NextUp', { SeriesId: id });
    expect(body.Items[0].IndexNumber).toBe(1);
    expect(body.Items[0].UserData).toMatchObject({ PlaybackPositionTicks: 50 });
  });

  it('applies StartIndex to a scoped result', async () => {
    const id = series('tt103');
    const body = await get('/Shows/NextUp', { SeriesId: id, StartIndex: 1 });
    expect(body).toMatchObject({
      Items: [],
      TotalRecordCount: 1,
      StartIndex: 1,
    });
  });

  it('pages eligible series after completed series without truncating candidates', async () => {
    for (let n = 0; n < 6; n++) {
      const id = `tt${200 + n}`;
      series(id);
      episodeState(id, 1, true);
      if (n < 3) {
        episodeState(id, 2, true);
        episodeState(id, 4, true);
      }
    }
    const body = await get('/Shows/NextUp', { StartIndex: 1, Limit: 1 });
    expect(body).toMatchObject({ TotalRecordCount: 3, StartIndex: 1 });
    expect(body.Items[0].SeriesName).toBe('tt204');
  });

  it('evaluates the scoped history, reuses metadata, and reads watched state immediately', async () => {
    for (let n = 0; n < 40; n++) {
      series(`budget-${n}`);
      episodeState(`budget-${n}`, 1, true);
    }
    const meta = vi.spyOn(mocks.context.service, 'getMetaLoose');
    const first = await get('/Shows/NextUp', { Limit: 1 });
    expect(meta).toHaveBeenCalledTimes(40);
    expect(first.TotalRecordCount).toBe(40);
    expect(Object.keys(first).sort()).toEqual([
      'Items',
      'StartIndex',
      'TotalRecordCount',
    ]);
    meta.mockClear();
    expect((await get('/Shows/NextUp', { Limit: 1 })).Items).toEqual(
      first.Items
    );
    expect(meta).not.toHaveBeenCalled();
    episodeState('budget-0', 2, true);
    const updated = await get('/Shows/NextUp', { Limit: 1 });
    expect(updated.Items[0].IndexNumber).toBe(4);
    expect(meta).not.toHaveBeenCalled();
    const adjacent = await get('/Shows/NextUp', { StartIndex: 16, Limit: 1 });
    expect(adjacent.Items[0].SeriesName).toBe('budget-16');
    expect(meta).not.toHaveBeenCalled();
  });

  it('finds the seventeenth series after sixteen completed series', async () => {
    for (let n = 0; n < 17; n++) {
      series(`eligible-${n}`);
      episodeState(`eligible-${n}`, 1, true);
      if (n < 16) {
        episodeState(`eligible-${n}`, 2, true);
        episodeState(`eligible-${n}`, 4, true);
      }
    }
    const body = await get('/Shows/NextUp', { Limit: 1 });
    expect(body.TotalRecordCount).toBe(1);
    expect(body.Items.map((item) => item.SeriesName)).toEqual(['eligible-16']);
  });

  it.each([
    [30, 5],
    [0, 40],
    [40, 1],
  ])(
    'counts every eligible series on a cold offset %s, limit %s',
    async (StartIndex, Limit) => {
      for (let n = 0; n < 40; n++) {
        series(`cold-${n}`);
        episodeState(`cold-${n}`, 1, true);
      }
      const build = vi.spyOn(core, 'buildEpisodeItem');
      try {
        const body = await get('/Shows/NextUp', { StartIndex, Limit });
        expect(body.TotalRecordCount).toBe(40);
        expect(body.Items.map((item) => item.SeriesName)).toEqual(
          Array.from({ length: 40 }, (_, n) => `cold-${n}`).slice(
            StartIndex,
            StartIndex + Limit
          )
        );
        expect(build).toHaveBeenCalledTimes(body.Items.length);
      } finally {
        build.mockRestore();
      }
    }
  );

  it('bounds cold candidate fanout to the 500 history scope with bounded concurrency', async () => {
    for (let n = 0; n < 510; n++) {
      series(`history-${n}`);
      episodeState(`history-${n}`, 1, true);
    }
    let active = 0;
    let peak = 0;
    const meta = vi
      .spyOn(mocks.context.service, 'getMetaLoose')
      .mockImplementation(async (_type, id) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return metadata.get(id)!;
      });
    const body = await get('/Shows/NextUp', { StartIndex: 499, Limit: 1 });
    expect(body.TotalRecordCount).toBe(500);
    expect(body.Items[0].SeriesName).toBe('history-499');
    expect(mocks.listRecentEpisodesBySeries).toHaveBeenCalledWith(
      'library-test',
      500
    );
    expect(meta).toHaveBeenCalledTimes(500);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    await get('/Shows/NextUp', { Limit: 1 });
    expect(meta).toHaveBeenCalledTimes(500);
  });

  it('does not wrap to earlier episodes after a completed finale', async () => {
    const id = series('tt104');
    episodeState('tt104', 4, true);
    expect((await get('/Shows/NextUp', { SeriesId: id })).Items).toEqual([]);
  });
});

describe('mounted bounded library browsing', () => {
  it('applies a recursive offset once across catalogs and preserves totals', async () => {
    catalog('first', ['A', 'B']);
    catalog('second', ['C', 'D', 'E']);
    const body = await get('/Items', {
      Recursive: true,
      StartIndex: 2,
      Limit: 2,
    });
    expect(body.Items.map((i: { Name: string }) => i.Name)).toEqual(['C', 'D']);
    expect(body).toMatchObject({ TotalRecordCount: 5, StartIndex: 2 });
  });

  it.each(['/Items', '/Users/user/Items'])(
    'slices filtered output rather than raw offsets at %s',
    async (path) => {
      const parent = catalog('filtered', ['A', 'B', 'C', 'D', 'E', 'F']);
      for (const preview of fixtures
        .get('filtered')!
        .filter((_, i) => i % 2 === 0)) {
        const payload: JellyfinItemDescriptor = {
          k: 'movie',
          t: 'movie',
          i: preview.id,
        };
        const itemId = encodeJellyfinId(payload);
        states.set(itemId, {
          itemId,
          payload,
          played: true,
          positionTicks: 0,
          runtimeTicks: 0,
          favorite: false,
          playCount: 1,
          updatedAt: 0,
          lastPlayedAt: null,
        });
      }
      const pages = await Promise.all(
        [0, 1, 2, 3].map((StartIndex) =>
          get(path, { ParentId: parent, IsPlayed: false, StartIndex, Limit: 1 })
        )
      );
      expect(
        pages.map((p) => p.Items.map((i: { Name: string }) => i.Name))
      ).toEqual([['B'], ['D'], ['F'], []]);
      expect(pages.map((p) => p.TotalRecordCount)).toEqual([3, 3, 3, 3]);
    }
  );

  it.each(['view', 'recursive', 'search'])(
    'sorts the entire bounded %s snapshot before slicing',
    async (mode) => {
      const parent = catalog('sorted', ['Zulu', 'Alpha', 'Mike', 'Bravo']);
      const scope =
        mode === 'view'
          ? { ParentId: parent }
          : mode === 'search'
            ? { SearchTerm: 'match' }
            : { Recursive: true };
      const pages = await Promise.all(
        [0, 1].map((StartIndex) =>
          get('/Items', { ...scope, SortBy: 'SortName', StartIndex, Limit: 1 })
        )
      );
      expect(pages.map((p) => p.Items[0].Name)).toEqual(['Alpha', 'Bravo']);
      expect(pages.map((p) => p.TotalRecordCount)).toEqual([4, 4]);
    }
  );

  it('does not report the first search page as the full result count', async () => {
    catalog('search', ['A', 'B', 'C', 'D']);
    const body = await get('/Items', { SearchTerm: 'match', Limit: 1 });
    expect(body.TotalRecordCount).toBe(4);
  });

  it('deduplicates recursive catalog overlaps before slicing', async () => {
    catalog('first', ['A', 'B']);
    catalog('second', ['C']);
    fixtures.get('second')!.unshift(fixtures.get('first')![1]);
    const body = await get('/Items', {
      Recursive: true,
      StartIndex: 1,
      Limit: 3,
    });
    expect(body.Items.map((i: { Name: string }) => i.Name)).toEqual(['B', 'C']);
    expect(body.TotalRecordCount).toBe(3);
  });

  it.each([0, 2000])(
    'keeps items beyond 1000 reachable with cap %s',
    async (cap) => {
      api.jellyfinMaxCatalogItems = cap;
      const parent = catalog(
        'infinite',
        Array.from({ length: 1200 }, (_, i) => `Movie ${i}`)
      );
      const first = await get('/Items', { ParentId: parent, Limit: 1 });
      const end = await get('/Items', {
        ParentId: parent,
        StartIndex: 1000,
        Limit: 1,
      });
      expect(first.TotalRecordCount).toBeGreaterThan(1);
      expect(mocks.getCatalogPage).toHaveBeenCalledTimes(4);
      expect(end.Items[0].Name).toBe('Movie 1000');
      expect(end.TotalRecordCount).toBeGreaterThan(1001);
      expect(
        mocks.getCatalogPage.mock.calls.every(([, opts]) => opts.maxPages === 1)
      ).toBe(true);
    }
  );

  it.each(['search', 'recursive'])(
    'filters unplayed %s results before slicing',
    async (mode) => {
      catalog('filtered-global', ['A', 'B', 'C']);
      const preview = fixtures.get('filtered-global')![0];
      const payload: JellyfinItemDescriptor = {
        k: 'movie',
        t: 'movie',
        i: preview.id,
      };
      const itemId = encodeJellyfinId(payload);
      states.set(itemId, {
        itemId,
        payload,
        played: true,
        positionTicks: 0,
        runtimeTicks: 0,
        favorite: false,
        playCount: 1,
        updatedAt: 0,
        lastPlayedAt: null,
      });
      const scope =
        mode === 'search' ? { SearchTerm: 'match' } : { Recursive: true };
      const body = await get('/Items', { ...scope, IsPlayed: false, Limit: 1 });
      expect(body.Items.map((i: { Name: string }) => i.Name)).toEqual(['B']);
      expect(body.TotalRecordCount).toBe(2);
    }
  );

  it('keeps favorite filtering inside the selected catalog', async () => {
    const parent = catalog('favorite-scope', ['A', 'B']);
    const preview = fixtures.get('favorite-scope')![1];
    const payload: JellyfinItemDescriptor = {
      k: 'movie',
      t: 'movie',
      i: preview.id,
    };
    const itemId = encodeJellyfinId(payload);
    states.set(itemId, {
      itemId,
      payload,
      played: false,
      positionTicks: 0,
      runtimeTicks: 0,
      favorite: true,
      playCount: 0,
      updatedAt: 0,
      lastPlayedAt: null,
    });
    mocks.listFavorites.mockResolvedValue([]);
    const body = await get('/Items', { ParentId: parent, IsFavorite: true });
    expect(body.Items.map((i: { Name: string }) => i.Name)).toEqual(['B']);
    expect(mocks.listFavorites).not.toHaveBeenCalled();
  });

  it('keeps stable warm pages and parent order with slow and failed catalogs', async () => {
    const parent = catalog('slow', ['A', 'B']);
    catalog('failed', []);
    const second = catalog('fast', ['C']);
    fixtures.get('fast')!.unshift(fixtures.get('slow')![1]);
    const original = mocks.getCatalogPage.getMockImplementation()!;
    let active = 0;
    let peak = 0;
    mocks.getCatalogPage.mockImplementation(
      async (c: Catalog, opts: CatalogPageOptions) => {
        active++;
        peak = Math.max(peak, active);
        try {
          if (c.id === 'failed') throw new Error('provider unavailable');
          if (c.id === 'slow')
            await new Promise((resolve) => setTimeout(resolve, 15));
          return await original(c, opts);
        } finally {
          active--;
        }
      }
    );
    const first = await get('/Items', { Recursive: true, Limit: 1 });
    const secondPage = await get('/Items', {
      Recursive: true,
      StartIndex: 1,
      Limit: 2,
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(mocks.getCatalogPage).toHaveBeenCalledTimes(3);
    expect(first.Items[0].ParentId).toBe(parent);
    expect(secondPage.Items.map((item) => item.ParentId)).toEqual([
      parent,
      second,
    ]);
    expect(secondPage.Items.map((item) => item.Name)).toEqual(['B', 'C']);
    expect(secondPage).toMatchObject({ TotalRecordCount: 3 });
    expect(
      mocks.getPlaystates.mock.calls.every(([, ids]) => ids.length <= 2)
    ).toBe(true);
  });

  it('continues beyond a cold request budget without dropping catalogs', async () => {
    for (let n = 0; n < 60; n++) catalog(`empty-${n}`, []);
    catalog('last', ['Reachable']);
    const body = await get('/Items', { Recursive: true });
    expect(body.Items[0].Name).toBe('Reachable');
    expect(body.TotalRecordCount).toBe(1);
    expect(mocks.getCatalogPage).toHaveBeenCalledTimes(61);
    await get('/Items', { Recursive: true });
    expect(mocks.getCatalogPage).toHaveBeenCalledTimes(61);
  });

  it.each(['/Items', '/Users/user/Items'])(
    'stops at the unsorted target and continues at the materialized boundary through %s',
    async (path) => {
      api.jellyfinMaxCatalogItems = 0;
      const ParentId = catalog(
        'prefix',
        Array.from({ length: 6000 }, (_, n) => `Movie ${n}`)
      );
      const first = await get(path, { ParentId, Limit: 256 });
      expect(first.Items).toHaveLength(256);
      expect(first.TotalRecordCount).toBeGreaterThan(256);
      expect(mocks.getCatalogPage).toHaveBeenCalledTimes(1);
      expect(Object.keys(first).sort()).toEqual([
        'Items',
        'StartIndex',
        'TotalRecordCount',
      ]);
      const second = await get(path, { ParentId, StartIndex: 256, Limit: 256 });
      expect(second.Items[0].Name).toBe('Movie 256');
      expect(second.Items).toHaveLength(256);
      expect(second.TotalRecordCount).toBeGreaterThan(512);
      expect(mocks.getCatalogPage).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['view', 'recursive', 'search'])(
    'serves a best-effort sorted %s snapshot when the budget is exhausted',
    async (mode) => {
      api.jellyfinMaxCatalogItems = 0;
      const ParentId = catalog(
        'large-sorted',
        Array.from({ length: 4300 }, (_, n) =>
          String(4300 - n).padStart(4, '0')
        )
      );
      const scope =
        mode === 'view'
          ? { ParentId }
          : mode === 'search'
            ? { SearchTerm: 'match' }
            : { Recursive: true };
      const query = { ...scope, SortBy: 'SortName', Limit: 1 };
      const body = await get('/Items', query);
      expect(body.Items).toHaveLength(1);
      expect(body.TotalRecordCount).toBeGreaterThan(1);
      const afterFirst = mocks.getCatalogPage.mock.calls.length;
      const page = await get('/Items', {
        ...scope,
        SortBy: 'SortName',
        Limit: 50,
      });
      expect(page.Items).toHaveLength(50);
      const names = page.Items.map((item) => item.Name);
      expect([...names].sort()).toEqual(names);
      expect(mocks.getCatalogPage.mock.calls.length).toBeGreaterThan(
        afterFirst
      );
      const warmed = await get('/Items', query);
      expect(mocks.getCatalogPage.mock.calls.length).toBeGreaterThan(
        afterFirst
      );
      expect(warmed.Items[0].Name).toBe(page.Items[0].Name);
    }
  );

  it('serves the materialized boundary for a cold deep offset', async () => {
    api.jellyfinMaxCatalogItems = 0;
    const ParentId = catalog(
      'deep',
      Array.from({ length: 6000 }, (_, n) => `Movie ${n}`)
    );
    const query = { ParentId, StartIndex: 4500, Limit: 10 };
    const body = await get('/Items', query);
    expect(body.Items).toHaveLength(10);
    expect(body.Items[0].Name).toBe('Movie 4500');
    expect(body.TotalRecordCount).toBeGreaterThan(4510);
    expect(mocks.getCatalogPage).toHaveBeenCalledTimes(Math.ceil(4510 / 256));
  });

  it('fills a page across a partial prefix before advertising continuation', async () => {
    api.jellyfinMaxCatalogItems = 0;
    const ParentId = catalog(
      'cross-page',
      Array.from({ length: 5000 }, (_, n) => `Movie ${n}`)
    );
    const body = await get('/Items', { ParentId, StartIndex: 250, Limit: 20 });
    expect(body.Items).toHaveLength(20);
    expect(body.Items[19].Name).toBe('Movie 269');
    expect(body.TotalRecordCount).toBeGreaterThan(270);
    expect(mocks.getCatalogPage).toHaveBeenCalledTimes(2);
  });

  it('bounds recursive catalog fanout', async () => {
    for (let n = 0; n < 60; n++) catalog(`empty-${n}`, []);
    const body = await get('/Items', { Recursive: true });
    expect(body.Items).toEqual([]);
    expect(body.TotalRecordCount).toBe(0);
    expect(mocks.getCatalogPage).toHaveBeenCalledTimes(60);
  });
});
