import { AIOStreams } from '../main/index.js';
import type {
  Manifest,
  MetaPreview,
  ParsedMeta,
  ParsedStream,
  Subtitle,
  UserData,
} from '../db/schemas.js';
import { createFormatter } from '../formatters/index.js';
import { createLogger } from '../logging/logger.js';
import { config as appConfig } from '../config/index.js';
import {
  buildMediaSource,
  streamToPlayable,
  type JellyfinMediaSource,
  type MediaSourceBuildOptions,
  type PlayableStreamRecord,
} from './dto.js';

const logger = createLogger('jellyfin');

type Catalog = NonNullable<Manifest['catalogs']>[number];

const STREMIO_PAGE_GUESS = 100;

export interface CatalogPageOptions {
  startIndex: number;
  limit: number;
  search?: string;
  genre?: string;
}

export interface CatalogPageResult {
  items: MetaPreview[];
  hasMore: boolean;
  capped: boolean;
}

export interface ResolvedStreams {
  streams: ParsedStream[];
  formatted: { name: string; description: string }[];
  subtitles: Subtitle[];
  errors: { title?: string; description?: string }[];
}

export class JellyfinService {
  private engine: AIOStreams | null = null;
  private initPromise: Promise<AIOStreams> | null = null;
  private readonly metaMemo = new Map<string, Promise<ParsedMeta | null>>();
  private readonly catalogMemo = new Map<string, Promise<MetaPreview[]>>();
  private readonly subtitleMemo = new Map<string, Promise<Subtitle[]>>();
  private readonly streamsMemo = new Map<string, Promise<ResolvedStreams>>();

  constructor(readonly userData: UserData) {}

  async getEngine(): Promise<AIOStreams> {
    if (this.engine) return this.engine;
    if (!this.initPromise) {
      this.initPromise = new AIOStreams(this.userData, {
        skipFailedAddons: true,
      })
        .initialise()
        .then((e) => {
          this.engine = e;
          return e;
        });
    }
    return this.initPromise;
  }

  async getCatalogs(): Promise<Catalog[]> {
    const engine = await this.getEngine();
    return (engine.getCatalogs() ?? []) as Catalog[];
  }

  async findCatalog(type: string, id: string): Promise<Catalog | undefined> {
    const catalogs = await this.getCatalogs();
    return catalogs.find((c) => c.type === type && c.id === id);
  }

  private fetchCatalog(
    type: string,
    id: string,
    extras?: string
  ): Promise<MetaPreview[]> {
    const k = `${type}|${id}|${extras ?? ''}`;
    let memo = this.catalogMemo.get(k);
    if (!memo) {
      memo = (async () => {
        const engine = await this.getEngine();
        const res = await engine.getCatalog(type, id, extras);
        if (res.errors?.length) {
          logger.debug(
            { type, id, extras, errors: res.errors.length },
            'catalog returned with errors'
          );
        }
        return (res.data ?? []).filter((m) => m && m.id);
      })();
      this.catalogMemo.set(k, memo);
    }
    return memo;
  }

  async getCatalogPage(
    catalog: Catalog,
    opts: CatalogPageOptions
  ): Promise<CatalogPageResult> {
    const supports = (name: string) =>
      (catalog.extra ?? []).some((e) => e.name === name);
    const cap = appConfig.api.jellyfinMaxCatalogItems || Infinity;
    const extrasBase: string[] = [];
    if (opts.search) {
      if (!supports('search'))
        return { items: [], hasMore: false, capped: false };
      extrasBase.push(`search=${opts.search}`);
    }
    if (opts.genre) {
      if (!supports('genre'))
        return { items: [], hasMore: false, capped: false };
      extrasBase.push(`genre=${opts.genre}`);
    }
    const canSkip = supports('skip');
    const wantEnd = Math.min(opts.startIndex + opts.limit, cap);
    if (opts.startIndex >= wantEnd) {
      return { items: [], hasMore: false, capped: opts.startIndex >= cap };
    }

    const out: MetaPreview[] = [];
    let offset = 0;
    let skip = 0;
    let hasMore = true;
    let guard = 0;
    while (offset < wantEnd && hasMore && guard++ < 50) {
      const extras = [...extrasBase];
      if (skip > 0) {
        if (!canSkip) break;
        extras.push(`skip=${skip}`);
      }
      const page = await this.fetchCatalog(
        catalog.type,
        catalog.id,
        extras.length ? extras.join('&') : undefined
      );
      if (page.length === 0) {
        hasMore = false;
        break;
      }
      for (const item of page) {
        if (offset >= opts.startIndex && offset < wantEnd) out.push(item);
        offset++;
      }
      skip += page.length;
      if (page.length < Math.min(STREMIO_PAGE_GUESS, 20)) hasMore = false;
      if (!canSkip) hasMore = false;
    }
    const capped = wantEnd < opts.startIndex + opts.limit && offset >= cap;
    return {
      items: out,
      hasMore: hasMore && offset >= wantEnd && wantEnd < cap,
      capped,
    };
  }

  async getCatalogGenres(catalog: Catalog): Promise<string[]> {
    const extra = (catalog.extra ?? []).find((e) => e.name === 'genre');
    return (extra?.options ?? []).filter(
      (o): o is string => typeof o === 'string' && o.length > 0
    );
  }

  async search(
    term: string,
    types?: string[],
    limit = 50
  ): Promise<MetaPreview[]> {
    const catalogs = (await this.getCatalogs()).filter(
      (c) =>
        (c.extra ?? []).some((e) => e.name === 'search') &&
        (!types || types.includes(c.type))
    );
    const results = await Promise.allSettled(
      catalogs.map((c) =>
        this.getCatalogPage(c, { startIndex: 0, limit, search: term })
      )
    );
    const seen = new Set<string>();
    const out: MetaPreview[] = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const item of r.value.items) {
        const k = `${item.type}|${item.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(item);
      }
    }
    return out.slice(0, limit);
  }

  getMeta(type: string, id: string): Promise<ParsedMeta | null> {
    const k = `${type}|${id}`;
    let memo = this.metaMemo.get(k);
    if (!memo) {
      memo = (async () => {
        const engine = await this.getEngine();
        const res = await engine.getMeta(type, id);
        return res.data ?? null;
      })();
      this.metaMemo.set(k, memo);
    }
    return memo;
  }

  async getMetaLoose(type: string, id: string): Promise<ParsedMeta | null> {
    const order =
      type === 'anime'
        ? [type, 'series']
        : type === 'series'
          ? [type, 'anime']
          : [type];
    for (const t of order) {
      try {
        const meta = await this.getMeta(t, id);
        if (meta) return meta;
      } catch (e) {
        logger.debug(
          `meta ${t}/${id} failed: ${e instanceof Error ? e.message : e}`
        );
      }
    }
    return null;
  }

  async resolveVideoId(type: string, id: string): Promise<string> {
    const meta = await this.getMetaLoose(type, id).catch(() => null);
    const hinted = meta?.behaviorHints?.defaultVideoId;
    if (typeof hinted === 'string' && hinted) return hinted;
    if (typeof meta?.id === 'string' && meta.id) return meta.id;
    return id;
  }

  getSubtitles(type: string, videoId: string): Promise<Subtitle[]> {
    const k = `${type}|${videoId}`;
    let memo = this.subtitleMemo.get(k);
    if (!memo) {
      memo = (async () => {
        try {
          const engine = await this.getEngine();
          const res = await engine.getSubtitles(type, videoId);
          return res.data ?? [];
        } catch (e) {
          logger.debug(
            `subtitles ${type}/${videoId} failed: ${e instanceof Error ? e.message : e}`
          );
          return [];
        }
      })();
      this.subtitleMemo.set(k, memo);
    }
    return memo;
  }

  resolveStreams(
    type: string,
    videoId: string,
    withSubtitles = true
  ): Promise<ResolvedStreams> {
    const k = `${type}|${videoId}|${withSubtitles ? 1 : 0}`;
    let memo = this.streamsMemo.get(k);
    if (!memo) {
      memo = (async () => {
        const engine = await this.getEngine();
        const [response, subtitles] = await Promise.all([
          engine.getStreams(videoId, type),
          withSubtitles
            ? this.getSubtitles(type, videoId)
            : Promise.resolve([] as Subtitle[]),
        ]);
        const streams = response.data.streams.filter((s) => !!s.url);
        const ctx = engine.getStreamContext();
        const formatter = ctx
          ? createFormatter(ctx.toFormatterContext(streams))
          : null;
        const formatted = await Promise.all(
          streams.map(async (s) => {
            if (s.addon.formatPassthrough || !formatter) {
              return {
                name: s.originalName || s.addon.name,
                description: s.originalDescription || '',
              };
            }
            try {
              return await formatter.format(s);
            } catch {
              return {
                name: s.originalName || s.addon.name,
                description: s.originalDescription || '',
              };
            }
          })
        );
        return {
          streams,
          formatted,
          subtitles,
          errors: response.errors ?? [],
        };
      })();
      this.streamsMemo.set(k, memo);
    }
    return memo;
  }

  async resolvePlayable(
    type: string,
    videoId: string
  ): Promise<PlayableStreamRecord[]> {
    const resolved = await this.resolveStreams(type, videoId, false);
    return resolved.streams
      .map((s, i) => streamToPlayable(s, resolved.formatted[i].name))
      .filter((p): p is PlayableStreamRecord => p !== null);
  }

  async buildMediaSources(
    type: string,
    videoId: string,
    opts: Omit<MediaSourceBuildOptions, 'subtitles'>
  ): Promise<{
    sources: JellyfinMediaSource[];
    errors: ResolvedStreams['errors'];
  }> {
    const resolved = await this.resolveStreams(type, videoId);
    const sources = resolved.streams
      .map((s, i) =>
        buildMediaSource(s, resolved.formatted[i], {
          ...opts,
          subtitles: resolved.subtitles,
        })
      )
      .filter((m): m is JellyfinMediaSource => m !== null);
    return { sources, errors: resolved.errors };
  }
}
