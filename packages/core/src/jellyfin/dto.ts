import type {
  Manifest,
  Meta,
  MetaPreview,
  ParsedMeta,
  ParsedStream,
  Subtitle,
} from '../db/schemas.js';
import type {
  JellyfinItemDescriptor,
  JellyfinPlaystateRow,
} from '../db/repositories/jellyfin.js';
import { IdParser } from '../utils/id-parser.js';
import { languageToCode } from '../utils/languages.js';
import { encodeJellyfinId, imageTag, streamIdToMediaSourceId } from './ids.js';
import { rememberImages, type ItemImages } from './images.js';

export const TICKS_PER_MS = 10_000;
export const TICKS_PER_SECOND = 10_000_000;
export const TICKS_PER_MINUTE = 600_000_000;

export type JellyfinItemType =
  | 'Movie'
  | 'Series'
  | 'Season'
  | 'Episode'
  | 'CollectionFolder'
  | 'Folder'
  | 'Genre'
  | 'Person'
  | 'Studio'
  | 'Video';

export type JellyfinUserItemData = {
  PlaybackPositionTicks: number;
  PlayCount: number;
  IsFavorite: boolean;
  Played: boolean;
  LastPlayedDate?: string;
  PlayedPercentage?: number;
  UnplayedItemCount?: number;
  Key: string;
  ItemId: string;
};

export type JellyfinItem = {
  Id: string;
  Name: string;
  ServerId: string;
  Type: JellyfinItemType;
  IsFolder: boolean;
  [key: string]: unknown;
};

export type JellyfinMediaStream = {
  Type: 'Video' | 'Audio' | 'Subtitle';
  Index: number;
  Codec?: string;
  Language?: string;
  DisplayTitle?: string;
  IsDefault?: boolean;
  IsForced?: boolean;
  IsExternal?: boolean;
  [key: string]: unknown;
};

export type JellyfinMediaSource = {
  Id: string;
  Name: string;
  Path: string;
  Protocol: 'Http' | 'File';
  [key: string]: unknown;
};

export interface ItemBuildContext {
  uuid: string;
  serverId: string;
}

export function parseRuntimeToTicks(
  runtime: string | number | null | undefined
): number | undefined {
  if (runtime == null) return undefined;
  if (typeof runtime === 'number') return runtime * TICKS_PER_MINUTE;
  const s = runtime.toLowerCase();
  let minutes = 0;
  const h = s.match(/(\d+)\s*h/);
  const m = s.match(/(\d+)\s*m/);
  if (h) minutes += Number(h[1]) * 60;
  if (m) minutes += Number(m[1]);
  if (!h && !m) {
    const n = s.match(/(\d+)/);
    if (n) minutes = Number(n[1]);
  }
  return minutes > 0 ? minutes * TICKS_PER_MINUTE : undefined;
}

function parseYear(value: unknown): number | undefined {
  if (value == null) return undefined;
  const m = String(value).match(/(\d{4})/);
  return m ? Number(m[1]) : undefined;
}

function parseReleaseStatus(
  value: unknown
): 'Continuing' | 'Ended' | undefined {
  if (value == null) return undefined;
  const s = String(value);
  if (/\d{4}\s*[-–]\s*$/.test(s)) return 'Continuing';
  if (/\d{4}\s*[-–]\s*\d{4}/.test(s)) return 'Ended';
  return undefined;
}

function toIso(date: unknown): string | undefined {
  if (!date) return undefined;
  const d = new Date(String(date));
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

function numberOr(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function linksByCategory(meta: MetaPreview | Meta, category: string): string[] {
  return (meta.links ?? [])
    .filter((l) => l.category.toLowerCase() === category.toLowerCase())
    .map((l) => l.name);
}

export function providerIdsFor(
  meta: MetaPreview | Meta | { id: string; type: string }
): Record<string, string> {
  const out: Record<string, string> = {};
  const parsed = IdParser.parse(meta.id, meta.type);
  if (parsed) {
    const v = String(parsed.value);
    switch (parsed.type) {
      case 'imdbId':
        out.Imdb = v.startsWith('tt') ? v : `tt${v}`;
        break;
      case 'themoviedbId':
        out.Tmdb = v;
        break;
      case 'thetvdbId':
        out.Tvdb = v;
        break;
      case 'kitsuId':
        out.Kitsu = v;
        break;
      case 'malId':
        out.MyAnimeList = v;
        break;
      case 'anilistId':
        out.AniList = v;
        break;
      case 'anidbId':
        out.AniDB = v;
        break;
      case 'simklId':
        out.Simkl = v;
        break;
    }
  }
  const any = meta as Record<string, unknown>;
  if (typeof any.imdb_id === 'string' && !out.Imdb) out.Imdb = any.imdb_id;
  if (any.moviedb_id != null && !out.Tmdb) out.Tmdb = String(any.moviedb_id);
  if (any.tmdb_id != null && !out.Tmdb) out.Tmdb = String(any.tmdb_id);
  if (any.tvdb_id != null && !out.Tvdb) out.Tvdb = String(any.tvdb_id);
  if (any.kitsu_id != null && !out.Kitsu) out.Kitsu = String(any.kitsu_id);
  if (any.mal_id != null && !out.MyAnimeList)
    out.MyAnimeList = String(any.mal_id);
  if (any.anilist_id != null && !out.AniList)
    out.AniList = String(any.anilist_id);
  const ids = any.ids ?? any.externalIds;
  if (ids && typeof ids === 'object') {
    const rec = ids as Record<string, unknown>;
    const map: Record<string, string> = {
      imdb: 'Imdb',
      imdb_id: 'Imdb',
      tmdb: 'Tmdb',
      tmdb_id: 'Tmdb',
      tvdb: 'Tvdb',
      tvdb_id: 'Tvdb',
      kitsu: 'Kitsu',
      mal: 'MyAnimeList',
      anilist: 'AniList',
      anidb: 'AniDB',
    };
    for (const [k, jk] of Object.entries(map)) {
      if (rec[k] != null && !out[jk]) out[jk] = String(rec[k]);
    }
  }
  return out;
}

function externalUrls(providerIds: Record<string, string>) {
  const urls: { Name: string; Url: string }[] = [];
  if (providerIds.Imdb)
    urls.push({
      Name: 'IMDb',
      Url: `https://www.imdb.com/title/${providerIds.Imdb}`,
    });
  if (providerIds.Tmdb)
    urls.push({
      Name: 'TheMovieDb',
      Url: `https://www.themoviedb.org/search?query=${providerIds.Tmdb}`,
    });
  if (providerIds.MyAnimeList)
    urls.push({
      Name: 'MyAnimeList',
      Url: `https://myanimelist.net/anime/${providerIds.MyAnimeList}`,
    });
  if (providerIds.AniList)
    urls.push({
      Name: 'AniList',
      Url: `https://anilist.co/anime/${providerIds.AniList}`,
    });
  if (providerIds.Kitsu)
    urls.push({
      Name: 'Kitsu',
      Url: `https://kitsu.app/anime/${providerIds.Kitsu}`,
    });
  return urls;
}

export function defaultUserData(itemId: string): JellyfinUserItemData {
  return {
    PlaybackPositionTicks: 0,
    PlayCount: 0,
    IsFavorite: false,
    Played: false,
    Key: itemId,
    ItemId: itemId,
  };
}

export function playstateToUserData(
  itemId: string,
  row: JellyfinPlaystateRow | undefined,
  runtimeTicks?: number
): JellyfinUserItemData {
  if (!row) return defaultUserData(itemId);
  const rt = runtimeTicks || row.runtimeTicks;
  const ud: JellyfinUserItemData = {
    PlaybackPositionTicks: row.played ? 0 : row.positionTicks,
    PlayCount: row.playCount,
    IsFavorite: row.favorite,
    Played: row.played,
    Key: itemId,
    ItemId: itemId,
  };
  if (row.lastPlayedAt)
    ud.LastPlayedDate = new Date(row.lastPlayedAt).toISOString();
  if (!row.played && rt && row.positionTicks > 0)
    ud.PlayedPercentage = Math.min(100, (row.positionTicks / rt) * 100);
  return ud;
}

export function stremioTypeToItemType(type: string): 'Movie' | 'Series' {
  return type === 'movie' ? 'Movie' : 'Series';
}

export function collectionTypeFor(type: string): string | undefined {
  if (type === 'movie') return 'movies';
  if (type === 'series' || type === 'anime') return 'tvshows';
  if (type === 'tv' || type === 'channel') return 'livetv';
  return undefined;
}

function peopleFrom(meta: MetaPreview | Meta) {
  const people: { Name: string; Id: string; Type: string; Role?: string }[] =
    [];
  const push = (name: string, type: string) => {
    if (!name) return;
    people.push({
      Name: name,
      Id: encodeJellyfinId({ k: 'person', n: name }),
      Type: type,
    });
  };
  const castList = Array.isArray(meta.cast)
    ? meta.cast
    : linksByCategory(meta, 'Cast');
  castList.forEach((c) => push(c, 'Actor'));
  const directors = Array.isArray(meta.director)
    ? meta.director.filter((d): d is string => typeof d === 'string')
    : typeof meta.director === 'string'
      ? [meta.director]
      : linksByCategory(meta, 'Directors');
  directors.forEach((d) => push(d, 'Director'));
  linksByCategory(meta, 'Writers').forEach((w) => push(w, 'Writer'));
  return people;
}

function genresFrom(meta: MetaPreview | Meta): string[] {
  const g =
    Array.isArray(meta.genres) && meta.genres.length
      ? meta.genres
      : linksByCategory(meta, 'Genres');
  return [
    ...new Set(
      g.filter((x): x is string => typeof x === 'string' && x.length > 0)
    ),
  ];
}

function trailersFrom(meta: MetaPreview | Meta) {
  return (meta.trailers ?? [])
    .filter((t) => t.source)
    .map((t) => ({
      Name: t.type ?? 'Trailer',
      Url: t.source.startsWith('http')
        ? t.source
        : `https://www.youtube.com/watch?v=${t.source}`,
    }));
}

export function stubMediaSources(
  itemId: string,
  name: string
): JellyfinMediaSource[] {
  return [
    {
      Id: itemId,
      ETag: itemId,
      Name: name,
      Path: `/aiostreams/${itemId}`,
      Protocol: 'File',
      Type: 'Default',
      SupportsDirectPlay: true,
      SupportsDirectStream: true,
      SupportsTranscoding: false,
      MediaStreams: [],
      Formats: [],
    },
    {
      Id: streamIdToMediaSourceId(`${itemId}-stub2`),
      ETag: itemId,
      Name: `${name} (2)`,
      Path: `/aiostreams/${itemId}`,
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

export function buildViewItem(
  ctx: ItemBuildContext,
  catalog: NonNullable<Manifest['catalogs']>[number]
): JellyfinItem {
  const id = encodeJellyfinId({ k: 'view', t: catalog.type, c: catalog.id });
  const collectionType = collectionTypeFor(catalog.type);
  return {
    Id: id,
    Name: catalog.name,
    ServerId: ctx.serverId,
    Type: 'CollectionFolder',
    IsFolder: true,
    ...(collectionType ? { CollectionType: collectionType } : {}),
    Etag: imageTag(`${catalog.type}:${catalog.id}`),
    DateCreated: '2020-01-01T00:00:00.0000000Z',
    CanDelete: false,
    CanDownload: false,
    SortName: catalog.name.toLowerCase(),
    ChildCount: 0,
    DisplayPreferencesId: id,
    LocationType: 'FileSystem',
    PlayAccess: 'Full',
    ImageTags: {},
    BackdropImageTags: [],
    UserData: defaultUserData(id),
    Path: `/${catalog.type}/${catalog.id}`,
    PrimaryImageAspectRatio: 1.7777,
    ExtraType: undefined,
    _aio: {
      type: catalog.type,
      catalogId: catalog.id,
      extras: (catalog.extra ?? []).map((e) => e.name),
    },
  };
}

export function stripInternal(item: JellyfinItem): JellyfinItem {
  const { _aio, ...rest } = item as JellyfinItem & { _aio?: unknown };
  return rest as JellyfinItem;
}

export function buildGenreItem(
  ctx: ItemBuildContext,
  type: string,
  catalogId: string,
  genre: string
): JellyfinItem {
  const id = encodeJellyfinId({ k: 'genre', t: type, c: catalogId, g: genre });
  return {
    Id: id,
    Name: genre,
    ServerId: ctx.serverId,
    Type: 'Genre',
    IsFolder: true,
    ImageTags: {},
    BackdropImageTags: [],
    UserData: defaultUserData(id),
  };
}

export function buildPersonItem(
  ctx: ItemBuildContext,
  name: string
): JellyfinItem {
  const id = encodeJellyfinId({ k: 'person', n: name });
  return {
    Id: id,
    Name: name,
    ServerId: ctx.serverId,
    Type: 'Person',
    IsFolder: false,
    ImageTags: {},
    BackdropImageTags: [],
    UserData: defaultUserData(id),
  };
}

export function descriptorForMeta(meta: {
  id: string;
  type: string;
}): JellyfinItemDescriptor {
  return stremioTypeToItemType(meta.type) === 'Movie'
    ? { k: 'movie', t: meta.type, i: meta.id }
    : { k: 'series', t: meta.type, i: meta.id };
}

export function buildMetaItem(
  ctx: ItemBuildContext,
  meta: MetaPreview | Meta,
  opts: {
    parentId?: string;
    userData?: JellyfinPlaystateRow;
    complete?: boolean;
  } = {}
): JellyfinItem {
  const descriptor = descriptorForMeta(meta);
  const id = encodeJellyfinId(descriptor);
  const itemType = stremioTypeToItemType(meta.type);
  const full = meta as Meta;
  const providerIds = providerIdsFor(meta);
  const genres = genresFrom(meta);
  const runtimeTicks = parseRuntimeToTicks(full.runtime);
  const year =
    parseYear(meta.releaseInfo) ??
    parseYear((meta as Record<string, unknown>).year) ??
    parseYear((meta as Record<string, unknown>).released);
  const premiere = toIso((meta as Record<string, unknown>).released);

  const images: ItemImages = {};
  if (meta.poster) images.Primary = meta.poster;
  if (full.background) images.Backdrop = full.background;
  if (full.logo) images.Logo = full.logo;
  rememberImages(ctx.uuid, id, images, opts.complete === true);

  const imageTags: Record<string, string> = {};
  if (images.Primary) imageTags.Primary = imageTag(images.Primary);
  if (images.Logo) imageTags.Logo = imageTag(images.Logo);

  const item: JellyfinItem = {
    Id: id,
    Name: meta.name ?? meta.id,
    OriginalTitle: meta.name ?? meta.id,
    SortName: (meta.name ?? meta.id).toLowerCase(),
    ServerId: ctx.serverId,
    Type: itemType,
    IsFolder: itemType === 'Series',
    MediaType: itemType === 'Movie' ? 'Video' : undefined,
    Etag: imageTag(id),
    DateCreated: premiere ?? '2020-01-01T00:00:00.0000000Z',
    CanDelete: false,
    CanDownload: itemType === 'Movie',
    LocationType: 'FileSystem',
    PlayAccess: 'Full',
    Overview: meta.description ?? undefined,
    ProductionYear: year,
    PremiereDate: premiere,
    CommunityRating: numberOr(meta.imdbRating),
    OfficialRating: (meta as Record<string, unknown>).certification as
      | string
      | undefined,
    RunTimeTicks: runtimeTicks,
    Genres: genres,
    GenreItems: genres.map((g) => ({
      Name: g,
      Id: encodeJellyfinId({ k: 'genre', t: meta.type, c: '', g }),
    })),
    People: peopleFrom(meta),
    Studios: [],
    Tags: [],
    Taglines: [],
    ProviderIds: providerIds,
    ExternalUrls: externalUrls(providerIds),
    RemoteTrailers: trailersFrom(meta),
    ImageTags: imageTags,
    BackdropImageTags: images.Backdrop ? [imageTag(images.Backdrop)] : [],
    ParentId: opts.parentId,
    PrimaryImageAspectRatio:
      meta.posterShape === 'landscape'
        ? 1.7777
        : meta.posterShape === 'square'
          ? 1
          : 0.6666,
    VideoType: itemType === 'Movie' ? 'VideoFile' : undefined,
    Status:
      itemType === 'Series' ? parseReleaseStatus(meta.releaseInfo) : undefined,
    EndDate: undefined,
    ChildCount:
      itemType === 'Series' ? full.videos?.length || undefined : undefined,
    RecursiveItemCount:
      itemType === 'Series' ? full.videos?.length || undefined : undefined,
    UserData: playstateToUserData(id, opts.userData, runtimeTicks),
    Path: `/${meta.type}/${meta.id}`,
    Container: undefined,
    MediaSources:
      itemType === 'Movie'
        ? stubMediaSources(id, meta.name ?? meta.id)
        : undefined,
    MediaStreams: undefined,
    _aio: { descriptor },
  };
  if (full.language) item.PreferredMetadataLanguage = full.language;
  if ((meta as Record<string, unknown>).country)
    item.ProductionLocations = [
      String((meta as Record<string, unknown>).country),
    ];
  if (full.website) item.HomePageUrl = full.website;
  return item;
}

export interface SeasonGroup {
  season: number;
  name: string;
  videos: NonNullable<ParsedMeta['videos']>;
}

export function groupSeasons(meta: ParsedMeta): SeasonGroup[] {
  const videos = [...(meta.videos ?? [])];
  if (videos.length === 0) {
    return [
      {
        season: 1,
        name: 'Season 1',
        videos: [
          {
            id: meta.id,
            title: meta.name ?? meta.id,
            season: 1,
            episode: 1,
            released: (meta as Record<string, unknown>).released as
              | string
              | undefined,
            thumbnail: meta.background ?? meta.poster ?? undefined,
            overview: meta.description ?? undefined,
          },
        ],
      },
    ];
  }
  const numbered = videos.some((v) => typeof v.episode === 'number');
  const groups = new Map<number, SeasonGroup>();
  videos.forEach((v, idx) => {
    const season = typeof v.season === 'number' ? v.season : 1;
    if (!numbered) v.episode = idx + 1;
    else if (typeof v.episode !== 'number') v.episode = idx + 1;
    if (typeof v.season !== 'number') v.season = season;
    let g = groups.get(season);
    if (!g) {
      g = {
        season,
        name: season === 0 ? 'Specials' : `Season ${season}`,
        videos: [],
      };
      groups.set(season, g);
    }
    g.videos.push(v);
  });
  for (const g of groups.values()) {
    g.videos.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
  }
  return [...groups.values()].sort((a, b) => {
    if (a.season === 0) return 1;
    if (b.season === 0) return -1;
    return a.season - b.season;
  });
}

export function buildSeasonItem(
  ctx: ItemBuildContext,
  meta: ParsedMeta,
  seriesItem: JellyfinItem,
  group: SeasonGroup,
  playstates?: Map<string, JellyfinPlaystateRow>
): JellyfinItem {
  const id = encodeJellyfinId({
    k: 'season',
    t: meta.type,
    i: meta.id,
    s: group.season,
  });
  const images: ItemImages = {};
  if (meta.poster) images.Primary = meta.poster;
  if (meta.background) images.Backdrop = meta.background;
  rememberImages(ctx.uuid, id, images, true);

  let played = 0;
  let inProgress = false;
  if (playstates) {
    for (const v of group.videos) {
      const epId = encodeJellyfinId({
        k: 'episode',
        t: meta.type,
        i: meta.id,
        s: group.season,
        e: v.episode ?? 0,
        v: v.id,
      });
      const ps = playstates.get(epId);
      if (ps?.played) played++;
      else if (ps && ps.positionTicks > 0) inProgress = true;
    }
  }
  const total = group.videos.length;
  return {
    Id: id,
    Name: group.name,
    SortName: String(group.season).padStart(4, '0'),
    ServerId: ctx.serverId,
    Type: 'Season',
    IsFolder: true,
    IndexNumber: group.season,
    SeriesId: seriesItem.Id,
    SeriesName: seriesItem.Name,
    ParentId: seriesItem.Id,
    ChildCount: total,
    RecursiveItemCount: total,
    LocationType: 'FileSystem',
    PlayAccess: 'Full',
    CanDelete: false,
    CanDownload: false,
    ImageTags: images.Primary ? { Primary: imageTag(images.Primary) } : {},
    BackdropImageTags: [],
    ParentBackdropItemId: images.Backdrop ? seriesItem.Id : undefined,
    ParentBackdropImageTags: images.Backdrop
      ? [imageTag(images.Backdrop)]
      : undefined,
    SeriesPrimaryImageTag: images.Primary
      ? imageTag(images.Primary)
      : undefined,
    ParentLogoItemId: meta.logo ? seriesItem.Id : undefined,
    ParentLogoImageTag: meta.logo ? imageTag(meta.logo) : undefined,
    PrimaryImageAspectRatio: 0.6666,
    ProductionYear: seriesItem.ProductionYear,
    ProviderIds: {},
    UserData: {
      ...defaultUserData(id),
      Played: total > 0 && played >= total,
      UnplayedItemCount: Math.max(0, total - played),
      PlayedPercentage: total > 0 ? (played / total) * 100 : 0,
      ...(inProgress ? {} : {}),
    },
  };
}

export function buildEpisodeItem(
  ctx: ItemBuildContext,
  meta: ParsedMeta,
  seriesItem: JellyfinItem,
  group: SeasonGroup,
  video: NonNullable<ParsedMeta['videos']>[number],
  playstate?: JellyfinPlaystateRow
): JellyfinItem {
  const descriptor: JellyfinItemDescriptor = {
    k: 'episode',
    t: meta.type,
    i: meta.id,
    s: group.season,
    e: video.episode ?? 0,
    v: video.id,
  };
  const id = encodeJellyfinId(descriptor);
  const seasonId = encodeJellyfinId({
    k: 'season',
    t: meta.type,
    i: meta.id,
    s: group.season,
  });
  const images: ItemImages = {};
  if (video.thumbnail) images.Primary = video.thumbnail;
  if (meta.background) images.Backdrop = meta.background;
  rememberImages(ctx.uuid, id, images, true);

  const runtimeTicks = parseRuntimeToTicks(meta.runtime);
  const premiere = toIso(video.released);
  const unaired = premiere ? new Date(premiere).getTime() > Date.now() : false;
  const title = video.title ?? video.name ?? `Episode ${video.episode}`;

  return {
    Id: id,
    Name: title,
    SortName: `${String(group.season).padStart(4, '0')}-${String(video.episode ?? 0).padStart(4, '0')}`,
    ServerId: ctx.serverId,
    Type: 'Episode',
    IsFolder: false,
    MediaType: 'Video',
    VideoType: 'VideoFile',
    LocationType: unaired ? 'Virtual' : 'FileSystem',
    PlayAccess: 'Full',
    CanDelete: false,
    CanDownload: !unaired,
    IndexNumber: video.episode,
    ParentIndexNumber: group.season,
    SeriesId: seriesItem.Id,
    SeriesName: seriesItem.Name,
    SeasonId: seasonId,
    SeasonName: group.name,
    ParentId: seasonId,
    Overview: video.overview ?? undefined,
    PremiereDate: premiere,
    ProductionYear: premiere
      ? new Date(premiere).getUTCFullYear()
      : seriesItem.ProductionYear,
    RunTimeTicks: runtimeTicks,
    ImageTags: images.Primary ? { Primary: imageTag(images.Primary) } : {},
    BackdropImageTags: [],
    ParentBackdropItemId: images.Backdrop ? seriesItem.Id : undefined,
    ParentBackdropImageTags: images.Backdrop
      ? [imageTag(images.Backdrop)]
      : undefined,
    SeriesPrimaryImageTag: meta.poster ? imageTag(meta.poster) : undefined,
    ParentLogoItemId: meta.logo ? seriesItem.Id : undefined,
    ParentLogoImageTag: meta.logo ? imageTag(meta.logo) : undefined,
    ParentThumbItemId: images.Backdrop ? seriesItem.Id : undefined,
    ParentThumbImageTag: images.Backdrop
      ? imageTag(images.Backdrop)
      : undefined,
    PrimaryImageAspectRatio: 1.7777,
    ProviderIds: {},
    Genres: seriesItem.Genres,
    CommunityRating: seriesItem.CommunityRating,
    UserData: playstateToUserData(id, playstate, runtimeTicks),
    MediaSources: unaired ? undefined : stubMediaSources(id, title),
    Path: `/${meta.type}/${video.id}`,
    _aio: { descriptor },
  };
}

const ENCODE_TO_CODEC: Record<string, string> = {
  AV1: 'av1',
  HEVC: 'hevc',
  AVC: 'h264',
  'VC-1': 'vc1',
  XviD: 'mpeg4',
  DivX: 'mpeg4',
  MPEG2: 'mpeg2video',
};
const AUDIO_TAG_TO_CODEC: [string, string][] = [
  ['Atmos', 'truehd'],
  ['TrueHD', 'truehd'],
  ['DTS:X', 'dts'],
  ['DTS-HD MA', 'dts'],
  ['DTS-HD', 'dts'],
  ['DTS-ES', 'dts'],
  ['DTS', 'dts'],
  ['DD+', 'eac3'],
  ['DD', 'ac3'],
  ['OPUS', 'opus'],
  ['FLAC', 'flac'],
  ['AAC', 'aac'],
];
const RES_TO_SIZE: Record<string, [number, number]> = {
  '2160p': [3840, 2160],
  '1440p': [2560, 1440],
  '1080p': [1920, 1080],
  '720p': [1280, 720],
  '576p': [720, 576],
  '480p': [640, 480],
  '360p': [480, 360],
  '240p': [320, 240],
};

function containerOf(stream: ParsedStream): string {
  const ext =
    stream.parsedFile?.container ||
    stream.parsedFile?.extension ||
    stream.filename?.split('.').pop() ||
    (stream.url ? stream.url.split('?')[0].split('.').pop() : undefined);
  const c = (ext || '').toLowerCase().replace(/^\./, '');
  if (/^(mkv|mp4|avi|mov|m4v|ts|webm|wmv|flv|m2ts|mpg|mpeg)$/.test(c)) return c;
  if (stream.type === 'live') return 'ts';
  return 'mkv';
}

function channelsOf(tag: string | undefined): number | undefined {
  if (!tag) return undefined;
  const m = tag.match(/^(\d+)\.(\d+)$/);
  if (!m) return undefined;
  return Number(m[1]) + Number(m[2]);
}

export function buildMediaStreams(
  stream: ParsedStream,
  subtitles: { url: string; lang: string; id: string }[],
  subtitleUrl: (
    index: number,
    sub: { url: string; lang: string; id: string }
  ) => string
): JellyfinMediaStream[] {
  const pf = stream.parsedFile;
  const streams: JellyfinMediaStream[] = [];
  let index = 0;

  const res =
    pf?.resolution && pf.resolution !== 'Unknown' ? pf.resolution : undefined;
  const size = res ? RES_TO_SIZE[res] : undefined;
  const encode = pf?.encode && pf.encode !== 'Unknown' ? pf.encode : undefined;
  const visual = pf?.visualTags ?? [];
  const hasDV =
    visual.includes('DV') ||
    visual.includes('HDR+DV') ||
    visual.includes('DV Only');
  const hasHDR = visual.some(
    (v) => /^HDR/.test(v) || v === 'HLG' || v === 'HDR Only'
  );
  const videoRangeType = hasDV
    ? 'DOVI'
    : visual.includes('HDR10+')
      ? 'HDR10Plus'
      : visual.includes('HDR10')
        ? 'HDR10'
        : visual.includes('HLG')
          ? 'HLG'
          : hasHDR
            ? 'HDR10'
            : 'SDR';
  const videoRange = hasDV || hasHDR ? 'HDR' : 'SDR';
  streams.push({
    Type: 'Video',
    Index: index++,
    Codec: encode
      ? (ENCODE_TO_CODEC[encode] ?? encode.toLowerCase())
      : undefined,
    Width: size?.[0],
    Height: size?.[1],
    IsDefault: true,
    IsForced: false,
    IsExternal: false,
    IsInterlaced: false,
    IsTextSubtitleStream: false,
    SupportsExternalStream: false,
    VideoRange: videoRange,
    VideoRangeType: videoRangeType,
    BitDepth: visual.includes('10bit') || hasDV || hasHDR ? 10 : 8,
    BitRate: stream.bitrate,
    DisplayTitle:
      [res, encode, videoRangeType !== 'SDR' ? videoRangeType : undefined]
        .filter(Boolean)
        .join(' ') || 'Video',
    Language: undefined,
    AspectRatio: size ? (size[0] / size[1] >= 1.7 ? '16:9' : '4:3') : undefined,
    Level: undefined,
    Profile: undefined,
  });

  const langs = (pf?.languages ?? []).filter((l) => l && l !== 'Unknown');
  const audioTag = (pf?.audioTags ?? []).find((t) =>
    AUDIO_TAG_TO_CODEC.some(([k]) => k === t)
  );
  const audioCodec = audioTag
    ? AUDIO_TAG_TO_CODEC.find(([k]) => k === audioTag)?.[1]
    : undefined;
  const channels = channelsOf(
    (pf?.audioChannels ?? []).find((c) => c !== 'Unknown')
  );
  const audioLangs = langs.length ? langs : ['Unknown'];
  audioLangs.forEach((lang, i) => {
    const code = lang === 'Unknown' ? undefined : languageToCode(lang);
    streams.push({
      Type: 'Audio',
      Index: index++,
      Codec: audioCodec,
      Language: code ?? (lang === 'Unknown' ? undefined : lang.toLowerCase()),
      DisplayTitle:
        [
          lang !== 'Unknown' ? lang : undefined,
          audioTag,
          pf?.audioChannels?.[0] !== 'Unknown'
            ? pf?.audioChannels?.[0]
            : undefined,
        ]
          .filter(Boolean)
          .join(' ') || 'Audio',
      Channels: channels,
      ChannelLayout:
        channels === 6
          ? '5.1'
          : channels === 8
            ? '7.1'
            : channels === 2
              ? 'stereo'
              : undefined,
      IsDefault: i === 0,
      IsForced: false,
      IsExternal: false,
      IsTextSubtitleStream: false,
      SupportsExternalStream: false,
      BitRate: undefined,
      SampleRate: undefined,
    });
  });

  subtitles.forEach((sub, i) => {
    const ext = (sub.url.split('?')[0].split('.').pop() || 'srt').toLowerCase();
    const codec = /^(srt|vtt|ass|ssa|sub|sup)$/.test(ext)
      ? ext === 'vtt'
        ? 'webvtt'
        : ext === 'sub'
          ? 'subrip'
          : ext
      : 'srt';
    const code = languageToCode(sub.lang) ?? sub.lang;
    streams.push({
      Type: 'Subtitle',
      Index: index++,
      Codec: codec === 'srt' ? 'subrip' : codec,
      Language: code,
      DisplayTitle: `${sub.lang} (external)`,
      Title: sub.lang,
      IsDefault: false,
      IsForced: false,
      IsExternal: true,
      IsTextSubtitleStream: true,
      SupportsExternalStream: true,
      DeliveryMethod: 'External',
      DeliveryUrl: sub.url,
      IsExternalUrl: true,
      Path: sub.url,
    });
  });

  return streams;
}

export interface MediaSourceBuildOptions {
  baseUrl: string;
  itemId: string;
  apiKey: string;
  encrypt: (plain: string) => string;
  subtitles: Subtitle[];
  runtimeTicks?: number;
}

export function mediaSourceIdFor(stream: ParsedStream): string {
  return streamIdToMediaSourceId(
    stream.id || stream.url || JSON.stringify(stream.releaseKey)
  );
}

export interface PlayableStreamRecord {
  msid: string;
  url: string;
  headers?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  filename?: string;
  name: string;
  type: string;
  size?: number;
  subtitles?: { id: string; url: string; lang: string }[];
}

export function streamToPlayable(
  stream: ParsedStream,
  name: string
): PlayableStreamRecord | null {
  if (!stream.url) return null;
  if (
    !stream.proxied &&
    ((stream.requestHeaders && Object.keys(stream.requestHeaders).length) ||
      (stream.responseHeaders && Object.keys(stream.responseHeaders).length))
  ) {
    return null;
  }
  return {
    msid: mediaSourceIdFor(stream),
    url: stream.url,
    headers: stream.requestHeaders,
    responseHeaders: stream.responseHeaders,
    filename: stream.filename,
    name,
    type: stream.type,
    size: stream.size,
    subtitles: stream.subtitles?.map((s) => ({
      id: s.id,
      url: s.url,
      lang: s.lang,
    })),
  };
}

export function buildMediaSource(
  stream: ParsedStream,
  formatted: { name: string; description: string },
  opts: MediaSourceBuildOptions
): JellyfinMediaSource | null {
  if (!stream.url) return null;
  if (
    !stream.proxied &&
    ((stream.requestHeaders && Object.keys(stream.requestHeaders).length) ||
      (stream.responseHeaders && Object.keys(stream.responseHeaders).length))
  ) {
    return null;
  }
  const msid = mediaSourceIdFor(stream);
  const container = containerOf(stream);
  const path = stream.url;

  const subs: { url: string; lang: string; id: string }[] = [
    ...(stream.subtitles ?? []).map((s) => ({
      url: s.url,
      lang: s.lang,
      id: s.id,
    })),
    ...opts.subtitles.map((s) => ({ url: s.url, lang: s.lang, id: s.id })),
  ];
  const mediaStreams = buildMediaStreams(
    stream,
    subs,
    (i, sub) =>
      `/Videos/${opts.itemId}/${msid}/Subtitles/${i}/0/Stream.${(sub.url.split('?')[0].split('.').pop() || 'srt').toLowerCase().replace(/[^a-z0-9]/g, '') || 'srt'}?api_key=${encodeURIComponent(opts.apiKey)}&u=${encodeURIComponent(opts.encrypt(sub.url))}`
  );
  const name = [formatted.name, formatted.description]
    .filter(Boolean)
    .join('\n');
  const isLive = stream.type === 'live';
  const subtitleIndex = mediaStreams.findIndex((s) => s.Type === 'Subtitle');

  return {
    Protocol: 'Http',
    Id: msid,
    Path: path,
    DirectStreamUrl: path,
    EncoderProtocol: undefined,
    Type: 'Default',
    Container: container,
    Size: stream.size,
    Name: name,
    IsRemote: true,
    ETag: msid,
    RunTimeTicks: isLive
      ? undefined
      : stream.duration
        ? stream.duration * TICKS_PER_MS
        : opts.runtimeTicks,
    ReadAtNativeFramerate: false,
    IgnoreDts: false,
    IgnoreIndex: false,
    GenPtsInput: false,
    SupportsTranscoding: false,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    IsInfiniteStream: isLive,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    SupportsProbing: false,
    VideoType: 'VideoFile',
    MediaStreams: mediaStreams,
    MediaAttachments: [],
    Formats: [],
    Bitrate: stream.bitrate,
    RequiredHttpHeaders: {},
    DefaultAudioStreamIndex: mediaStreams.findIndex((s) => s.Type === 'Audio'),
    DefaultSubtitleStreamIndex: -1,
    HasSegments: false,
  };
}
