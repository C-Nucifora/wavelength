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

## Round one checkpoint

Base `27da633`; checkpoint requested before round closure; clean-round count zero. The required three rounds and two consecutive clean independent rounds have not completed. Round two has not started. The user requested a checkpoint and pause before further audit work.

The two independent breakers covered A/B/C and D/E/F. Engine/state checks finished with 14 passes, three failing regressions and 354 assertions. Data/package checks finished with 14 passes, six failing regressions and 1,804 assertions. The owner reproduced two additional malformed helper error failures. Fixture mistakes were corrected before these totals; they are not production findings.

New experiments included 32 deterministic append fault schedules with seed `0x51a7c0de`, concurrent receipt replay, actual loopback authentication, cancelled deferred reads, ignored termination signals, constructor/lease faults, 48 CSV seeds across five byte partition schedules, malformed UTF-8, catalog seeds 101 through 132, matching seeds 201 through 248, discovery seeds 301 through 316 and history seeds 401 through 416. All account and automation boundaries were synthetic.

| ID | Severity | Reproduction and root cause | Checkpoint fix and verification |
| --- | --- | --- | --- |
| R1.1 | P2 | A helper ignoring SIGTERM survived timeout and owned shutdown after ownership was deleted before exit. | Web helpers remain owned through exit and receive SIGKILL on timeout, overflow or shutdown, with a bounded reap wait. Legacy helpers retain ownership until callback and use SIGKILL. New actual-child cases cover all three paths and preserve unrelated sentinels. |
| R1.2 | P3 | Cancel during deferred status/rebind, then reject the read. Catch overwrote cancellation with failed, with zero writes. | Preserve cancellation without clearing creation/track uncertainty. Both rejection cases and cancellation during uncertain creation pass; retry remains blocked for unknown creation. |
| R1.3 | P3 | Prototype-like HTML entities became inherited function text; mixed-case accent suffixes could produce undefined text. | Both entity tables require own properties and accent lookup checks the suffix. Unknown names stay literal; valid named, accented and numeric entities still decode. |
| R1.4 | P3 | Snapshot capture hashed FIFOs before checking type and blocked, including leaf and parent symlink cases. | Validate root, parents and final file type before hashing. Inventory, duplicate, mode and hash rules remain enforced. Direct and aliased FIFO children reject and are reaped. Checks are not atomic against concurrent path replacement. |
| R1.5 | P2 | Unknown helper error codes with uncertain false cleared possible-write intent; two integrated tests issued a second create. | Reject unknown codes conservatively and use safe message lookup. All 11 legitimate native error codes preserve explicit uncertainty, private diagnostics stay hidden, and integrated Jobs tests block another create. |
| R1.6 | P2 | Mac packaged HistoryChecks opened a second Store while the engine held its lease. | Stop before all three direct database checks, refresh the client after both restarts and seed required job fields. All original assertions remain. Linux embedded-script checks pass two tests with 44 assertions. |

The engine fixer changed only its five owned files. Its broader focused run passed 68 tests and found one stale legacy mock expectation outside its ownership. The owner updated that expectation to assert SIGKILL and retain membership until the exit callback. The integrated checkpoint run below passes that test and all 28 new engine regressions. The data fixer passed 26 new tests with 1,840 assertions and 11 focused existing tests with 23 assertions.

A fresh independent Astra challenge of R1.6 passed one new test with 94 assertions against actual engine children. It covered three launches with different tokens, stale read/Forget rejection, scripts rejected while leased and accepted after shutdown, readiness fields, schema recovery, record preservation and an unrelated process sentinel. It found no substantive issue. This does not establish Swift decoding or native scheduling.

Fresh data review found no substantive source defect. Its generated runtime challenge was prepared but not launched before the pause request, and remains preserved. It left an untested root-alias-with-trailing-slash hypothesis; CLI callers normalize roots with resolve. Independent runtime sign-off is incomplete. The engine fixes still need a fresh independent challenge after restart. Neither review gap counts as a clean round.

## Verification and publication

The pre-round full baseline had 333 passes, three platform skips and two failures requiring absent macOS tools. The final checkpoint command was `bun test --max-concurrency 1 --timeout 120000`, under the shared lock, disk-backed TMPDIR and umask 022. It completed 394 tests with 389 passes, three platform skips, two failures and 3,746 assertions. The only failures were the source ZIP test requiring `/usr/bin/ditto` and the real ad hoc signing test requiring `/usr/bin/xcrun`. Tests and limits were not weakened.

Typecheck, public JavaScript syntax, both JXA stdin syntax checks, auth-wrapper CaptureChecks and `git diff --check` passed. No owned Bun listener or Wavelength container remained afterward. Existing unrelated public services were left alone. No production deployment, release, installed-app replacement or authentication change occurred.

The remote baseline was `1e65113`. The only workflow, `.github/workflows/check.yml`, runs tests and a local ad hoc app build on push, pull request or manual dispatch. It has no deployment, release or artifact publication step. The initial topic push published the four earlier reviewed commits and coverage commit `8299b53`. Its Mac run `43115346536` passed Bun, typecheck, JavaScript, native, WebMusic, artwork and auth-wrapper checks. App compilation and ad hoc signing verification passed, then packaged HistoryChecks failed with R1.6.

Before this checkpoint the reliable branch last-push record was 2026-11-12 08:52:26 +1000. The authorized remote was fetched again and matched `8299b53`. New signed commits use chronological timestamps after that push, preserve existing history and include only this team's intended files. The nine commits through `e45a228` have verified SSH signatures using a temporary public-key allowed-signers file, without persistent configuration changes.

| Commit | Concrete work |
| --- | --- |
| `19ccb85` | Owned-helper cleanup, cancellation/error uncertainty and bounded synthetic regression tests |
| `6a6352a` | Discovery entity integrity and regular-file validation before release hashing, with regressions |
| `452bb7c` | Packaged history fixture lease ordering, fresh clients and valid sentinel fields |
| `e45a228` | Normalize closed synthetic lease sidecars before symlink fixture setup on macOS |

The ordinary push to `https://github.com/C-Nucifora/wavelength.git`, branch `hardening-rounds`, succeeded at 2026-11-12 09:17:10 +1000. No force push, merge, PR, release or deployment was performed. Mac run `43118634768` on code head `452bb7c` passed 391 tests and skipped one, but two new symlink fixtures failed during setup because macOS SQLite left closed WAL/SHM files. The owner repaired only that isolated setup, retaining every safety assertion. All 30 affected Linux tests passed with 410 assertions. Follow-up `e45a228` was signed, verified and pushed normally at 2026-11-12 09:27:57 +1000. [Mac rerun 43120025709](https://github.com/C-Nucifora/wavelength/actions/runs/43120025709) passed on that exact code head. It used macOS 26.7.2 arm64, runner image 20261102.0473.1 and Bun 1.3.14. The Bun suite passed 393 tests with one existing icon-bundle skip, zero failures and 3,758 assertions. Typecheck, JavaScript, native, WebMusic, artwork and auth-wrapper checks passed. The app compiled and signed, and packaged history, profile-replacement and engine lifecycle checks passed. This closes R1.6's observed CI failure. The exact Xcode version was not printed. macOS 14 runtime acceptance remains unverified.

## R1.7 unresolved native pagination total defect

P2. The earlier prepared Swift experiment compiled with Swift 6.0.3 in a rootless container, one CPU and 2 GiB memory, with networking disabled. The image digest was `sha256:95f6ef898992dc840b35517e780f6f6db9661432775ab0b33cc0a531ea749bdb`. Scratch copies add Linux FoundationNetworking/CoreFoundation imports and exclude the unused live URLSession transport class; production Types, Core and Catalog logic otherwise remains unchanged. All account, storage and HTTP boundaries are synthetic.

One valid terminal-total case passed. Seven contradictory or malformed catalog-total cases were incorrectly accepted. A fake playlist held two songs but returned one row, no next and total two. The append path ignored the total, sent another POST for the existing second song, then accepted a two-row read with total three as confirmed. Actual synthetic contents became `[1, 2, 2]`. Expected behavior is to stop before writing or confirming an incomplete read.

Catalog parsing and playlist readback both ignore meta.total. The experiment ended with one pass and eight failing checks. Source snapshots, hashes, fixture, driver and log remain in disk-backed owner scratch for restart. No production fix or new worker started for R1.7 after the checkpoint request. This is executable Linux evidence for shared Swift logic, not macOS framework, account, UI, installation or signing acceptance.

## Restart requirements

The existing goal will pause after this checkpoint. All workers finished safely; their code and review artifacts remain preserved. Resume by fixing R1.7, completing the stopped independent data runtime challenge and obtaining a fresh engine challenge. Continue round one before starting distinct later rounds. Other proposed challenges include overlapping native start/stop with stale startup cleanup and history import/forget/scan completion ordering.

The remaining acceptance gaps are described in `hardening-verification.md`, with the newer Mac CI evidence above superseding its earlier native-execution gap. No clean-machine, Gatekeeper, GUI/accessibility, real account/storefront compatibility, real Apple CSV compatibility, or clean runtime rebuild/relink acceptance is claimed. The passing Mac fixture/build run establishes only its exercised synthetic checks and compilation/signature/package behavior.
