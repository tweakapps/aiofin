# 05-03 Summary — Cast photos/roles, person images, image-relay diagnostics, single media-source stub

Commit: `8bd18dec` (pushed to `release`)

## Files changed

- `packages/core/src/jellyfin/dto.ts`: `peopleFrom(ctx, meta)` (line ~282, now `export`ed) reads `meta.app_extras.cast` (`{name,character,photo}` or plain strings), dedupes by lowercased name, caps at 30, calls `rememberImages(ctx.uuid, personId, {Primary: photo}, true)` + sets `PrimaryImageTag` per person; also checks `app_extras.director`/`directors`/`writers` before the existing links fallback. Call site updated to `peopleFrom(ctx, meta)` (line ~500 area, now ~570). `buildPersonItem` (line ~414) takes optional `photo?`, remembers it, sets `ImageTags.Primary` + `PrimaryImageAspectRatio: 0.6667`. `stubMediaSources` (line ~320) now returns one entry — confirmed via `grep -rn "stub2\|MediaSources\[1\]"` that no other src code depended on the second stub (only the compiled `dist/` artifact referenced it).
- `packages/server/src/routes/jellyfin/playback.ts`: `ARTWORK_KINDS` (line ~372) gained `'person'`; `imageUrlFor` (line ~446) returns `null` for `d.k === 'person'` after a cache miss, never calling `rebuildImages`. GET image route (line ~464): catch-block log raised `debug`→`warn` with `{url, itemId, type}`; new `fallbackImageUrl()` helper decodes the item id and calls `metahubImageUrl`; when `upstream.status >= 400`, the route no longer forwards that status — it 302s to the metahub fallback when `!result.public` and one exists, else 404. HEAD route already matched the required 200/404-only resolution — no change needed there.
- `packages/core/src/jellyfin/dto.test.ts` (new): tests `peopleFrom` with `app_extras.cast` (photo/role + `recallImages` round-trip) and the `meta.cast` fallback (no `PrimaryImageTag`); tests `stubMediaSources` returns exactly one entry.

## Deviations

1. **[Rule 1 — bug/consistency] Catch-block fallback changed from 502 to 404.** The plan's explicit instruction only covered the `upstream.status >= 400` branch; I also changed the `catch` block's non-public fallback from `res.status(502).end()` to `res.status(404).end()`, matching the plan's stated rationale verbatim ("Jellyfin clients handle 404 as 'no image' gracefully, but treat 502 as an error") — a 502 from the same handler for the same failure mode (unreachable/broken upstream) would be inconsistent with the newly-added `>=400` path. `result.public` fallback (302 redirect to the original URL) is unchanged.
2. **[Test-infra, coordinator-directed] `dto.test.ts` import order.** `dto.ts` → `ids.js` does a real (non-type) import of `db/index.js`, which enters a pre-existing circular dependency (`logging/logger.ts` ↔ `redact.ts` ↔ `config/index.ts` ↔ `tasks/index.ts`, and separately `db/repositories/usenet-library.ts` ↔ `usenet/integration/share-provider.ts`) that throws `ReferenceError: Cannot access 'root'/'usenetLibraryBus' before initialization` when `node:test` loads `dto.test.ts` directly (confirmed independent of my changes — reproduces with a bare `import '../db/repositories/jellyfin.js'` probe file; `ids.test.ts`/`images.test.ts` avoid it entirely by importing only leaf modules `ids-codec.js`/`images.js`). Per coordinator instruction, added `import '../index.js';` (the same `packages/core/src/index.ts` barrel that `packages/server/src/app.ts` pulls in first in production, which exports `config` before `db`/`tasks`) as the first import in `dto.test.ts`. This mirrors the real server boot order and resolves the cycle — tests pass. Left as a comment in the test file for future maintainers; no production code touched.

## Build / test output

- `pnpm build`: zero TypeScript errors (server, core, web, extensions, seanime-extensions all built clean).
- `pnpm --filter ./packages/core test`:
  ```
  ℹ tests 53
  ℹ suites 9
  ℹ pass 53
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ```
  (50 pre-existing + 3 new in `dto.test.ts`, all green.)

## Not done (per plan scope)

No VPS deploy — out of scope for this plan (05-04 handles VPS verification).
