# 05-02 Summary — Reuse JellyfinService per profile; TTL memos; batch user data

Commit: `da912818` (pushed to `release`)

## Files changed

- `packages/server/src/routes/jellyfin/context.ts`: `CachedUser` gained `service?: JellyfinService`. Extracted `getOrBuildCachedUser` (was inline in `resolveUserData`) and added exported `getCachedUserEntry(uuid, encryptedPassword)` returning the raw cached entry. `buildContext` (line ~310) now calls `getCachedUserEntry` instead of `resolveUserData`, clones `entry.userData` per-request for `ip`, and lazily creates `new JellyfinService(entry.userData)` on the entry (cached, no `ip`) once, reusing it thereafter. Service is evicted automatically with the `CachedUser` entry (TTL/version invalidation untouched).
- `packages/core/src/jellyfin/service.ts`: added generic `memo<T>(map, key, ttlMs, producer)` (line ~62) storing `{promise, expiresAt}`; evicts on rejection immediately, caps each map at 2000 entries (oldest-insertion eviction). `fetchCatalog`/`getMeta`/`getSubtitles`/`resolveStreams` refactored to use it with TTLs: catalog 60s, meta 5min, subtitles 5min, streams 60s.
- `packages/server/src/routes/jellyfin/items.ts`: `itemFromDescriptor` opts gained `skipUserData?: boolean` (line ~112); movie/series branch skips `attachUserData` when set (line ~142). `itemFromId` (line ~202) takes/forwards `opts`.
- `packages/server/src/routes/jellyfin/library.ts`: `itemsFromPlaystates` (line ~227) and the `Ids` branch of `handleItemsQuery` (line ~262) now pass `skipUserData: true` per item and call `attachUserData(ctx, items)` once on the collected array.

## Build / test output

- `pnpm build`: zero TypeScript errors (server, core, web, extensions all built clean).
- `pnpm --filter ./packages/core test`: `tests 50 / pass 50 / fail 0` — unchanged from baseline.

## Deviations

None — implemented as written. One note: `itemsFromPlaystates` previously avoided any extra playstate query for movie/series rows (playstate was passed straight into `buildMetaItem`); it now also calls the batched `attachUserData` per the plan's explicit instruction, which is one extra batched Supabase query per list call (was 0) but functionally equivalent output. Not a regression on the tvOS home-screen hot path the plan targets (catalog/`Ids` lookups), which now drop from N to 1 query.

## Not done (per plan scope)

No VPS deploy — 05-04 verifies on the VPS.
