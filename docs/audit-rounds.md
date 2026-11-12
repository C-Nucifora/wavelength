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

Base `27da633`; checkpoint published before round closure; clean-round count zero. The required three rounds and two consecutive clean independent rounds have not completed. Round two source and bounded-fixture work begins while final round-one Mac verification is pending; neither round is closed yet. The user superseded the checkpoint pause and resumed the unfinished fix and review work.

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

The resumed independent data challenge confirmed R1.8 below. Its entity, Unicode, inventory and nonregular-file checks passed after correcting one ambiguous quote fixture. The fresh independent engine challenge found no new substantive defect in R1.1, R1.2 or R1.5. Its nine new tests passed with 112 assertions, covering delayed exit notifications/callbacks, repeated stop at three launch stages, malformed replies, cancelled creation and append across account changes and Store reopen, and cover uncertainty. Actual synthetic children were reaped and unrelated sentinels survived. Focused typecheck and whitespace checks passed. These results do not close the pagination review or establish a clean round.

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

## R1.7 native pagination total defect

P2. The earlier prepared Swift experiment compiled with Swift 6.0.3 in a rootless container, one CPU and 2 GiB memory, with networking disabled. The image digest was `sha256:95f6ef898992dc840b35517e780f6f6db9661432775ab0b33cc0a531ea749bdb`. Scratch copies add Linux FoundationNetworking/CoreFoundation imports and exclude the unused live URLSession transport class; production Types, Core and Catalog logic otherwise remains unchanged. All account, storage and HTTP boundaries are synthetic.

One valid terminal-total case passed. Seven contradictory or malformed catalog-total cases were incorrectly accepted. A fake playlist held two songs but returned one row, no next and total two. The append path ignored the total, sent another POST for the existing second song, then accepted a two-row read with total three as confirmed. Actual synthetic contents became `[1, 2, 2]`. Expected behavior is to stop before writing or confirming an incomplete read.

Catalog parsing and playlist readback both ignored meta.total. The experiment ended with one pass and eight failing checks. Source snapshots, hashes, fixture, driver and log remain in disk-backed owner scratch for restart. After resumption, a separate fixer reproduced those results, then added shared validation for optional totals to catalog and playlist reads. Supplied totals must be finite non-boolean integers, agree with raw row counts and continuations, and remain stable during a playlist read. Missing metadata remains compatible. Catalog operations remain stateless, with validation per page.

All nine original cases now pass. The new `WebMusicPaginationChecks.swift` fixture passes 286 assertions against production service logic in the restricted Linux Swift container. It covers duplicate prevention before a write, incomplete readback after a write, reconciliation without another POST, optional metadata and unavailable occurrence counts. The existing Mac check script now compiles and runs it with one compiler worker.

Fresh independent review found a preserved-decimal precision defect: raw `1.999999999999999999` passed the rounded Double guard as 2, then converted to integer 1. Its actual synthetic append again produced `[1, 2, 2]` with false confirmation. The focused regression failed 13 of 24 assertions. The reviewer tested an exact NSDecimalNumber comparison against the supplied integer in scratch; all 6,151 independent assertions passed. The owner applied that same three-line guard and wired both native fixtures into the Mac script.

Owner verification of the final source passed the 286-assertion implementation fixture, the 24-assertion independent decimal regression and the 1,125-case independent matrix with 6,127 assertions. All final source hashes matched the tested snapshots. Both native fixtures compiled with warnings-as-errors. The malformed pre-read returned conflict with zero POSTs and unchanged `[1, 2]`; truncated post-write readback returned conflict after one POST and reconciliation remained read-only. The new Mac run is pending. This is executable Linux evidence for shared Swift logic, not macOS framework, account, UI, installation or signing acceptance.

## R1.8 release root alias defect

P3. Independent review reproduced `captureSnapshot` and `verifyFiles` accepting an unchanged symlink root when `/` or `//` was appended. `join(root)` preserves the trailing separator, causing `lstat` to follow the root symlink. Unsuffixed aliases reject correctly. This requires no concurrent replacement. CLI callers already normalize their roots and both CLI controls passed.

The independent challenge completed eight passes, five failures and 6,313 assertions; all five failures reproduce this one defect. The owner added lexical `resolve(root)` normalization inside the shared regular-file validator. Four direct-call regressions and two CLI controls remain in `round1-data-review.test.ts`. The affected data suites and independent challenge now pass 39 tests with 8,154 assertions; typecheck passes. Signed commit `691e84a` contains the fix and six portable regressions. It and independent engine coverage commit `6ae7167` were signature-verified and pushed normally to `origin/hardening-rounds`. The resumed integrated suite passed 404 tests with three platform skips and the same two missing-macOS-tool failures, across 409 tests and 3,876 assertions. No new regression was observed. The existing non-atomic stat/read/copy limitation remains.

## Continuing work

Checkpoint `c3b2c03` was pushed normally and its Mac CI run `43120481492` passed. Work resumed under the user's superseding instruction. R1.7's independent challenge and owner verification, R1.8's checks and the fresh engine challenge are complete. Obtain Mac CI evidence for the final pagination change before closing round one. Then start distinct later rounds. Other proposed challenges include overlapping native start/stop with stale startup cleanup and history import/forget/scan completion ordering.

The remaining acceptance gaps are described in `hardening-verification.md`, with the newer Mac CI evidence above superseding its earlier native-execution gap. No clean-machine, Gatekeeper, GUI/accessibility, real account/storefront compatibility, real Apple CSV compatibility, or clean runtime rebuild/relink acceptance is claimed. The passing Mac fixture/build run establishes only its exercised synthetic checks and compilation/signature/package behavior.

## Resumed verification

The resumed full command was `bun test --max-concurrency 1 --timeout 120000`, under the shared heavy-job lock, disk-backed TMPDIR and umask 022. It completed with 404 passes, three skips and two failures across 409 tests, with 3,876 assertions. The failures still require `/usr/bin/ditto` and `/usr/bin/xcrun`; no assertion was disabled. The nine independent engine cases and six release-root cases pass in this integrated run. Repository typecheck and whitespace checks passed. Final native pagination verification passes 6,437 assertions across the two repository fixtures and the independent matrix, with source hashes checked. Mac CI for that change remains pending.

The signed follow-up batch `691e84a` and `6ae7167` was pushed normally to `origin/hardening-rounds` at 2026-11-12 10:01:56 +1000. Mac run [43124255062](https://github.com/C-Nucifora/wavelength/actions/runs/43124255062) passed. Pagination code, fixtures and integration are a separate subsequent batch. No deployment, release or merge was triggered; the sole workflow remains tests and a local app build.


## Round two hypotheses and ownership

Base `dbc447b`. Round-one code fixes and independent Linux challenges are complete; publication-batch typecheck passes and the final Mac run is still pending. New breaker work can proceed against the committed sources, without counting either round as closed or clean.

- C/F: overlap native starts, stops, cancellation and delayed readiness. Check whether stale startup cleanup can stop a newer owned engine, whether each start returns the matching live client, and whether unrelated children survive. Use actual owned synthetic child processes and deterministic barriers, with Mac fixtures where feasible. Source-only hypotheses remain unconfirmed until reproduced.
- A/B/D/E: overlap history scan, import/preview, Forget and session changes through fake account/automation boundaries. Challenge stale completions, receipt consumption/replay and immutable provenance with bounded fault schedules. Check both persistence and response truthfulness, including failed reads and cancellation. No live library or account operations are permitted.

Two independent breakers own distinct fixture files. No production edit or new fix is authorized to a breaker. Findings require a failing reproduction, severity, expected behavior and root cause before triage. All heavy jobs remain serialized with the shared lock and disk-backed TMPDIR. Later repair/review and full checks remain required.


### R2.1 provenance representation mismatch

P3, confirmed by the history/session breaker. `/api/provenance` validates `String(input.kind)` but stores `input.kind`. Singleton and nested arrays coerce to valid labels, then remain arrays in the database. Strict `kind === "ai"` checks no longer recognize the label. A valid string AI label blocks preflight with `includeAI: false`; replacing it with `[["ai"]]` permits one fake playlist create and two fake appends. Expected behavior is HTTP 400, unchanged saved provenance and zero fake writes. The normal native UI sends strings; no unauthenticated or live-account impact is claimed.

The breaker completed 13 tests with nine passes, four failures and 260 assertions. All failures reproduce this one defect. Twelve Forget/scan schedules, two import rollback/enrichment orders, stale valid/malformed preview completions, session reset, receipt persistence/replay faults, account-generation transition and partial-job provenance reassessment passed. Fixture-only generic type annotations were corrected and focused typecheck passed. A separate fixer will require a string before enum validation and preserve valid labels and existing evidence behavior. No production fix is yet applied.


Final publication-batch typecheck passed with the repository compiler options and an isolated temporary config excluding only the active, untracked `round2-history.test.ts`. The first unscoped run reported four generic-inference errors in that fixture while its breaker was writing it. The breaker corrected those annotations and passed focused compilation. No repository compiler setting was changed. Round-two full compilation remains required after integration. Signed pagination commit `dbc447b` contains only the reviewed native total validator, its two fixtures and Mac integration script.
