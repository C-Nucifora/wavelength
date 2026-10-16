# Wavelength implementation plan

> Historical record. This document describes the approved work at the time, including its earlier architecture, build and installation steps. Use [the current README](../README.md) for current behavior and setup. It does not authorize repeating past live tests or replacing an installed app.

**Goal:** Build the approved macOS desktop interface into a local tool that discovers songs from Every Noise genres or artist seeds and creates Apple Music playlists without an Apple developer token.

**Architecture:** A Bun TypeScript server binds to loopback and serves a dependency-light HTML/CSS/JavaScript interface. Discovery uses cached Every Noise pages, public Apple iTunes catalog metadata, and a public related-artist source where available. Music library reads/writes use JXA; a native macOS accessibility helper adds missing catalog tracks through Music.app. Sources and ambiguous matches remain visible for review.

**Spec:** The user-approved desktop layout has a rectangular full-window shell, compact toolbar, settings sidebar and wide song-review panel. It uses Radix Slate dark and Iris dark. Earlier mockups remain in the local `every-noise-apple-music` output folder; runtime behavior and limitations are documented in `README.md`.

**Constraints:** macOS only; desktop Slate/Iris UI; Artist and Genre modes; Include AI artists defaults off; unknown provenance is disclosed; no Apple API keys; no private credentials or user library data in Git; preserve previous mockups; cached user-triggered Every Noise requests; no bulk crawler; do not fabricate available matches or completed additions.

## Interfaces

Shared request, draft, song, job, provenance, and Music status shapes are in `src/types.ts`.

Discovery exports `getGenres(): Promise<Array<{name:string;slug:string}>>` and `buildDraft(request:SeedRequest, options:{signal:AbortSignal;onProgress:(progress:Draft['progress'])=>void;provenance:(artistId:number)=>Provenance|undefined}): Promise<{tracks:DraftTrack[];warnings:string[]}>`.

Music exports `getMusicStatus(): Promise<MusicStatus>`, `ensurePlaylist(name:string, existingId?:string): Promise<{id:string;name:string}>`, `addTrackToPlaylist(track:DraftTrack, playlistId:string): Promise<{libraryId:string;alreadyPresent:boolean}>`, and `openPlaylist(playlistId:string): Promise<void>`. These functions never remove existing user music. Playlist identity, not its name alone, controls retries.

## Work

- [x] Discovery worker: parse selected Every Noise pages and index with Bun HTMLRewriter; cache and pace requests; use current catalog metadata; support artist seeds with honest fallback when similarity has no coverage; test normalization, entity decoding, ambiguous matching, deduplication, and AI exclusion.
- [x] Music worker: implement safe JSON input JXA and native accessibility helper, useful permission errors, catalog additions that verify expected identity, exact playlist IDs, and idempotent insertion. Test non-mutating status and script/argument safety; do not run library mutations outside the root's end-to-end check.
- [x] Frontend worker: replace sample data with the real API, keep full desktop layout, show discovery progress/shortfalls, allow song exclusion and provenance review, display library-addition note, create/cancel/retry progress, and permission guidance. Use textContent for source content.
- [x] Root: implement localhost server with strict Host/Origin/token checks, bounded validation, persistence, serialized Music jobs, cancellation between additions, retries, launch command, and README. Test creation failure/retry without real Music writes, request security, job persistence, and validation.
- [x] Integrate: run tests and type checks, start app, verify real genre and artist discovery, inspect desktop interface, and perform a scoped Music write test if permissions permit.
- [x] Separate reviewer: inspect actual app and relevant checks; fix findings; run final verification; commit only app files. Prepare GitHub delivery without user library data, cached website data, secrets, or binaries.

## Review focus

Ambiguous catalog matches must not silently select another artist. Native UI failure must not insert a different song. Cancellation and restarts must preserve completed work. Retries must reuse playlist IDs and avoid duplicate songs. Cross-origin websites must not be able to control Music through the localhost server.

## Decisions

The user approved the concrete V3 design and explicitly instructed implementation. Routine implementation decisions proceed under that authorization. Apple iTunes search metadata is not identical to the subscription catalog; a track is only reported added after Music.app/library verification. Unknown AI provenance is not certification of human authorship.

The user selected Wavelength as the app and repository name. The AI setting accompanies the reviewed selection and is saved with each Music job. Unfinished additions and retries check current local artist assessments. A read-only library preflight is required before creating a playlist, and its receipt is tied to the selected songs and AI choice.

## Verification so far

35 automated tests with 154 assertions and TypeScript checks pass. Live ambient Mix produced essentials and recent tracks. Live Autechre discovery returned Autechre, Aphex Twin and Boards of Canada. The real API preflight correctly counted two absent library songs. Foreign Host and Origin requests returned HTTP 403. Separate source review and isolated Swift compilation found no blocking issues.

Native testing fixed full-tree traversal timeouts, catalog search key delivery and a menu fallback that could close an already-open menu. Keyboard activity changed Music's search field during diagnostics, so UI testing paused until the user approved an uninterrupted window. The latest bridge then completed the same saved two-song job, adding "Avril 14th" by Aphex Twin and "An Ending (Ascent)" by Brian Eno without creating another playlist. Independent JXA reads confirmed exact song metadata and two unique library IDs in the playlist. Music's visible playlist showed both songs and a two-song total. Playback was stopped during verification.

The initial private GitHub push passed its macOS CI workflow, including all 35 tests, typecheck, JavaScript syntax and Swift compilation. Live checks cover this Mac and the two selected songs only; other Music versions, regions and catalog songs remain subject to the documented limitations.

The user approved publishing `C-Nucifora/wavelength` as a private repository. Only app source, tests and documentation are included. Library data, saved jobs, discovery caches and generated binaries remain local.
