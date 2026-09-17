import {
  collectConcurrent,
  config,
  type JellyfinService,
  buildEpisodeItem,
  buildMetaItem,
  buildSeasonItem,
  buildViewItem,
  buildGenreItem,
  buildPersonItem,
  decodeJellyfinId,
  encodeJellyfinId,
  groupSeasons,
  JellyfinRepository,
  playstateToUserData,
  recallImages,
  stripInternal,
  type JellyfinItem,
  type JellyfinItemDescriptor,
  type JellyfinPlaystateRow,
  type MetaPreview,
  type ParsedMeta,
} from '@aiostreams/core';
import type { JellyfinRequestContext } from './context.js';

export interface ItemList {
  Items: JellyfinItem[];
  TotalRecordCount: number;
  StartIndex: number;
}

export function list(
  items: JellyfinItem[],
  total?: number,
  startIndex = 0
): ItemList {
  return {
    Items: items.map(stripInternal),
    TotalRecordCount: total ?? startIndex + items.length,
    StartIndex: startIndex,
  };
}

export async function attachUserData(
  ctx: JellyfinRequestContext,
  items: JellyfinItem[]
): Promise<JellyfinItem[]> {
  const ids = items
    .filter(
      (i) => i.Type === 'Movie' || i.Type === 'Episode' || i.Type === 'Series'
    )
    .map((i) => i.Id);
  if (!ids.length) return items;
  const states = await JellyfinRepository.getPlaystates(ctx.uuid, ids);
  if (!states.size) return items;
  for (const item of items) {
    const ps = states.get(item.Id);
    if (!ps) continue;
    if (item.Type === 'Series') {
      item.UserData = { ...(item.UserData as object), IsFavorite: ps.favorite };
    } else {
      item.UserData = playstateToUserData(
        item.Id,
        ps,
        item.RunTimeTicks as number | undefined
      );
    }
  }
  return items;
}

export async function itemsFromPreviews(
  ctx: JellyfinRequestContext,
  previews: MetaPreview[],
  parentId?: string
): Promise<JellyfinItem[]> {
  const items = previews.map((p) => buildMetaItem(ctx.build, p, { parentId }));
  return attachUserData(ctx, items);
}

export async function viewItems(
  ctx: JellyfinRequestContext
): Promise<JellyfinItem[]> {
  const catalogs = await ctx.service.getCatalogs();
  return catalogs
    .filter((c) => {
      // Search-only catalogs (Movies/Series/Anime/People Search, Voice
      // Actor Roles) require a SearchTerm to return anything — they'd be a
      // permanently empty library row/tile. They remain reachable via
      // search() and findCatalog() (see below), just not listed as views.
      const isSearchOnly = (c.extra ?? []).some(
        (e) => e.name === 'search' && e.isRequired === true
      );
      if (isSearchOnly) return false;
      // Catalogs whose first unfiltered page was empty on the last fetch
      // are hidden too. This is a rolling 10-minute memo (see
      // JellyfinService.isKnownEmpty): the very first load after startup
      // still shows an empty catalog (state unknown), but once the home
      // screen fan-out fetches it once, the next UserViews call hides it.
      if (ctx.service.isKnownEmpty(c)) return false;
      return true;
    })
    .map((c) => buildViewItem(ctx.build, c));
}

export async function findView(
  ctx: JellyfinRequestContext,
  d: { t: string; c: string }
) {
  return ctx.service.findCatalog(d.t, d.c);
}

export function findEpisode(
  meta: ParsedMeta,
  d: Extract<JellyfinItemDescriptor, { k: 'episode' }>
) {
  const groups = groupSeasons(meta);
  for (const g of groups) {
    for (const v of g.videos) {
      if (v.id === d.v) return { group: g, video: v };
    }
  }
  for (const g of groups) {
    if (g.season !== d.s) continue;
    const v = g.videos.find((x) => x.episode === d.e);
    if (v) return { group: g, video: v };
  }
  return null;
}

export async function itemFromDescriptor(
  ctx: JellyfinRequestContext,
  d: JellyfinItemDescriptor,
  opts: {
    playstate?: JellyfinPlaystateRow;
    seriesPlaystates?: boolean;
    skipUserData?: boolean;
  } = {}
): Promise<JellyfinItem | null> {
  switch (d.k) {
    case 'view': {
      const catalog = await findView(ctx, d);
      return catalog ? buildViewItem(ctx.build, catalog) : null;
    }
    case 'genre':
      return buildGenreItem(ctx.build, d.t, d.c, d.g);
    case 'person': {
      const remembered = await recallImages(ctx.uuid, encodeJellyfinId(d));
      return buildPersonItem(ctx.build, d.n, remembered?.images.Primary);
    }
    case 'studio':
      return {
        Id: encodeJellyfinId(d),
        Name: d.n,
        ServerId: ctx.serverId,
        Type: 'Studio',
        IsFolder: true,
      };
    case 'movie':
    case 'series': {
      const meta = await ctx.service.getMetaLoose(d.t, d.i);
      const base = meta
        ? { ...meta, id: d.i }
        : ({ id: d.i, type: d.t, name: d.i } as MetaPreview);
      const item = buildMetaItem(
        ctx.build,
        { ...base, type: d.t },
        { userData: opts.playstate, complete: !!meta }
      );
      if (!opts.playstate && !opts.skipUserData)
        await attachUserData(ctx, [item]);
      return item;
    }
    case 'season': {
      const meta = await ctx.service.getMetaLoose(d.t, d.i);
      if (!meta) return null;
      const seriesItem = buildMetaItem(
        ctx.build,
        { ...meta, type: d.t },
        { complete: true }
      );
      const group = groupSeasons(meta).find((g) => g.season === d.s);
      if (!group) return null;
      const states = await JellyfinRepository.getPlaystates(
        ctx.uuid,
        group.videos.map((v) =>
          encodeJellyfinId({
            k: 'episode',
            t: d.t,
            i: d.i,
            s: group.season,
            e: v.episode ?? 0,
            v: v.id,
          })
        )
      );
      return buildSeasonItem(ctx.build, meta, seriesItem, group, states);
    }
    case 'episode': {
      const meta = await ctx.service.getMetaLoose(d.t, d.i);
      if (!meta) return null;
      const seriesItem = buildMetaItem(
        ctx.build,
        { ...meta, type: d.t },
        { complete: true }
      );
      const found = findEpisode(meta, d);
      const group = found?.group ?? {
        season: d.s,
        name: d.s === 0 ? 'Specials' : `Season ${d.s}`,
        videos: [],
      };
      const video = found?.video ?? {
        id: d.v,
        title: `Episode ${d.e}`,
        season: d.s,
        episode: d.e,
      };
      const ps =
        opts.playstate ??
        (await JellyfinRepository.getPlaystate(
          ctx.uuid,
          encodeJellyfinId(d)
        )) ??
        undefined;
      return buildEpisodeItem(ctx.build, meta, seriesItem, group, video, ps);
    }
  }
}

export async function itemFromId(
  ctx: JellyfinRequestContext,
  id: string,
  opts: { skipUserData?: boolean } = {}
): Promise<{ item: JellyfinItem; descriptor: JellyfinItemDescriptor } | null> {
  const d = await decodeJellyfinId(id);
  if (!d) return null;
  const item = await itemFromDescriptor(ctx, d, opts);
  return item ? { item, descriptor: d } : null;
}

export async function seasonsForSeries(
  ctx: JellyfinRequestContext,
  d: { t: string; i: string }
): Promise<{
  meta: ParsedMeta;
  seriesItem: JellyfinItem;
  seasons: JellyfinItem[];
} | null> {
  const meta = await ctx.service.getMetaLoose(d.t, d.i);
  if (!meta) return null;
  const seriesItem = buildMetaItem(
    ctx.build,
    { ...meta, type: d.t },
    { complete: true }
  );
  const groups = groupSeasons(meta);
  const allEpisodeIds = groups.flatMap((g) =>
    g.videos.map((v) =>
      encodeJellyfinId({
        k: 'episode',
        t: d.t,
        i: d.i,
        s: g.season,
        e: v.episode ?? 0,
        v: v.id,
      })
    )
  );
  const states = await JellyfinRepository.getPlaystates(
    ctx.uuid,
    allEpisodeIds
  );
  const seasons = groups.map((g) =>
    buildSeasonItem(ctx.build, meta, seriesItem, g, states)
  );
  return { meta, seriesItem, seasons };
}

export async function episodesForSeries(
  ctx: JellyfinRequestContext,
  d: { t: string; i: string },
  season?: number
): Promise<{
  meta: ParsedMeta;
  seriesItem: JellyfinItem;
  episodes: JellyfinItem[];
} | null> {
  const meta = await ctx.service.getMetaLoose(d.t, d.i);
  if (!meta) return null;
  const seriesItem = buildMetaItem(
    ctx.build,
    { ...meta, type: d.t },
    { complete: true }
  );
  const groups = groupSeasons(meta).filter(
    (g) => season == null || g.season === season
  );
  const pairs = groups.flatMap((g) => g.videos.map((v) => ({ g, v })));
  const ids = pairs.map(({ g, v }) =>
    encodeJellyfinId({
      k: 'episode',
      t: d.t,
      i: d.i,
      s: g.season,
      e: v.episode ?? 0,
      v: v.id,
    })
  );
  const states = await JellyfinRepository.getPlaystates(ctx.uuid, ids);
  const episodes = pairs.map(({ g, v }, idx) =>
    buildEpisodeItem(ctx.build, meta, seriesItem, g, v, states.get(ids[idx]))
  );
  return { meta, seriesItem, episodes };
}

const NEXT_UP_HISTORY_LIMIT = 500;
const nextUpMetadata = new WeakMap<
  JellyfinService,
  Map<string, { expiresAt: number; promise: Promise<ParsedMeta | null> }>
>();

function nextUpMeta(ctx: JellyfinRequestContext, d: { t: string; i: string }) {
  let cache = nextUpMetadata.get(ctx.service);
  if (!cache) nextUpMetadata.set(ctx.service, (cache = new Map()));
  const key = JSON.stringify([d.t, d.i]);
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.promise;
  const promise = ctx.service.getMetaLoose(d.t, d.i).catch(() => null);
  if (cache.size >= NEXT_UP_HISTORY_LIMIT)
    cache.delete(cache.keys().next().value!);
  cache.set(key, { expiresAt: Date.now() + 60_000, promise });
  return promise;
}

async function selectNextUp(
  ctx: JellyfinRequestContext,
  d: { t: string; i: string },
  source: ParsedMeta,
  last?: JellyfinPlaystateRow,
  enableResumable = true
): Promise<(() => JellyfinItem) | null> {
  const meta = { ...source, type: d.t, id: d.i };
  const pairs = groupSeasons(meta)
    .filter((g) => g.season !== 0)
    .flatMap((g) =>
      g.videos
        .filter(
          (v) => !v.released || !(new Date(v.released).getTime() > Date.now())
        )
        .map((v) => ({
          g,
          v,
          id: encodeJellyfinId({
            k: 'episode',
            t: d.t,
            i: d.i,
            s: g.season,
            e: v.episode ?? 0,
            v: v.id,
          }),
        }))
    );
  const states = await JellyfinRepository.getPlaystates(
    ctx.uuid,
    pairs.map((p) => p.id)
  );
  const eligible = (pair: (typeof pairs)[number]) => {
    const state = states.get(pair.id);
    return !state?.played && (enableResumable || !state?.positionTicks);
  };
  const index = last ? pairs.findIndex((pair) => pair.id === last.itemId) : -1;
  const resume =
    index >= 0 &&
    eligible(pairs[index]) &&
    (states.get(pairs[index].id)?.positionTicks ?? 0) > 0;
  const pair = resume ? pairs[index] : pairs.slice(index + 1).find(eligible);
  if (!pair) return null;
  return () =>
    buildEpisodeItem(
      ctx.build,
      meta,
      buildMetaItem(ctx.build, meta, { complete: true }),
      pair.g,
      pair.v,
      states.get(pair.id)
    );
}

export async function nextUpPage(
  ctx: JellyfinRequestContext,
  startIndex: number,
  limit: number,
  enableResumable: boolean
) {
  const recent = await JellyfinRepository.listRecentEpisodesBySeries(
    ctx.uuid,
    NEXT_UP_HISTORY_LIMIT
  );
  const seen = new Set<string>();
  const candidates = recent.filter((row) => {
    if (row.payload.k !== 'episode') return false;
    const key = JSON.stringify([row.payload.t, row.payload.i]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const selected = await collectConcurrent(
    candidates,
    async (row) => {
      if (row.payload.k !== 'episode') return [];
      const d = { t: row.payload.t, i: row.payload.i };
      const meta = await nextUpMeta(ctx, d);
      if (!meta) return [];
      const next = await selectNextUp(ctx, d, meta, row, enableResumable);
      return next ? [next] : [];
    },
    { concurrency: config.api.jellyfinLookupConcurrency }
  );
  return list(
    selected.slice(startIndex, startIndex + limit).map((build) => build()),
    selected.length,
    startIndex
  );
}

export async function nextUpForSeries(
  ctx: JellyfinRequestContext,
  d: { t: string; i: string },
  last?: JellyfinPlaystateRow,
  enableResumable = true
): Promise<JellyfinItem | null> {
  const meta = await nextUpMeta(ctx, d);
  if (!meta) return null;
  const candidate = await selectNextUp(ctx, d, meta, last, enableResumable);
  return candidate?.() ?? null;
}
