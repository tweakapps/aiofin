# Roadmap: AIOStreams-JF

**Milestone:** Jellyfin layer on latest AIOStreams, live for Maged's profiles
**Core Value:** Each AIOStreams profile is a complete Jellyfin server for its owner.
**Granularity:** coarse

## Phases

- [x] **Phase 1: Port** (completed 2026-09-08) - Jellyfin layer ported onto v2.34.0, building and tested
- [x] **Phase 2: Parallel Deploy** (completed 2026-09-08; GHCR push deferred) - Image on GHCR, parallel container on the Dubai VPS with a DB copy
- [ ] **Phase 3: Profile & Clients** - AioMetadata in the profile, Infuse/SenPlayer checklist with evidence
- [ ] **Phase 4: Cut-over** - Production on the ported image with rollback, all profiles
- [x] **Phase 5: Jellyfin Hardening** (completed 2026-09-08; jf3 live on the parallel container; cast photos + service reuse to be eyeballed by Maged in Infuse) - Fix the Infuse tvOS home-screen 429s, cast photos, per-user service caching, error isolation and contract bugs found in the 2026-09-08 audit

## Phase Details

### Phase 1: Port
**Goal**: The qooode Jellyfin layer works on a clean AIOStreams v2.34.0 checkout
**Depends on**: Nothing
**Requirements**: PORT-01, PORT-02, PORT-03, PORT-04
**Success Criteria**:
  1. `pnpm build` green on `jellyfin-layer`; layer tests + upstream tests pass
  2. Migrations apply on a DB copy
  3. Local login via UUID/password returns a token
**Plans**: TBD
**Executor**: Sonnet, Fable diff review

### Phase 2: Parallel Deploy
**Goal**: The port runs on the Dubai VPS next to production without touching it
**Depends on**: Phase 1
**Requirements**: DEP-01, DEP-02, DEP-03
**Success Criteria**:
  1. GHCR image `ghcr.io/tweakapps/aiostreams-jf-update:<tag>` exists
  2. Parallel container answers `/System/Info/Public` on its hostname; production unchanged
  3. Rollback path documented
**Plans**: TBD
**Executor**: Sonnet (SSH to Dubai VPS), Fable review of compose changes

### Phase 3: Profile & Clients
**Goal**: Maged's profile works end-to-end in Infuse and SenPlayer through the layer
**Depends on**: Phase 2
**Requirements**: PROF-01, CLI-01, CLI-02, CLI-03
**Success Criteria**:
  1. Libraries = profile catalogs via AioMetadata; Solo Leveling structure per provider
  2. Playback of cached, uncached and usenet entries behaves as documented; explicit picks honoured
  3. Resume / next-up / favourites persist per profile
**Plans**: TBD
**Executor**: Sonnet prepares; Maged tests; Fable reads evidence

### Phase 4: Cut-over
**Goal**: Production runs the ported image for all profiles with a rollback
**Depends on**: Phase 3
**Requirements**: CUT-01
**Success Criteria**:
  1. Maged's explicit approval recorded before the swap
  2. Production container on the new image; old tag + DB backup retained; smoke passes
**Plans**: TBD
**Executor**: Sonnet with Fable step-by-step review

### Phase 5: Jellyfin Hardening
**Goal**: The layer survives a tvOS Infuse home screen (24 libraries fanned out in parallel), shows cast with photos, and never turns one bad catalog into a client-wide error
**Depends on**: Phase 3 (runs before Phase 4 cut-over; jf3 image replaces jf2 on the parallel container)
**Requirements**: HARD-01, HARD-02, HARD-03, HARD-04
**Success Criteria**:
  1. 60 back-to-back requests to `/jellyfin/Users/x/Items/Latest` from one IP produce zero `stremio-catalog rate limit exceeded` warnings and zero 429s
  2. `People` entries for a movie from AioMetadata carry `PrimaryImageTag` and `Role`, and `/Items/{personId}/Images/Primary` returns the photo (200), not 404
  3. A throwing `getCatalogPage` on one catalog yields an empty row plus an error log, never a 500 for the whole request; 500 bodies never contain upstream text
  4. `JellyfinService` is reused across requests for the same profile (one `AIOStreams.initialise` per profile per TTL, not per request)
**Plans**: 05-01 rate limiting + error isolation; 05-02 per-user service cache; 05-03 cast photos, image relay, media-source stubs; 05-04 contract fixes + jf3 build/deploy
**Executor**: Sonnet; Fable authored the plans from the audit (`/Users/magededward/claude-cc/aiostreams-jf-audit-2026-09-08.md`) and reviews the diff

