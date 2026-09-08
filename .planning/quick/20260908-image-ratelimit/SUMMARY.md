# Summary — dedicated Jellyfin image rate limit -> jf6

Added `jellyfinImages` limiter (1500/5s, device-keyed), routed `/Items/{id}/Images/*`
+ `/UserImage/*` to it first in the classifier (ahead of `staticRateLimiter` 200/5s) —
fixes 429'd posters/cast photos under Infuse fan-out.

Commit `f22e90a6` (pushed origin/release). Files: rate-limits.ts, ratelimit.ts,
jellyfin/index.ts. `pnpm build` zero errors; core tests 53/53 pass.

Deployed `aiostreams-jf:2.34.0-jf6` (`5d3a66c825e1`) on VPS, container healthy.

Verification: 250 image requests -> `250 200` (zero 429); static-rate-limit log
grep count = `0`; `System/Info/Public` -> `200`. Production untouched. README jf6
entry added (rollback: retag jf5).

Note: origin/release advanced past this (52e11815, 4c9ef658 — unified single
limiter, Phase 6 work) after our push; deployed jf6 unaffected, built pre-that.
