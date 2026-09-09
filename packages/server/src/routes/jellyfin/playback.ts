import { Router, type Request, type Response } from 'express';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import {
  config as appConfig,
  createLogger,
  decodeJellyfinId,
  decryptString,
  encryptString,
  JellyfinRepository,
  makeRequest,
  recallImages,
  rememberImages,
  parseRuntimeToTicks,
  type ItemImages,
  type JellyfinItemDescriptor,
  type PlayableStreamRecord,
  type RememberedImages,
} from '@aiostreams/core';
import { jf, qi, qs, type JellyfinRequestContext, param } from './context.js';
import { isRelayLoop } from './relay-target.js';

const logger = createLogger('jellyfin');
const router: Router = Router({ mergeParams: true });

const RELAY_OPTIONS = { ignoreRecursion: true } as const;

let selfOriginsMemo: Set<string> | null = null;
function selfOrigins(): Set<string> {
  if (selfOriginsMemo) return selfOriginsMemo;
  const origins = new Set<string>();
  for (const candidate of [
    appConfig.bootstrap.baseUrl,
    appConfig.bootstrap.internalUrl,
    `http://localhost:${appConfig.bootstrap.port}`,
  ]) {
    if (!candidate) continue;
    try {
      origins.add(new URL(candidate).origin);
    } catch {}
  }
  selfOriginsMemo = origins;
  return origins;
}

async function relay(url: string, headers?: Record<string, string>) {
  if (isRelayLoop(url, selfOrigins())) {
    throw new Error('relay target loops back to this server');
  }
  const timeout = appConfig.api.jellyfinRelayTimeout;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await makeRequest(url, {
      ...RELAY_OPTIONS,
      timeout,
      signal: controller.signal,
      headers,
    });
  } finally {
    clearTimeout(timer);
  }
}

function encrypt(plain: string): string {
  const r = encryptString(plain);
  if (!r.success || !r.data) throw new Error('encryption failed');
  return r.data;
}

function decrypt(token: string): string | null {
  const r = decryptString(token);
  return r.success && r.data != null ? r.data : null;
}

async function playTarget(
  ctx: JellyfinRequestContext,
  d: JellyfinItemDescriptor
): Promise<{ type: string; videoId: string; seriesId?: string } | null> {
  if (d.k === 'movie')
    return { type: d.t, videoId: await ctx.service.resolveVideoId(d.t, d.i) };
  if (d.k === 'episode') return { type: d.t, videoId: d.v, seriesId: d.i };
  if (d.k === 'series')
    return {
      type: d.t,
      videoId: await ctx.service.resolveVideoId(d.t, d.i),
      seriesId: d.i,
    };
  return null;
}

async function runtimeTicksFor(
  ctx: JellyfinRequestContext,
  d: JellyfinItemDescriptor
): Promise<number | undefined> {
  if (d.k !== 'movie' && d.k !== 'episode' && d.k !== 'series')
    return undefined;
  const meta = await ctx.service.getMetaLoose(d.t, d.i).catch(() => null);
  return parseRuntimeToTicks(meta?.runtime);
}

function clientMatches(clientName: string, clients: readonly string[]) {
  const lower = clientName.toLowerCase();
  return clients.some((c) => c && lower.includes(c.toLowerCase()));
}

const SOURCES_ATTACH_CLIENT_CAP = 50;

async function playbackInfo(
  req: Request,
  res: Response,
  ctx: JellyfinRequestContext
) {
  const itemId = param(req, 'itemId');
  const d = await decodeJellyfinId(itemId);
  const target = d ? await playTarget(ctx, d) : null;
  if (!d || !target) {
    res
      .status(404)
      .json({ MediaSources: [], PlaySessionId: '', ErrorCode: 'NotAllowed' });
    return;
  }
  const requestedSource =
    qs(req, 'MediaSourceId') ??
    (req.body as Record<string, unknown> | undefined)?.MediaSourceId;
  const runtimeTicks = await runtimeTicksFor(ctx, d);
  const { sources, errors } = await ctx.service.buildMediaSources(
    target.type,
    target.videoId,
    {
      baseUrl: ctx.baseUrl,
      itemId: itemId.replace(/-/g, '').toLowerCase(),
      apiKey: ctx.apiKey,
      encrypt,
      runtimeTicks,
      withSubtitles: true,
    }
  );
  const normalizedItemId = itemId.replace(/-/g, '').toLowerCase();
  // SenPlayer-style clients (jellyfinAttachSourcesClients) rely on the full
  // source list to build their version picker; everyone else gets the
  // configurable cap (default 20) since Infuse only shows the picker
  // briefly and picks the first source by default (D3).
  const maxSources = clientMatches(
    ctx.client.name,
    appConfig.api.jellyfinAttachSourcesClients
  )
    ? SOURCES_ATTACH_CLIENT_CAP
    : appConfig.api.jellyfinMaxPlaybackSources;
  let out = sources.slice(0, maxSources);
  const specific =
    typeof requestedSource === 'string' &&
    requestedSource &&
    requestedSource.replace(/-/g, '').toLowerCase() !== normalizedItemId;
  if (specific) {
    const picked = sources.filter((s) => s.Id === requestedSource);
    if (picked.length) out = picked;
  }
  if (!specific && out.length) {
    out[0] = { ...out[0], Id: normalizedItemId, ETag: normalizedItemId };
  }
  if (!specific && out.length > 5) {
    // Beyond the first 5 sources, drop MediaStreams to cut payload size.
    // Infuse reads streams from the selected source at play time via the
    // stream itself (resolveStreamTarget does not read MediaSources).
    out = out.map((s, i) => (i < 5 ? s : { ...s, MediaStreams: [] }));
  }
  if (!out.length) {
    const reason = errors
      .map((e) => [e.title, e.description].filter(Boolean).join(': '))
      .join('; ');
    logger.warn(
      { itemId, type: target.type, videoId: target.videoId, reason },
      'no playable sources'
    );
    res.json({
      MediaSources: [],
      PlaySessionId: `${ctx.userId}-${Date.now()}`,
      ErrorCode: 'NoCompatibleStream',
    });
    return;
  }
  res.json({
    MediaSources: out,
    PlaySessionId: `${ctx.userId}-${Date.now().toString(36)}`,
  });
}

router.get('/Items/:itemId/PlaybackInfo', jf(playbackInfo));
router.post('/Items/:itemId/PlaybackInfo', jf(playbackInfo));

router.get(
  '/Items/:itemId/MediaSources',
  jf(async (req, res, ctx) => {
    await playbackInfo(req, res, ctx);
  })
);

interface StreamTarget {
  url: string;
  headers?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  filename?: string;
}

async function resolveStreamTarget(
  req: Request,
  ctx: JellyfinRequestContext,
  d: JellyfinItemDescriptor
): Promise<StreamTarget | null> {
  const t = qs(req, 't');
  if (t) {
    const plain = decrypt(t);
    if (plain) {
      try {
        const parsed = JSON.parse(plain) as {
          u: string;
          h?: Record<string, string>;
          r?: Record<string, string>;
          f?: string;
        };
        if (parsed.u)
          return {
            url: parsed.u,
            headers: parsed.h,
            responseHeaders: parsed.r,
            filename: parsed.f,
          };
      } catch {}
    }
  }
  const target = await playTarget(ctx, d);
  if (!target) return null;
  const rawMsid = qs(req, 'MediaSourceId');
  const itemGuid = param(req, 'itemId').replace(/-/g, '').toLowerCase();
  const msid =
    rawMsid && rawMsid.replace(/-/g, '').toLowerCase() === itemGuid
      ? undefined
      : rawMsid;
  const playable = await ctx.service.resolvePlayable(
    target.type,
    target.videoId
  );
  if (!playable.length) return null;
  const pick: PlayableStreamRecord | undefined = msid
    ? playable.find((p) => p.msid === msid)
    : playable[0];
  const chosen = pick ?? playable[0];
  return {
    url: chosen.url,
    headers: chosen.headers,
    responseHeaders: chosen.responseHeaders,
    filename: chosen.filename,
  };
}

async function streamHandler(
  req: Request,
  res: Response,
  ctx: JellyfinRequestContext
) {
  const d = await decodeJellyfinId(param(req, 'itemId'));
  if (!d) {
    res.status(404).json({ Message: 'Item not found' });
    return;
  }
  const target = await resolveStreamTarget(req, ctx, d);
  if (!target) {
    res.status(404).json({ Message: 'No playable stream' });
    return;
  }
  res.redirect(302, target.url);
}

router.get(
  [
    '/Videos/:itemId/stream',
    '/Videos/:itemId/stream.:ext',
    '/Videos/:itemId/stream/:filename',
    '/Videos/:itemId/original',
    '/Videos/:itemId/original.:ext',
    '/Items/:itemId/Download',
    '/Items/:itemId/File',
  ],
  jf(streamHandler)
);
router.head(
  [
    '/Videos/:itemId/stream',
    '/Videos/:itemId/stream.:ext',
    '/Videos/:itemId/stream/:filename',
    '/Items/:itemId/Download',
  ],
  jf(streamHandler)
);

router.get(
  [
    '/Videos/:itemId/master.m3u8',
    '/Videos/:itemId/main.m3u8',
    '/Videos/:itemId/live.m3u8',
    '/Videos/:itemId/hls1/{*rest}',
    '/Videos/:itemId/hls/{*rest}',
  ],
  jf(async (_req, res) => {
    res.status(501).json({
      Message: 'Transcoding is not supported by this server; use direct play.',
    });
  })
);
router.delete('/Videos/ActiveEncodings', (_req, res) => {
  res.status(204).end();
});

router.get(
  [
    '/Videos/:itemId/:mediaSourceId/Subtitles/:index/Stream.:format',
    '/Videos/:itemId/:mediaSourceId/Subtitles/:index/:start/Stream.:format',
  ],
  jf(async (req, res, ctx) => {
    const u = qs(req, 'u');
    let url = u ? decrypt(u) : null;
    if (!url) {
      const d = await decodeJellyfinId(param(req, 'itemId'));
      const target = d ? await playTarget(ctx, d) : null;
      if (target) {
        const playable = await ctx.service.resolvePlayable(
          target.type,
          target.videoId
        );
        const rec = playable.find(
          (p) => p.msid === param(req, 'mediaSourceId')
        );
        const idx = Number(param(req, 'index'));
        const subs = [
          ...(rec?.subtitles ?? []),
          ...(await ctx.service.getSubtitles(target.type, target.videoId)),
        ];
        url = subs[idx]?.url ?? null;
      }
    }
    if (!url) {
      res.status(404).end();
      return;
    }
    try {
      const upstream = await relay(url);
      if (!upstream.ok || !upstream.body) {
        res.status(upstream.status >= 400 ? upstream.status : 502).end();
        return;
      }
      res.status(200);
      res.setHeader(
        'content-type',
        upstream.headers.get('content-type') ?? 'text/plain; charset=utf-8'
      );
      await pipeline(
        Readable.fromWeb(upstream.body as import('stream/web').ReadableStream),
        res
      ).catch(() => undefined);
    } catch (error) {
      logger.debug(
        { err: error instanceof Error ? error.message : String(error) },
        'subtitle relay failed'
      );
      if (!res.headersSent) res.status(502).end();
    }
  })
);

const FALLBACK_IMAGE = '/logo.png';

function metahubImageUrl(
  d: JellyfinItemDescriptor,
  want: string
): string | null {
  if (!('i' in d) || typeof d.i !== 'string' || !d.i.startsWith('tt'))
    return null;
  if (d.k === 'episode')
    return `https://images.metahub.space/background/medium/${d.i}/img`;
  if (d.k !== 'movie' && d.k !== 'series' && d.k !== 'season') return null;
  if (want === 'primary' || want === 'thumb')
    return `https://images.metahub.space/poster/medium/${d.i}/img`;
  if (want === 'backdrop' || want === 'art' || want === 'banner')
    return `https://images.metahub.space/background/medium/${d.i}/img`;
  if (want === 'logo')
    return `https://images.metahub.space/logo/medium/${d.i}/img`;
  return null;
}

interface ResolvedImage {
  url: string;
  public: boolean;
}

// Hosts that serve artwork over plain public URLs with no auth/secret in
// the path, so we can redirect Jellyfin clients straight to them instead
// of relaying the bytes through this server (D2).
const PUBLIC_IMAGE_HOSTS = [
  'image.tmdb.org',
  'artworks.thetvdb.com',
  'images.metahub.space',
  'm.media-amazon.com',
  'assets.fanart.tv',
];

function isPublicImageHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PUBLIC_IMAGE_HOSTS.some((h) => host.endsWith(h));
  } catch {
    return false;
  }
}

// TMDB only accepts these exact size buckets per image kind.
const TMDB_POSTER_SIZES = [
  { name: 'w185', px: 185 },
  { name: 'w342', px: 342 },
  { name: 'w500', px: 500 },
  { name: 'w780', px: 780 },
  { name: 'original', px: Infinity },
];
const TMDB_BACKDROP_SIZES = [
  { name: 'w300', px: 300 },
  { name: 'w780', px: 780 },
  { name: 'w1280', px: 1280 },
  { name: 'original', px: Infinity },
];
const TMDB_PROFILE_SIZES = [
  { name: 'w185', px: 185 },
  { name: 'h632', px: 632 },
  { name: 'original', px: Infinity },
];

function requestedImageWidth(req: Request): number | undefined {
  for (const key of ['maxWidth', 'fillWidth', 'width']) {
    const n = qi(req, key, NaN);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

// Rewrite a TMDB `/t/p/<size>/...` URL to the smallest bucket that is >=
// the requested width (or a sane default when no size was requested).
// Non-TMDB hosts (TVDB has no size variants) are returned unchanged.
function sizeImageUrl(
  url: string,
  want: string,
  req: Request,
  isPerson: boolean
): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!u.hostname.toLowerCase().endsWith('image.tmdb.org')) return url;
  const match = u.pathname.match(/^(\/t\/p\/)([^/]+)(\/.+)$/);
  if (!match) return url;
  const isBackdrop = want === 'backdrop' || want === 'art' || want === 'banner';
  const sizes = isPerson
    ? TMDB_PROFILE_SIZES
    : isBackdrop
      ? TMDB_BACKDROP_SIZES
      : TMDB_POSTER_SIZES;
  const requestedWidth = requestedImageWidth(req);
  const target =
    requestedWidth != null
      ? (sizes.find((s) => s.px >= requestedWidth) ?? sizes[sizes.length - 1])
      : (sizes.find(
          (s) =>
            s.name === (isPerson ? 'w185' : isBackdrop ? 'w1280' : 'w500')
        ) ?? sizes[sizes.length - 1]);
  u.pathname = `${match[1]}${target.name}${match[3]}`;
  return u.toString();
}

const ARTWORK_KINDS = new Set([
  'movie',
  'series',
  'season',
  'episode',
  'person',
]);

const inflightRebuilds = new Map<
  string,
  Promise<RememberedImages | undefined>
>();

async function rebuildImages(
  uuid: string | undefined,
  getCtx: () => Promise<JellyfinRequestContext | null>,
  d: JellyfinItemDescriptor,
  id: string
): Promise<RememberedImages | undefined> {
  const run = async (): Promise<RememberedImages | undefined> => {
    const ctx = await getCtx().catch(() => null);
    if (!ctx) return undefined;
    const { itemFromDescriptor } = await import('./items.js');
    const ran = await itemFromDescriptor(ctx, d).then(
      () => true,
      () => false
    );
    const found = await recallImages(ctx.uuid, id);
    if (found?.complete) return found;
    if (!ran) return found;
    const settled = { images: found?.images ?? {}, complete: true };
    rememberImages(ctx.uuid, id, settled.images, true);
    return settled;
  };
  if (!uuid) return run();
  const cacheKey = `${uuid}|${id}`;
  let inFlight = inflightRebuilds.get(cacheKey);
  if (!inFlight) {
    inFlight = run().finally(() => inflightRebuilds.delete(cacheKey));
    inflightRebuilds.set(cacheKey, inFlight);
  }
  return inFlight;
}

async function imageUrlFor(
  uuid: string | undefined,
  getCtx: () => Promise<JellyfinRequestContext | null>,
  itemId: string,
  type: string,
  req: Request,
  opts: { rebuild?: boolean } = {}
): Promise<ResolvedImage | null> {
  const id = itemId.replace(/-/g, '').toLowerCase();
  const want = type.toLowerCase();
  const pick = (imgs: ItemImages | undefined) => {
    if (!imgs) return null;
    switch (want) {
      case 'primary':
        return imgs.Primary ?? imgs.Thumb ?? imgs.Backdrop ?? null;
      case 'backdrop':
      case 'art':
      case 'banner':
        return imgs.Backdrop ?? imgs.Primary ?? null;
      case 'thumb':
        return imgs.Thumb ?? imgs.Backdrop ?? imgs.Primary ?? null;
      case 'logo':
        return imgs.Logo ?? null;
      default:
        return imgs.Primary ?? null;
    }
  };
  // Decoded up front (cheap: most ids unpack synchronously) so both the
  // cache-hit and cache-miss paths know whether this is a person, which
  // TMDB image sizing needs (profile sizes differ from poster/backdrop).
  const d = await decodeJellyfinId(id).catch(() => null);
  const isPerson = d?.k === 'person';
  const resolve = (url: string): ResolvedImage => {
    if (!isPublicImageHost(url)) return { url, public: false };
    return { url: sizeImageUrl(url, want, req, isPerson), public: true };
  };
  const remembered = uuid ? await recallImages(uuid, id) : undefined;
  const cached = pick(remembered?.images);
  if (cached) return resolve(cached);
  if (!d) return null;
  if (!ARTWORK_KINDS.has(d.k)) return null;
  if (d.k === 'person') return null;
  if (opts.rebuild !== false && !remembered?.complete) {
    const rebuilt = pick((await rebuildImages(uuid, getCtx, d, id))?.images);
    if (rebuilt) return resolve(rebuilt);
  }
  const fallback = metahubImageUrl(d, want);
  return fallback ? { url: fallback, public: true } : null;
}

function lazyCtx(req: Request): () => Promise<JellyfinRequestContext | null> {
  return () =>
    req.jf
      ? Promise.resolve(req.jf)
      : (req.jfLazy?.() ?? Promise.resolve(null));
}

async function fallbackImageUrl(
  itemId: string,
  type: string
): Promise<string | null> {
  const id = itemId.replace(/-/g, '').toLowerCase();
  const d = await decodeJellyfinId(id).catch(() => null);
  if (!d) return null;
  return metahubImageUrl(d, type.toLowerCase());
}

router.get(
  ['/Items/:itemId/Images/:type', '/Items/:itemId/Images/:type/:index'],
  async (req, res) => {
    const itemIdParam = param(req, 'itemId');
    const typeParam = param(req, 'type');
    const result = await imageUrlFor(
      req.uuid,
      lazyCtx(req),
      itemIdParam,
      typeParam,
      req
    ).catch(() => null);
    if (!result) {
      res.status(404).end();
      return;
    }
    if (result.public) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.redirect(302, result.url);
      return;
    }
    try {
      const headers: Record<string, string> = {};
      const inm = req.headers['if-none-match'];
      if (typeof inm === 'string') headers['if-none-match'] = inm;
      const ims = req.headers['if-modified-since'];
      if (typeof ims === 'string') headers['if-modified-since'] = ims;
      const upstream = await relay(result.url, headers);
      if (upstream.status >= 400) {
        const fallbackUrl = await fallbackImageUrl(itemIdParam, typeParam);
        if (fallbackUrl) {
          res.redirect(302, fallbackUrl);
        } else {
          res.status(404).end();
        }
        return;
      }
      res.status(upstream.status);
      for (const h of [
        'content-type',
        'content-length',
        'etag',
        'last-modified',
        'cache-control',
        'expires',
      ]) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      if (!upstream.body || upstream.status === 304) {
        res.end();
        return;
      }
      await pipeline(
        Readable.fromWeb(upstream.body as import('stream/web').ReadableStream),
        res
      ).catch(() => undefined);
    } catch (error) {
      logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          url: result.url,
          itemId: itemIdParam,
          type: typeParam,
        },
        'image relay failed'
      );
      if (res.headersSent) return;
      res.status(404).end();
    }
  }
);
router.head(
  ['/Items/:itemId/Images/:type', '/Items/:itemId/Images/:type/:index'],
  async (req, res) => {
    const result = await imageUrlFor(
      req.uuid,
      lazyCtx(req),
      param(req, 'itemId'),
      param(req, 'type'),
      req,
      { rebuild: false }
    ).catch(() => null);
    if (!result) {
      res.status(404).end();
      return;
    }
    if (result.public) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.redirect(302, result.url);
      return;
    }
    res.status(200).end();
  }
);
router.get(
  '/Items/:itemId/Images',
  jf(async (req, res, ctx) => {
    const id = param(req, 'itemId').replace(/-/g, '').toLowerCase();
    const imgs = (await recallImages(ctx.uuid, id))?.images ?? {};
    const out = Object.entries(imgs)
      .filter(([, v]) => !!v)
      .map(([k]) => ({
        ImageType: k,
        ImageIndex: k === 'Backdrop' ? 0 : undefined,
        Path: '',
        Size: 0,
        Width: 0,
        Height: 0,
      }));
    res.json(out);
  })
);
router.get(
  [
    '/Users/:userId/Images/:type',
    '/Users/:userId/Images/:type/:index',
    '/UserImage',
  ],
  (_req, res) => {
    res.redirect(302, FALLBACK_IMAGE);
  }
);
router.get(['/Branding/Splashscreen'], (_req, res) => {
  res.redirect(302, FALLBACK_IMAGE);
});
router.get('/Images/General/:name/:type', (_req, res) => {
  res.redirect(302, FALLBACK_IMAGE);
});

function ticksFrom(
  body: Record<string, unknown>,
  req: Request,
  key: string
): number | undefined {
  const v =
    body[key] ??
    body[key.charAt(0).toLowerCase() + key.slice(1)] ??
    qs(req, key);
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function idFrom(
  body: Record<string, unknown>,
  req: Request
): string | undefined {
  const v =
    body.ItemId ?? body.itemId ?? qs(req, 'ItemId') ?? param(req, 'itemId');
  return typeof v === 'string' && v
    ? v.replace(/-/g, '').toLowerCase()
    : undefined;
}

const PLAYED_THRESHOLD = 0.9;

const PROGRESS_MIN_DELTA_TICKS = 30 * 10_000_000;
const PROGRESS_MIN_WALL_MS = 60_000;
const lastProgressWrite = new Map<string, { pos: number; at: number }>();
const LAST_PROGRESS_MAX = 20_000;

async function recordProgress(
  ctx: JellyfinRequestContext,
  itemId: string,
  positionTicks: number | undefined,
  event: 'start' | 'progress' | 'stop'
) {
  const d = await decodeJellyfinId(itemId);
  if (!d || (d.k !== 'movie' && d.k !== 'episode')) return;
  const throttleKey = `${ctx.uuid}:${itemId}`;
  if (event === 'progress' && positionTicks != null) {
    const last = lastProgressWrite.get(throttleKey);
    if (
      last &&
      Math.abs(positionTicks - last.pos) < PROGRESS_MIN_DELTA_TICKS &&
      Date.now() - last.at < PROGRESS_MIN_WALL_MS
    ) {
      return;
    }
  }
  if (lastProgressWrite.size >= LAST_PROGRESS_MAX) lastProgressWrite.clear();
  lastProgressWrite.set(throttleKey, {
    pos: positionTicks ?? 0,
    at: Date.now(),
  });
  const runtimeTicks = (await runtimeTicksFor(ctx, d)) ?? 0;
  const existing = await JellyfinRepository.getPlaystate(ctx.uuid, itemId);
  const rt = runtimeTicks || existing?.runtimeTicks || 0;
  const pos = positionTicks ?? existing?.positionTicks ?? 0;
  const now = Date.now();
  if (event === 'start') {
    await JellyfinRepository.upsertPlaystate(ctx.uuid, itemId, d, {
      runtimeTicks: rt || undefined,
      positionTicks: positionTicks ?? undefined,
      lastPlayedAt: now,
    });
    return;
  }
  const finished = rt > 0 && pos >= rt * PLAYED_THRESHOLD;
  if (finished) {
    await JellyfinRepository.upsertPlaystate(ctx.uuid, itemId, d, {
      positionTicks: 0,
      runtimeTicks: rt || undefined,
      played: true,
      incrementPlayCount: event === 'stop' ? 'if-unplayed' : false,
      lastPlayedAt: now,
    });
    return;
  }
  await JellyfinRepository.upsertPlaystate(ctx.uuid, itemId, d, {
    positionTicks: pos,
    runtimeTicks: rt || undefined,
    played: false,
    lastPlayedAt: now,
  });
}

router.post(
  ['/Sessions/Playing', '/PlayingItems/:itemId'],
  jf(async (req, res, ctx) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = idFrom(body, req);
    if (id)
      await recordProgress(
        ctx,
        id,
        ticksFrom(body, req, 'PositionTicks'),
        'start'
      );
    res.status(204).end();
  })
);
router.post(
  ['/Sessions/Playing/Progress', '/PlayingItems/:itemId/Progress'],
  jf(async (req, res, ctx) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = idFrom(body, req);
    if (id)
      await recordProgress(
        ctx,
        id,
        ticksFrom(body, req, 'PositionTicks'),
        'progress'
      );
    res.status(204).end();
  })
);
router.post(
  ['/Sessions/Playing/Stopped'],
  jf(async (req, res, ctx) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = idFrom(body, req);
    if (id)
      await recordProgress(
        ctx,
        id,
        ticksFrom(body, req, 'PositionTicks'),
        'stop'
      );
    res.status(204).end();
  })
);
router.delete(
  '/PlayingItems/:itemId',
  jf(async (req, res, ctx) => {
    const id = idFrom({}, req);
    if (id)
      await recordProgress(
        ctx,
        id,
        ticksFrom({}, req, 'PositionTicks'),
        'stop'
      );
    res.status(204).end();
  })
);
router.post('/Sessions/Playing/Ping', (_req, res) => {
  res.status(204).end();
});

async function userDataResponse(ctx: JellyfinRequestContext, itemId: string) {
  const d = await decodeJellyfinId(itemId);
  if (!d) return null;
  const { itemFromDescriptor } = await import('./items.js');
  const row = await JellyfinRepository.getPlaystate(ctx.uuid, itemId);
  const item = await itemFromDescriptor(ctx, d, {
    playstate: row ?? undefined,
  });
  return item?.UserData ?? null;
}

router.post(
  ['/Users/:userId/PlayedItems/:itemId', '/UserPlayedItems/:itemId'],
  jf(async (req, res, ctx) => {
    const id = param(req, 'itemId').replace(/-/g, '').toLowerCase();
    const d = await decodeJellyfinId(id);
    if (!d) {
      res.status(404).json({ Message: 'Item not found' });
      return;
    }
    if (d.k === 'series' || d.k === 'season') {
      const { episodesForSeries } = await import('./items.js');
      const r = await episodesForSeries(
        ctx,
        d,
        d.k === 'season' ? d.s : undefined
      );
      for (const ep of r?.episodes ?? []) {
        const epDesc = (ep as { _aio?: { descriptor: JellyfinItemDescriptor } })
          ._aio?.descriptor;
        if (!epDesc) continue;
        await JellyfinRepository.upsertPlaystate(ctx.uuid, ep.Id, epDesc, {
          played: true,
          positionTicks: 0,
          incrementPlayCount: true,
          lastPlayedAt: Date.now(),
        });
      }
    } else {
      await JellyfinRepository.upsertPlaystate(ctx.uuid, id, d, {
        played: true,
        positionTicks: 0,
        incrementPlayCount: true,
        lastPlayedAt: Date.now(),
      });
    }
    res.json((await userDataResponse(ctx, id)) ?? { Played: true });
  })
);
router.delete(
  ['/Users/:userId/PlayedItems/:itemId', '/UserPlayedItems/:itemId'],
  jf(async (req, res, ctx) => {
    const id = param(req, 'itemId').replace(/-/g, '').toLowerCase();
    const d = await decodeJellyfinId(id);
    if (!d) {
      res.status(404).json({ Message: 'Item not found' });
      return;
    }
    if (d.k === 'series' || d.k === 'season') {
      const { episodesForSeries } = await import('./items.js');
      const r = await episodesForSeries(
        ctx,
        d,
        d.k === 'season' ? d.s : undefined
      );
      for (const ep of r?.episodes ?? []) {
        const epDesc = (ep as { _aio?: { descriptor: JellyfinItemDescriptor } })
          ._aio?.descriptor;
        if (!epDesc) continue;
        await JellyfinRepository.upsertPlaystate(ctx.uuid, ep.Id, epDesc, {
          played: false,
          positionTicks: 0,
        });
      }
    } else {
      await JellyfinRepository.upsertPlaystate(ctx.uuid, id, d, {
        played: false,
        positionTicks: 0,
      });
    }
    res.json((await userDataResponse(ctx, id)) ?? { Played: false });
  })
);

router.post(
  ['/UserItems/:itemId/UserData', '/Users/:userId/Items/:itemId/UserData'],
  jf(async (req, res, ctx) => {
    const id = param(req, 'itemId').replace(/-/g, '').toLowerCase();
    const d = await decodeJellyfinId(id);
    if (!d) {
      res.status(404).json({ Message: 'Item not found' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    await JellyfinRepository.upsertPlaystate(ctx.uuid, id, d, {
      played: typeof body.Played === 'boolean' ? body.Played : undefined,
      favorite:
        typeof body.IsFavorite === 'boolean' ? body.IsFavorite : undefined,
      positionTicks:
        typeof body.PlaybackPositionTicks === 'number'
          ? body.PlaybackPositionTicks
          : undefined,
    });
    res.json((await userDataResponse(ctx, id)) ?? {});
  })
);
router.get(
  ['/UserItems/:itemId/UserData', '/Users/:userId/Items/:itemId/UserData'],
  jf(async (req, res, ctx) => {
    const id = param(req, 'itemId').replace(/-/g, '').toLowerCase();
    res.json((await userDataResponse(ctx, id)) ?? {});
  })
);

export default router;
