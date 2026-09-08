# Requirements: AIOStreams-JF

**Defined:** 2026-09-07
**Core Value:** Each AIOStreams profile is a complete Jellyfin server for its owner.

## v1 Requirements

### Port
- [ ] **PORT-01**: All qooode Jellyfin-layer files are present on `jellyfin-layer` with core hooks re-applied on v2.34.0; `pnpm install && pnpm build` succeeds
- [ ] **PORT-02**: The layer's own tests (`ids.test.ts`, `images.test.ts`, `relay-target.test.ts`) and the upstream test suite pass
- [ ] **PORT-03**: Migrations `0020_jellyfin`/`0021_jellyfin_keys` apply cleanly on a copy of the production database
- [ ] **PORT-04**: A local run exposes `/jellyfin` (or the layer's mount) and `POST /Users/AuthenticateByName` succeeds with a profile UUID/password

### Deploy
- [ ] **DEP-01**: Docker image built from the branch and pushed to GHCR under `tweakapps`
- [ ] **DEP-02**: Parallel container on the Dubai VPS with a DB copy, own hostname via Traefik, production container untouched
- [ ] **DEP-03**: Rollback documented: previous image tag + DB backup path

### Profile & Clients
- [ ] **PROF-01**: AioMetadata added to `maged-dxb` with catalogs + meta; scrobbling enabled
- [ ] **CLI-01**: Infuse: login, libraries, Solo Leveling seasons per provider, Shawshank + Silo playback (cached, uncached, usenet), explicit pick, resume/next-up
- [ ] **CLI-02**: SenPlayer: same checklist
- [ ] **CLI-03**: Labels match the profile formatter; evidence table written

### Cut-over
- [x] **HARD-01**: Jellyfin browse routes use their own rate limit (device-aware key) and return `{ Message }` on 429; no tvOS home-screen 429s
- [x] **HARD-02**: Cast (`People`) carries photos and roles from AioMetadata `app_extras.cast`; person images served through the image relay
- [x] **HARD-03**: One failing catalog never 500s a browse response; error bodies are generic; `JellyfinService` cached per profile with TTL
- [x] **HARD-04**: Paging/filter maths, extras encoding, double-decode, route order and media-source stubs fixed; jf3 image deployed on the parallel container
- [ ] **CUT-01**: Production switched to the ported image after Maged's approval; other profiles get AioMetadata; rollback verified possible

## Out of Scope
| Feature | Reason |
|---|---|
| Transcoding | direct-play layer by design |
| Remux/AioFin | discontinued |

## Traceability
| Requirement | Phase | Status |
|---|---|---|
| PORT-01..04 | Phase 1 | Complete |
| DEP-01..03 | Phase 2 | Complete (DEP-01 deferred: GHCR token scope) |
| PROF-01, CLI-01..03 | Phase 3 | Pending |
| HARD-01..04 | Phase 5 | Complete (HARD-02 client confirmation pending) |
| CUT-01 | Phase 4 | Pending |
