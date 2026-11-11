# Further audit rounds

The extension begins at `27da633`. It preserves the earlier findings and Mac acceptance limits in `hardening-verification.md`. The owner has authorized signed commits and pushes to the dedicated `hardening-rounds` branch on `C-Nucifora/wavelength`, with no merge, release or deployment.

## Coverage and stopping rule

Each round uses new bounded synthetic experiments and independent analysis across this matrix. Old suite results establish the baseline, not a new round. A round is closed only after confirmed findings are fixed, regression checks and full feasible checks run, and a fresh independent challenge addresses the findings and responses. At least three new rounds must close. Two consecutive independent rounds must then have no substantive unresolved defect in this matrix. A new confirmed defect resets that clean-round count.

| Cell | Required coverage | New sequence or fault families |
| --- | --- | --- |
| A | Loopback, origins, request validation, native bootstrap and helper trust | Receipt reuse, concurrent requests, malformed or stale inputs, auth and redirect boundaries |
| B | Playlist planning, creation, append, deduplication, retry and account changes | Deferred/rejected status and rebind, ambiguous outcomes, repeated retry/cancel, cover recovery |
| C | Store and process ownership, cancellation, crash and startup/retry/shutdown | Failed constructors, lock sidecars, stale owners, detached tasks and unrelated process sentinels |
| D | CSV streaming, enrichment, summary and history replacement | Chunk/UTF-8 splits, contradictory values, exact matching, overlapping import/forget/scan |
| E | Discovery, catalog, discography, artwork and provenance | Invalid totals/next pages, unavailable occurrences, identity substitution and staged asset validation |
| F | Native contract/UI, packaging, signing, notices and matching source | Stale callbacks, resource paths/modes/aliases, source snapshot integrity and build assumptions |

All experiments use fake account/Music boundaries and isolated data. No real credentials, personal libraries, account writes, paid services, Gatekeeper changes or installed-app replacement. Services bind only to `127.0.0.1` and stop afterward. Native source/fixture preparation cannot establish macOS execution, UI/accessibility, account compatibility, clean installation or runtime rebuild acceptance.

The small swarm starts with two breakers. Every test/build/fuzz/browser command takes `$HOME/.local/state/agent-swarms/heavy.lock`, uses one worker and sets disk-backed `TMPDIR`. This thread's T3 project binding prevents creating Wavelength worktrees through the isolation API. The rejected requests started no workers. Breakers therefore use explicit read-only source access and distinct owned fixture files. Fixers receive separate file ownership and integrate serially; no shell-created worktree will substitute for the orchestration API.

## Round one

Base `27da633`; status in progress; clean-round count zero.

- Engine/state breaker owns A/B/C and new deferred, malformed and concurrent operation schedules.
- Data/package breaker owns D/E/F and new generated input, pagination and resource-integrity cases.
- Hypotheses, reproductions, triage, fixes, regression commands, fresh review responses and published hashes will be recorded as results arrive.

The new pre-round full baseline completed 338 tests with 333 passes, three existing platform skips and two failures requiring absent macOS `ditto` and `xcrun`. All checks ran under the shared resource lock. No new failure occurred. This baseline alone does not count as the round's breaker evidence.

## Publication baseline

The remote was fetched before work and remains at `1e65113`. The only repository workflow is `.github/workflows/check.yml`, which runs tests and a local ad hoc app build on push, pull request or manual dispatch. It contains no release, deployment or artifact publication step. No reliable earlier branch push timestamp was available from the local remote-tracking reflog or available user push events. New local history uses the realistic-commits fallback within the past day and preserves the existing four signed commits.
