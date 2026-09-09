# AIOStreams-JF changelog

The Jellyfin compatibility layer on top of upstream AIOStreams. Upstream's own changelog is in `CHANGELOG.md`. Releases are tagged `jf-v<upstream version>-<n>`; the matching Docker image is `ghcr.io/tweakapps/aiostreams-jf:<tag>`.

## jf-v2.34.0-2 (2026-09-09) — hotfix

- Backdrops, episode thumbnails and cast photos were blank in Infuse: the server had started answering artwork requests with a redirect to TMDB/TVDB, and Infuse does not follow redirects for images. Artwork is relayed again, size-rewritten first (TMDB w1280 backdrops, w780 posters, h632 profiles), so a backdrop is ~200 KB instead of 1.7 MB.
- `HEAD` on an image answers 200 for any resolvable image.

## jf-v2.34.0-1 (2026-09-09) — first tagged release

### Base
- Upstream **AIOStreams v2.34.0**, the latest official release at the time, on the `release` branch. The layer originally published by [qooode/AIOStreams](https://github.com/qooode/AIOStreams) (written against a 2.33.x dev snapshot) was ported onto it: 23 layer files, two migrations (`jellyfin`, `jellyfin_keys`), config schema, WebSocket and task hooks, `ws` dependency, `node:test` runner restored. `main` mirrors upstream dev untouched, so future upstream tags merge with conflicts only in the hook files.
- Multi-arch images (amd64, arm64) published to GHCR by GitHub Actions on every push to `release` and every `jf-v*` tag.

### Infuse on Apple TV works
- Home screen no longer fails with "An error occurred". Jellyfin routes had been sharing the Stremio catalog rate limit (30 requests per 5 s per IP); tvOS fans out one or two requests per library, ~48 in a second. Jellyfin traffic now has its own device-keyed limit (`JELLYFIN_WINDOW` / `JELLYFIN_MAX`, default 5 s / 2000) and 429s carry a Jellyfin-shaped `{ Message }` body.
- Posters and cast photos no longer disappear under load (image requests had been falling into the static-file limit).
- One failing catalog becomes an empty row and a log line instead of a 500 for the whole request; 500 bodies no longer leak upstream text.

### Cast, crew and metadata
- Cast with photos and character names, directors and writers with photos, from AioMetadata's `app_extras`.
- Age rating (`OfficialRating`) from certification; TMDB and TVDB provider ids; episode cast; season posters; person pages with photo and filmography; the "Similar" strip populated.
- Content-based item `Etag` (with a DTO version) so clients refresh cached metadata when the server changes.

### Speed
- One `JellyfinService` per profile with short-lived caches instead of a new engine per request; browse calls went from seconds to ~40 ms and a 100-request home fan-out completes in ~1.4 s.
- Item detail no longer resolves every stream on open (1.5 s / 139 KB → 30 ms / 4.5 KB) and no longer triggers a subtitle fetch. Media sources attach only when the client asks (`Fields=MediaSources`) or for SenPlayer-class clients (`JELLYFIN_ATTACH_SOURCES_CLIENTS`, default `SenPlayer`); `JELLYFIN_ALWAYS_ATTACH_SOURCES` now defaults to false.
- PlaybackInfo capped at 20 sources for regular clients (`JELLYFIN_MAX_PLAYBACK_SOURCES`), 50 for SenPlayer.
- Artwork requests honour `maxWidth` / `maxHeight` via TMDB size buckets.

### Correctness
- Multi-word search returns series as well as movies (extras were double-encoded once).
- Search-only and empty catalogs are hidden from the library list.
- Paging: filters applied before slicing, honest totals, `Recursive=1` accepted, literal `/Items/*` routes registered before `/Items/{id}`, `%` in genre and person names no longer 500s.
- Person filmography via `PersonIds`; sort applied once per response.

### Security notes
- API tokens embed the encrypted profile password and cannot be revoked; treat a leaked token like a leaked password.
- Alias logins accept any password by design (aliases are share links); do not alias a profile you expose through the Jellyfin layer unless you intend it to be open.
- Do not enable AioMetadata's subtitles resource for profiles used via the layer; its Trakt/Simkl check-in fires from the subtitle request rather than from playback.

## Before the first release (2026-09-07 to 2026-09-08)

- Port of the qooode layer onto v2.34.0 (see Base above).
- Parallel container on the Dubai VPS with a database copy; Authelia OIDC callback; version metadata in `/api/v1/status`.
- SenPlayer: media sources attached on item detail so its version picker appears (later made opt-in per client).
- Error handling on `/Movies/Recommendations`.
