import rateLimit, { MemoryStore, ipKeyGenerator } from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';
import { RedisStore } from 'rate-limit-redis';
import {
  Env,
  appConfig,
  createLogger,
  constants,
  APIError,
  Cache,
  REDIS_PREFIX,
} from '@aiostreams/core';
import { parseMediaBrowserHeader } from '../routes/jellyfin/context.js';

const logger = createLogger('server');

const createRateLimiter = (
  windowMs: number,
  maxRequests: number,
  prefix: string = '',
  keyExtra?: (req: Request) => string | undefined
) => {
  if (appConfig.rateLimits.disabled) {
    return (req: Request, res: Response, next: NextFunction) => next();
  }
  const redisClient = appConfig.bootstrap.redisUri
    ? Cache.getRedisClient()
    : undefined;
  const store =
    redisClient && appConfig.rateLimits.store === 'redis'
      ? new RedisStore({
          prefix: `${REDIS_PREFIX}rate-limit:`,
          sendCommand: (...args: string[]) => redisClient.sendCommand(args),
        })
      : new MemoryStore();
  return rateLimit({
    windowMs,
    max: maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    validate: { creationStack: false },
    keyGenerator: (req: Request) => {
      const ip = req.requestIp || req.userIp || req.ip;
      const ipKey = ip ? ipKeyGenerator(ip) : '';
      const extra = keyExtra ? keyExtra(req) : undefined;
      return extra ? prefix + ':' + ipKey + ':' + extra : prefix + ':' + ipKey;
    },
    handler: (
      req: Request,
      res: Response,
      next: NextFunction,
      options: any
    ) => {
      const timeRemaining = req.rateLimit?.resetTime
        ? req.rateLimit.resetTime.getTime() - new Date().getTime()
        : 0;
      logger.warn(
        `${prefix} rate limit exceeded for IP: ${req.requestIp || req.userIp || req.ip} - ${
          options.message
        } - Time remaining: ${timeRemaining}ms`
      );
      throw new APIError(constants.ErrorCode.RATE_LIMIT_EXCEEDED);
    },
  });
};

/**
 * Each limiter reads `appConfig.rateLimits.*`, which is unavailable at
 * module-load time. Wrap the construction so the underlying express-rate-limit
 * instance is built on the first incoming request (after `initialiseConfig()`
 * has resolved) and reused thereafter.
 */
const lazyLimiter = (
  resolve: () => { window: number; maxRequests: number },
  prefix: string,
  keyExtra?: (req: Request) => string | undefined
) => {
  let limiter: ReturnType<typeof createRateLimiter> | null = null;
  return (req: Request, res: Response, next: NextFunction) => {
    if (!limiter) {
      const { window, maxRequests } = resolve();
      limiter = createRateLimiter(
        window * 1000,
        maxRequests,
        prefix,
        keyExtra
      );
    }
    return limiter(req, res, next);
  };
};

/**
 * Keys the Jellyfin browse limiter by device (in addition to IP) so one
 * Infuse device fanning out N parallel library requests doesn't starve the
 * bucket for every other device sharing the same IP/NAT. Falls back to the
 * first 12 chars of `api_key` when no MediaBrowser/Emby auth header is
 * present, else undefined (IP-only).
 */
const jellyfinDeviceKeyExtra = (req: Request): string | undefined => {
  const mb = parseMediaBrowserHeader(
    req.get('authorization') ?? req.get('x-emby-authorization')
  );
  if (mb.deviceid) return mb.deviceid;
  const apiKey =
    typeof req.query.api_key === 'string' ? req.query.api_key : undefined;
  return apiKey ? apiKey.slice(0, 12) : undefined;
};

const userApiRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.userApi,
  'user-api'
);

const userCreateRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.userCreate,
  'user-create'
);

const streamApiRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.streamApi,
  'stream-api'
);

const formatApiRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.formatApi,
  'format-api'
);

const catalogApiRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.catalogApi,
  'catalog-api'
);

const animeApiRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.animeApi,
  'anime-api'
);

const stremioStreamRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.stremioStream,
  'stremio-stream'
);

const stremioCatalogRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.stremioCatalog,
  'stremio-catalog'
);

const jellyfinBrowseRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.jellyfinBrowse,
  'jellyfin-browse',
  jellyfinDeviceKeyExtra
);

const jellyfinImagesRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.jellyfinImages,
  'jellyfin-images',
  jellyfinDeviceKeyExtra
);

const stremioManifestRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.stremioManifest,
  'stremio-manifest'
);

const stremioSubtitleRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.stremioSubtitle,
  'stremio-subtitle'
);

const stremioMetaRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.stremioMeta,
  'stremio-meta'
);

const linkedAccountsRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.linkedAccountsApi,
  'linked-accounts-api'
);

const loginRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.login,
  'auth-login'
);

const oidcRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.oidc,
  'auth-oidc'
);

const staticRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.static,
  'static'
);

const communityApiRateLimiter = lazyLimiter(
  () => appConfig.rateLimits.communityApi,
  'community-api'
);

export {
  userApiRateLimiter,
  userCreateRateLimiter,
  linkedAccountsRateLimiter,
  communityApiRateLimiter,
  streamApiRateLimiter,
  formatApiRateLimiter,
  catalogApiRateLimiter,
  animeApiRateLimiter,
  stremioStreamRateLimiter,
  stremioCatalogRateLimiter,
  jellyfinBrowseRateLimiter,
  jellyfinImagesRateLimiter,
  stremioManifestRateLimiter,
  stremioSubtitleRateLimiter,
  stremioMetaRateLimiter,
  staticRateLimiter,
  loginRateLimiter,
  oidcRateLimiter,
};
