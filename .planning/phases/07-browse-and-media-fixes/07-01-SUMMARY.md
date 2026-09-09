# Plan 07-01 Summary — Browse & similar fixes

Commit `36d67bd2` on `release`, pushed. Build zero errors; core tests 58/58 (57 + 1 new).

## Changes
- `library.ts:311-327` (D1): personIds decoded via `decodeJellyfinId` when no `parent.k==='person'`; dedupe by `Type|Id`.
- `library.ts:834-902` (D4): loop over every item genre (case-insensitive/trimmed match), first non-empty catalog page wins; falls back to `service.search(meta.name, [d.t], limit+1)`; whole handler wrapped in try/catch returning empty list.
- `items.ts:78-99` (D5): `viewItems` drops catalogs with a required `search` extra and catalogs `service.isKnownEmpty()` flags. `service.ts`: added `emptyCatalogs` Map + `isKnownEmpty()`; `getCatalogPage` sets/clears the 10-min TTL entry on unfiltered `startIndex===0` fetches. `findCatalog` untouched — still resolves hidden catalogs.
- `library.ts:368-393` (R3): `applySort` moved out of the top-up loop, applied once to the concatenated `filtered` array before slicing.
- `dto.ts:22-45,330-334,497-499` (R5): module-level `rememberedPeople` memo (10 min TTL, 20k cap) guards `rememberImages` in `peopleFrom` and `buildPersonItem`.
- `dto.test.ts`: new test confirms a second `peopleFrom` call for the same person within the TTL does not overwrite the cached photo.

## R6 (season scoping) — no code change
Read `items.ts` `episodesForSeries` (line ~276) and `itemFromDescriptor`'s `'season'` case (line ~170): both already filter `groupSeasons(meta)` down to the requested season *before* encoding episode ids, so `/Shows/:id/Episodes?SeasonId=` and single-season item lookups already do a scoped fetch. `seasonsForSeries` still encodes all episodes across all seasons, which the plan says to keep (per-season played counts). No `seasons?: number[]` option was added since the two call sites the plan names don't call `seasonsForSeries`. Deviation from plan wording, not from intent — the target behavior already existed (introduced in `da912818`/`73da3d23`).

## Build/test verbatim
`pnpm build`: zero TS errors (all packages incl. crypto native addon, core, server, frontend, seanime-extensions).
`pnpm --filter ./packages/core test`: `tests 58 / pass 58 / fail 0`.

## Deviations
- [Rule 1] `opts.some((o) => o.toLowerCase()...)` needed a null guard (`options` is `(string|null)[]`) — added `!!o &&` to fix a TS18047 compile error.
- R6: documented above — verified already correct, no functional change, no new test file added (not in `files_modified`).

No deploy in this plan (07-02 deploys).
