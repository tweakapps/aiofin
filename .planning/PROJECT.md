# AIOStreams-JF

## What This Is

Maged's build of AIOStreams (upstream Viren070/AIOStreams, tracking the latest release, v2.34.0 at start) with the Jellyfin compatibility layer published by qooode/AIOStreams ported on top. Jellyfin-compatible clients (Infuse, SenPlayer, Jellyfin web/desktop) log in with an AIOStreams profile UUID and password and get libraries, metadata, seasons/episodes, media sources, resume/next-up and favourites straight from that profile's own addons, with no Jellyfin server and no Remux/AioFin in between. AioMetadata inside each profile supplies catalogs, metadata and scrobbling.

## Core Value

Each AIOStreams profile is a complete Jellyfin server for its owner: their addons, their metadata provider, their streams in their order, their watch state, on the newest AIOStreams.

## Requirements

### Validated

(None yet)

### Active

- [ ] The qooode Jellyfin layer (23 files + core hooks) is ported onto a clean AIOStreams v2.34.0 checkout, builds, and its own tests pass
- [ ] A Docker image of the port runs as a parallel container on the Dubai VPS under its own hostname, with a copy of the production AIOStreams database, production untouched
- [ ] The `maged-dxb` profile includes AioMetadata (catalogs + meta) and AioMetadata scrobbling is enabled
- [ ] Infuse and SenPlayer log in with UUID/password and pass the checklist: catalogs as libraries, Solo Leveling structure per provider, Shawshank/Silo playback including uncached and usenet entries, explicit pick, resume and next-up, labels
- [ ] Cut-over: the production instance runs the ported image with the previous image tag kept for rollback; the other two profiles get AioMetadata; AIOStreams-JF stays upgradeable when upstream releases

### Out of Scope

- Any Remux/AioFin work — discontinued 2026-09-07
- Transcoding — the layer is direct-play by design (302 redirect); browser playback of remux/DTS is not a goal
- Modifying upstream AIOStreams behaviour beyond the Jellyfin layer hooks — keeps the port rebaseable; if upstream adopts the layer officially, this repo is retired

## Context

- Repo: `/Users/magededward/opencode/aiostreams-jf-update`, GitHub `tweakapps/aiostreams-jf-update` (fork of Viren070/AIOStreams), default branch `release` = v2.34.0 + layer (images build from it; upstream tags merged into it); `main` mirrors upstream dev. Remotes: `origin` (fork), `upstream` (Viren070), `jflayer` (qooode/AIOStreams, single "Initial commit" snapshot of a 2.33.x dev tree + the layer). `tweakapps/AIOStreams-JF` is Maged's untouched mirror of qooode's repo.
- Layer inventory (from qooode main): `packages/core/src/jellyfin/{index,service,dto,ids,ids-codec,images}.ts` (+ tests), `packages/core/src/db/repositories/jellyfin.ts`, migrations `0020_jellyfin.ts`, `0021_jellyfin_keys.ts`, `packages/server/src/routes/jellyfin/{index,context,items,library,playback,system,tasks,ws,relay-target}.ts` (+ test). Core hooks to re-apply live in roughly: `db/index.ts`, `db/migrations/index.ts`, `db/repositories/users.ts`, `config/schema/api.ts`, `formatters/base.ts`, `core/src/index.ts`, `server/src/app.ts`, `server/src/server.ts`, plus frontend `save-install.tsx` (Installation > Jellyfin tab) and `manifest.ts` bits. Verify each by diffing qooode's file against the same file at its nearest upstream ancestor, not against v2.34.0.
- Production: `aiostreams-dxb.tweakstreams.stream` → Dubai Oracle VPS 145.241.123.188 (ssh `ubuntu@145.241.123.188`, key `~/.ssh/ssh-key-2026-06-13.key`, compose `~/apps/docker-compose.yml`, Traefik + Authelia). Running v2.34.0. Usenet via `nzbhydra2` on the same host. AioMetadata at `aiometadata.tweakstreams.stream` (Hetzner).
- Profiles: `maged-dxb`, plus two family profiles (aligned formatter; `⌁` cached, `∅` uncached, `⧉` usenet).
- Working rules: Fable plans/reviews; Sonnet executes; cost discipline (targeted reading, targeted tests, ≤25-line summaries); push to GitHub after every commit; never touch production containers/DB except via the documented cut-over step with backup.

## Constraints

- **Upstream tracking**: keep the layer as an additive patch on upstream tags; no unrelated edits to upstream files.
- **Secrets**: profile UUIDs/passwords, manifest URLs, VPS keys never in the repo.
- **Production safety**: parallel container with a DB copy first; cut-over only on Maged's explicit approval; rollback tag retained.

## Key Decisions

| Decision | Rationale | Outcome |
|---|---|---|
| Port the layer onto v2.34.0 rather than run qooode's 2.33.x snapshot | Maged wants the newest AIOStreams; the layer is 23 files + small hooks | — Pending |
| Parallel deployment on a separate hostname before cut-over | Zero risk to the live profiles | — Pending |
| AioMetadata inside the profile for catalogs, meta and scrobbling | Replaces AioFin's metadata-truth and watch-sync goals by construction | — Pending |

---
*Last updated: 2026-09-07 after initialization*
