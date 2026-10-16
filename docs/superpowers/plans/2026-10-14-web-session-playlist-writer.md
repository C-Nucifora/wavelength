# Web-session playlist writer implementation plan

> For agentic workers: use executing-plans for the root integration track. Native bridge and wrapper are isolated worker-owned tracks with explicit file ownership, followed by independent whole-result review.

Goal: build a native Wavelength test bundle whose playlist writer uses the proven web-session route without Music UI automation.

Architecture: Swift owns credential storage and Apple HTTP requests. Bun owns discovery, authenticated selection receipts and persistent ordered jobs. The SwiftUI app saves connection values through native stdin IPC, never through Bun. The wrapper remains a separately testable native auth component.

Tech stack: existing SwiftUI, Foundation, Security, WebKit, Bun and SQLite. No new dependency.

Spec: `docs/superpowers/specs/2026-10-14-web-session-playlist-writer-design.md`.

User approved the written design and directed continuous build until a live test is needed on 14 October 2026. Root owns integration; the existing wrapper worker owns only its experimental directory. A native-bridge worker owns its new native directory and checks. This explicit ownership permits concurrent work without shared-file mutation. Preserve the user's existing checkout preference.

## Global constraints

- Stay on `feature/apple-music-web-session`; do not push, merge, install, launch a normal app with personal data, or issue account requests during implementation.
- Tokens never enter Bun, argv, environment, logs, server results or job records. Native setup and the bridge communicate only over bounded stdin/stdout.
- Production service `local.wavelength.apple-music.web-session.v1`, account `apple-music-web-session`. Never read the probe or wrapper's real items in checks.
- Fixed HTTPS `amp-api.music.apple.com`, Origin `https://music.apple.com`, no redirects, shared cookies, cache or URL credential storage.
- Preserve existing jobs, installed apps, builds, history and AI-off policy. No automatic Music writer fallback.
- Every track outcome must be confirmed before advancing. Ambiguous writes reconcile through GET only. No blind POST retry.
- Native generation checks and interprocess mutation exclusion are mandatory. Initial status and first setup support an absent generation.
- macOS 14 minimum. All tests use isolated data, fake credentials and fixture network boundaries.
- Local commits only after separate review. User requests handoff at the next live test, not an unapproved installation.

## Shared protocol

Native CLI receives one JSON object on stdin, at most 128 KiB. Response is one JSON envelope `{ok:true,result:...}` or `{ok:false,error:{code:string,message:string,uncertain:boolean}}`. Never emit raw underlying errors or input JSON. Allowed codes distinguish rejected, generation-changed, busy, invalid-input, missing, storage, unavailable, malformed and transport outcomes.

Requests use these exact operation names and fields:

```typescript
type NativeRequest = {
  action: "status" | "checkConnection" | "inspectTracks" | "ensurePlaylist" |
    "addTrackToPlaylist" | "rebindPlaylist" | "saveConnection" | "disconnect";
  generation?: string;
  catalogIds?: string[];
  position?: number;
  reconcileOnly?: boolean;
  playlistId?: string;
  name?: string;
  credentials?: {bearer: string; user: string}; // native setup only
};
```

`status` returns the existing compatibility status fields plus `backend:"web-session"`, `connection:"missing"|"saved"`, optional `generation`, optional `storefront`, and safe `message`. Compatibility running/accessibility are false and automation is unknown; the UI must not display them as write requirements.

`checkConnection` returns `{generation,storefront}`. `inspectTracks` returns `{generation,storefront,total,availableCatalogTracks,unavailableCatalogTracks,newLibraryAdditions:0,existingLibrarySongs:0}`. The last two fields are compatibility only and are not displayed for the web backend.

`ensurePlaylist` returns `{id,name}`. On an existing cloud ID it verifies an authenticated library read. On create it sends one empty-playlist POST. Definite pre-request or rejected outcomes have `uncertain:false`; transport, lost process reply or malformed successful create outcomes have `uncertain:true`.

`addTrackToPlaylist` receives the entire ordered `catalogIds` list, zero-based position and reconciliation mode. It returns the spec's `TrackWriteOutcome`. It requires exact current prefix before POST and exact extended prefix afterward. In reconcile-only mode it never sends POST even when the song appears absent.

`rebindPlaylist` receives a current generation, known cloud ID, expected sequence and position. It verifies current-account ownership and an expected prefix before returning `{generation}`. It may observe the current position already present for an uncertain track. It never writes.

`saveConnection` compares the expected prior generation or absent state under the lock, validates the candidate via reads, stores a complete pair with a fresh UUID generation, and returns a status/check result without credentials. `disconnect` compares the expected current state and deletes only the production item. Mutations fail busy while a bridge operation holds the shared private lock.

Shared native type for the wrapper is `WebCredentials` with `bearer`, `user` and `static parse(bearer:user:)`. Root supplies `typealias Credentials = WebCredentials` in the app module. Reusable wrapper files reference only that parser and their own capture types, not ProbeClient or storage.

## Review focus

1. Local Save racing a previously issued selection receipt must fail at the native generation boundary before a POST.
2. Lost create response or child termination must preserve an unknown creation state, not silently create again.
3. A 204 append with delayed/missing readback must stop the ordered queue and leave later tracks pending.
4. Reconnect to another account must not resume a private cloud playlist without ownership/prefix validation.
5. Legacy sixteen-character IDs and old partial jobs must remain untouched and must not enter the web writer.

### Task 1: native request and credential boundary

Owner: isolated native worker. Files: `native/WebMusic/Types.swift`, `Core.swift`, `Storage.swift`, `Main.swift`; `native/Tests/WebMusicChecks.swift`; `scripts/check-web-music.ts`.

- [ ] Write Swift fixture checks with literal responses and fake credential storage/locks. Assert no request on generation mismatch or lock contention, fixed host/headers, redirects blocked, safe normalization, no token-bearing error, create/append/readback and GET-only reconciliation. Observe RED against compiling unavailable behavior.
- [ ] Implement the shared protocol and native service. Preserve a complete credential record under one operation lock. Example expected guard:

```swift
guard request.generation == record.generation else { throw WebMusicError.generationChanged }
```

- [ ] Implement catalog availability and playlist readback with validated bounded pagination. Return typed confirmed/not-added/uncertain/conflict results; serialize safe envelopes only.
- [ ] Check real lock/journal-independent filesystem behavior in a fresh temporary directory and production Keychain target construction through fakes, never the user's items.
- [ ] Run `bun scripts/check-web-music.ts`; expected all fixture checks pass. Compile CLI and verify strict signature without running its production status or requests.
- [ ] Report RED/GREEN, filenames, protocol deviations and exact checks. No staging or commits from worker.

### Task 2: engine adapter, ordered jobs and receipts

Owner: root. Files: `src/web-music.ts`, `src/jobs.ts`, `src/types.ts`, `src/server.ts`, `src/index.ts`; new `tests/web-music.test.ts`, `tests/web-jobs.test.ts`; affected server fixtures.

- [ ] Write tests first against the current queue. A three-song web job whose second outcome is uncertain must retain first added, second failed/uncertain, third pending. Assert only catalog IDs 1 and 2 reached the writer. Assert Retry for the second uses reconciliation and does not reset its uncertainty. Observe RED.
- [ ] Add a web adapter discriminator and persisted connection generation, creation phase and typed track outcome. Keep legacy adapter behavior available only for existing isolated tests; production dependencies select the web adapter.
- [ ] Implement bridge IPC on stdin with safe bounded output parsing and owned-child shutdown. Unexpected child errors are uncertain where a write may have started. Do not include stdout/stderr/argv in user errors.
- [ ] Bind the native inspection generation to the selection receipt, pass it to job creation, and preserve existing draft/AI/expiry checks. Example literal assertion:

```typescript
expect(command).toEqual({action: "inspectTracks", catalogIds: ["1", "2"]});
expect(job.writer).toBe("web-session");
```

- [ ] Persist create-in-flight before ensure; persist cloud ID before append; stop at first nonconfirmed result. Preserve unknown create across restart. Rebind known jobs only after explicit Retry and read-only prefix/ownership check.
- [ ] Run focused adapter/job/server checks, then `bun test` and `bun run typecheck`; expected zero failures. Record results before advancing.

### Task 3: native connection UI, status and packaging

Owner: root. Files: `native/App/MusicConnection.swift`, `AppModel.swift`, `APITypes.swift`, `Views.swift`, `EngineController.swift`; `scripts/build-app.ts`, `scripts/check-native.ts`; native and packaging fixture checks; compatibility `public/app.js`; README.

- [ ] Write native/model fixture checks for saved/missing connection status, blocked stale receipt, generation update clearing preflight, failed local save preserving input and state, and safe native IPC. Observe RED before implementation.
- [ ] Implement a native connection panel with two SecureFields and explicit validation/save, check and disconnect. Call native bridge directly and clear fields after successful save. Disable mutations while a job/operation is active. Never expose saved values.
- [ ] Update web-backend preflight and status rendering to catalog availability and connection state. Preserve layout and selection/AI/history behavior. Legacy jobs are visible but retry/open controls cannot use old IDs under the web backend.
- [ ] Package and check `WebMusicBridge` instead of the Accessibility writer. Copy read-only history JXA only; no active Music UI writer. Compile shared Types and the wrapper's reusable files into the native app when available. Update the Apple Events description to history reads only.
- [ ] Keep automatic sign-in labelled experimental until its live capture gate passes. Manual entry remains available and no login/capture starts on launch.
- [ ] Run `bun run test:native`, `bun run typecheck`, complete Bun suite and signed app build. Use isolated fixture data for packaged checks; expected no account or personal Keychain access.

### Task 4: independent native sign-in wrapper

Owner: existing wrapper worker. Files exclusively under `experimental/web-session-probe/auth-wrapper/`. Requirements: reviewed `../web-session-probe/wrapper-research.md` and `wrapper-review.md`.

- [ ] Test trusted frame/origin/generation, exact host filtering, native cookie combination, complete-pair parsing, preserved fetch/XHR semantics and cancellation with fakes. Observe RED then GREEN.
- [ ] Implement `AppleMusicSignInSheet(onCapture: (Credentials)->Void, onCancel: ()->Void)` in reusable `WrapperPolicy.swift`, `WrapperCapture.swift`, `WrapperWebView.swift`. Main-frame MusicKit getters first, exact native cookie fallback next, narrow HTTP-header observer last. No password fields, account-frame scraping, request-body capture or broad storage search.
- [ ] Standalone wrapper uses ProbeClient GET-only validation and its separate Keychain item. It never instantiates the playlist probe model/journal or POSTs.
- [ ] Build a separate signed bundle in a new numbered T3 project directory without launching it. Return reusable file paths, checks and known live-only limitations. No staging/commits or shared source mutations.

### Task 5: integration review and live-test handoff

Owner: root plus fresh separate reviewer.

- [ ] Integrate stable worker results without touching the saved probe connection or completed test guard. Run full suites, all native fixture checks, TypeScript checks, build and strict signature verification on the actual result.
- [ ] Give reviewer the actual diff, spec, plan, worker reports, ledger and five review-focus conditions. No credentials/account writes in review.
- [ ] Fix concrete Critical/Important findings with reproducing RED/GREEN checks and rerun relevant full checks. Local commits only after review; preserve all prior bundles. No push or install.
- [ ] Hand off the new native bundle and wrapper bundle with exact next tests. Stop for user login and consent before token capture, production Keychain grants, installation or another account playlist write. Report unofficial-route risks and any unresolved live-only behavior.
