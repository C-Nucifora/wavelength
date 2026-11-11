# Hardening verification

This audit started from `1e651133b0f65336d6336af12cc0a9aab0f58869` on Linux x86_64 with Bun 1.3.14 and Node 22.22.1. The checkout was clean before the audit. The interrupted run's changes were preserved and reviewed before resuming. No real credentials, Keychain items, personal Music library, paid services or installed app were used. All account and write checks used synthetic adapters or fixtures and temporary state.

## Issue ledger

P2 means a security or correctness defect that should be fixed before release. P3 means a bounded integrity defect. Native fixtures below are prepared source checks until they run on macOS.

| ID | Severity | Reproduction and expected behavior | Root cause and fix | Verification |
| --- | --- | --- | --- | --- |
| H1 | P2 | Fetch `/api/session` anonymously, then send a local-header write with its token. A native engine must reject both without its parent's token. | Browser bootstrap was also available in native mode. The parent now generates a launch token, passes it to the owned engine, and authenticates readiness and every request. Developer mode retains an explicit shared-machine limitation. | `native-engine.test.ts`; HTTP launch/restart check in `native-packaging.test.ts`; native transport and pending-engine fixtures. |
| H2 | P2 | Retry a job with no playlist ID, defer status, cancel, then resolve status. No playlist creation may follow cancellation. | Retry awaited status without checking cancellation before `ensurePlaylist`. It now saves cancellation and returns before creation. | Deferred-status regression in `web-jobs.test.ts` asserts zero creation calls and no playlist ID. |
| H3 | P2 | Queue a connection helper, then stop before launch. No helper may start after shutdown. | Detached work could publish a process before launch while stop only killed running processes. Launch and stop now share the ownership lock and a permanent stopped guard. | `ConnectionChecks.swift` checks stopped IPC before spawn. Actual macOS scheduling and process behavior remain unverified. |
| H4 | P2 | Call native `start()` twice synchronously. Startup must have one owner; stopping an older process must preserve a newer process reference. | `starting` was set only inside the task; stop cleared mutable process/output after suspension. Startup now claims `starting` synchronously, and stop captures its owned process/output and clears only the matching reference. | Duplicate-start assertion in `PendingChecks.swift`; packaged restart and unrelated-process sentinel in `NativeChecks.swift`. Overlapping native teardown needs macOS execution. |
| H5 | P2 | Open the same state file twice while a saved job is active. The second engine must fail without marking the first engine's work interrupted. Kill the first owner and reopen. | SQLite state writes allowed multiple engine owners and startup recovery could mutate another engine's jobs. A separate SQLite lease holds an immediate transaction for the owner's lifetime. | Same-process exclusivity, persisted state, private lease permissions, lock-file symlink rejection without target changes, close/reopen, and SIGKILL/reopen in `store.test.ts`. |
| H6 | P2 | Check `[A,B]`, then submit `[B,A]` with that receipt. Reject the changed order. | The preflight key sorted IDs while discovery creation preserved caller order. Receipt keys now retain requested order. | `server.test.ts` tests rejected reordering and accepted unchanged selection. Discography retains its canonical draft order. |
| H7 | P2 | Return a playlist page whose next offset is zero or skips rows. Never confirm duplicate occurrences using repeated or incomplete readback. | Helper readback accepted any numeric offset. It now requires nonempty pages and an offset equal to the number of accumulated tracks. | `WebMusicChecks.swift` adds repeated and skipped offset fixtures. Swift execution is pending. |
| H8 | P3 | Return 41 releases with 25 songs each and mark the artist AI. A catalog over 1,000 occurrences must fail even if no songs are retained. | The discography bound counted retained songs but omitted earlier excluded songs. It now includes excluded occurrences. | `discography.test.ts` rejects the 1,025-occurrence excluded catalog. |
| H9 | P3 | Match CSV title/album to a library row with a conflicting explicit artist. Preserve supplied metadata without borrowing another artist's genre or album artist. | Enrichment checked title/album while ignoring a supplied artist. Conflicting artist names now prevent enrichment. | `history.test.ts` checks null genre/album artist, no enriched fields, and unmatched coverage. Case/accent distinctions remain exact. |
| R1 | P2 | Run the native fixture client after H1. It must authenticate before requesting the session, including after restart. | Four fixture bootstrap requests lacked the new parent token. Each now reads the owned fixture process's launch token before bootstrap. The fixture still rejects unsigned requests. | Independent native review reproduced 403 without a synthetic token and 200 with it. All affected Swift bootstrap call sites were checked; execution needs macOS. |

## Verification coverage

The resumed full `bun test --timeout 120000` run, with `umask 022`, completed with 331 passes, 3 skips and 2 failures across 336 tests. Both failures require absent macOS tools: source ZIP round-trip uses `/usr/bin/ditto`; real ad hoc executable signing uses `/usr/bin/xcrun` and `/usr/bin/codesign`. They were left visible. Earlier mode/hash failures came from this host's group-writable creation mask; large-fixture timeouts occurred under concurrent host load. No assertions or data limits were weakened.

Typecheck, browser JavaScript syntax, and JXA syntax through Node's stdin check passed. JXA fixture tests exercise fake dictionary getters under Bun; syntax checks do not establish Automation acceptance. Native, WebMusic, artwork and auth-wrapper Swift commands cannot run because `/usr/bin/xcrun` is absent. `build:app` explicitly rejects Linux. No macOS app or release ZIP was built or signed here.

After native fixture repair, the added HTTP launch/restart test passed with 26 assertions. It uses a real loopback server, rejects anonymous and wrong-token reads, accepts authenticated readiness, shuts down and reopens the same isolated data directory. The auth-wrapper JavaScript capture checks also passed for dormant capture, exact hosts, request overrides, XHR and teardown.

Final affected-suite verification after adding the lock-file symlink fixture passed 19 tests with 116 assertions across store, native-engine and native-packaging, with one existing macOS-only skip. Typecheck passed again. These checks ran serially with disk-backed temporary storage. They supplement the full-suite result above; they do not replace the blocked release or native checks.

The existing fixtures cover ordered playlist intent, seeded creation, deduplication, uncertain create/append outcomes, retry/rebind, generation changes, missing playlists, partial failures, cancellation, catalog substitution, discography paging, CSV bounds, source provenance, and artwork status mapping. Conservative cover crash recovery remains read-only: a saved pending cover without a helper journal can become uncertain and offer only Check cover. It may remain unapplied; recovery never resends songs or silently reapplies artwork.

Static review covered fixed Apple hosts and redirect rejection, helper stdin/stdout bounds and error mapping, Keychain generation checks, literal subprocess arguments, artwork path/hash/mode checks, WebKit capture origins, release snapshot completeness, symlink rejection and nested signature checks. The 26-entry runtime source inventory has unique relative paths and SHA256-shaped values, and records clean rebuild/relink as not run. This does not verify the unavailable companion archives' bytes or establish successful redistribution/rebuild.

Native UI review found explicit labels on history actions and chart/table alternatives, guarded Create/Retry/connection actions, startup recovery text, adaptive grids and scrolling. Native model fixtures cover stale receipts, pending requests, unavailable songs, history recovery and connection changes. VoiceOver, focus order, keyboard navigation, window resizing and actual memory/CPU behavior require a Mac. No visual or accessibility acceptance is claimed from source inspection.

Test engines bind `127.0.0.1` with ephemeral ports. An actual listener inspection during the resumed suite showed Bun on `127.0.0.1`; no Bun/Wavelength listener remained after the targeted checks. Existing nginx routes were inspected and did not proxy Wavelength. Existing public services were left alone. After rootless Docker became available, its running-container listing was empty. No container or proxy was created, and no other daemon was inspected. Further runs use disk-backed `TMPDIR` because the VPS `/tmp` is memory-backed and host resources are shared.

## Reproduce the Linux checks

Use Bun 1.3.14, Node, Git, an isolated checkout and enough memory for the 20 MiB and 50,000-row fixtures. Run one suite at a time. Do not provide any Apple credentials or production data environment variables.

```sh
mkdir -p "$HOME/.local/share/agent-tmp"
export TMPDIR="$HOME/.local/share/agent-tmp"
umask 022
bun install --frozen-lockfile
bun test --timeout 120000
bun run typecheck
node --check public/app.js
node --check < native/history.jxa
node --check < native/library.jxa
bun experimental/web-session-probe/auth-wrapper/CaptureChecks.ts
git diff --check
```

Expect the two release tests above to need macOS. Do not substitute Linux ZIP/signature mocks as release acceptance.

## Required macOS verification

Missing inputs are a macOS 14 or later machine with Command Line Tools or Xcode, SwiftUI/AppKit/WebKit/Security frameworks, `xcrun`, `codesign`, `ditto`, and the exact reviewed source. Release packaging additionally needs Apple Silicon, the pinned official arm64 Bun binary/archive and all companion source archives. This VPS cannot reach home machines. No home-host SSH was attempted.

On a disposable test user with no Apple Music account or production connection, record `sw_vers`, `xcodebuild -version`, `xcrun swiftc --version`, architecture and Bun revision. Then run:

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
node --check public/app.js
mkdir -p .build
xcrun swiftc native/MusicBridge.swift -o .build/MusicBridge
bun run test:native
bun scripts/check-web-music.ts
bun scripts/check-artwork.ts
bun experimental/web-session-probe/auth-wrapper/check.ts
WAVELENGTH_SIGN_IDENTITY=- bun run build:app
```

The fixture suites use fake Music/account boundaries and temporary state. The build creates a new app under `../builds.noindex/` and runs packaged lifecycle checks; it must never replace an installed copy. Repeat `bun run test:native /path/to/new/Wavelength.app/Contents/Resources` to verify that specific bundle's readiness token, private port, shutdown, restart and unrelated-process sentinel. Verify nested and outer signatures with `codesign --verify --deep --strict /path/to/new/Wavelength.app`.

Exercise minimum window size, resizing, VoiceOver, keyboard focus and visible error/recovery states in a disposable test environment without signing in, reading Music, importing private CSV files or creating playlists. Use synthetic CSV fixtures. Record observations separately from model tests. Idle and active fixture CPU/memory and retained child counts need measurement on that Mac.

For a release candidate, follow `docs/RELEASING.md` with an independently reviewed snapshot and matching runtime materials. Extract both ZIPs into new directories, recheck hashes/signatures/resources and run fixtures against the extracted app. Follow `licenses/RUNTIME-REBUILD.md` separately for a clean runtime rebuild and modified-library relink. Those steps remain unverified here.

Gatekeeper, quarantine-preserving clean-machine installation, account/storefront compatibility and real Apple CSV exports remain unverified. Do not alter Gatekeeper or remove quarantine. Account acceptance requires separate owner authorization and is outside this task's permitted tests.

## Review and local history

The initial four read-only audits covered security, jobs, native/release behavior and data. Resumed independent Astra high/priority reviews examined the preserved changes. Native review found R1, which was fixed, and no additional production defect. Engine/data review found no substantive defect. Its extra isolated checks confirmed cross-process lease exclusion after a rejected opener, lock-file symlink rejection, actual HTTP token enforcement and ownership release on shutdown. The two suggested fixtures were added. No repository files were changed by reviewers.

No reliable branch last-push timestamp was found in the remote-tracking reflog or available GitHub push events. This is an application repository, not coursework. Local commits use the realistic-commits past-day fallback, keep configured signing enabled, and include only this audit's changes. No push, publication, deployment, provider/authentication change or remote-setting change is authorized or performed.
