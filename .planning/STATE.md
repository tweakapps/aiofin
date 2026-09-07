# State: AIOStreams-JF

## Project Reference
See: .planning/PROJECT.md (updated 2026-09-07)
**Core value:** Each AIOStreams profile is a complete Jellyfin server for its owner.
**Current focus:** Phase 3: Profile & Clients

## Position
Phase 1 COMPLETE 2026-09-08 (commits 419aa27b..f6b355d8, all pushed). Layer mounted at `/jellyfin`; login = profile UUID + password; env `ENABLE_JELLYFIN_API`; migrations 0027/0028; deps ws/@types/ws. Branching model (2026-09-08): `release` = upstream release tag + Jellyfin layer, the DEFAULT branch and the build source; `main` mirrors upstream dev, untouched. Upstream update: `git fetch upstream --tags && git checkout release && git merge vX.Y.Z` (conflicts only in hook files), build, tag `jf-vX.Y.Z`. Next: Phase 2 — build image, push to GHCR (tweakapps), parallel container on Dubai VPS with DB copy + own hostname.

## Session log
- 2026-09-07: project initialised after AioFin was discontinued.
- 2026-09-08: Phase 1 port complete; Fable reviewed hook diff (additive only).
- 2026-09-08: Phase 2 complete. Parallel container `aiostreams-jf` (image aiostreams-jf:2.34.0-jf1, built on the Dubai VPS) live at https://jf.tweakstreams.stream (project dir /home/ubuntu/aiostreams-jf, DB copy in ./data, env in ./.env chmod 600, README = rollback/cut-over). Jellyfin server name "TweakStreams DXB JF", reports Jellyfin 10.10.7. Production untouched. GHCR push deferred (token lacks write:packages).
