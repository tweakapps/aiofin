# 06-01 Summary — Cheap detail, no accidental scrobbling, one Jellyfin limiter

**Commit:** 52e11815 (pushed to `origin/release`)

## Changes
- `api.ts`: `jellyfinAlwaysAttachSources` default `true→false`; added `jellyfinAttachSourcesClients` (commaSeparatedList, default `['SenPlayer']`, env `JELLYFIN_ATTACH_SOURCES_CLIENTS`).
- `library.ts` (~L642-663): added `clientMatches()` helper; `sendItem` now computes `alwaysAttachSources` from config OR `clientMatches(ctx.client.name, jellyfinAttachSourcesClients)`; only resolves `buildMediaSources` when `wantsSources || alwaysAttachSources`.
- `service.ts` `buildMediaSources` (~L351-369): added `opts.withSubtitles?: boolean` (default `false`), destructured and passed to `resolveStreams`; `MediaSourceBuildOptions` spread now excludes `withSubtitles`.
- `playback.ts` (~L120-130): `PlaybackInfo`'s `buildMediaSources` call now passes `withSubtitles: true`, preserving subtitle tracks at play time. Response shape unchanged (verified before/after).
- `rate-limits.ts`: replaced `jellyfinBrowse`/`jellyfinImages` with single `jellyfin` (`windowDefault: 5`, `maxDefault: 2000`, envPrefix `JELLYFIN`).
- `ratelimit.ts`: replaced `jellyfinBrowseRateLimiter`/`jellyfinImagesRateLimiter` with `jellyfinRateLimiter` (same `jellyfinDeviceKeyExtra` key fn).
- `context.ts`: added exported `PUBLIC_STATIC_LIKE` (subset of `PUBLIC`: System/Info/Public, ping, users/public, Branding/*, QuickConnect/*, startup, System/Endpoint — excludes AuthenticateByName and image paths).
- `index.ts`: removed `CATALOG_LIKE`/`ITEM_DETAIL_LIKE`/`IMAGE_LIKE` regex branches; classifier now: `LOGIN_LIKE`→loginRateLimiter, `STREAM_LIKE` (PlaybackInfo|MediaSources)→stremioStreamRateLimiter, `PUBLIC_STATIC_LIKE`→staticRateLimiter, everything else (all other authenticated Jellyfin traffic incl. images/browse/detail)→jellyfinRateLimiter.

## Deviation
The image-rate-limiter split commit (`f22e90a6`, `jellyfinBrowse`/`jellyfinImages`) had already landed on `release` before this plan started. Per instructions, removed both and replaced with the single `jellyfin` limiter as specified — no separate merge/rebase needed since this plan's changes touch the same lines those commits added.

## Build / Test (verbatim tail)
```
pnpm build → tsc (core, server) zero errors; rsbuild + extensions built OK.
pnpm --filter ./packages/core test →
ℹ tests 53
ℹ suites 9
ℹ pass 53
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```
("metadata.json not found" is a pre-existing, unrelated warning from an unrelated test resource.)

No VPS deploy performed (06-02 deploys jf7).
