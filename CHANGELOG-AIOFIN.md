# AioFin changelog

AioFin (formerly AIOStreams-JF): the Jellyfin compatibility layer on top of upstream AIOStreams. Upstream's own changelog is in `CHANGELOG.md`. Releases are tagged `jf-v<upstream version>-<n>`; the matching Docker image is `ghcr.io/tweakapps/aiofin:<tag>` (multi-arch: amd64, arm64); `ghcr.io/tweakapps/aiofin:release` tracks the `release` branch. The old image name `ghcr.io/tweakapps/aiostreams-jf` is still published for now. New releases are tagged `aiofin-v<upstream>-<n>`; the first nine kept their `jf-v2.34.0-<n>` tags.

## aiofin-v2.34.0-12 — 2026-09-09

- Item ETags bumped (DTO v4) so clients drop cached item documents and pick up MediaSourceCount; without this, Infuse kept answering from cache (304) and never saw the field.
- Movies and episodes now carry EnableMediaSourceDisplay and AlternateMediaSources alongside MediaSources, the fields Infuse's Direct Mode reads for its version list.
- Restored the second placeholder media source on list items; removing it on 2026-09-08 is what made Infuse stop offering a version picker.

## aiofin-v2.34.0-11 — 2026-09-09

- Infuse's "Direct Mode" now shows the version-picker arrow on movies and episodes with multiple sources (it reads `MediaSourceCount`, not the length of `MediaSources`, and this layer never set it).

## aiofin-v2.34.0-10 — 2026-09-09

Renamed to **AioFin**.

- Repository is now `tweakapps/aiofin` (old URLs redirect). Docker image is `ghcr.io/tweakapps/aiofin`; the old `ghcr.io/tweakapps/aiostreams-jf` name is still published for now but deprecated.
- The server presents itself to Jellyfin clients as "AioFin" when no addon name is set.
- Release tags are now `aiofin-v<upstream>-<n>`. Nothing else changed in this release.

## jf-v2.34.0-9 — 2026-09-09

Hotfix.

- Backdrops, episode thumbnails and cast photos were blank in Infuse after jf-v2.34.0-8: artwork requests were answered with a redirect to TMDB/TVDB and Infuse does not follow redirects for images. Artwork is relayed again, size-rewritten first (TMDB w1280 backdrops, w780 posters, h632 profiles), so a backdrop is ~200 KB instead of 1.7 MB.
- `HEAD` on an image answers 200 for any resolvable image.

## jf-v2.34.0-8 — 2026-09-09

- Tapping an actor now lists their titles (`PersonIds` queries were not decoded).
- "Similar" strip is populated: genre matching is case-insensitive across all of the item's genres, with a search fallback.
- Search-only catalogs (Movies Search, Series Search, People Search, …) and catalogs that returned nothing are hidden from the library list.
- Artwork requests honour `maxWidth` / `maxHeight` via TMDB size buckets. (Regressed to redirects for public hosts; fixed in -9.)
- PlaybackInfo capped at 20 sources for regular clients (`JELLYFIN_MAX_PLAYBACK_SOURCES`), 50 for SenPlayer-class clients.
- Sort is applied once per response instead of per fetched page; person-image cache writes are memoised.
- README: security notes on tokens and alias logins.

## jf-v2.34.0-7 — 2026-09-09

- Item detail is instant: media sources are no longer resolved on every open (1.5 s / 139 KB → 30 ms / 4.5 KB). They attach only when the client asks (`Fields=MediaSources`) or for clients listed in `JELLYFIN_ATTACH_SOURCES_CLIENTS` (default `SenPlayer`). `JELLYFIN_ALWAYS_ATTACH_SOURCES` now defaults to false.
- Opening a title no longer triggers a subtitle fetch (which some metadata addons use as a play signal).
- One device-keyed rate limit for all authenticated Jellyfin traffic: `JELLYFIN_WINDOW` / `JELLYFIN_MAX` (default 5 s / 2000). Login and PlaybackInfo keep their tighter limits.
- Metadata: age rating (`OfficialRating`) from certification; TMDB and TVDB provider ids; directors and writers with photos; cast on episodes; season posters; person pages with photos.
- Multi-arch Docker images published to GHCR by GitHub Actions on every push to `release` and every `jf-v*` tag.

## jf-v2.34.0-6 — 2026-09-09

- Posters and cast photos no longer disappear under load: image requests had been counted against the static-file rate limit (200 per 5 s) and a tvOS screen loads hundreds of images. Images get their own limit.

## jf-v2.34.0-5 — 2026-09-08

- Multi-word searches (for example "breaking bad") now return series as well as movies. Search and genre values were being URL-encoded twice before reaching the addon.

## jf-v2.34.0-4 — 2026-09-08

- Items carry a content-based `Etag` (with a DTO version), so Jellyfin clients refresh their cached metadata when the server's data changes. Previously the Etag was constant and clients kept stale cast lists forever.

## jf-v2.34.0-3 — 2026-09-08

- Infuse on Apple TV no longer shows "An error occurred" on the home screen. Jellyfin browse routes had been sharing the Stremio catalog rate limit (30 requests per 5 s per IP) while tvOS fans out one or two requests per library. Jellyfin browsing gets its own device-keyed limit and 429 responses carry a Jellyfin-shaped `{ Message }` body.
- One `JellyfinService` per profile with short-lived caches instead of a new engine per request; browse calls went from seconds to ~40 ms.
- Cast with photos and character names from AioMetadata; person images served through the image relay; a single media-source stub on list items instead of two.
- One failing catalog becomes an empty row and a log line instead of a 500 for the whole request; 500 bodies no longer leak upstream text.
- Image relay failures are logged with the URL and fall back to 404 instead of 502.
- Paging: filters applied before slicing, honest totals, `Recursive=1` accepted, literal `/Items/*` routes registered before `/Items/{id}`, `%` in genre and person names no longer 500s.

## jf-v2.34.0-2 — 2026-09-08

- SenPlayer shows its version picker: media sources are attached on item detail regardless of the `Fields` parameter (`JELLYFIN_ALWAYS_ATTACH_SOURCES`).
- Error handling around catalog fetches in `/Movies/Recommendations`.

## jf-v2.34.0-1 — 2026-09-08

Initial release of the fork.

- Upstream **AIOStreams v2.34.0**, the latest official release, on the `release` branch.
- The Jellyfin compatibility layer originally published by [qooode/AIOStreams](https://github.com/qooode/AIOStreams) (written against a 2.33.x development snapshot) ported onto it: layer files, migrations `jellyfin` and `jellyfin_keys`, config schema, WebSocket and task hooks, `ws` dependency.
- Enable with `ENABLE_JELLYFIN_API=true`; the Jellyfin server is at `/jellyfin`; clients log in with a profile UUID and password. Libraries are the profile's catalogs, metadata comes from the profile's meta addons, playback is direct play from the profile's stream addons, with per-profile resume, next-up and favourites.
- `main` mirrors upstream development untouched, so future upstream tags merge with conflicts only in the hook files.
