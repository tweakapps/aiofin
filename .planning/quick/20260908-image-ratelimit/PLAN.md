# Quick task — image requests need their own (high) rate limit → jf6

## Problem (verified live 2026-09-08 19:45 UTC)
Container log: `static rate limit exceeded for IP: 92.99.67.121` in bursts. In `packages/server/src/routes/jellyfin/index.ts` the limiter classifier sends everything that is not LOGIN/STREAM/CATALOG/ITEM_DETAIL-like to `staticRateLimiter` (200 req / 5 s / IP). `/Items/{id}/Images/{type}` falls in that bucket. Infuse tvOS loads ~10 posters per home row × 24 rows plus ~20 cast photos per detail page, so image requests get 429 → blank posters and blank cast avatars, which masks the cast fix shipped in jf3/jf4.

## Change
1. `packages/core/src/config/schema/rate-limits.ts`: add next to `jellyfinBrowse`:
   `jellyfinImages: rateLimit({ windowDefault: 5, maxDefault: 1500, envPrefix: 'JELLYFIN_IMAGES', label: 'Jellyfin images' })`
2. `packages/server/src/middlewares/ratelimit.ts`: add `jellyfinImagesRateLimiter = lazyLimiter(() => appConfig.rateLimits.jellyfinImages, 'jellyfin-images', jellyfinDeviceKeyExtra)` and export it.
3. `packages/server/src/routes/jellyfin/index.ts`: add `const IMAGE_LIKE = /^\/Items\/[^/]+\/Images(\/|$)/i;` (also match `/UserImage`), check it FIRST in the classifier chain (before ITEM_DETAIL_LIKE, since `/Items/x/Images/Primary` must not fall into other buckets) and route to `jellyfinImagesRateLimiter`. Import it.
4. Also make the existing 429 error middleware in index.ts cover these (it already catches any RATE_LIMIT_EXCEEDED APIError on the router — verify it is registered before `jellyfinContext`, which it is).
5. `pnpm build` zero errors; `pnpm --filter ./packages/core test` green (53). Commit `fix(jellyfin): dedicated image rate limit (1500/5s, device-keyed) so posters and cast photos are never 429'd`; push `origin release`.
6. Deploy as `aiostreams-jf:2.34.0-jf6` exactly like `.planning/quick/20260908-search-extras/SUMMARY.md` (reset VPS clone to origin/release, build context `/home/ubuntu/aiostreams-jf/src`, long-timeout build, compose tag jf5→jf6, `docker compose up -d`). Production untouched; never print secrets.
7. Verify from the VPS: 250 back-to-back `curl -s -o /dev/null -w '%{http_code}\n' https://jf.tweakstreams.stream/jellyfin/Items/a11101000001ed72edffffffff000000/Images/Primary` → count the status codes; expect zero 429 (200/302/404 are all fine), and `docker logs --since 2m aiostreams-jf | grep -c "static rate limit exceeded"` = 0. `System/Info/Public` → 200.
8. VPS README jf6 entry (rollback jf5). SUMMARY.md here ≤15 lines with the counts verbatim; commit, push.
