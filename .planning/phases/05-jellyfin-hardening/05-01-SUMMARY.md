# 05-01 Summary — Jellyfin browse rate limit + catalog error isolation

**Commit:** ad0a44cc (pushed to `release`)

## Changes

- `core/config/schema/rate-limits.ts:121-126` — added `jellyfinBrowse` limiter (5s/300 req, `JELLYFIN_BROWSE_*` env).
- `server/middlewares/ratelimit.ts` — `createRateLimiter` and `lazyLimiter` take optional `keyExtra(req)`; key becomes `prefix:ip:extra` when present. Added `jellyfinDeviceKeyExtra` (DeviceId from MediaBrowser/Emby auth header via `parseMediaBrowserHeader`, imported from `routes/jellyfin/context.js`; falls back to first 12 chars of `api_key`, else IP-only). New `jellyfinBrowseRateLimiter` export, added to export list.
- `server/routes/jellyfin/index.ts` — swapped `stremioCatalogRateLimiter` for `jellyfinBrowseRateLimiter` in the classifier; added `ITEM_DETAIL_LIKE` regex (`/Items/[id]$`, structurally excludes PlaybackInfo/MediaSources/Images since those have extra path segments) routed to the same limiter; added 4-arg error middleware after the classifier that catches `APIError` with `RATE_LIMIT_EXCEEDED` and returns `429 {Message: "Too many requests, please slow down"}`.
- `server/routes/jellyfin/context.ts:456-457` — `jf()` catch block: 500 body now generic (`Internal server error`, no leaked message); `next(error)` after headersSent replaced with `if (!res.writableEnded) res.end()`.
- `server/routes/jellyfin/library.ts` — added `safeCatalogPage(ctx, catalog, opts, what)` wrapper (returns `{items:[], hasMore:false, capped:false}` on throw, logs via existing logger). Replaced all 7 direct `ctx.service.getCatalogPage` call sites (`Items by view`, `Items recursive`, `Latest by view`, `Latest` inside the `lookup` fan-out, `Similar`, `Recommendations`); removed the ad-hoc try/catch around the `Recommendations` loop since the helper now covers it.

## Deviation from plan
None. Verified the 429-throw path reaches the router's error middleware by reading `express-rate-limit@8.5.2`'s source directly (`node_modules/.pnpm/express-rate-limit@8.5.2.../dist/index.cjs:852-856,883,996`): the whole middleware is wrapped in `handleAsyncErrors`, an async function that `await`s the handler and routes any thrown/rejected error to `next(error)` — so the plan's primary approach (error-handling middleware, not a custom `handler`) works as written; no fallback needed.

## Build/test
- `pnpm build` — zero TypeScript errors (crypto, core, server, frontend, seanime-extensions all built).
- `pnpm --filter ./packages/core test` — `tests 50, pass 50, fail 0` (matches plan's baseline).

No deploy performed (out of scope per plan).
