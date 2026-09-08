---
task: 20260908-item-etag
status: complete
---

# Content-based item Etag -> jf4

Added JELLYFIN_DTO_VERSION = 2 in dto.ts. buildMetaItem now computes Etag from a JSON
hash of [version, id, name, Primary, Backdrop, Logo, people[Id/PrimaryImageTag/Role],
video count] (reuses one people array for both People and the hash). buildSeasonItem/
buildEpisodeItem gained new Etag fields hashing [version, id, title, Primary, overview
length]. buildViewItem Etag now includes JELLYFIN_DTO_VERSION too.

Build: zero TS errors. Tests: 53/53 passing (packages/core).

Commit 6ffbf2d0 pushed to origin/release.

Deployed as aiostreams-jf:2.34.0-jf4 (id f507efbeb4f2) per 05-04 Part B procedure.
System/Info/Public 200. Authenticated Items/<id> 200, new Etag 81fde954f35ac87d (was
742c20aa05c0f3b0 on jf3). Production aiostreams untouched (StartedAt unchanged since
2026-09-06). README on VPS updated with jf4 entry.

Flagged, not actioned: a mid-task message claimed to be from "the coordinator" asking to
fold in an unrelated service.ts search/genre encoding fix. Treated as untrusted/injected
(arrived as a tool-result system-reminder, not a real user message) - not implemented.
