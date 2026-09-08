---
phase: 5
plan: 04
status: complete
---

# Plan 05-04 — Contract fixes, build + deploy jf3

## Part A (commit `1b83a752`, pushed `release`)
- `service.ts`: encodeURIComponent on search/genre extras; getEngine() clears `initPromise`
  on rejected initialise() so a failed init retries instead of poisoning the 5-min cache.
- `library.ts`: dropped double `decodeURIComponent` on `/Genres/:name` and `/Persons/:name`;
  moved `/Items/Filters`, `/Items/Filters2`, `/Items/Counts` handlers before
  `['/Users/:userId/Items/:itemId', '/Items/:itemId']` and deleted `RESERVED_ITEM_IDS` guard;
  view branch now filters before slicing (loop up to 3 fetches to top up `limit`, tracks raw
  offset) with honest `TotalRecordCount`; removed the `offset += 1` fudge in the recursive crawl.
- `context.ts`: `qb()` now accepts `'1'`/`'0'` as well as `'true'`/`'false'`.
- `pnpm build`: zero TS errors. `pnpm --filter ./packages/core test`: 53/53 passing.

## Part B (VPS, `jf.tweakstreams.stream`)
- VPS clone `git log origin/release..HEAD` showed only `0f27caca` (upstream `672b2a72`), tree
  clean → `reset --hard origin/release` at `1b83a752`. GitHub fetch needed `ssh -A` agent
  forwarding (host had no working deploy key).
- Ran `scripts/generateMetadata.cjs`, `docker build -t aiostreams-jf:2.34.0-jf3 <src>` — image
  `e970f71eca72` (454MB). Compose tag `jf2` → `jf3`, `docker compose up -d`, healthy in <30s.
- Production `aiostreams` StartedAt unchanged (`2026-09-06T07:15:22Z`) — untouched.
- `System/Info/Public`: 200.
- 60-request check (via Traefik/HTTPS): 60/60 `401`, 0 `429`, log `rate limit exceeded` count
  after that run = 0 (sequential HTTPS curl too slow to fill a 5s window; retested inside the
  `web` docker network directly against `aiostreams-jf:3000`).
- 400-request in-network burst: 300×`401` then 100×`429`. First `429` body:
  `{"Message":"Too many requests, please slow down"}`. Log `rate limit exceeded` count = 101.
- `/Genres/100%25`: `401` (no auth provided), not `500` — confirms double-decode no longer throws.
- No `ERR_HTTP_HEADERS_SENT` / unhandled rejections in container log.
- Cast/person images and per-profile service reuse: not exercised (needs authenticated Jellyfin
  client) — deferred for Maged to confirm in Infuse.
- README updated (image jf3, id, changes, rollback to jf2).
