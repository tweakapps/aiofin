# Plan 01-01 Summary — Port qooode Jellyfin layer onto v2.34.0

**BASE commit** (jflayer/main's true parent): `04b3d736e5b5bfb943bb1b85548a9ef1abf02ad2` ("style: format", 2026-08-24) — matched 32/55 non-jellyfin file blobs, the strongest single-commit match.

**New files ported verbatim (21):** `core/src/jellyfin/{dto,ids,ids-codec,ids.test,images,images.test,index,service}.ts`, `core/src/db/repositories/jellyfin.ts`, migrations (renumbered 0020/0021 → **0027/0028**, upstream already occupies 0020–0026), `server/src/routes/jellyfin/{index,context,items,library,playback,system,tasks,ws,relay-target,relay-target.test}.ts`.

**Hooks re-applied:** `config/schema/api.ts` (4 new settings), `db/index.ts` (+export), `db/migrations/index.ts` (register 0027/0028), `db/repositories/users.ts` (+`verifyCredentials`), `core/index.ts` (+export), `server/app.ts` (+3 route mounts, no limiter renames needed), `server/express.d.ts` (+2 fields), `server/server.ts` (+registerJellyfinTasks/attachJellyfinWebSocket), `frontend/save-install.tsx` (Jellyfin install card). **`formatters/base.ts` intentionally untouched** — its only diff vs jflayer was unrelated upstream drift (`mediaInfoQuality`), not a jellyfin hook.

**Deps added:** `ws@^8.21.0` + `@types/ws@^8.18.1` in `packages/server/package.json` (ws.ts needs it; missed by the literal-jellyfin-grep pass, caught at build time).

**Deviations (Rule 1/3 auto-fixes):** ported `utils/concurrency.ts` (+test) — `library.ts` imports `collectConcurrent` from core, not exported on v2.34.0; fixed one implicit-any TS7006 in `library.ts`; `ids.test.ts`/`images.test.ts` briefly mis-converted to vitest then reverted — `packages/core` tests run via `tsx --test` (node:test), not vitest.

**Tests:** core `50/50` pass (incl. layer: jellyfin id codec, jellyfin image memory, collectConcurrent); server `5/5` (relay-target); frontend `281/281` (pre-existing) — no regressions vs pre-patch state.

**Build:** `pnpm build` exit 0 (crypto→core→server→frontend→seanime-extensions).

**Local smoke:** sqlite temp DB, migrations 1–28 applied, `jellyfin_playstate`/`jellyfin_items`/`jellyfin_display_prefs` tables confirmed. Mount path: **`/jellyfin`**. `POST /jellyfin/Users/AuthenticateByName` → 200 + `AccessToken`. `GET /jellyfin/System/Info/Public` → 200.

**Gaps:** none — every jellyfin route/hook ported and verified; docs mdx env-var table not updated (out of `files_modified` scope).
