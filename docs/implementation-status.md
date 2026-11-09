# Implementation and evidence status

## Integrated dependency checkpoint — November 9, 2026

The pending live-notice reorder, actual Signal live publication, owned live
publisher, portable live transport, hardware-coordinate adapter, scale/cache
qualification and release-assessment sources are integrated together. Replay
protection and the current contribution evaluators are retained. Live transport
now compiles with exact optional types, authenticates each encrypted chunk before
upload, snapshots private descriptors, and withholds the private manifest when a
publisher is closed during upload. The replay adapter's SQL migration is included
in the distributable package. A cancellation test now waits for actual upload
entry instead of racing capture encryption.

On Node 24.19.0, the integrated software rehearsal passed all 12 stages: runner,
portable checks, Signal/relay types, real Signal endpoint tests, real TLS relay
tests, production C integration, Signal-to-C, TLS-to-C, registry and status-record
checks. The portable suite has 306 cases; the Signal suite has 112. Source-bound
rehearsal evidence was produced from clean commit
`905860737c1e81288e9d61f9cc444900a0e6ab4a`. Subsequent source reconciliation retains
the same implementations and incorporates the already-merged replay PR #80;
hosted CI independently verifies the final integration head before merge.

These are software SDK and transport results. Root/key provisioning, consuming
applications, vendor financial integrations, actual hardware measurements and
physical scale qualification are distinct. The release assessor remains advisory;
no production authorization, stable release or independent certification is
manufactured by integrating these sources. Older counts below are historical.

## Current checkpoint: October 13, 2026

PR #56 merged the [atomic endpoint delivery journal](endpoint-journal.md), with all
five exact-head hosted workflows passing. The [relay recovery composition](endpoint-relay-recovery.md)
in PR #57 builds on that journal with bounded intake, acknowledgment ordering and
explicit private-manifest rehydration.
Outbound ciphertext, signed encrypted controls and inbound authenticated envelopes
commit with their Signal ratchet state in one encrypted compare-and-set row.
Stable request IDs permit byte-identical retries after an uncertain commit;
completed inbox entries discard private payloads while retaining expiry-bounded
replay tombstones. Current membership, clock/expiry checks and combined byte/count
limits still apply. Complete signed packets now survive intake crashes. Encrypted per-asset high-water
marks prevent older retained keys from reappearing after replacement expiry.
This is not automatic playback recovery or exactly-once audio.
The [journal record](../registry/endpoint-journal.json) refines the canonical
34-milestone plan without promoting production or review gates.

The Signal suite now includes 70 endpoint/storage/playback/model cases (54 at
PR #56 plus 16 recovery cases), with 10 separate Signal-to-production-C integration cases.
Exact-head hosted checks remain required before merge; local checks on a different
runtime are supplementary. Test source is not evidence of a passed hosted run.
The PR and GitHub Actions retain the exact tested head and conclusions.

The [TLS ciphertext relay](../services/ciphertext-relay/README.md) and endpoint
client deliver public prekeys, encrypted manifests/controls and bounded encrypted
audio chunks. Its 24 SQLite/TLS/launcher cases and ten Signal-to-TLS-to-C cases
remain active. It is runnable with explicit operator configuration, not deployed.
The explicit endpoint wrapper now commits authenticated messages before relay
acknowledgment, and opt-in durable playback inboxes rehydrate current manifests.
Two new actual-TLS/C cases reopen endpoint state twice and verify that restoration
starts no output, consumed leases stay rejected and a fresh join renders again.

The portable engine has 200 tests, including 23 owned-session cases. Native
checks retain 13 C contract cases plus 10,000 adversarial sequences/concurrency,
17 Swift/C/JavaScriptCore cases and seven Java/JNI/C cases. Additional signed-media
integration has 17 Node-to-C cases. Hosted native jobs compile the actual unsigned
iOS simulator target and Android arm64-v8a/x86_64 libraries with lint. ASan/UBSan,
strict types, dependency audit, source boundaries, roadmap DAG and offline packed
consumer checks remain separate gates.

## What is implemented versus what remains

| Area | Implemented software | Remaining gates |
|---|---|---|
| Endpoint encryption | Pinned real libsignal parent channel, root-verified peer membership, encrypted atomic vault and bounded delivery journal | Mobile protocol bindings, protected keys/revision floors, account recovery and resolved concrete security/license findings |
| Audio delivery | Endpoint AES-GCM packaging, authenticated ranges, immutable ciphertext relay chunks, signed controls and current rights checks | Application effect reconciliation, deployed transport, codec/loudness/native format integration |
| Native playback | Shared C kernel, foreground Android AudioTrack/JNI and iOS AVAudioEngine/Swift hosts; actual system JavaScriptCore audio bridge | Android runtime bridge, full endpoint bootstrap/web-crypto/module loading, explicit rate/channel/drift adapters and consuming apps |
| Timing/output evidence | Monotonic timeline checks, challenge-bound conservative intervals, native fades/hard stops and route invalidation | Physical calibration/attribution, audible stop latency, Bluetooth/wired delays, supported-device matrix and six-hour soaks |
| Business and operations | Scoped rights, immutable checkout, SQLite purchases/accounting/entitlements, sponsorship and observability/evidence primitives | Real provider signatures/APIs/sandbox/dispatch, complete-product/refund fulfillment, durable sponsor adapters, deployed observability and restore/retention/deletion drills |
| Advanced capabilities | Neutral spatial/mixing primitives, local coordination and bounded ciphertext caches | Resampling/topology/positioning pilots, LAN provisioning, live input and advanced hardware per existing dependencies |

Both mobile hosts remain **foreground-only**. Calls, interruptions, route changes,
foreground loss and lock screen stop output and require an explicit new join.
Software callbacks and simulated routes cannot prove audible stopping or acoustic
synchronization. No optional background-playback qualification is claimed.

No cloud deployment, registry publication, app signing, new paid resource, stable
release, physical-speaker trial or independent certification is claimed. Source
and CI artifacts are development SDK deliverables, not a turnkey mobile app.
Check dependent repositories separately before making application-level claims.

## Evidence and next execution order

The [October 12 checkpoint](implementation-status-2026-10-12.md) preserves the
previous capability table, PR history and evidence boundaries. Its references to
an absent Node endpoint journal and 31 endpoint tests are superseded only by the
new scoped journal record. The [recovery record](../registry/endpoint-recovery.json)
also supersedes the missing Node acknowledgment/manifest composition descriptions.
Other unpassed gates are unchanged.

Continue with controller/application-specific effect reconciliation, Android
runtime bridging and complete endpoint bootstrap/mobile protocol bindings. Integrate protected native state and explicit rate/channel/drift
adapters. Qualify physical routes/interruptions/rejoin and six-hour soaks. Complete
provider/fulfillment and deployed operational drills with artifact-bound
AI security review and testing before release. Independent expert review remains
deferred follow-up, not a merge/release prerequisite under the October 13 owner
policy in `AGENTS.md`. No independent audit or certification is claimed. See the [development plan](DEVELOPMENT_PLAN.md),
[native plan](../native/README.md) and [canonical roadmap](../registry/roadmap.json).
