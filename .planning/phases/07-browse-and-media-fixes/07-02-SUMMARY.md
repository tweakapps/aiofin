# Plan 07-02 Summary — Image redirects, PlaybackInfo cap, test setup, README, GHCR deploy

Commit `143ecb60` on `release`, pushed. Build zero errors; core tests 58/58 (unchanged, no new test added).

## Changes
- `playback.ts` (D2): `PUBLIC_IMAGE_HOSTS` (tmdb/tvdb/metahub/amazon/fanart.tv); `imageUrlFor` decodes the id up front, marks a URL public when its host matches, and `sizeImageUrl()` rewrites TMDB `/t/p/<size>/` to the smallest bucket >= `maxWidth`/`fillWidth`/`width` (poster/backdrop/profile bucket sets). GET/HEAD routes 302 with `Cache-Control: public, max-age=86400` for public results; relay path unchanged for non-public.
- `playback.ts` (D3): new `jellyfinMaxPlaybackSources` config (`api.ts`, default 20, env `JELLYFIN_MAX_PLAYBACK_SOURCES`) caps `PlaybackInfo`; clients matching `jellyfinAttachSourcesClients` (SenPlayer) keep 50. Sources beyond the first 5 get `MediaStreams: []` — confirmed `resolveStreamTarget` never reads `MediaSources`/`MediaStreams`, only `resolvePlayable()`.
- `packages/core/test/setup.ts` (R7): now `await import('../src/index.js')` once via the existing `tsx --test --import` mechanism; removed the manual `import '../index.js'` workaround from `dto.test.ts`. Repo uses `node --test`/tsx, not vitest — no vitest config exists, so no `vitest.config.ts` was touched.
- `README.md` (R9): Security notes block (unrevocable tokens, open alias logins, `JELLYFIN_WINDOW`/`JELLYFIN_MAX` defaults, AioMetadata subtitles check-in warning).

## Deploy
First GHCR-only deploy (no VPS build): Actions run 34322628713 green (~2m11s arm64, 2m7s amd64, manifest merge). VPS pulled `ghcr.io/tweakapps/aiostreams-jf:release` @ `sha256:2ec9f966bedea33f249a2f6f6cb4a5c7b8cee9a2c1a61bc36110c625afe8e022`, container healthy. Production `aiostreams` untouched (uptime unaffected).

## Verification (verbatim)
- Backdrop `maxWidth=780`: 302 → `image.tmdb.org/t/p/w780/...` (43ms cached; 2.2s first request while the image cache rebuilt).
- Person Primary: 302 → `image.tmdb.org/t/p/w185/...`.
- Movie Primary `maxWidth=300`: 200 (relay), `content-type: image/webp` — this item's poster is sourced from a private addon proxy, not TMDB, for this profile; correct behavior, not a bug.
- PlaybackInfo: `Client="Infuse-Direct"` → 20 sources; `Client="SenPlayer"` → 50 sources.
- `PersonIds` query: 72 items. `Similar?Limit=12`: 12 items.
- `UserViews`: 44 views on a fresh restart (Movies/Series/People Search absent; `Voice Actor Roles` present until its first empty fetch populated the 10-min `isKnownEmpty()` cache, then 43 views, absent — expected TTL warm-up, not a regression).
- Home fan-out: 77/77 parallel requests (UserViews + per-view Items + per-view Latest) → 200, run twice.
- Container log: only pre-existing anime-DB-refresh 503 warnings (unrelated to Jellyfin/image/playback); zero Jellyfin-related warn/error.

## Deviations
- [Rule 1] Test setup lives in the pre-existing `packages/core/test/setup.ts` (loaded via `tsx --test --import`), not a new `src/test-setup.ts`/vitest config — the package uses `node --test`, not vitest.
