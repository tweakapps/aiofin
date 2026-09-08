---
status: in-progress
---
Attach media sources on Jellyfin item detail regardless of Fields param (SenPlayer fix)

Task: fix single-item Jellyfin GET handler to always resolve media sources for movie/episode items, guarded by new config flag jellyfinAlwaysAttachSources. Build, test, commit, push to release, then rebuild+redeploy aiostreams-jf container on Dubai VPS.
