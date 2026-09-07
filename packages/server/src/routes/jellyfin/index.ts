import express, { type Router } from 'express';
import { isEncrypted } from '@aiostreams/core';
import { corsMiddleware } from '../../middlewares/cors.js';
import {
  loginRateLimiter,
  staticRateLimiter,
  stremioCatalogRateLimiter,
  stremioStreamRateLimiter,
} from '../../middlewares/ratelimit.js';
import { jellyfinContext } from './context.js';
import systemRouter from './system.js';
import playbackRouter from './playback.js';
import libraryRouter from './library.js';

export function createJellyfinRouter(): Router {
  const router = express.Router({ mergeParams: true, caseSensitive: false });
  router.use(corsMiddleware);
  router.use(
    express.json({
      limit: '1mb',
      type: ['application/json', 'text/json', 'application/*+json'],
    })
  );
  router.use(express.urlencoded({ extended: false }));
  router.use((req, _res, next) => {
    const p = req.params as Record<string, string | undefined>;
    if (p.uuid && p.encryptedPassword && !isEncrypted(p.encryptedPassword)) {
      next('router');
      return;
    }
    next();
  });
  router.use((req, _res, next) => {
    if (/^\/emby(\/|$)/i.test(req.url))
      req.url = req.url.replace(/^\/emby/i, '') || '/';
    next();
  });
  const CATALOG_LIKE =
    /^\/(Users\/[^/]+\/)?Items(\/Latest|\/Resume)?$|^\/UserItems\/Resume$|^\/Shows\/NextUp$|^\/Shows\/[^/]+\/(Seasons|Episodes)$|^\/Search\/Hints$|^\/Genres$/i;
  const STREAM_LIKE = /^\/Items\/[^/]+\/(PlaybackInfo|MediaSources)$/i;
  const LOGIN_LIKE = /^\/Users\/AuthenticateByName$/i;
  router.use((req, res, next) => {
    if (LOGIN_LIKE.test(req.path) && !req.params.encryptedPassword) {
      loginRateLimiter(req, res, next);
    } else if (STREAM_LIKE.test(req.path)) {
      stremioStreamRateLimiter(req, res, next);
    } else if (CATALOG_LIKE.test(req.path)) {
      stremioCatalogRateLimiter(req, res, next);
    } else {
      staticRateLimiter(req, res, next);
    }
  });
  router.use(jellyfinContext);
  router.use(systemRouter);
  router.use(playbackRouter);
  router.use(libraryRouter);
  router.use((req, res) => {
    res.status(404).json({
      Message: `Unsupported Jellyfin endpoint: ${req.method} ${req.path}`,
    });
  });
  return router;
}

export { attachJellyfinWebSocket } from './ws.js';
export { registerJellyfinTasks } from './tasks.js';
