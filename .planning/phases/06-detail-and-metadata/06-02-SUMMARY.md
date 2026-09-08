# 06-02 Summary — Metadata mapping, person pages, jf7 deploy

**Commit:** `73da3d23` (pushed `origin/release`)

## Changes
- `dto.ts`: `officialRatingFor()` (app_extras.certification -> certificationLocal -> legacy) drives `OfficialRating`; `providerIdsFor` adds `Tmdb`/`Tvdb` from `_tmdbId`/`_tvdbId` (and `Imdb` from `_imdbId`); `peopleFrom` treats `app_extras.directors`/`writers` objects (`{name,character,photo}`) the same as `cast`, dedupe key changed to `name|type` so one person can be Actor + Director; `buildEpisodeItem` now passes `seriesItem.People` through; `buildSeasonItem` uses new `seasonPosterFor()` (handles both `{season: url}` map and `[{season, poster|url}]` array shapes) before falling back to the series poster; `buildPersonItem` sets an `Etag` when a photo is present. `JELLYFIN_DTO_VERSION` bumped to 3.
- `items.ts`: `itemFromDescriptor` `'person'` case now calls `recallImages` and passes the remembered photo to `buildPersonItem`.
- `dto.test.ts`: 4 new cases (certification, `_tmdbId`/`_tvdbId`, directors-with-photo, actor+director dedupe).

## Build / Test
`pnpm build` zero errors. `pnpm --filter ./packages/core test`: 57/57 pass (53 + 4 new).

## Deploy — jf7 (verbatim)
- Item detail (`Mutiny`, `a11101000001ed72edffffffff000000`): status 200, 30.3ms, 4525 bytes; `OfficialRating: R`; `ProviderIds: {Imdb: tt32338669, Tmdb: 1288445, Tvdb: 356666}`; Director Jean-François Richet with `PrimaryImageTag`; zero `"resource":"subtitles"` log lines for the item.
- `/Shows/{seriesId}/Episodes`: first episode `People.length` = 6.
- `/Persons/Jason%20Statham`: `ImageTags.Primary` present.
- 300 back-to-back image requests: `{200: 300}`, zero 429; `rate limit exceeded` log count = 0.
- `System/Info/Public`: 200. Production `aiostreams` container untouched (Up, healthy, unmodified).

Rollback: retag `aiostreams-jf:2.34.0-jf6`, `docker compose up -d`.

Phase 6 (DET-01, DET-02, META-01, META-02) complete.
