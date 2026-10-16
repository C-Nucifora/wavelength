# Wavelength listening history

## Purpose and agreed scope

Add two local sources of listening information to the native macOS app:

- An explicit, read-only scan of the Music library.
- An optional import of an extracted Apple Music CSV export.

Use either source for a personalised Get started page and a Listening breakdown. Keep the existing Discover, review, preflight and Create in Music workflow. No API key, cloud account, background listening recorder or browser UI is added.

The user approved both source paths and local storage. This document defines the implementation design for review; no history feature has been implemented yet.

## Chosen approach

Keep the SwiftUI app and its bundled local engine. Extend the existing Music JXA bridge for library statistics and add a small CSV parser and summary module to the engine. Use the existing SQLite store for normalised data.

A Music-only implementation would miss event detail. An export-only implementation would delay getting started until Apple supplies the download. Supporting both gives an immediate library summary and optional richer information without introducing MusicKit credentials or replacing the current playlist automation.

The two sources remain separate. Never add library play counts to exported activity, or merge overlapping export files into one total.

## Native interface

Add Get started, Discover and Listening navigation to the existing desktop sidebar. Preserve the dark charcoal and iris palette, wide resizable window and existing Discover controls. Share the palette with a separate history view file rather than duplicating its values.

Get started is the initial page when no draft or active playlist job needs attention. It offers Read Music library, Import Apple CSV and Continue to Discover. Opening the app never scans Music, opens files or asks for permissions automatically.

After a successful scan or import, show the selected source, capture/import date, coverage notes and artist-based starting points. Cards include a top artist and, when last-played dates exist, an older favourite. Describe the actual basis for each card. Clicking a card switches to Discover and fills the seed; the user still presses Preview playlist. Do not overwrite a building draft or active playlist job. Ask before replacing an existing ready draft's settings.

Listening shows a source picker for Library snapshot and Apple export when available, summary totals, artist/album/track rankings and genres where known. Rankings remain accessible through paginated tables, not only a few cards. Library data also shows last-played, favourites and skip counts. Export data shows date-based activity charts and reported play duration only when the schema supplies those fields.

Display missing information as unavailable, not zero. Every chart has a text/table equivalent. Use source-specific labels such as Library play count, Activity records, Last seen and Reported play duration. Do not label all export rows as completed song plays.

The import sheet explains how to request Apple Media Services information at privacy.apple.com and extract the archive. A native file picker accepts one CSV at a time. It previews detected format, row count, available fields and warnings before saving. A new export replaces the previous export only after confirmation. The library snapshot remains separate and unaffected.

Provide Refresh library, Replace export and Forget history controls. Forget history asks for confirmation and removes only history data, not drafts, provenance assessments, playlist jobs or the Music library. Do not claim secure erasure from disk or backups.

## Library scan

Extend native/library.jxa with a read-only statistics action. Read the library's track collection using batched property reads where practical. Collect persistent ID, title, artist, album artist, album, genre, duration, played count/date, skipped count/date, date added and favourited status when available.

Represent unavailable properties as null with warnings. Validate finite nonnegative counts and durations and valid dates. Unknown dates are not converted to the Unix epoch. Use track artist for artist rankings; album identity includes album artist when available so unrelated albums with the same name stay separate.

The Music dictionary defines played date and skipped date as the last such date. It exposes no per-play event collection. Library metrics therefore cover current library tracks and their reported aggregate counts. They cannot represent complete lifetime history, past non-library listens, daily listening totals or actual listening minutes. Do not compute listening time as play count multiplied by track duration.

Only an explicit scan invokes Music automation. If Music is closed, ask the user to open it, as the existing bridge does. Explain the Automation permission before the action; scanning does not require Accessibility or keyboard input. Denial, a missing library or timeout produces a recoverable error without replacing the last successful snapshot.

Cap the scan at 50,000 tracks and individual text properties at 4,000 characters. Use a dedicated 32 MiB statistics response buffer rather than increasing limits for playlist commands. Give the scan a 90-second helper deadline, leaving a 30-second margin inside the existing 120-second APIClient and Bun idle timeouts for validation, persistence and error responses. Prevent concurrent scans, preflights and playlist writes. An oversized or incomplete scan fails clearly instead of silently saving a partial history. Native UI remains responsive and shows a scanning state.

## CSV import and source semantics

Recognise schemas by required headers, not filename. Match headers case-insensitively after trimming whitespace and a UTF-8 BOM. Support UTF-8 CSV with quoted commas, escaped quotes, quoted newlines, CRLF and empty fields. Reject malformed quoting, duplicate canonical headers and invalid encoding. Do not execute cell contents or interpret spreadsheet formulas.

Initial supported profiles are based on the converter project's published fixture headers, not a promise about every Apple export version:

| Profile | Required fields | Optional fields | Interpretation |
| --- | --- | --- | --- |
| Play activity | Song Name, Event End Timestamp | Artist, Album Name, Play Duration Milliseconds, Media Duration In Milliseconds | Activity records with event-end timestamps; reported play duration where valid |
| Daily tracks | Track Description, Date Played | Container Description, Play Duration Milliseconds | Date-associated records; do not invent individual play times |
| Recently played | Track Description, Last Event End Timestamp | Container Description, Media duration in millis | Last-seen track summary; not a complete event timeline or listening-duration source |

If headers do not identify exactly one supported profile, show an unsupported-format error listing recognised profiles and leave saved data untouched. Do not guess column meanings. Public fixtures validate the supported contracts; a real user export is still needed to verify coverage against their actual data.

Parse explicit-offset timestamps as instants. A date-only value remains a calendar date. An unzoned date-time remains unresolved and is excluded from hourly charts, with a warning. Reject ambiguous day/month dates. Display instant-based charts in the Mac's current time zone, named in the UI. A recently-played profile never becomes an hourly/monthly listening chart merely because it has a last-seen timestamp.

Accept rows with a title even when artist/album/date is absent or invalid; count missing fields and exclude them only from affected metrics. Invalid or negative duration is unavailable, not zero. Empty title rows are rejected and counted. No supported rows is an error. Preserve repeat records within the file because repeated listening can be legitimate; importing a file replaces the prior export instead of appending it, so a repeated import cannot inflate totals.

Genre comes from supplied library metadata, not an inferred label. Missing artist, album or genre may be filled from the saved library snapshot only for an unambiguous exact title-and-album match. Never split Track Description heuristically or choose the first fuzzy catalog result. Mark enriched metadata and unmatched records in the coverage report. Unresolved artist records still appear in track rankings but cannot seed an artist suggestion.

The import preview includes profile, accepted/rejected rows, missing-field counts, earliest/latest usable date and duration coverage. After confirmation, save normalised records and the same report atomically. Do not persist raw CSV text, absolute file paths or unneeded device/account fields. Do not claim the earliest/latest observed dates prove continuous or lifetime coverage.

## Breakdown and suggestions

Library rankings sum reported play counts, with zero-play tracks kept available in track tables. Export rankings count source records and optionally sum reported play duration for rows that supply it. Daily totals and time-of-day patterns appear only for applicable dated activity profiles, with the metric and excluded-row count stated. Do not calculate skip rates or completed-play counts from a short duration alone.

When both sources exist, default suggestions to the export if it has usable artist metadata; otherwise use the library snapshot. The user can change source. Choose up to six distinct artists deterministically from the selected source's rankings. With library dates, an older favourite requires a positive play count and a last-played date at least 90 days ago. Without suitable evidence, omit that card rather than inventing one.

History analytics describe actual imported listening and are not filtered by the AI toggle. Playlist suggestions use the existing discovery and provenance checks once the artist resolves to a catalog identity. Include AI artists stays off by default, and using a history card never enables it. Unknown artist provenance remains explicitly unknown. Only the existing Create in Music action writes playlists or library songs.

## Integration and storage

Add engine history types and a focused history module for validation, CSV parsing, aggregation and suggestions. Keep Music automation in src/music.ts. Inject readLibraryHistory into the existing server dependencies so tests can use fixtures without running Music.

Add authenticated local endpoints:

- GET /api/history returns saved source summaries, coverage and suggestions, with bounded paginated ranking queries.
- POST /api/history/library performs the explicit read-only scan and atomically replaces the snapshot on success.
- POST /api/history/preview accepts raw CSV bytes and returns an in-memory import preview token and report.
- POST /api/history/import confirms that token and replaces the export atomically.
- POST /api/history/forget clears only history records and outstanding import previews.

Import previews expire after ten minutes. Permit one outstanding preview per app instance, replacing it on a new preview; never persist it across restarts. Confirming an expired preview asks the user to select the file again. The engine keeps a history-operation generation: forgetting history advances it and invalidates every preview token and pending scan/import completion. Each completion checks the captured generation before publishing or saving. A late completion cannot recreate forgotten data. Release preview memory on expiry, replacement, forget and shutdown.

The native picker reads only the user-selected file and uploads its bytes to the loopback engine. Endpoints never accept filesystem paths. Limit each file to 20 MiB, parsed records to 100,000 and each field to 4,000 characters. Enforce limits during streaming/parsing, including chunked bodies and files that grow after selection. Native UI shows reading/parsing state and retains previous saved history on failure or cancelled selection.

The existing Bun server and JSON body parser both cap requests at 128 KiB. Increase the transport ceiling only enough for the CSV route; preserve the 128 KiB application limit for all other POST routes. The import route has its own byte limit and media-type check. Keep existing Host and Origin validation on every history route. Existing session-token checks apply only to POST; add an explicit token requirement for GET /api/history too, and send that header from APIClient for history reads. Do not expose private history through an unauthenticated GET. Bound pagination, reject unknown source IDs and never return raw records through the summary endpoint.

Persist one current library snapshot and one current export, identified by fixed history-specific Store keys with a schema version. Store replacement is one SQLite transaction. Summary calculations use normalised records; do not duplicate full payloads across state keys. Imported data lives under the existing Application Support/Wavelength directory, not the source repository or deliverables folder. Set the database and SQLite sidecar files to owner-only access without changing permissions on unrelated files. Do not log track names, CSV bodies or library contents.

Swift API types mirror the history contracts. AppModel owns the selected source, preview and operation state. New native views consume those models without direct filesystem or engine calls. Reuse APIClient error handling and extend it narrowly for authenticated byte uploads. Load saved summaries on startup without touching Music. History work cannot overwrite newer results after engine restart or a newer operation, following the existing revision checks.

History data is not uploaded for analysis. Preview playlist retains normal discovery network requests using the chosen seed, so this is not an entirely offline app. No credentials are required for the import itself.

## Verification and acceptance

Use invented fixtures, not personal history, in source control. Test all three CSV profiles, Unicode, BOM, multiline quoting, missing artist, invalid dates/durations, same-title different artists, repeated rows, empty files, malformed files and every input limit. Verify imported summaries do not combine with library counts, recently-played rows do not create event trends and media duration never becomes listening time.

Server tests cover authentication including unauthenticated history GET, hostile origins, arbitrary-path rejection, oversized/chunked input, expired preview tokens, atomic replacement, failure preserving prior data, forgetting only history, late completion after forgetting and concurrent Music operation guards. Library adapter tests use mocked bridge output including null properties and incomplete results.

Native checks cover initial empty state, saved-summary decoding, source selection, picker cancellation, import confirmation/replacement, permission-error presentation, seed handoff without automatic preview/write, AI off, active-job guards and engine restart races. Run existing Bun tests, TypeScript checks, native Swift checks and app packaging/signature checks.

Manually verify the installed native app's navigation, wide-window layout, keyboard/VoiceOver labels and import workflow with synthetic CSVs. Real library scanning is an explicit user action, not a hidden test. Real-export compatibility remains unverified until the user supplies an export; report that limit at handoff. Preserve the previous app build when installing the update. No push is authorised for this new feature yet.

## Evidence

- Installed Music scripting dictionary: /System/Applications/Music.app/Contents/Resources/com.apple.Music.sdef, track properties including played count/date and skipped count/date.
- [Apple data export file guides](https://privacy.apple.com/file-guides) identify Apple Music activity within Apple Media Services information.
- [Converter CSV fixtures](https://github.com/nerveband/Apple-Music-Play-History-Converter/tree/main/tauri-app/python-sidecar/fixtures) provide the initial header contracts. Wavelength will implement its own parser and synthetic tests; it will not install or copy that application.
