import {
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
  return catalogs.map((c) => buildViewItem(ctx.build, c));
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
  opts: { playstate?: JellyfinPlaystateRow; seriesPlaystates?: boolean } = {}
): Promise<JellyfinItem | null> {
  switch (d.k) {
    case 'view': {
      const catalog = await findView(ctx, d);
      return catalog ? buildViewItem(ctx.build, catalog) : null;
    }
    case 'genre':
      return buildGenreItem(ctx.build, d.t, d.c, d.g);
    case 'person':
      return buildPersonItem(ctx.build, d.n);
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
      if (!opts.playstate) await attachUserData(ctx, [item]);
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
  id: string
): Promise<{ item: JellyfinItem; descriptor: JellyfinItemDescriptor } | null> {
  const d = await decodeJellyfinId(id);
  if (!d) return null;
  const item = await itemFromDescriptor(ctx, d);
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

export async function nextUpForSeries(
  ctx: JellyfinRequestContext,
  d: { t: string; i: string },
  last?: JellyfinPlaystateRow
): Promise<JellyfinItem | null> {
  const res = await episodesForSeries(ctx, d);
  if (!res) return null;
  const eps = res.episodes.filter(
    (e) => e.LocationType !== 'Virtual' && (e.ParentIndexNumber as number) !== 0
  );
  if (!eps.length) return null;
  if (last) {
    const idx = eps.findIndex((e) => e.Id === last.itemId);
    if (idx >= 0) {
      const lastUd = eps[idx].UserData as {
        Played: boolean;
        PlaybackPositionTicks: number;
      };
      if (!lastUd.Played && lastUd.PlaybackPositionTicks > 0) return eps[idx];
      return eps[idx + 1] ?? null;
    }
  }
  return eps.find((e) => !(e.UserData as { Played: boolean }).Played) ?? null;
}
