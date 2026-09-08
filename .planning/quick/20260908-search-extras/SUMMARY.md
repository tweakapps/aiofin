# Summary — search extras fix → jf5 (2026-09-09 00:05 Dubai)
- Commit `659d348f` fix(jellyfin): pass raw search/genre extras (ExtrasParser encodes them). Build clean, 53/53 tests.
- Image `aiostreams-jf:2.34.0-jf5` (8c704a62df8a) built on the VPS by the Sonnet executor; its build-poll loop self-matched its own pgrep pattern and never exited, so Fable performed the compose tag swap (backup `docker-compose.yml.bak-jf4`) and verification.
- Verified: `System/Info/Public` 200; `Search/Hints?SearchTerm=breaking bad` returns `('Breaking Bad','Series')` plus 4 other series; upstream AioMetadata URL shows `search=breaking%20bad` (single-encoded). Production untouched.
- Lesson for executors: when polling a background build, match on the image tag via `docker images`, not on the build command line.
