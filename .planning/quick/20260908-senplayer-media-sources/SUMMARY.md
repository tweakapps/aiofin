---
status: complete
---

# SenPlayer media sources on item detail — Summary

## What was done

- Added a new config setting `jellyfinAlwaysAttachSources` (default `true`, env
  `JELLYFIN_ALWAYS_ATTACH_SOURCES`) to `packages/core/src/config/schema/api.ts`,
  following the exact pattern used by `jellyfinMaxCatalogItems`.
- Updated the single-item GET handler (`sendItem`) in
  `packages/server/src/routes/jellyfin/library.ts` (`/Users/:userId/Items/:id` and
  `/Items/:id`) so it computes the real `target` (and calls
  `ctx.service.buildMediaSources`) when `wantsSources` (client sent
  `Fields=MediaSources`) OR the new config is enabled and the item is a movie or
  episode (`descriptor.k === 'movie' || descriptor.k === 'episode'`). No other
  handler was touched.
  - Note: the codebase does not actually have a `stubMediaSources` fallback as
    originally described in the task brief -- the real behavior was simply "no
    MediaSources/MediaStreams attached at all" when `wantsSources` was false.
    The fix targets that actual gap using the real variable names in the file
    (`wantsSources`, `descriptor.k`, `target`, `buildMediaSources`).

## Build & test

- `pnpm build` -- passed, zero errors.
- `pnpm --filter ./packages/core test` -- 50/50 tests passed, 0 failed.

## Commit & deploy

- Commit: `82f94b05` on branch `release`, pushed to `origin/release`.
- VPS (Dubai, `/home/ubuntu/aiostreams-jf`): pulled `release`, regenerated
  `metadata.json` (commitHash `82f94b05`), built image `aiostreams-jf:2.34.0-jf2`
  (id `af672b94068e`), updated `docker-compose.yml` to the new image tag, and
  recreated the `aiostreams-jf` container.
- Container health: `healthy`.
- Verification:
  - `GET /api/v1/status` -- `version: 2.34.0`, `commit: 82f94b05` (matches deployed
    commit).
  - `GET /jellyfin/System/Info/Public` -- HTTP `200`.
- Production `aiostreams` container / `apps-hetzner` project was not touched.
