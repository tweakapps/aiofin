---
phase: 2
plan: 01
subsystem: deploy
tags: [docker, traefik, jellyfin, dubai-vps]
requires: []
provides: [aiostreams-jf-container]
affects: [02-parallel-deploy]
---

# Phase 2 Plan 01: Parallel `aiostreams-jf` container Summary

Built `release` branch natively on Dubai VPS, deployed as isolated `aiostreams-jf`
container behind Traefik at `jf.tweakstreams.stream`; production untouched.

## Results
- Image `aiostreams-jf:2.34.0-jf1`, id `1e87d8cfa454`, 453MB, built in ~3 min.
- GHCR push (DEP-01): **deferred** — `permission_denied` (token scope). Local image used.
- DB copy: `cp -a` (no sqlite3 on host or in either container) → `/home/ubuntu/aiostreams-jf/data/aiostreams`, 8.8G.
- Compose + `.env` (chmod 600, 27 vars, names verified only) at `/home/ubuntu/aiostreams-jf/`.
- Verified: `https://jf.tweakstreams.stream/jellyfin/System/Info/Public` → 200; `/stremio/u/maged-dxb/manifest.json` → 302 → 200 (follows to profile).
- Production `aiostreams` StartedAt unchanged (2026-09-06T07:15:22Z); `apps-hetzner` compose/data mtimes unchanged.
- README.md written with rollback/cutover recipe; prod rollback digest recorded.

## Deviations from Plan
None — GHCR push failure handled per plan's deferral instruction (Rule N/A, explicit plan branch).

## Self-Check: PASSED
