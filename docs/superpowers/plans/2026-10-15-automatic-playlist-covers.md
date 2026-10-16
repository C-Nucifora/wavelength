# Automatic playlist covers implementation plan

> Historical record. This document describes the approved work at the time, including its earlier architecture, build and installation steps. Use [the current README](../../../README.md) for current behavior and setup. It does not authorize repeating past live tests or replacing an installed app.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Generate free playlist covers, attach them in Music after confirmed song completion, then install the reviewed native build in Applications.

**Architecture:** Extend the existing locked WebMusicBridge with a credential-free artwork service. The helper validates the cloud playlist and local Music identity before attachment. Independent, durable cover state preserves completed songs and prevents repeating uncertain writes.

**Tech stack:** Bun, TypeScript, Swift, Foundation, AppKit, CryptoKit, Security and non-UI Music AppleEvents. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-automatic-playlist-covers-design.md`

## Global constraints

- Work in the existing `feature/apple-music-web-session` branch. Preserve the existing availability-fix changes and saved app data.
- New marked jobs only. No retroactive covers, unrelated playlist writes, discovery changes, paid image services or GitHub push.
- No Accessibility, clicks, keystrokes, activation, playback control or dialog dismissal.
- Render a deterministic 1024-pixel JPEG and retain immutable attempted bytes and SHA-256 across upgrades.
- Persist songs `complete` and cover `pending` together. Cover failures must never fail the song job or resend songs.
- Lost replies and restarted attempts reconcile read-only, including when the native journal is absent.
- Verify direct `data of artwork 1` bytes, even after script errors or zero artwork counts. Local verification is not automated cloud proof.
- Build 4, version `0.1.0`, macOS 14 minimum, approved icon unchanged. Preserve build 3 before replacing `~/Applications/Wavelength.app`.
- Keep evidence and bundles under the project output folder at `../`. Never log credentials or pass them through artwork interfaces.

## Review focus

- A playlist syncs late or two local copies share a marker. Block before writing, preserve songs and allow an explicit pre-write retry.
- Duplicate catalog IDs and Unicode metadata remain ordered and compare consistently. Reject missing/nonfinite duration and differences over three seconds.
- A process stops after persisting native setter intent but before sending. Treat it as potentially written and perform read-only recovery.
- A malicious or damaged local asset uses symlinks, a different owner or mismatched hashes. Reject it without sending a setter or exposing arbitrary files in the UI.
- Music permission is denied or helper output is lost. Keep song completion accurate, request permission only through an explicit action and never blindly repeat attachment.

## Task 1: Locked cloud validation and artwork contracts

**Files:** Create `native/WebMusic/ArtworkTypes.swift`; modify `native/WebMusic/Types.swift`, `native/WebMusic/Core.swift`, `native/WebMusic/Main.swift`, `native/Tests/WebMusicChecks.swift`, `scripts/check-web-music.ts`.

**Interfaces:** Add these Foundation-only contracts. Native rendering and Music control implement the service in Task 2.

```swift
enum ArtworkMode: String, Codable { case apply, check, authorize }
struct ArtworkTrack: Codable, Equatable {
    let title: String; let artist: String; let album: String
    let durationSeconds: Double
}
struct ArtworkTarget: Codable {
    let jobID: String; let playlistID: String; let name: String
    let tracks: [ArtworkTrack]
}
struct ArtworkResult: Codable {
    let state: String // verified, blocked or uncertain
    let code: String
    let writeAttempted: Bool // durable native setter intent, not proof of dispatch
    let imageHash: String?
}
protocol ArtworkService {
    func handle(_ target: ArtworkTarget, mode: ArtworkMode) async -> ArtworkResult
}
enum ArtworkPaths {
    static func root() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Wavelength/playlist-covers", isDirectory: true)
    }
    static func directory(jobID: String, root: URL) throws -> URL {
        guard let uuid = UUID(uuidString: jobID) else { throw WebMusicError.invalidInput }
        return root.appendingPathComponent(uuid.uuidString, isDirectory: true)
    }
}
```

Extend `WebMusicRequest` with optional `jobId: String?` and `coverMode: ArtworkMode?`. Inject `artwork: (any ArtworkService)? = nil` into `WebMusicService.init`. Add `playlistCover` to action validation. It requires UUID `jobId`, generation, exact playlist ID/name, nonempty catalog IDs and a mode; it does not use append `position`. Reject cover-only fields on unrelated actions and unknown native JSON keys before decoding. Allow optional valid `jobId` on `ensurePlaylist` for legacy test compatibility, but new Jobs always provide it.

- [ ] Write failing native checks with a fake artwork service. Assert the service runs while `FakeWebLock.held`, sees metadata but no credentials, and is not called for stale generation, wrong marker/name, noneditable playlist, missing metadata or different complete catalog order. Use a one-song complete playlist and duplicate `["1", "1"]` order fixtures to catch use of the old position validator.

```swift
let request = WebMusicRequest(action: "playlistCover", generation: record.generation,
    catalogIds: ["1"], playlistId: "p.created", name: "Fixture playlist",
    jobId: "33333333-3333-3333-3333-333333333333", coverMode: .apply)
let result = try await service.handle(request)
try expect(result["state"] as? String == "verified", "complete order accepts no remaining position")
try expect(artwork.targets.count == 1 && artwork.targets[0].tracks[0].durationSeconds == 180,
           "canonical cloud milliseconds become seconds")
```

- [ ] Run `bun scripts/check-web-music.ts`. Confirm failure is from the missing contract/action, not a live network or Keychain request.
- [ ] Implement the contracts and request validation. Creation attributes add `description: "Wavelength playlist job " + UUID(uuidString: jobId)!.uuidString` when marked. Add a dedicated full-order cloud inspection under the existing lock. Require exact `p.*` resource, `attributes.canEdit == true`, exact name and description marker. Accept description as either Apple's plain string or its `standard` string field; reject other representations. Preserve existing bounded pagination and catalog mapping. Parse canonical `name`, `artistName`, `albumName`, `durationInMillis` from track attributes only for cover validation, so missing cover metadata does not break ordinary song append checks.

```swift
var attributes: [String: Any] = ["name": request.name!]
if let jobID = request.jobId {
    attributes["description"] = "Wavelength playlist job " + UUID(uuidString: jobID)!.uuidString
}
// Use attributes in the existing ensurePlaylist POST body.
// The separate playlistCover branch retains the lock and requires full equality:
guard contents.map(\.catalogID) == request.catalogIds! else { throw WebMusicError.malformed }
```
- [ ] Catch artwork preparation errors as safe typed blocked results before entering the native service. Do not send credentials, raw response bodies or arbitrary error messages to it. A generation change remains the existing safe generation error. Return native `ArtworkResult` fields in a bounded helper result.
- [ ] Extend offline checks for marker creation, wrong album/title/artist, nonfinite/nonpositive duration, duplicate order, malformed descriptions and more than one cloud row. Run `bun scripts/check-web-music.ts` and obtain green output. Have the reviewer inspect the actual diff before a scoped local commit named `Validate playlist cover targets`.

## Task 2: Immutable cover assets and non-UI Music attachment

**Files:** Create `native/WebMusic/ArtworkStore.swift`, `native/WebMusic/ArtworkRenderer.swift`, `native/WebMusic/ArtworkMusic.swift`, `native/Tests/ArtworkChecks.swift`, `scripts/check-artwork.ts`; modify `native/WebMusic/Main.swift`, `scripts/check-web-music.ts`.

**Interfaces:** `NativeArtworkService: ArtworkService` composes an `ArtworkStore`, renderer and injected `ArtworkMusicDriver`. Use these testable boundaries.

```swift
struct ArtworkAsset { let url: URL; let hash: String }
struct LocalArtworkTarget: Codable { let persistentID: String; let name: String; let marker: String; let tracks: [ArtworkTrack] }
protocol ArtworkMusicDriver {
    func permission(ask: Bool) async -> Bool
    func resolve(_ target: ArtworkTarget) async throws -> LocalArtworkTarget
    func read(_ target: LocalArtworkTarget) async throws -> Data
    func set(_ target: LocalArtworkTarget, asset: ArtworkAsset) async throws
}
```

`ArtworkStore` uses `~/Library/Application Support/Wavelength/playlist-covers/<canonical UUID>/cover.jpg` and `journal.json`, resolving the home location through the platform API, not caller paths. Use one shared path derivation for native service and UI. Journal records version, UUID, cloud ID, name, canonical snapshot, optional validated hexadecimal local ID, image hash and conservative `writeAttempted`. Managed cover root/job directories must be owned 0700 and regular files owned 0600, single-link, no symlinks. Use no-follow file opens, bounded reads and atomic journal/image replacement with durability before setter dispatch. Reject assets larger than 4 MiB, non-JPEG data, wrong 1024×1024 dimensions and journal/hash disagreement. Generated title input remains at most 512 UTF-8 bytes. Initializers must be inert. Inject a temporary private root in all tests; CLI rejection checks must never create production files, launch Music or inspect permission.

- [ ] Write failing `ArtworkChecks` using fake Music calls and a temporary private store. Pin the actual count-zero/error regression and safety rules.

```swift
driver.setterError = NSError(domain: "fixture", code: 1)
driver.readBytes = generatedJPEG
let result = await service.handle(target, mode: .apply)
try expect(result.state == "verified" && result.writeAttempted, "readback beats setter error")
try expect(driver.setCalls == 1, "one setter")
let recovered = await service.handle(target, mode: .check)
try expect(recovered.state == "verified" && driver.setCalls == 1, "recovery reads only")
```

- [ ] Run `bun scripts/check-artwork.ts` and confirm a missing implementation failure. The harness must compile fake-boundary tests and scripts without executing Music, Keychain or network.
- [ ] Implement the renderer with AppKit drawing and CryptoKit hashing. Use a stable SHA-256 seed of canonical job UUID/title for charcoal/violet accent choices and wave geometry. Draw bounded/wrapped title text, then JPEG-encode at fixed quality. Reuse existing validated bytes rather than rerendering an attempted asset. Tests decode the image, compare dimensions/hashes, test long multilingual titles, distinguish different UUIDs and confirm existing bytes survive a renderer change.
- [ ] Implement matching by trimming and collapsing Unicode whitespace, then locale-independent lowercase. Compare every ordered title/artist/album and finite positive duration with absolute tolerance `<= 3` seconds. Require exactly one local playlist with the reserved marker; save and validate its hexadecimal persistent ID. Recheck name, marker, ID and ordered snapshot inside the setter script before changing artwork. Missing or duplicate candidates return a known pre-write block.
- [ ] Implement Music background launch without activation and permission inspection with `AEDeterminePermissionToAutomateTarget`. Only `.authorize` may ask for permission. It follows the same locked completed-job ownership validation before entering the credential-free artwork service. Authorization performs no setter and returns a known pre-write status when safe. `.apply` with missing permission blocks. Keep a potentially written journal/result uncertain if permission or identity now blocks its readback.
- [ ] Adapt the proven picture-data setter from `../artwork-probe/004/Probe.swift`, never its playlist-creation or track-duplication actions. Quote only validated strings. Read the fixed asset `as picture` before `tell application id "com.apple.Music"`; dispatch `set data of artwork 1 of p to imageData`. Use 15-second AppleScript timeouts and the existing helper deadline. Directly read `data of artwork 1`, decode it and compare SHA-256 even if the setter throws. Do not query artwork count to decide whether to read. Persist setter intent first; attempted, unknown or missing-journal check mode never sends a setter.

```applescript
with timeout of 15 seconds
    set imageData to (read POSIX file imagePath as picture)
    tell application id "com.apple.Music"
        set candidates to get every user playlist whose description is marker
        if (count of candidates) is not 1 then error number -2700
        set p to item 1 of candidates
        if (persistent ID of p) is not savedID then error number -2700
        if (name of p) is not savedName then error number -2700
        -- The generated script also compares every saved ordered local track before this setter.
        set data of artwork 1 of p to imageData
    end tell
end timeout
```
- [ ] Add tests for wrong/unreadable images, crash after intent save, lost result, absent journal, wrong ownership, symlinked parent/file, hash mismatch, duplicate marker, changed saved local ID, reordered tracks, three-second boundary and permission denial. Compile the actual AppleScript templates offline. Wire `NativeArtworkService` into Main only for production; retain the injected fake for checks.
- [ ] Run `bun scripts/check-artwork.ts` and `bun scripts/check-web-music.ts`. Reviewer checks the actual setter, file safety and recovery paths before a scoped local commit named `Add native playlist cover attachment`.

## Task 3: Durable cover jobs and safe actions

**Files:** Modify `src/types.ts`, `src/jobs.ts`, `src/web-music.ts`, `src/server.ts`, `tests/web-jobs.test.ts`, `tests/web-music.test.ts`, `tests/server.test.ts`; update fixtures constructing web adapters.

**Interfaces:** Add the following shared types and adapter operation. Existing job data has optional fields and remains readable.

```ts
export type PlaylistCover = {
  state: "pending" | "applying" | "verified" | "blocked" | "uncertain";
  code?: string;
  helperAttempted: boolean;
  writeAttempted?: boolean;
  imageHash?: string;
};
export type CoverContext = {
  jobId: string; name: string; connectionGeneration: string;
  expectedCatalogIds: string[]; mode: "apply" | "check" | "authorize";
};
// MusicJob gets coverEligible?: boolean and cover?: PlaylistCover.
// ensurePlaylist context gets jobId?: string.
// WebMusicAdapter gets:
// playlistCover(id: string, context: CoverContext): Promise<PlaylistCover>
// Jobs gets coverAction(id: string, action: "retry" | "check" | "permission"): MusicJob.
```

- [ ] Write failing job tests proving completion precedes cover dispatch and a thrown cover operation leaves songs complete and does not repeat create/append. Use an injected deferred cover promise to prove `jobs.isActive()` stays true and another create/retry remains blocked.

```ts
const store = new Store(":memory:");
let finishCover!: (value: PlaylistCover) => void;
const deferred = new Promise<PlaylistCover>(resolve => {finishCover = resolve;});
let appends = 0;
const jobs = new Jobs(store, adapter({
  addTrackToPlaylist: async (t: DraftTrack) => {
    appends++;
    return {kind: "confirmed", catalogId: String(t.catalogId), alreadyPresent: false};
  },
  playlistCover: async () => deferred,
}));
const job = jobs.create("Test", [track(1)], false, "g1");
for (let i = 0; i < 100 && jobs.get(job.id)?.cover?.state !== "applying"; i++) await Bun.sleep(5);
expect(jobs.get(job.id)).toMatchObject({state: "complete", cover: {state: "applying"}});
expect(jobs.isActive()).toBe(true);
expect(() => jobs.create("Other", [track(2)], false, "g1")).toThrow("already running");
finishCover({state: "verified", helperAttempted: true, writeAttempted: true, imageHash: "a".repeat(64)});
await finished(jobs, job.id); // Existing bounded fixture helper in web-jobs.test.ts.
expect(jobs.get(job.id)?.state).toBe("complete");
expect(appends).toBe(1);
store.close();
```

- [ ] Run `bun test tests/web-jobs.test.ts tests/web-music.test.ts tests/server.test.ts` and record the intended failures.
- [ ] Persist cover eligibility for new web jobs before POST and pass job UUID to marked creation. After all songs are confirmed, save complete/pending together. Run cover handling after the song try/catch and before releasing `activeId`. Before IPC save applying/helperAttempted. Map typed results without changing song state/message. Unknown replies become uncertain, never a retryable pre-write block.

```ts
private async runCover(job: MusicJob, music: WebMusicAdapter, mode: CoverContext["mode"]) {
  if (!job.coverEligible || job.state !== "complete" || !job.playlistId || !job.connectionGeneration) return;
  const prior = job.cover;
  job.cover = {...job.cover, state: "applying", helperAttempted: true};
  this.save(job);
  try {
    const next = await music.playlistCover(job.playlistId, {
      jobId: job.id, name: job.name, connectionGeneration: job.connectionGeneration,
      expectedCatalogIds: job.tracks.map(item => String(item.track.catalogId)), mode,
    });
    const previouslyUncertain = prior?.state === "uncertain" || prior?.state === "applying" || prior?.writeAttempted === true;
    job.cover = previouslyUncertain && next.state !== "verified"
      ? {...next, state: "uncertain", writeAttempted: prior?.writeAttempted === true || next.writeAttempted === true ? true : undefined}
      : next;
  } catch {
    job.cover = {...job.cover, state: "uncertain", code: "connection-unconfirmed", helperAttempted: true};
  }
  this.save(job);
}
```
- [ ] On construction persist `applying` cover records as `uncertain` before scheduling read-only reconciliation. Recover `pending` records read-only too. Serialize recovery with normal work. Do not acquire cover eligibility for old jobs. An absent or damaged native journal cannot reset backend helper uncertainty. Explicit retry of a known pre-write block may use apply; uncertain/prior write uses check. Explicit permission action only authorizes, then lets the user retry. After reconnection, explicit actions obtain current generation and invoke full ownership/marker/order validation; automatic actions use the saved generation.
- [ ] Preserve prior native write intent and backend uncertainty across later permission, generation or identity failures. A new pre-write rejection does not prove that an older lost operation never wrote. Add a regression test for uncertain IPC followed by cloud validation rejection and an absent journal; the next action must still be check-only.
- [ ] Add the restart variant with saved `applying`, `helperAttempted: true`, absent `writeAttempted` and no native journal. After a cloud validation rejection it must remain `uncertain`, keep songs complete and issue only checks on every subsequent cover action.
- [ ] Add `/api/jobs/:id/cover-retry`, `/cover-check` and `/cover-permission` routes using existing request authentication, exact-empty JSON action bodies and Music-read/job exclusion. Validate completed web job, UUID/marker eligibility, all songs confirmed and idle state. Never route these through song retry or create.
- [ ] Add `playlistCover`, `jobId`, `coverMode` to strict adapter allowlists. Classify apply-mode cover IPC as a potentially mutating request. Validate only known state/code values, boolean write intent and optional lowercase 64-hex hash. Never return helper-supplied free-form messages or paths. Test oversized/malformed/lost cover replies and definite pre-write blocks.
- [ ] Extend tests for old records, partial/cancelled jobs, pending restart, absent native journal, generation change and all three API actions. Confirm no append/create counters increase during cover-only actions. Run the focused tests plus `bun run typecheck`, then reviewer checks actual persistence and action guards before a scoped commit named `Track automatic cover jobs`.

## Task 4: Native cover status and build 4

**Files:** Create `native/App/PlaylistCover.swift`; modify `native/App/APITypes.swift`, `native/App/AppModel.swift`, `native/App/Views.swift`, `native/Tests/PendingChecks.swift`, `native/Tests/ConnectionChecks.swift`, `tests/fixtures/pending-engine.ts`, `scripts/check-native.ts`, `scripts/build-app.ts`, `tests/native-icon.test.ts`, `public/app.js`, `tests/frontend.test.ts`, `README.md`.

**Interfaces:** Decode optional `coverEligible` and `cover` using the same names as Task 3. Keep `songActive` separate from `coverActive`; `MusicJob.active` combines both. Add cover-only action dispatch using the three routes, not `submitMusicJob` song retry. `PlaylistCover.swift` maps validated codes to local text, derives the fixed UUID image path and validates private file type/owner/size/hash before creating a thumbnail. No arbitrary server path or image bytes in IPC.

- [ ] Write failing native fixtures for complete/applying polling, denied permission, uncertain check-only control, verified thumbnail and old records without cover. Confirm connection changes and history scans are blocked during cover work, while cover failure still shows all songs added.

```swift
try expect(job.state == "complete" && job.active && job.coverActive, "cover keeps polling after songs complete")
try expect(!job.songActive && !job.retryable, "cover does not expose song retry")
try expect(!model.canManageConnection, "cover excludes connection mutation")
```

- [ ] Run `bun scripts/check-native.ts` and observe the expected missing cover-model failures.
- [ ] Extend Codable models and job polling. Native job panel displays a small thumbnail, independent cover message and the applicable permission/retry/check button. Only song-active work shows Cancel creation. Preserve legacy job text and song totals. Load thumbnail when expected hash appears, without blocking the main thread. Reject bad UUID, bad hash or untrusted asset. Keep browser compatibility status text-only, using local mapped text, and extend its polling/busy checks so it cannot start a conflicting job during cover work.

```swift
var songActive: Bool { ["queued", "running"].contains(state) }
var coverActive: Bool { ["pending", "applying"].contains(cover?.state ?? "") }
var active: Bool { songActive || coverActive }
// JobPanel's existing Cancel creation and song progress controls use songActive.
// AppModel polling and connection/history exclusion continue to use active.
```
- [ ] Update native harness source lists for PlaylistCover and ArtworkTypes, and helper packaging lists for ArtworkTypes/Store/Renderer/Music. App builds include ArtworkTypes for shared path derivation. Bump build 3 to 4. Set AppleEvents purpose text to `Wavelength reads your Music library metadata and listening statistics when you request a history scan, and updates artwork for playlists it creates.` Keep identifiers, macOS floor and icon unchanged. Update README to explain HTTP song writes, background Music/Automation covers and local versus cloud verification.
- [ ] Run `bun scripts/check-native.ts`, `bun scripts/check-artwork.ts`, `bun scripts/check-web-music.ts`, `bun run typecheck` and `bun test`. Reviewer checks real UI/action state and packaging changes before a scoped commit named `Show native playlist cover status`.

## Task 5: Review, end-to-end acceptance and safe installation

**Files:** Build outputs in `../builds.noindex/`; evidence in `../automatic-covers/001/`; previous installed bundle in `../installed-backups.noindex/`. No unrelated library targets or test cleanup.

**Interfaces:** Use the reviewed build 4 candidate native app, its normal job API and bundled helper for acceptance before replacing Applications. Keep credentials in Keychain. Record only safe job/playlist IDs, marker, cover hash, song counts and outcome in acceptance evidence.

- [ ] Record the current repository diff and build 3 bundle identity. Run a whole-feature independent review against the spec and plan. Fix actual findings and repeat focused checks before proceeding. Run `git diff --check`, `bun run typecheck`, `bun scripts/check-artwork.ts`, `bun scripts/check-web-music.ts`, `bun scripts/check-native.ts`, `bun test`, then `bun run build:app`. Require actual zero exits, not worker assurances.
- [ ] Run `WAVELENGTH_PACKAGING_APP=<exact new bundle> bun test`, `/usr/bin/codesign --verify --deep --strict <exact new bundle>` and `/usr/bin/plutil -lint <exact new bundle>/Contents/Info.plist`. Independently verify build 4, expected executable identifiers, packaged sources/resources and unchanged approved icon. Do not replace Applications until checks and review pass.
- [ ] Before launching the candidate, check whether the installed app or an owned job/helper is running. Ask for a safe quit if needed. Never run two Wavelength instances against the same saved data. Launch the exact reviewed candidate and confirm its path/build before sending acceptance requests through its normal job API. Do not read credentials from a separate process; the candidate's bundled helper owns account access.
- [ ] Run one clearly labelled end-to-end acceptance job such as `Wavelength automatic cover TEST <short UUID>` through the new HTTP writer, with one available catalog song and AI inclusion off. The user's authorization permits testing; cap this acceptance at one newly created playlist and do not automatically retry writes. Persist the job before each mutation. Verify catalog order, unique marker/name match, completed song state and exact image readback. If local sync is late, use only read-only checks until identity is safe, then a known pre-write retry. No account writes from a standalone credential-extraction script.
- [ ] If Automation requires interaction, ask the user to use the app's explicit permission action. If cloud/local correlation cannot be proven, keep the cover blocked and report the acceptance blocker instead of weakening matching. Ask the user to check the generated cover on the web/another device separately; never claim per-job cloud delivery from the Mac-only readback.
- [ ] Resolve the exact Applications target and inspect app/owned helper running state without dumping other process arguments. If Wavelength is running or a job is active, ask for a safe quit and wait. Do not kill it, overwrite a running bundle or discard an uncertain record.
- [ ] Create a versioned backup of the exact installed build 3. Stage the verified build 4 in a temporary sibling directory, verify equality/signature, then replace the closed Applications copy with recoverable rename operations. Keep backup and rollback bundles. Never modify saved history/jobs/Keychain. Register the exact new bundle with LaunchServices for Spotlight.
- [ ] Have the separate reviewer verify installed/source tree equality, build 4, signatures, previous-build preservation and registration. Run `WAVELENGTH_PACKAGING_APP="$HOME/Applications/Wavelength.app" bun test`. Hand off the installed app path, fresh check counts, acceptance outcome and any cloud/permission caveat. No GitHub push.

## Execution and commit policy

Use the user's requested worker plus separate reviewer. Execute tasks sequentially because later contracts depend on earlier ones. Review the actual diff at each gate, then make short local commits containing only the cover changes. Preserve existing unstaged availability work; do not stage whole overlapping files blindly. Root performs plan self-review and verifies final evidence independently.
