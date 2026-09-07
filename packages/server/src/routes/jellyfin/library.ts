import { Router, type Request } from 'express';
import {
  collectConcurrent,
  config as appConfig,
  createLogger,
  encryptString,
} from '@aiostreams/core';
import {
  buildGenreItem,
  buildMetaItem,
  buildViewItem,
  decodeJellyfinId,
  encodeJellyfinId,
  JellyfinRepository,
  stripInternal,
  collectionTypeFor,
  type JellyfinItem,
  type JellyfinItemDescriptor,
  type MetaPreview,
} from '@aiostreams/core';
import {
  jf,
  qb,
  qi,
  qlist,
  qs,
  type JellyfinRequestContext,
  param,
} from './context.js';
import {
  attachUserData,
  episodesForSeries,
  itemFromDescriptor,
  itemFromId,
  itemsFromPreviews,
  list,
  nextUpForSeries,
  seasonsForSeries,
  viewItems,
} from './items.js';

const logger = createLogger('jellyfin');
const router: Router = Router({ mergeParams: true });

const MAX_MEDIA_SOURCES = 50;

function lookup<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R[]>,
  opts: { target?: number; what: string }
): Promise<R[]> {
  return collectConcurrent(items, fn, {
    concurrency: appConfig.api.jellyfinLookupConcurrency,
    target: opts.target,
    onError: (error) =>
      logger.debug(
        { err: error instanceof Error ? error.message : String(error) },
        `skipping unresolvable ${opts.what}`
      ),
  });
}

function encryptToken(plain: string): string {
  const r = encryptString(plain);
  if (!r.success || !r.data) throw new Error('encryption failed');
  return r.data;
}

async function views(ctx: JellyfinRequestContext) {
  const items = await viewItems(ctx);
  return list(items, items.length);
}

router.get(
  ['/Users/:userId/Views', '/UserViews'],
  jf(async (_req, res, ctx) => {
    res.json(await views(ctx));
  })
);
router.get(
  ['/Users/:userId/GroupingOptions', '/UserViews/GroupingOptions'],
  jf(async (_req, res, ctx) => {
    const items = await viewItems(ctx);
    res.json(items.map((i) => ({ Name: i.Name, Id: i.Id })));
  })
);
router.get(
  ['/Library/VirtualFolders', '/Library/MediaFolders'],
  jf(async (req, res, ctx) => {
    const items = await viewItems(ctx);
    if (/MediaFolders/i.test(req.path)) {
      res.json(list(items, items.length));
      return;
    }
    res.json(
      items.map((i) => ({
        Name: i.Name,
        Locations: [i.Path],
        CollectionType: i.CollectionType ?? null,
        LibraryOptions: {
          Enabled: true,
          EnableRealtimeMonitor: false,
          PathInfos: [],
        },
        ItemId: i.Id,
        PrimaryImageItemId: i.Id,
        RefreshStatus: 'Idle',
      }))
    );
  })
);

type ItemTypeFilter = Set<string> | null;

function includeTypes(req: Request): ItemTypeFilter {
  const types = qlist(req, 'IncludeItemTypes');
  return types.length ? new Set(types.map((t) => t.toLowerCase())) : null;
}

function filterByType(
  items: JellyfinItem[],
  types: ItemTypeFilter
): JellyfinItem[] {
  if (!types) return items;
  return items.filter((i) => types.has(String(i.Type).toLowerCase()));
}

function stremioTypesFor(types: ItemTypeFilter): string[] | undefined {
  if (!types) return undefined;
  const out = new Set<string>();
  if (types.has('movie')) out.add('movie');
  if (types.has('series') || types.has('episode') || types.has('season')) {
    out.add('series');
    out.add('anime');
  }
  return out.size ? [...out] : undefined;
}

function applyUserFilters(req: Request, items: JellyfinItem[]): JellyfinItem[] {
  const filters = qlist(req, 'Filters').map((f) => f.toLowerCase());
  const isPlayed = qb(req, 'IsPlayed');
  const isFavorite = qb(req, 'IsFavorite');
  let out = items;
  const ud = (i: JellyfinItem) =>
    i.UserData as {
      Played: boolean;
      IsFavorite: boolean;
      PlaybackPositionTicks: number;
    };
  if (filters.includes('isplayed') || isPlayed === true)
    out = out.filter((i) => ud(i).Played);
  if (filters.includes('isunplayed') || isPlayed === false)
    out = out.filter((i) => !ud(i).Played);
  if (filters.includes('isfavorite') || isFavorite === true)
    out = out.filter((i) => ud(i).IsFavorite);
  if (filters.includes('isresumable'))
    out = out.filter((i) => ud(i).PlaybackPositionTicks > 0);
  return out;
}

function applySort(req: Request, items: JellyfinItem[]): JellyfinItem[] {
  const sortBy = qlist(req, 'SortBy').map((s) => s.toLowerCase());
  const desc = (qs(req, 'SortOrder') ?? '').toLowerCase() === 'descending';
  if (!sortBy.length || sortBy[0] === 'default') return items;
  const key = sortBy[0];
  const val = (i: JellyfinItem): number | string => {
    switch (key) {
      case 'sortname':
      case 'name':
        return String(i.SortName ?? i.Name ?? '').toLowerCase();
      case 'productionyear':
      case 'premieredate':
        return Number(i.ProductionYear ?? 0);
      case 'communityrating':
        return Number(i.CommunityRating ?? 0);
      case 'runtime':
        return Number(i.RunTimeTicks ?? 0);
      case 'random':
        return Math.random();
      case 'datecreated':
      case 'dateplayed':
      case 'dateadded':
      default:
        return 0;
    }
  };
  if (
    ['datecreated', 'dateplayed', 'dateadded', 'datelastcontentadded'].includes(
      key
    )
  )
    return items;
  const sorted = [...items].sort((a, b) => {
    const av = val(a);
    const bv = val(b);
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  });
  return desc ? sorted.reverse() : sorted;
}

async function itemsFromPlaystates(
  ctx: JellyfinRequestContext,
  rows: Awaited<ReturnType<typeof JellyfinRepository.listFavorites>>,
  limit: number
): Promise<JellyfinItem[]> {
  return lookup(
    rows.slice(0, limit),
    async (row) => {
      const item = await itemFromDescriptor(ctx, row.payload, {
        playstate: row,
      });
      return item ? [item] : [];
    },
    { what: 'item' }
  );
}

async function handleItemsQuery(req: Request, ctx: JellyfinRequestContext) {
  const startIndex = Math.max(0, qi(req, 'StartIndex', 0));
  const limit = Math.min(Math.max(1, qi(req, 'Limit', 100)), 500);
  const parentId = qs(req, 'ParentId');
  const ids = qlist(req, 'Ids');
  const searchTerm = qs(req, 'SearchTerm')?.trim();
  const types = includeTypes(req);
  const genres = qlist(req, 'Genres');
  const genreIds = qlist(req, 'GenreIds');
  const filters = qlist(req, 'Filters').map((f) => f.toLowerCase());
  const wantsFavorites =
    filters.includes('isfavorite') || qb(req, 'IsFavorite') === true;
  const wantsPlayed =
    filters.includes('isplayed') || qb(req, 'IsPlayed') === true;
  const wantsResumable = filters.includes('isresumable');
  const recursive = qb(req, 'Recursive') ?? false;
  const personIds = qlist(req, 'PersonIds');

  if (ids.length) {
    const items = await lookup(
      ids.slice(0, 200),
      async (id) => {
        const r = await itemFromId(ctx, id);
        return r ? [r.item] : [];
      },
      { what: 'id' }
    );
    return list(filterByType(items, types), items.length, 0);
  }

  let parent: JellyfinItemDescriptor | null = null;
  if (parentId) parent = await decodeJellyfinId(parentId);

  if (parent?.k === 'series') {
    if (types?.has('episode') || recursive) {
      const r = await episodesForSeries(ctx, parent);
      const eps = applyUserFilters(req, r?.episodes ?? []);
      return list(
        filterByType(eps, types ?? new Set(['episode'])).slice(
          startIndex,
          startIndex + limit
        ),
        eps.length,
        startIndex
      );
    }
    const r = await seasonsForSeries(ctx, parent);
    const seasons = r?.seasons ?? [];
    return list(
      seasons.slice(startIndex, startIndex + limit),
      seasons.length,
      startIndex
    );
  }
  if (parent?.k === 'season') {
    const r = await episodesForSeries(ctx, parent, parent.s);
    const eps = applyUserFilters(req, r?.episodes ?? []);
    return list(
      eps.slice(startIndex, startIndex + limit),
      eps.length,
      startIndex
    );
  }
  if (parent?.k === 'person' || personIds.length) {
    const name = parent?.k === 'person' ? parent.n : null;
    const previews = name
      ? await ctx.service.search(name, stremioTypesFor(types), limit)
      : [];
    const items = await itemsFromPreviews(ctx, previews);
    return list(filterByType(items, types), items.length, 0);
  }

  if (wantsFavorites || wantsPlayed || wantsResumable) {
    const kinds = types
      ? [...types].map((t) =>
          t === 'movie'
            ? 'movie'
            : t === 'episode'
              ? 'episode'
              : t === 'series'
                ? 'series'
                : t
        )
      : undefined;
    const rows = wantsFavorites
      ? await JellyfinRepository.listFavorites(ctx.uuid, kinds)
      : wantsResumable
        ? await JellyfinRepository.listResume(ctx.uuid, limit + startIndex)
        : await JellyfinRepository.listPlayed(ctx.uuid, kinds);
    const items = await itemsFromPlaystates(ctx, rows, startIndex + limit);
    const page = applySort(req, filterByType(items, types)).slice(
      startIndex,
      startIndex + limit
    );
    return list(page, items.length, startIndex);
  }

  const genreFromIds = genreIds.length
    ? await decodeJellyfinId(genreIds[0])
    : null;
  const genre =
    genres[0] ?? (genreFromIds?.k === 'genre' ? genreFromIds.g : undefined);

  let catalogDesc: { t: string; c: string } | null = null;
  if (parent?.k === 'view') catalogDesc = parent;
  else if (parent?.k === 'genre') catalogDesc = parent;
  else if (genreFromIds?.k === 'genre' && genreFromIds.c)
    catalogDesc = genreFromIds;

  if (catalogDesc) {
    const catalog = await ctx.service.findCatalog(catalogDesc.t, catalogDesc.c);
    if (!catalog) return list([], 0, startIndex);
    const g = parent?.k === 'genre' ? parent.g : genre;
    const page = await ctx.service.getCatalogPage(catalog, {
      startIndex,
      limit,
      search: searchTerm,
      genre: g,
    });
    const items = await itemsFromPreviews(ctx, page.items, parentId);
    const filtered = applySort(
      req,
      applyUserFilters(req, filterByType(items, types))
    );
    const total = page.hasMore
      ? startIndex + filtered.length + limit
      : startIndex + filtered.length;
    return list(filtered, total, startIndex);
  }

  if (searchTerm) {
    const previews = await ctx.service.search(
      searchTerm,
      stremioTypesFor(types),
      startIndex + limit
    );
    const items = await itemsFromPreviews(ctx, previews);
    const filtered = filterByType(items, types);
    return list(
      filtered.slice(startIndex, startIndex + limit),
      filtered.length,
      startIndex
    );
  }

  if (!parentId && !recursive) {
    return views(ctx);
  }

  if (!parentId && recursive) {
    const catalogs = await ctx.service.getCatalogs();
    const wanted = stremioTypesFor(types);
    const usable = catalogs.filter((c) => !wanted || wanted.includes(c.type));
    const items: JellyfinItem[] = [];
    let offset = 0;
    for (const catalog of usable) {
      if (items.length >= limit) break;
      const page = await ctx.service.getCatalogPage(catalog, {
        startIndex: Math.max(0, startIndex - offset),
        limit: limit - items.length + Math.max(0, offset - startIndex),
      });
      const viewId = encodeJellyfinId({
        k: 'view',
        t: catalog.type,
        c: catalog.id,
      });
      const built = await itemsFromPreviews(ctx, page.items, viewId);
      for (const it of built) {
        if (offset >= startIndex && items.length < limit) items.push(it);
        offset++;
      }
      if (page.hasMore) offset += 1;
      if (page.hasMore && items.length >= limit) {
        return list(
          filterByType(items, types),
          startIndex + items.length + limit,
          startIndex
        );
      }
    }
    return list(
      filterByType(items, types),
      startIndex + items.length,
      startIndex
    );
  }

  return list([], 0, startIndex);
}

router.get(
  ['/Users/:userId/Items', '/Items'],
  jf(async (req, res, ctx) => {
    res.json(await handleItemsQuery(req, ctx));
  })
);

router.get(
  ['/Users/:userId/Items/Latest', '/Items/Latest'],
  jf(async (req, res, ctx) => {
    const limit = Math.min(Math.max(1, qi(req, 'Limit', 16)), 100);
    const parentId = qs(req, 'ParentId');
    const types = includeTypes(req);
    let items: JellyfinItem[] = [];
    if (parentId) {
      const d = await decodeJellyfinId(parentId);
      if (d?.k === 'view') {
        const catalog = await ctx.service.findCatalog(d.t, d.c);
        if (catalog) {
          const page = await ctx.service.getCatalogPage(catalog, {
            startIndex: 0,
            limit,
          });
          items = await itemsFromPreviews(ctx, page.items, parentId);
        }
      }
    } else {
      const catalogs = await ctx.service.getCatalogs();
      const wanted = stremioTypesFor(types);
      const usable = catalogs.filter((c) => !wanted || wanted.includes(c.type));
      const perCatalog = Math.max(
        4,
        Math.ceil(limit / Math.max(1, usable.length))
      );
      items = await lookup(
        usable,
        async (catalog) => {
          const page = await ctx.service.getCatalogPage(catalog, {
            startIndex: 0,
            limit: perCatalog,
          });
          const built = await itemsFromPreviews(
            ctx,
            page.items,
            encodeJellyfinId({ k: 'view', t: catalog.type, c: catalog.id })
          );
          return filterByType(built, types);
        },
        { target: limit, what: 'catalog in Latest' }
      );
    }
    res.json(filterByType(items, types).slice(0, limit).map(stripInternal));
  })
);

router.get(
  ['/Users/:userId/Items/Resume', '/UserItems/Resume'],
  jf(async (req, res, ctx) => {
    const limit = Math.min(Math.max(1, qi(req, 'Limit', 12)), 100);
    const startIndex = Math.max(0, qi(req, 'StartIndex', 0));
    const types = includeTypes(req);
    const mediaTypes = qlist(req, 'MediaTypes').map((m) => m.toLowerCase());
    if (mediaTypes.length && !mediaTypes.includes('video')) {
      res.json(list([], 0, startIndex));
      return;
    }
    const kinds = types
      ? [...types].filter((t) => t === 'movie' || t === 'episode')
      : ['movie', 'episode'];
    const rows = await JellyfinRepository.listResume(
      ctx.uuid,
      startIndex + limit,
      kinds.length ? kinds : ['movie', 'episode']
    );
    const items = await itemsFromPlaystates(ctx, rows, startIndex + limit);
    res.json(
      list(
        items.slice(startIndex, startIndex + limit),
        items.length,
        startIndex
      )
    );
  })
);

router.get(
  '/Shows/NextUp',
  jf(async (req, res, ctx) => {
    const limit = Math.min(Math.max(1, qi(req, 'Limit', 12)), 50);
    const seriesId = qs(req, 'SeriesId');
    const items: JellyfinItem[] = [];
    if (seriesId) {
      const d = await decodeJellyfinId(seriesId);
      if (d && (d.k === 'series' || d.k === 'movie')) {
        const rows = await JellyfinRepository.listForSeries(ctx.uuid, d.t, d.i);
        rows.sort((a, b) => b.updatedAt - a.updatedAt);
        const next = await nextUpForSeries(ctx, d, rows[0]);
        if (next) items.push(next);
      }
    } else {
      const recent = await JellyfinRepository.listRecentEpisodesBySeries(
        ctx.uuid,
        limit * 2
      );
      const candidates = recent.filter(
        (row): row is typeof row & { payload: { t: string; i: string } } =>
          row.payload.k === 'episode'
      );
      const nexts = await lookup(
        candidates,
        async (row) => {
          const next = await nextUpForSeries(
            ctx,
            { t: row.payload.t, i: row.payload.i },
            row
          );
          return next && !(next.UserData as { Played: boolean }).Played
            ? [next]
            : [];
        },
        { target: limit, what: 'series in Next Up' }
      );
      items.push(...nexts.slice(0, limit));
    }
    res.json(list(items, items.length, 0));
  })
);

router.get(
  '/Shows/Upcoming',
  jf(async (_req, res) => {
    res.json(list([], 0, 0));
  })
);

router.get(
  '/Shows/:seriesId/Seasons',
  jf(async (req, res, ctx) => {
    const d = await decodeJellyfinId(param(req, 'seriesId'));
    if (!d || (d.k !== 'series' && d.k !== 'movie')) {
      res.status(404).json({ Message: 'Series not found' });
      return;
    }
    const r = await seasonsForSeries(ctx, d);
    const seasons = r?.seasons ?? [];
    res.json(list(seasons, seasons.length, 0));
  })
);

router.get(
  '/Shows/:seriesId/Episodes',
  jf(async (req, res, ctx) => {
    const d = await decodeJellyfinId(param(req, 'seriesId'));
    if (!d || (d.k !== 'series' && d.k !== 'movie')) {
      res.status(404).json({ Message: 'Series not found' });
      return;
    }
    let season: number | undefined;
    const seasonId = qs(req, 'SeasonId');
    if (seasonId) {
      const sd = await decodeJellyfinId(seasonId);
      if (sd?.k === 'season') season = sd.s;
    }
    const seasonNum = qs(req, 'Season');
    if (season == null && seasonNum != null && seasonNum !== '')
      season = Number(seasonNum);
    const r = await episodesForSeries(ctx, d, season);
    let eps = r?.episodes ?? [];
    const startItemId = qs(req, 'StartItemId');
    if (startItemId) {
      const idx = eps.findIndex((e) => e.Id === startItemId);
      if (idx >= 0) eps = eps.slice(idx);
    }
    const adjacentTo = qs(req, 'AdjacentTo');
    if (adjacentTo) {
      const idx = eps.findIndex((e) => e.Id === adjacentTo);
      if (idx >= 0) eps = eps.slice(Math.max(0, idx - 1), idx + 2);
    }
    const startIndex = Math.max(0, qi(req, 'StartIndex', 0));
    const limit = Math.min(Math.max(1, qi(req, 'Limit', 1000)), 2000);
    res.json(
      list(eps.slice(startIndex, startIndex + limit), eps.length, startIndex)
    );
  })
);

async function sendItem(
  req: Request,
  res: import('express').Response,
  ctx: JellyfinRequestContext,
  id: string
) {
  const r = await itemFromId(ctx, id);
  if (!r) {
    res.status(404).json({ Message: 'Item not found' });
    return;
  }
  const { item, descriptor } = r;
  const wantsSources = qlist(req, 'Fields').some(
    (f) => f.toLowerCase() === 'mediasources'
  );
  const target = !wantsSources
    ? null
    : descriptor.k === 'movie'
      ? {
          type: descriptor.t,
          videoId: await ctx.service.resolveVideoId(descriptor.t, descriptor.i),
        }
      : descriptor.k === 'episode'
        ? { type: descriptor.t, videoId: descriptor.v }
        : null;
  if (target) {
    try {
      const { sources } = await ctx.service.buildMediaSources(
        target.type,
        target.videoId,
        {
          baseUrl: ctx.baseUrl,
          itemId: item.Id,
          apiKey: ctx.apiKey,
          encrypt: encryptToken,
          runtimeTicks: item.RunTimeTicks as number | undefined,
        }
      );
      const capped = sources.slice(0, MAX_MEDIA_SOURCES);
      if (capped.length) {
        capped[0] = { ...capped[0], Id: item.Id, ETag: item.Id };
        item.MediaSources = capped;
        item.MediaStreams = capped[0].MediaStreams;
        item.Container = capped[0].Container;
      } else {
        item.MediaSources = [
          {
            Id: item.Id,
            ETag: item.Id,
            Name: 'No streams found',
            Path: `/aiostreams/${item.Id}`,
            Protocol: 'File',
            Type: 'Default',
            SupportsDirectPlay: true,
            SupportsDirectStream: true,
            SupportsTranscoding: false,
            MediaStreams: [],
            Formats: [],
          },
        ];
      }
    } catch (e) {}
  }
  res.json(stripInternal(item));
}

const RESERVED_ITEM_IDS =
  /^(Filters2?|Counts|Latest|Resume|Intros|Root|Suggestions)$/i;
router.get(
  ['/Users/:userId/Items/:itemId', '/Items/:itemId'],
  (req, _res, next) =>
    RESERVED_ITEM_IDS.test(param(req, 'itemId')) ? next('route') : next(),
  jf(async (req, res, ctx) => {
    await sendItem(req, res, ctx, param(req, 'itemId'));
  })
);

router.get(
  '/Items/:itemId/Ancestors',
  jf(async (req, res, ctx) => {
    const d = await decodeJellyfinId(param(req, 'itemId'));
    const out: JellyfinItem[] = [];
    if (d?.k === 'episode') {
      const season = await itemFromDescriptor(ctx, {
        k: 'season',
        t: d.t,
        i: d.i,
        s: d.s,
      });
      const series = await itemFromDescriptor(ctx, {
        k: 'series',
        t: d.t,
        i: d.i,
      });
      if (season) out.push(season);
      if (series) out.push(series);
    } else if (d?.k === 'season') {
      const series = await itemFromDescriptor(ctx, {
        k: 'series',
        t: d.t,
        i: d.i,
      });
      if (series) out.push(series);
    }
    res.json(out.map(stripInternal));
  })
);

router.get(
  [
    '/Items/:itemId/Similar',
    '/Movies/:itemId/Similar',
    '/Shows/:itemId/Similar',
  ],
  jf(async (req, res, ctx) => {
    const d = await decodeJellyfinId(param(req, 'itemId'));
    const limit = Math.min(Math.max(1, qi(req, 'Limit', 12)), 50);
    if (!d || (d.k !== 'movie' && d.k !== 'series')) {
      res.json(list([], 0, 0));
      return;
    }
    const meta = await ctx.service.getMetaLoose(d.t, d.i);
    const genre = (meta?.genres ?? [])[0];
    if (!genre) {
      res.json(list([], 0, 0));
      return;
    }
    const catalogs = await ctx.service.getCatalogs();
    for (const catalog of catalogs) {
      if (catalog.type !== d.t) continue;
      const opts =
        (catalog.extra ?? []).find((e) => e.name === 'genre')?.options ?? [];
      if (!opts.includes(genre)) continue;
      const page = await ctx.service.getCatalogPage(catalog, {
        startIndex: 0,
        limit: limit + 1,
        genre,
      });
      const items = (
        await itemsFromPreviews(
          ctx,
          page.items.filter((p) => p.id !== d.i)
        )
      ).slice(0, limit);
      res.json(list(items, items.length, 0));
      return;
    }
    res.json(list([], 0, 0));
  })
);

router.get(
  '/Movies/Recommendations',
  jf(async (req, res, ctx) => {
    const limit = Math.min(Math.max(1, qi(req, 'ItemLimit', 8)), 20);
    const catalogs = (await ctx.service.getCatalogs())
      .filter((c) => c.type === 'movie')
      .slice(0, 3);
    const out: {
      Items: JellyfinItem[];
      RecommendationType: string;
      BaselineItemName: string;
      CategoryId: string;
    }[] = [];
    for (const catalog of catalogs) {
      const page = await ctx.service.getCatalogPage(catalog, {
        startIndex: 0,
        limit,
      });
      const items = await itemsFromPreviews(ctx, page.items);
      out.push({
        Items: items.map(stripInternal),
        RecommendationType: 'SimilarToRecentlyPlayed',
        BaselineItemName: catalog.name,
        CategoryId: encodeJellyfinId({
          k: 'view',
          t: catalog.type,
          c: catalog.id,
        }),
      });
    }
    res.json(out);
  })
);

for (const p of [
  '/Items/:itemId/ThemeMedia',
  '/Items/:itemId/ThemeSongs',
  '/Items/:itemId/ThemeVideos',
]) {
  router.get(
    p,
    jf(async (req, res) => {
      const empty = {
        Items: [],
        TotalRecordCount: 0,
        StartIndex: 0,
        OwnerId: param(req, 'itemId'),
      };
      if (/ThemeMedia/.test(p))
        res.json({
          ThemeVideosResult: empty,
          ThemeSongsResult: empty,
          SoundtrackSongsResult: empty,
        });
      else res.json(empty);
    })
  );
}
router.get(
  [
    '/Items/:itemId/SpecialFeatures',
    '/Users/:userId/Items/:itemId/SpecialFeatures',
    '/Users/:userId/Items/:itemId/LocalTrailers',
    '/Items/:itemId/LocalTrailers',
    '/Users/:userId/Items/:itemId/Intros',
    '/Items/:itemId/Intros',
  ],
  jf(async (req, res) => {
    if (/Intros/.test(req.path))
      res.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    else res.json([]);
  })
);
router.get(
  '/MediaSegments/:itemId',
  jf(async (_req, res) => {
    res.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
  })
);

router.get(
  '/Genres',
  jf(async (req, res, ctx) => {
    const parentId = qs(req, 'ParentId');
    const catalogs = await ctx.service.getCatalogs();
    const genresOut: JellyfinItem[] = [];
    const seen = new Set<string>();
    let scoped = catalogs;
    if (parentId) {
      const d = await decodeJellyfinId(parentId);
      if (d?.k === 'view')
        scoped = catalogs.filter((c) => c.type === d.t && c.id === d.c);
    }
    for (const catalog of scoped) {
      for (const g of await ctx.service.getCatalogGenres(catalog)) {
        const key = `${catalog.type}|${g}`;
        if (seen.has(key)) continue;
        seen.add(key);
        genresOut.push(buildGenreItem(ctx.build, catalog.type, catalog.id, g));
      }
    }
    res.json(list(genresOut, genresOut.length, 0));
  })
);
router.get(
  '/Genres/:name',
  jf(async (req, res, ctx) => {
    res.json(
      stripInternal(
        buildGenreItem(
          ctx.build,
          'movie',
          '',
          decodeURIComponent(param(req, 'name'))
        )
      )
    );
  })
);

router.get(
  ['/Items/Filters', '/Items/Filters2'],
  jf(async (req, res, ctx) => {
    const parentId = qs(req, 'ParentId');
    const catalogs = await ctx.service.getCatalogs();
    let scoped = catalogs;
    if (parentId) {
      const d = await decodeJellyfinId(parentId);
      if (d?.k === 'view')
        scoped = catalogs.filter((c) => c.type === d.t && c.id === d.c);
    }
    const genres: { Name: string; Id: string }[] = [];
    const seen = new Set<string>();
    for (const catalog of scoped) {
      for (const g of await ctx.service.getCatalogGenres(catalog)) {
        if (seen.has(g)) continue;
        seen.add(g);
        genres.push({
          Name: g,
          Id: encodeJellyfinId({
            k: 'genre',
            t: catalog.type,
            c: catalog.id,
            g,
          }),
        });
      }
    }
    if (/Filters2/i.test(req.path)) {
      res.json({ Genres: genres, Tags: [] });
    } else {
      res.json({
        Genres: genres.map((g) => g.Name),
        Tags: [],
        OfficialRatings: [],
        Years: [],
      });
    }
  })
);

router.get(
  '/Items/Counts',
  jf(async (_req, res) => {
    res.json({
      MovieCount: 0,
      SeriesCount: 0,
      EpisodeCount: 0,
      ArtistCount: 0,
      ProgramCount: 0,
      TrailerCount: 0,
      SongCount: 0,
      AlbumCount: 0,
      MusicVideoCount: 0,
      BoxSetCount: 0,
      BookCount: 0,
      ItemCount: 0,
    });
  })
);

router.get(
  '/Search/Hints',
  jf(async (req, res, ctx) => {
    const term = (qs(req, 'SearchTerm') ?? qs(req, 'searchTerm') ?? '').trim();
    const limit = Math.min(Math.max(1, qi(req, 'Limit', 20)), 50);
    const types = includeTypes(req);
    if (!term) {
      res.json({ SearchHints: [], TotalRecordCount: 0 });
      return;
    }
    const previews = await ctx.service.search(
      term,
      stremioTypesFor(types),
      limit
    );
    const items = filterByType(await itemsFromPreviews(ctx, previews), types);
    res.json({
      SearchHints: items.map((i) => ({
        ItemId: i.Id,
        Id: i.Id,
        Name: i.Name,
        Type: i.Type,
        MediaType: i.MediaType ?? 'Video',
        ProductionYear: i.ProductionYear,
        PrimaryImageTag: (i.ImageTags as Record<string, string>)?.Primary,
        BackdropImageTag: (i.BackdropImageTags as string[])?.[0],
        BackdropImageItemId: i.Id,
        PrimaryImageAspectRatio: i.PrimaryImageAspectRatio,
        RunTimeTicks: i.RunTimeTicks,
        IsFolder: i.IsFolder,
      })),
      TotalRecordCount: items.length,
    });
  })
);

router.get(
  '/Persons/:name',
  jf(async (req, res, ctx) => {
    const item = await itemFromDescriptor(ctx, {
      k: 'person',
      n: decodeURIComponent(param(req, 'name')),
    });
    res.json(item ? stripInternal(item) : { Message: 'Not found' });
  })
);

async function toggleFavorite(
  ctx: JellyfinRequestContext,
  itemId: string,
  favorite: boolean
) {
  const d = await decodeJellyfinId(itemId);
  if (!d) return null;
  const row = await JellyfinRepository.upsertPlaystate(
    ctx.uuid,
    itemId.replace(/-/g, '').toLowerCase(),
    d,
    { favorite }
  );
  return row;
}

router.post(
  ['/Users/:userId/FavoriteItems/:itemId', '/UserFavoriteItems/:itemId'],
  jf(async (req, res, ctx) => {
    const row = await toggleFavorite(ctx, param(req, 'itemId'), true);
    if (!row) {
      res.status(404).json({ Message: 'Item not found' });
      return;
    }
    const item = await itemFromDescriptor(ctx, row.payload, { playstate: row });
    res.json(item?.UserData ?? { IsFavorite: true });
  })
);
router.delete(
  ['/Users/:userId/FavoriteItems/:itemId', '/UserFavoriteItems/:itemId'],
  jf(async (req, res, ctx) => {
    const row = await toggleFavorite(ctx, param(req, 'itemId'), false);
    if (!row) {
      res.status(404).json({ Message: 'Item not found' });
      return;
    }
    const item = await itemFromDescriptor(ctx, row.payload, { playstate: row });
    res.json(item?.UserData ?? { IsFavorite: false });
  })
);

export default router;
