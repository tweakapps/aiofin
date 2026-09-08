# Quick task — publish aiostreams-jf images to GHCR via GitHub Actions

## Goal
Every push to `release` (and every `jf-v*` tag) builds a multi-arch image and publishes `ghcr.io/tweakapps/aiostreams-jf` so the Dubai VPS can `docker compose pull` instead of building for 10 minutes. Uses the workflow `GITHUB_TOKEN` (`packages: write`) — no PAT.

## Steps
1. Read `.github/workflows/deploy-docker.yml` (upstream, multi-arch by-digest build + manifest merge). Create `.github/workflows/jf-docker.yml` modelled on it:
   - `name: JF Docker Image`
   - `on: push: branches: [release]; tags: ['jf-v*']; workflow_dispatch:`
   - `permissions: contents: read, packages: write`
   - `env: IMAGE: ghcr.io/${{ github.repository_owner }}/aiostreams-jf` (lower-case the owner via a step if needed — GHCR requires lowercase; `tweakapps` already is).
   - Job `build` matrix `platform: [linux/amd64, linux/arm64]`, same runners as upstream (`ubuntu-latest` for amd64, `ubuntu-24.04-arm` for arm64 if upstream uses it; otherwise QEMU via `docker/setup-qemu-action`), `docker/login-action` to ghcr with `${{ github.actor }}` / `${{ secrets.GITHUB_TOKEN }}`, `docker/build-push-action@v7` with `outputs: type=image,name=${{ env.IMAGE }},push-by-digest=true,name-canonical=true`, context `.` (repo root; the Dockerfile is at the repo root — the VPS `src/` quirk is only because the clone lives in a subfolder), upload digest artifacts exactly as upstream does. Keep upstream's build args if any (e.g. version/commit metadata; check if the Dockerfile runs `scripts/generateMetadata.cjs`).
   - Job `merge`: download digests, create manifest list with tags: `release` (on branch push), `sha-<short sha>`, and the git tag name when the ref is a tag. Use `docker/metadata-action` or the upstream's shell `imagetools create` pattern.
2. Do NOT modify the upstream workflows. Add a short section to the repo README ("Docker image: `ghcr.io/tweakapps/aiostreams-jf:release`; VPS deploy = `docker compose pull && docker compose up -d`").
3. Commit `ci: publish aiostreams-jf multi-arch image to GHCR on release pushes`; push `origin release`.
4. Watch the run: `gh run list --repo tweakapps/aiostreams-jf-update --workflow jf-docker.yml --limit 1` then `gh run watch <id> --repo tweakapps/aiostreams-jf-update --exit-status` (arm64 build can take ~10-15 min). If it fails, read the log (`gh run view <id> --log-failed`), fix, push again — at most two fix iterations, then stop and report.
5. When green: `gh api "user/packages/container/aiostreams-jf"` may 404 because the package belongs to the org `tweakapps`; try `gh api "orgs/tweakapps/packages/container/aiostreams-jf"` and report its `visibility`. Do NOT change visibility (the coordinator does that) and do NOT touch the VPS in this task.
6. SUMMARY.md here (≤12 lines: run URL, image tags produced, digest, visibility). Commit, push.
