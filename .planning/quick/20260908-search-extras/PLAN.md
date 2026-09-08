# Quick task — pass raw search/genre extras (ExtrasParser encodes) → jf5

## Problem (verified live on jf4)
Commit 1b83a752 wrapped `search=` / `genre=` values in `encodeURIComponent()` inside `JellyfinService.getCatalogPage()` (`packages/core/src/jellyfin/service.ts` ~line 114-122). But the core `ExtrasParser` (`packages/core/src/utils/extras.ts` lines 13-17) splits the extras string on `&` and `=` and then `encodeURIComponent()`s each value itself, so upstream receives double-encoded values, e.g. `…/catalog/series/search.series/search=breaking%2520bad.json`. Effect: multi-word search terms return nothing from series catalogs (Infuse "search only finds movies"), and multi-word genre filters return nothing. One-word terms work, which is why it went unnoticed.

## Change
1. `service.ts` getCatalogPage(): replace the two `encodeURIComponent(...)` calls with raw values where only the two separator characters are neutralised:
   - `extrasBase.push(\`search=${opts.search.replace(/[&=]/g, ' ').trim()}\`)`
   - `extrasBase.push(\`genre=${opts.genre.replace(/[&=]/g, ' ')}\`)`
   Add a one-line comment: `// ExtrasParser (utils/extras.ts) splits on & and = and URL-encodes each value itself — pass raw text.`
2. `pnpm build` zero errors; `pnpm --filter ./packages/core test` green (53). Commit `fix(jellyfin): pass raw search/genre extras (ExtrasParser encodes them)`; `git push origin release`.
3. Deploy as `aiostreams-jf:2.34.0-jf5` following the exact procedure in `.planning/quick/20260908-item-etag/SUMMARY.md` / `.planning/phases/05-jellyfin-hardening/05-04-SUMMARY.md` (VPS `ssh -i ~/.ssh/ssh-key-2026-06-13.key ubuntu@145.241.123.188`, `ssh -A` if needed for the fetch, reset `/home/ubuntu/aiostreams-jf/src` to `origin/release`, build context `/home/ubuntu/aiostreams-jf/src`, long-timeout build, compose tag jf4→jf5, `docker compose up -d`). Production untouched; never print secrets.
4. Verify with the pre-authenticated URL for profile `c05bd9bc-88a1-44c7-b674-6c1ea9da5a2d` (encrypted password read from `config_profiles` in `/home/ubuntu/aiostreams-jf/data/aiostreams/db.sqlite` via a server-side python3 script, then delete the script):
   - `GET /Search/Hints?SearchTerm=breaking%20bad&Limit=10` → the SearchHints array contains an entry with Name "Breaking Bad" and Type "Series".
   - The container log for that request shows the upstream AioMetadata URL containing `search=breaking%20bad` (single-encoded), not `%2520`.
   - `GET /System/Info/Public` → 200.
5. Update the VPS README (jf5 entry, rollback = jf4). Write `SUMMARY.md` here (≤15 lines, verification verbatim), commit, push.
