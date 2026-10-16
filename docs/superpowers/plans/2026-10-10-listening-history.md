# Wavelength listening history implementation plan

> Historical record. This document describes the approved work at the time, including its earlier architecture, build and installation steps. Use [the current README](../../../README.md) for current behavior and setup. It does not authorize repeating past live tests or replacing an installed app.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user's standing execution method is a worker and a separate reviewer. Get the user's review of this plan before implementation.

**Goal:** Add explicit Music library snapshots and reviewed Apple CSV imports to native Get started and Listening pages, with honest, separate source statistics.

**Architecture:** Keep SwiftUI, the bundled Bun engine, SQLite and the existing JXA playlist bridge. Parse and normalise history in focused engine modules, persist one envelope per source, and return authenticated summaries and bounded pages. AppModel owns native operation state and revisions; history views call AppModel methods and never call the engine or filesystem directly.

**Tech Stack:** Existing Bun, TypeScript 5.9.3, bun:sqlite, SwiftUI and AppKit on macOS 14+, JXA. No runtime dependency additions.

**Spec:** `docs/superpowers/specs/2026-10-10-listening-history-design.md`, committed as `f9a4aac`.

## Global Constraints

The following requirements are copied verbatim from the approved design. They apply to every task.

- "No API key, cloud account, background listening recorder or browser UI is added."
- "The two sources remain separate. Never add library play counts to exported activity, or merge overlapping export files into one total."
- "Opening the app never scans Music, opens files or asks for permissions automatically."
- "Clicking a card switches to Discover and fills the seed; the user still presses Preview playlist."
- "Do not overwrite a building draft or active playlist job. Ask before replacing an existing ready draft's settings."
- "Display missing information as unavailable, not zero. Every chart has a text/table equivalent."
- "Do not label all export rows as completed song plays."
- "Forget history asks for confirmation and removes only history data, not drafts, provenance assessments, playlist jobs or the Music library. Do not claim secure erasure from disk or backups."
- "Do not compute listening time as play count multiplied by track duration."
- "Only an explicit scan invokes Music automation."
- "Cap the scan at 50,000 tracks and individual text properties at 4,000 characters."
- "Use a dedicated 32 MiB statistics response buffer rather than increasing limits for playlist commands."
- "Give the scan a 90-second helper deadline, leaving a 30-second margin inside the existing 120-second APIClient and Bun idle timeouts for validation, persistence and error responses."
- "Prevent concurrent scans, preflights and playlist writes."
- "An oversized or incomplete scan fails clearly instead of silently saving a partial history."
- "Reject malformed quoting, duplicate canonical headers and invalid encoding."
- "Do not execute cell contents or interpret spreadsheet formulas."
- "Parse explicit-offset timestamps as instants. A date-only value remains a calendar date. An unzoned date-time remains unresolved and is excluded from hourly charts, with a warning. Reject ambiguous day/month dates."
- "A recently-played profile never becomes an hourly/monthly listening chart merely because it has a last-seen timestamp."
- "Preserve repeat records within the file because repeated listening can be legitimate; importing a file replaces the prior export instead of appending it, so a repeated import cannot inflate totals."
- "Missing artist, album or genre may be filled from the saved library snapshot only for an unambiguous exact title-and-album match."
- "Never split Track Description heuristically or choose the first fuzzy catalog result."
- "Do not calculate skip rates or completed-play counts from a short duration alone."
- "Choose up to six distinct artists deterministically from the selected source's rankings."
- "With library dates, an older favourite requires a positive play count and a last-played date at least 90 days ago."
- "Include AI artists stays off by default, and using a history card never enables it. Unknown artist provenance remains explicitly unknown."
- "Only the existing Create in Music action writes playlists or library songs."
- "Import previews expire after ten minutes. Permit one outstanding preview per app instance, replacing it on a new preview; never persist it across restarts."
- "Each completion checks the captured generation before publishing or saving. A late completion cannot recreate forgotten data."
- "Release preview memory on expiry, replacement, forget and shutdown."
- "Endpoints never accept filesystem paths."
- "Limit each file to 20 MiB, parsed records to 100,000 and each field to 4,000 characters."
- "Enforce limits during streaming/parsing, including chunked bodies and files that grow after selection."
- "Increase the transport ceiling only enough for the CSV route; preserve the 128 KiB application limit for all other POST routes."
- "Keep existing Host and Origin validation on every history route."
- "Existing session-token checks apply only to POST; add an explicit token requirement for GET /api/history too, and send that header from APIClient for history reads."
- "Bound pagination, reject unknown source IDs and never return raw records through the summary endpoint."
- "Store replacement is one SQLite transaction. Summary calculations use normalised records; do not duplicate full payloads across state keys."
- "Imported data lives under the existing Application Support/Wavelength directory, not the source repository or deliverables folder."
- "Set the database and SQLite sidecar files to owner-only access without changing permissions on unrelated files."
- "Do not log track names, CSV bodies or library contents."
- "Use invented fixtures, not personal history, in source control."
- "Real library scanning is an explicit user action, not a hidden test."
- "Real-export compatibility remains unverified until the user supplies an export; report that limit at handoff."
- "Preserve the previous app build when installing the update. No push is authorised for this new feature yet."

Implementation also follows the repository's existing macOS 14 target, no runtime npm dependencies, off-by-default AI setting, draft selection/preflight revisions, pending Music write guards and owned-process shutdown. Preserve existing user changes. Local commits may follow worker and separate reviewer checks, use short messages matching `Add native macOS app`, stage exact task files and omit AI credit. Do not push. All retained builds, synthetic CSVs and screenshots go under the project output folder at `../`; runtime history remains in Application Support.

## Review Focus

1. A newer CSV preview completes before an older upload, or Forget history runs during a scan/import. The older completion must not publish a token or restore deleted history. Task 3 and Task 5 pin these races with controlled promises.
2. Valid text fields contain a 121-character artist name, newlines or control characters. Analytics retain the metadata, but suggestions never truncate it into another identity or pass an invalid discovery seed. Task 2 tests the existing 120-character seed boundary and control-character exclusions.
3. Explicit offsets cross local midnight or a daylight-saving transition. Chart bins use the Mac's named current time zone, date-only records keep their calendar date, and unzoned timestamps never acquire an invented hour. Task 2 tests these with explicit time zones.
4. Two library tracks share title and album but have different artists or album artists. Export enrichment stays unresolved and album rankings remain distinct. Task 1 and Task 2 test collisions rather than choosing the first match.
5. A selected file grows, a chunked upload crosses a limit, or one large quoted field crosses chunk boundaries. Native and engine limits reject the entire operation while retaining saved data. Task 1, Task 5 and Task 6 test each boundary.

---

## Contract and file map

These are one feature with shared source semantics, not independent applications. Implement the seven tasks in order. Reuse the existing state table and build scripts; do not change the browser frontend.

| File | Responsibility |
| --- | --- |
| `src/history-types.ts` | Limits, normalised records, coverage, summary/page and preview contracts |
| `src/history.ts` | UTF-8 CSV state machine, profiles, date/property validation and exact enrichment |
| `src/history-summary.ts` | Source-specific metrics, identities, rankings, trend bins and suggestions |
| `src/history-state.ts` | Single in-memory preview, generations, atomic store calls and disposal |
| `src/store.ts` | Transactional history replacement/removal and exact database-file permissions |
| `src/music.ts`, `native/library.jxa` | Read-only statistics bridge with dedicated deadline and output cap |
| `src/server.ts`, `src/validation.ts`, `src/index.ts` | Route auth, bounded raw upload, Music operation guards and shutdown |
| `native/App/HistoryTypes.swift`, `native/App/HistoryFileReader.swift` | Codable mirror and bounded selected-file byte reading |
| `native/App/APIClient.swift`, `native/App/AppModel.swift` | Authenticated reads/uploads and operation/navigation revisions |
| `native/App/Palette.swift`, `native/App/HistoryViews.swift`, `native/App/Views.swift` | Shared palette, native navigation, tables, charts and review sheets |
| `native/Tests/HistoryChecks.swift`, existing native checks/scripts | Contract, workflow, race and packaged-app checks |

JSON always uses explicit null for missing metric values. JavaScript Date objects and non-finite values never cross the API. New Swift types use `String` for stored ISO values and optional numeric fields, matching the existing decoder style.

`GET /api/history` supports `source=library|export`, `kind=artists|albums|tracks|genres|daily|monthly|hourly`, `offset=0..100000`, `limit=1..100`, and `timeZone=<valid IANA zone>`. Default limit is 50 and offset is 0. No source returns summaries and the preferred source without a page. A supplied source defaults to its artist page. Invalid, duplicate or unknown query parameters fail with 400; unavailable sources fail with 404. The native client always supplies `TimeZone.current.identifier`. Validate it with `Intl.DateTimeFormat`; never rely on the engine's process time zone. Trend pages use the same bounded page contract, so all chart values have an accessible table and pagination, including large date ranges.

`POST /api/history/preview` accepts only `text/csv`, optionally `charset=utf-8`, as raw bytes. Other history POSTs accept JSON. Library and forget accept `{}` only. Import accepts exactly `{token: string, replace: boolean}`; existing exports require `replace: true`, while the native UI obtains that value through explicit confirmation. Endpoints never accept a name, URL or path in place of bytes.

## Task 1: Normalised records and bounded CSV parsing

**Files:**

- Create: `src/history-types.ts`
- Create: `src/history.ts`
- Create: `tests/history.test.ts`
- Create: `tests/fixtures/history.ts`, containing invented CSV builders only

**Interfaces:**

```ts
export const HISTORY_LIMITS = {
  fileBytes: 20 * 1024 * 1024, exportRows: 100_000,
  libraryTracks: 50_000, fieldCharacters: 4_000,
  previewMs: 10 * 60_000, scanMs: 90_000,
  scanBufferBytes: 32 * 1024 * 1024, pageSize: 50, maxPageSize: 100,
} as const;
export type HistorySource = "library" | "export";
export type ExportProfile = "play-activity" | "daily-tracks" | "recently-played";
export type HistoryDate = {kind: "instant" | "date" | "unresolved"; value: string};
export type MetadataField = "artist" | "album" | "genre";
export type LibraryTrack = {
  id: string; title: string | null; artist: string | null;
  albumArtist: string | null; album: string | null; genre: string | null;
  durationMs: number | null; playedCount: number | null;
  playedAt: HistoryDate | null; skippedCount: number | null;
  skippedAt: HistoryDate | null; addedAt: HistoryDate | null;
  favorite: boolean | null;
};
export type ExportRecord = {
  title: string; artist: string | null; album: string | null;
  albumArtist: string | null; genre: string | null; date: HistoryDate | null;
  reportedDurationMs: number | null; mediaDurationMs: number | null;
  enriched: MetadataField[];
};
export type HistoryCoverage = {
  inputRows: number; acceptedRows: number; rejectedRows: number;
  missing: {artist: number; album: number; genre: number; date: number;
    reportedDurationMs: number; mediaDurationMs: number};
  firstDate: HistoryDate | null; lastDate: HistoryDate | null;
  datedRows: number; instantRows: number; durationRows: number;
  enrichedRows: number; unmatchedRows: number;
  availableFields: string[]; warnings: string[];
};
export type ParsedExport = {profile: ExportProfile; records: ExportRecord[]; coverage: HistoryCoverage};
export type LibraryReadResult = {
  complete: true; declaredTrackCount: number; tracks: LibraryTrack[]; warnings: string[];
};
export type LibraryEnvelope = {
  schemaVersion: 1; source: "library"; capturedAt: string;
  records: LibraryTrack[]; coverage: HistoryCoverage;
};
export type ExportEnvelope = {
  schemaVersion: 1; source: "export"; importedAt: string; profile: ExportProfile;
  records: ExportRecord[]; coverage: HistoryCoverage;
};
export type HistoryEnvelope = LibraryEnvelope | ExportEnvelope;
```

`history.ts` produces `parseAppleCSV(chunks: AsyncIterable<Uint8Array>, library: readonly LibraryTrack[] = []): Promise<ParsedExport>`, `parseHistoryDate(value: string): HistoryDate | null`, `normalizeLibraryRead(value: unknown): LibraryReadResult`, and `libraryEnvelope(result: LibraryReadResult, capturedAt: string): LibraryEnvelope`. Tests create bytes with `TextEncoder`; they never read Music. A fixture builder is `csvChunks(text: string, chunkBytes = 17): AsyncIterable<Uint8Array>`. It encodes once and yields byte slices, including splits inside UTF-8 sequences.

- [ ] **Step 1: Write parser and collision tests.** Start with the three supported header sets and the quoted Unicode/BOM case below. Each test imports `parseAppleCSV`, `parseHistoryDate`, `normalizeLibraryRead` and the fixture builders from the exact files above.

```ts
test("BOM, CRLF and multiline Unicode survive small chunks", async () => {
  const text = '\uFEFF Song Name , Event End Timestamp , Artist ,Album Name\r\n' +
    '"曲, one\nline","2026-10-01T14:00:00+10:00","A ""quoted"" artist",Set\r\n';
  const result = await parseAppleCSV(csvChunks(text, 1));
  expect(result.profile).toBe("play-activity");
  expect(result.records[0]).toMatchObject({title: "曲, one\nline", artist: 'A "quoted" artist'});
  expect(result.records[0]!.date).toEqual({kind: "instant", value: "2026-10-01T04:00:00.000Z"});
});
test.each([
  ["Track Description,Date Played\nSong,2026-10-01", "daily-tracks"],
  ["Track Description,Last Event End Timestamp\nSong,2026-10-01T10:00:00Z", "recently-played"],
] as const)("required headers select %s", async (text, profile) => {
  expect((await parseAppleCSV(csvChunks(text))).profile).toBe(profile);
});
test("ambiguous exact title/album matches never choose an artist", async () => {
  const library = [libraryTrack({artist: "One"}), libraryTrack({artist: "Two", id: "0000000000000002"})];
  const result = await parseAppleCSV(csvChunks("Song Name,Event End Timestamp,Album Name\nSong,,Album"), library);
  expect(result.records[0]!.artist).toBeNull();
  expect(result.coverage.unmatchedRows).toBe(1);
});
```

Define `libraryTrack(overrides: Partial<LibraryTrack> = {}): LibraryTrack` in `tests/fixtures/history.ts`. Its base is ID `0000000000000001`, title `Song`, artist `Artist`, albumArtist `Artist`, album `Album`, genre `Electronic`, durationMs `120000`, playedCount `3`, skippedCount `null`, all dates `null`, favorite `null`. Spread overrides last.

- [ ] **Step 2: Run RED.** Run `bun test tests/history.test.ts`. Expect missing-module/export failures until the contracts and parser exist. After imports resolve, each added rejection test must fail on the specific bad input before its implementation.

- [ ] **Step 3: Implement the incremental CSV state machine and validators.** Use fatal streaming UTF-8 decoding and count byte length before decoding. Keep parser states `field`, `quoted`, `afterQuote` and a pending CR; preserve quoted line breaks, permit escaped `""`, reject quotes in unquoted fields and non-delimiter text after a closing quote. Check field character count while accumulating Unicode code points, check every data row before accepting or rejecting it, and finish the decoder with `decode()` to detect incomplete encoding.

```ts
const decoder = new TextDecoder("utf-8", {fatal: true});
let bytes = 0;
for await (const chunk of chunks) {
  bytes += chunk.byteLength;
  if (bytes > HISTORY_LIMITS.fileBytes) throw new Error("CSV exceeds 20 MiB.");
  consume(decoder.decode(chunk, {stream: true}));
}
consume(decoder.decode());
finish();
```

`consume(text: string): void` advances the state machine per code point and calls `finishField(): void` at delimiters. `finishField` adds the field to the row and resets its character count. `finishRow(): void` first parses/canonicalises headers or increments `inputRows` and checks the 100,000 data-row limit, then validates row width and normalises fields. `finish(): void` rejects an open quote, emits any last row and rejects a file without accepted records. A trailing newline is not another row. Count internal blank/empty-title rows as rejected. Treat extra/missing columns as malformed input rather than silently shifting values.

Canonical headers remove only the first header's UTF-8 BOM, trim and lowercase. Reject duplicates before profile recognition. Select exactly one profile by required headers:

```ts
const profiles = [
  {id: "play-activity", required: ["song name", "event end timestamp"]},
  {id: "daily-tracks", required: ["track description", "date played"]},
  {id: "recently-played", required: ["track description", "last event end timestamp"]},
] as const;
const matched = profiles.filter(p => p.required.every(h => headers.includes(h)));
if (matched.length !== 1) throw new Error("Unsupported CSV format. Recognised profiles: Play activity, Daily tracks, Recently played.");
```

Map optional headers exactly as the spec table states. For daily/recent profiles, `Container Description` is album metadata, never an inferred artist. Preserve `Track Description` as the full title. Recently played has media duration only and must always leave reportedDurationMs null. A formula-looking title such as `=SUM(1,2)` is plain text. Normalise an empty text property to null; retain other valid text. Duration parsing requires a nonempty decimal value, finite and nonnegative; an empty cell never becomes `Number("") === 0`.

`parseHistoryDate` accepts calendar-valid `YYYY-MM-DD`, ISO `YYYY-MM-DDTHH:mm:ss` with optional milliseconds and `Z` or explicit `±HH:mm`, and the same date-time without an offset as `unresolved`. Reject rollover dates, impossible times and slash/day-month formats. Use explicit component checks before constructing Date. Preserve the original unzoned value and add a coverage warning. Coverage earliest/latest ignores unresolved/invalid dates and compares the ISO calendar-date prefix plus instant value where comparable; retain the original `HistoryDate` kind so no calendar date becomes an instant. Coverage says "observed dates", never continuous coverage.

Enrichment indexes exact, trimmed, case-sensitive title plus album. A record without album cannot match. Require exactly one matching track identity; duplicate persistent IDs are not separate candidates, but distinct artists/album artists are ambiguous. Fill only missing artist/album/genre, carry albumArtist solely from that exact match, and record which missing fields were filled. Do not use the accent-folding playlist `normalize()` helper. Report accepted rows, rejected empty titles, missing fields after enrichment, enriched rows, unmatched rows, available headers, date and duration coverage, without saving raw text.

`normalizeLibraryRead` rejects a non-array, missing/false `complete`, count mismatch, duplicate/invalid persistent IDs, more than 50,000 tracks or any overlong text. Null properties remain null with property-count warnings. Invalid counts, durations and dates become null with warnings; counts must also be integers. A valid zero remains zero. Build library coverage from the normalised tracks, with durationRows zero because track duration is not reported listening duration.

- [ ] **Step 4: Add each boundary test, then run RED/GREEN for it.** Include empty input/header-only/all-rejected files, unsupported and multiply-matching profiles, duplicate canonical headers, invalid UTF-8, incomplete multibyte encoding, malformed quoting, row-width mismatch, quoted formula text, every optional field, missing artist/album/date, invalid or negative durations, leap-day rollover, unzoned and ambiguous dates, repeated identical records, same title with different artists, exact enrichment and albumless unmatched records. Cover 20 MiB vs 20 MiB plus one byte, 100,000 vs 100,001 data rows and 4,000 vs 4,001 characters, including a quoted field across chunks and Unicode characters split across chunks. Generate large fixtures in the test process, not checked-in large files.

```ts
test("limits count rejected rows and quoted field characters", async () => {
  const header = "Song Name,Event End Timestamp\n";
  await expect(parseAppleCSV(csvChunks(header + "x".repeat(4001) + ","))).rejects.toThrow("4,000");
  await expect(parseAppleCSV(csvChunks(header + ",\n".repeat(100001)))).rejects.toThrow("100,000");
  expect(parseHistoryDate("2026-02-30")).toBeNull();
  expect(parseHistoryDate("03/04/2026")).toBeNull();
  expect(parseHistoryDate("2026-10-01T09:00:00")).toEqual({kind: "unresolved", value: "2026-10-01T09:00:00"});
});
```

Run `bun test tests/history.test.ts` and `bun run typecheck`. Expect all parser tests PASS and no diagnostics.

- [ ] **Step 5: Separate reviewer checks the parser, then commit only its files.** Reviewer reads the actual diff and checks required/optional profile mappings, byte/character/row bounds, metadata ambiguity, and no raw data persistence. Fix findings and rerun affected tests. Stage the four listed task files and commit `Add history import parser`.

## Task 2: Honest summaries, rankings and deterministic suggestions

**Files:**

- Modify: `src/history-types.ts`
- Create: `src/history-summary.ts`
- Create: `tests/history-summary.test.ts`
- Modify: `tests/fixtures/history.ts`

**Interfaces:**

Consumes `HistoryEnvelope`, `LibraryTrack`, `ExportRecord`, `HistoryDate`, `HistoryCoverage` and limits from Task 1. Add these contracts to `history-types.ts`:

```ts
export type HistoryKind = "artists" | "albums" | "tracks" | "genres" | "daily" | "monthly" | "hourly";
export type HistorySuggestion = {
  artist: string; kind: "top" | "older-favorite"; basis: string;
};
export type HistoryTotals = {
  tracks: number; artists: number; albums: number;
  libraryPlayCount: number | null; activityRecords: number | null;
  reportedDurationMs: number | null; skippedCount: number | null;
  favoriteTracks: number | null;
};
export type HistorySourceSummary = {
  source: HistorySource; savedAt: string; profile: ExportProfile | null;
  metricLabel: string; totals: HistoryTotals; coverage: HistoryCoverage;
  suggestions: HistorySuggestion[]; trendsAvailable: boolean;
};
export type HistoryRow = {
  id: string; label: string; artist: string | null; album: string | null;
  albumArtist: string | null; genre: string | null;
  libraryPlayCount: number | null; activityRecords: number | null;
  reportedDurationMs: number | null; skippedCount: number | null;
  favoriteTracks: number | null; lastDate: HistoryDate | null;
};
export type HistoryPage = {
  source: HistorySource; kind: HistoryKind; offset: number; limit: number;
  total: number; rows: HistoryRow[]; metricLabel: string;
  excludedRows: number; timeZone: string | null;
};
export type HistoryResponse = {
  sources: HistorySourceSummary[]; preferredSource: HistorySource | null;
  page: HistoryPage | null;
};
export type HistoryQuery = {
  source?: HistorySource; kind?: HistoryKind; offset: number;
  limit: number; timeZone: string;
};
```

Produces `summarizeHistory(envelopes: readonly HistoryEnvelope[], query: HistoryQuery, now: number): HistoryResponse` and `validateHistoryQuery(params: URLSearchParams): HistoryQuery`. Add fixture `exportEnvelope(text: string, importedAt = "2026-10-10T00:00:00.000Z"): Promise<ExportEnvelope>` using Task 1's parser, and `savedLibrary(tracks: LibraryTrack[], capturedAt = "2026-10-10T00:00:00.000Z"): LibraryEnvelope` using `libraryEnvelope`.

- [ ] **Step 1: Write the semantic tests.** Pin source separation, no invented time, album identities and invalid suggestion names.

```ts
test("sources never combine play counts and activity records", async () => {
  const library = savedLibrary([libraryTrack({playedCount: 12})]);
  const exported = await exportEnvelope("Song Name,Event End Timestamp,Artist\nSong,2026-10-01T00:00:00Z,Artist\nSong,2026-10-01T00:00:00Z,Artist");
  const result = summarizeHistory([library, exported], {offset: 0, limit: 50, timeZone: "Australia/Brisbane"}, Date.parse("2026-10-10T00:00:00Z"));
  expect(result.sources.find(s => s.source === "library")!.totals).toMatchObject({libraryPlayCount: 12, activityRecords: null, reportedDurationMs: null});
  expect(result.sources.find(s => s.source === "export")!.totals.activityRecords).toBe(2);
  expect(result.preferredSource).toBe("export");
});
test("recently played never supplies event trends or listening duration", async () => {
  const exported = await exportEnvelope("Track Description,Last Event End Timestamp,Media duration in millis\nSong,2026-10-01T10:00:00Z,120000");
  const result = summarizeHistory([exported], {source: "export", kind: "tracks", offset: 0, limit: 50, timeZone: "UTC"}, 0);
  expect(result.sources[0]!.trendsAvailable).toBe(false);
  expect(result.sources[0]!.totals.reportedDurationMs).toBeNull();
  expect(result.page!.rows[0]!.lastDate?.kind).toBe("instant");
});
test("unusable seeds remain metadata but cannot become artist suggestions", () => {
  const tracks = [libraryTrack({artist: "a".repeat(121)}), libraryTrack({id: "0000000000000002", artist: "bad\nseed"})];
  const result = summarizeHistory([savedLibrary(tracks)], {source: "library", kind: "artists", offset: 0, limit: 50, timeZone: "UTC"}, 0);
  expect(result.page!.total).toBe(2);
  expect(result.sources[0]!.suggestions).toEqual([]);
});
```

- [ ] **Step 2: Run RED.** Run `bun test tests/history-summary.test.ts`. Expect missing summary exports, then semantic assertion failures before each behavior is added.

- [ ] **Step 3: Implement identities and metric aggregation.** Use JSON tuple identities, not joined display strings, to avoid separator collisions. Track identity is `[title, artist, album, albumArtist]`; album identity is `[album, albumArtist ?? artist]`; artist/genre identities use exact supplied text. Keep unresolved tracks in track pages, exclude null fields only from the affected artist/album/genre page, and state the excluded count. Library pages retain zero-play tracks. For partially missing totals, sum valid values but include coverage warnings and missing-field counts; if no value is available, return null. Do not let one available zero hide total absence of data.

```ts
function availableSum(values: readonly (number | null)[]): number | null {
  const available = values.filter((v): v is number => v !== null);
  return available.length ? available.reduce((sum, v) => sum + v, 0) : null;
}
function canSeed(artist: string): boolean {
  return artist.trim().length > 0 && artist.length <= 120 && !/[\u0000-\u001F\u007F]/.test(artist);
}
```

Rank library groups by reported played-count sum, then exact label and identity for deterministic ties. Rank exports by record count with optional reported-duration sum. Preserve repeated rows. Library lastDate means last played; export lastDate means last seen. Recently-played totals and labels are "Last-seen records", not an event/play count. `tracks` is the number of track identities, while `coverage.acceptedRows` is source records. Favourite and skip totals are available only for library data.

Artist suggestions skip unusable discovery seeds without truncating the metadata. Choose up to six distinct valid artists from the source's ranking; put the highest-ranked artist first. Add at most one older-favorite card from a library track with playedCount > 0 and an instant playedAt at least 90 days before `now`, deduplicating its artist and keeping the total at six. Deterministically choose the highest played-count eligible track, then oldest date and identity. Include the actual play-count/record-count and last-played basis in card text. Favourite status is shown separately; do not require it to invent the 90-day evidence. Default to export only when it has a valid artist suggestion; otherwise prefer the library, then export when it is the sole saved source. A user's explicit source wins. Do not read or filter by provenance/AI preferences in analytics. Do not attach catalog IDs to history names.

Build daily/monthly/hourly bins only for play-activity and daily-tracks profiles. Date-only values enter their daily/monthly calendar bin and never hourly bins. Valid explicit-offset instants use `Intl.DateTimeFormat` with the requested IANA zone and `hourCycle: "h23"`; combine both occurrences of a daylight-saving repeated hour into the same 0..23 bin. Unresolved timestamps are excluded from trends with explicit counts. Return unavailable errors for library/recently-played trend queries rather than empty misleading charts. Paginate chronological daily/monthly rows and hourly rows; no dense array spanning invented empty years. Every trend row uses `activityRecords` and nullable reportedDurationMs, with page metric "Activity records" or "Date-associated records".

- [ ] **Step 4: Add timezone, identity and suggestion-boundary tests.** Run `bun test tests/history-summary.test.ts -t 'time zone'` before and after binning. Test `2026-10-01T00:30:00Z` as September 30 in `America/Los_Angeles` and October 1 in Brisbane. Test November 1, 2026 repeated local hour in Los Angeles with `2026-11-01T08:30:00Z` and `2026-11-01T09:30:00Z`, yielding hour `1` count 2. Date-only `2026-10-01` stays October 1 in both zones; unresolved `2026-10-01T09:30:00` contributes no hourly value.

```ts
test("album artists separate equally named albums", () => {
  const tracks = [libraryTrack({albumArtist: "One"}), libraryTrack({id: "0000000000000002", albumArtist: "Two"})];
  const result = summarizeHistory([savedLibrary(tracks)], {source: "library", kind: "albums", offset: 0, limit: 1, timeZone: "UTC"}, 0);
  expect(result.page!.total).toBe(2);
  expect(result.page!.rows).toHaveLength(1);
});
```

Also test positive plays exactly 90 days old, 89 days old, null last-played, zero plays, tied ranks, >6 valid artists, 120-character artist acceptance, excluded unknown artists, no media-duration listening estimate, nullable skips/favourites, AI-independent totals and valid/invalid/duplicate/oversized query parameters. Run `bun test tests/history.test.ts tests/history-summary.test.ts` and `bun run typecheck`; expect PASS.

- [ ] **Step 5: Separate reviewer checks semantic labels and identities, then commit.** Fix findings, rerun affected tests, stage only the four listed files and commit `Add listening summaries`.

## Task 3: Atomic history storage and preview lifetimes

**Files:**

- Modify: `src/store.ts`, Store constructor and persistence methods
- Create: `src/history-state.ts`
- Modify: `src/history-types.ts`
- Create: `tests/history-state.test.ts`
- Create: `tests/store.test.ts`

**Interfaces:**

Consumes the envelopes and parser from Task 1. Add `HistoryPreview = {token: string; expiresAt: string; profile: ExportProfile; coverage: HistoryCoverage; replacesExport: boolean}`. The preview API contains no records or file paths.

Add Store methods `history(): HistoryEnvelope[]`, `replaceHistory(envelope: HistoryEnvelope): void`, and `forgetHistory(): void`. The only persisted keys are `kind="history", id="library"` and `kind="history", id="export"`, with schemaVersion 1 in their envelopes. Reject unsupported versions with a recoverable error asking the user to forget/reimport history; never delete other Store kinds. Keep all normalised records and their report in that one envelope, with no summary payload copies.

`HistoryState` is constructed with `(store: Store, now: () => number = Date.now)` and exposes:

```ts
beginScan(): number;
finishScan(generation: number, result: LibraryReadResult): void;
preview(chunks: AsyncIterable<Uint8Array>): Promise<HistoryPreview>;
importPreview(token: string, replace: boolean): void;
forget(): void;
dispose(): void;
```

`beginScan` returns the forget generation. Scan exclusivity belongs to Task 5. `finishScan` validates the captured generation before replacement. `preview` snapshots library metadata when it starts, increments a separate preview revision before reading, clears previous preview memory immediately and checks both revisions after parsing. The winning token owns only its normalised export and report in memory. `importPreview` is synchronous through its SQLite transaction, validates expiry and generation, refuses replacement without `replace=true`, stamps importedAt, atomically saves, and consumes the token only after success. Forget increments both revisions before clearing tokens and the two Store keys. Disposal marks the state closed, advances both revisions and releases timers/payloads.

- [ ] **Step 1: Write lifecycle and rollback tests with a fake clock.** Use the Task 1 synthetic fixtures. Add a small `deferred<T>()` test helper returning `{promise: Promise<T>, resolve(value: T): void}` and the complete chunk source shown below.

```ts
test("older preview cannot replace a newer token", async () => {
  const store = new Store(":memory:");
  const state = new HistoryState(store, () => 0);
  const release = deferred<void>();
  async function* slow() { await release.promise; yield new TextEncoder().encode("Song Name,Event End Timestamp\nOld,"); }
  const old = state.preview(slow());
  const current = await state.preview(csvChunks("Song Name,Event End Timestamp\nNew,"));
  release.resolve();
  await expect(old).rejects.toThrow("superseded");
  state.importPreview(current.token, false);
  expect((store.history()[0] as ExportEnvelope).records[0]!.title).toBe("New");
  state.dispose(); store.close();
});
test("forget invalidates pending scan and preserves unrelated state", () => {
  const store = new Store(":memory:");
  store.put("draft", "draft", {id: "draft"});
  store.put("job", "job", {id: "job"});
  store.put("provenance", "1", {kind: "human"});
  const state = new HistoryState(store, () => 0);
  const generation = state.beginScan();
  state.forget();
  expect(() => state.finishScan(generation, {complete: true, declaredTrackCount: 1, tracks: [libraryTrack()], warnings: []})).toThrow("forgotten");
  expect(store.history()).toEqual([]);
  expect(store.get("draft", "draft")).toEqual({id: "draft"});
  expect(store.get("job", "job")).toEqual({id: "job"});
  expect(store.get("provenance", "1")).toEqual({kind: "human"});
  state.dispose(); store.close();
});
```

- [ ] **Step 2: Run RED.** Run `bun test tests/history-state.test.ts tests/store.test.ts`. Expect missing methods/classes, then stale-publication failures.

- [ ] **Step 3: Implement the two-key Store transaction and memory ownership.** SQLite replacement validates source/schema before beginning a transaction. Forget executes exactly `DELETE FROM state WHERE kind='history' AND id IN ('library','export')`. Use Bun SQLite's synchronous transaction wrapper and propagate write failures without modifying current in-memory ownership.

```ts
replaceHistory(envelope: HistoryEnvelope): void {
  if (envelope.schemaVersion !== 1 || !["library", "export"].includes(envelope.source)) throw new Error("Unsupported history schema.");
  this.restrictDatabaseFiles();
  this.db.transaction(() => {
    this.put("history", envelope.source, envelope);
    this.restrictDatabaseFiles();
  })();
}
```

`restrictDatabaseFiles(): void` tracks the concrete database path, skips `:memory:`, and chmods only that regular file and its exact `-wal` and `-shm` sidecars to `0o600`. Use lstat and reject symbolic links instead of following them. Call it after opening/WAL setup, before a history transaction and inside that transaction after writes that can create sidecars. A permission failure must abort before commit, preserving prior history, rather than report failure after publishing new data. Apply the same ordering to Forget history. Ignore only absent sidecars, propagate other errors, and never recursively chmod the containing directory or other files. Do not broaden the existing data-directory permission changes.

Test permission-path failure in an owned temporary test directory by substituting a symlink for an exact sidecar path. The checker must refuse it without following the link; the prior envelope/report and retryable import token stay intact. The unrelated symlink target's permissions stay unchanged. Restore only the test-owned sidecar before continuing.

The preview timer is ten minutes, uses `unref()` where supported, and closes over its own token/revision so an old timer cannot clear a newer preview. Check the clock again in import even if the timer has not fired. Empty/unknown/consumed/expired tokens get the same select-file-again instruction. Release references on replacement, expiry, forget, import success and dispose. A failed parser leaves stored history untouched and does not revive the previous preview. A failed store transaction preserves saved data and retains the current valid preview for retry.

```ts
const generation = this.generation;
const revision = ++this.previewRevision;
this.clearPreview();
const parsed = await parseAppleCSV(chunks, this.savedLibraryRecords());
if (this.disposed || generation !== this.generation || revision !== this.previewRevision) {
  throw new Error("This history operation was superseded or forgotten. Select the file again.");
}
```

`clearPreview(): void` cancels its timer and drops the payload. `savedLibraryRecords(): LibraryTrack[]` reads the current library envelope or returns `[]`. These private helpers live in `history-state.ts`; no extra persistence store or global singleton is needed.

- [ ] **Step 4: Add expiry, atomic-failure and permission checks.** Test exactly 600,000 ms expiry, replacement of a preview, confirming a consumed token, no preview after constructing a new app instance, forget during a pending CSV parse, disposed state, repeated imports replacing rather than appending, export replacement leaving library untouched and library replacement leaving export untouched. Force SQLite failure with a temporary test database and a SQLite trigger that rejects the new history insert, then confirm the old envelope/report remains together. Use a separate test `Database` connection only to create/drop the trigger; do not add a production failure hook.

```ts
test("database permissions cover only its own files", () => {
  const directory = mkdtempSync(join(tmpdir(), "wavelength-store-"));
  const path = join(directory, "state.sqlite");
  const unrelated = join(directory, "keep.txt");
  writeFileSync(unrelated, "synthetic", {mode: 0o644});
  const store = new Store(path);
  try {
    store.replaceHistory(savedLibrary([libraryTrack()]));
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(file)) expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(statSync(unrelated).mode & 0o777).toBe(0o644);
  } finally { store.close(); rmSync(directory, {recursive: true, force: true}); }
});
```

Run `bun test tests/history-state.test.ts tests/store.test.ts tests/jobs.test.ts` and `bun run typecheck`; expect PASS. Close states and Stores in tests to release timers and handles.

- [ ] **Step 5: Separate reviewer checks key scoping and generations, then commit.** Fix findings, rerun affected tests, stage the five listed files and commit `Store reviewed history locally`.

## Task 4: Explicit read-only Music statistics adapter

**Files:**

- Modify: `native/library.jxa`, add a `history` action before the existing action fallback
- Modify: `src/music.ts`, execution options and new exported adapter
- Modify: `tests/music.test.ts`
- Create: `tests/music-history.test.ts`

**Interfaces:**

Consumes `LibraryReadResult`, limits and `normalizeLibraryRead` from Task 1. Produces `readLibraryHistory(runner?: HistoryBridgeRunner): Promise<LibraryReadResult>` from `src/music.ts`. The injected runner is for tests only; `createApp` injects the whole adapter in Task 5.

```ts
export type HistoryBridgeRunner = (
  command: ReturnType<typeof libraryCommand>,
  options: {timeout: number; maxBuffer: number},
) => Promise<string>;
```

Keep `libraryCommand()` fixed to `/usr/bin/osascript -l JavaScript native/library.jxa` with one JSON argument. Extend internal `execute(file, args, timeout = 30_000, maxBuffer = 2 * 1024 * 1024)` narrowly, retaining current playlist/default limits and registered-child ownership. History calls `{action: "history"}` with `timeout=90_000`, `maxBuffer=32*1024*1024`. Errors must not echo stdout, track names or raw contents.

- [ ] **Step 1: Write the no-write JXA and adapter tests.** Load `native/library.jxa` using the existing `runInNewContext` test pattern. Use mocked `Application('Music')` and getters; mock make, duplicate, reveal and activate as functions that throw if invoked. Provide batched track property getters and deliberately unavailable optional properties.

```ts
test("statistics adapter has a dedicated buffer and deadline", async () => {
  let call: {action: string; timeout: number; maxBuffer: number} | undefined;
  const result = await readLibraryHistory(async (command, options) => {
    call = {...JSON.parse(command.args[3]!), ...options};
    return JSON.stringify({ok: true, result: {complete: true, declaredTrackCount: 1, tracks: [libraryTrack({playedCount: null})], warnings: []}});
  });
  expect(call).toEqual({action: "history", timeout: 90000, maxBuffer: 33554432});
  expect(result.tracks[0]!.playedCount).toBeNull();
});
```

- [ ] **Step 2: Run RED.** Run `bun test tests/music-history.test.ts tests/music.test.ts`. Expect missing history export/action. Existing playlist tests must remain unchanged and pass after implementation.

- [ ] **Step 3: Implement batched read-only properties and strict completion.** Use the installed scripting dictionary's actual getters `persistentID`, `name`, `artist`, `albumArtist`, `album`, `genre`, `duration`, `playedCount`, `playedDate`, `skippedCount`, `skippedDate`, `dateAdded`, `favorited`. Library records map the last getter to JSON `favorite`.

```js
if (input.action === 'history') {
  var libraries = Music.libraryPlaylists();
  if (!libraries.length) throw new Error('Music has no readable library. Open Music and retry.');
  var tracks = libraries[0].tracks;
  var count = tracks.length;
  if (count > 50000) throw new Error('Music library exceeds 50,000 tracks.');
  var ids = tracks.persistentID();
  if (ids.length !== count) throw new Error('Music returned an incomplete library snapshot. Retry.');
  result = readHistoryColumns(tracks, ids, count);
}
```

`readHistoryColumns(tracks, ids, count)` is a named helper in `library.jxa`. It batches each property read, checks every successful property's array length against `count`, and builds records indexed by persistent ID. An unavailable optional property becomes an all-null column plus a property-name/count warning. A thrown per-property getter is recoverable only for unavailable optional metadata; timeouts, permission denial, a disappearing library/collection or mismatched arrays fail the entire action. Missing IDs or structural changes fail. Re-read the track count/IDs after the columns and reject mutations in membership/order during the scan. Enforce 4,000-character text bounds in JXA before serialisation and again in TypeScript. Convert duration seconds to milliseconds only when finite/nonnegative. Convert genuine valid Date values to ISO; missing/sentinel/invalid dates become null, never epoch. Do not invoke `Music.activate()` or the native keyboard helper.

The adapter decodes `{ok,result,error}` with existing error handling, maps `-1743` to the existing Automation permission explanation, validates complete/count/records via `normalizeLibraryRead` and returns only normalised data. If Music is closed, reuse "Open Music ... before continuing". An output-buffer overflow becomes a clear too-large-snapshot error. Keep the owned-helper set cleanup on every success/failure/shutdown path.

- [ ] **Step 4: Add adapter failure cases and run GREEN.** Cover missing library, Music closed, Automation denial, null properties, NaN/negative numbers, invalid dates, count mismatch, incomplete flag, duplicate/missing IDs, oversized text and >50,000 tracks. Assert getter-only behavior and that default playlist calls still use 2 MiB/30 seconds. Test bridge transport failures through the injected runner; never call actual `osascript` in tests.

```ts
test("incomplete statistics never become a snapshot", async () => {
  await expect(readLibraryHistory(async () => JSON.stringify({ok: true, result: {
    complete: false, declaredTrackCount: 2, tracks: [libraryTrack()], warnings: [],
  }}))).rejects.toThrow("incomplete");
  await expect(readLibraryHistory(async () => { throw new Error("-1743 not authorized"); })).rejects.toThrow("Automation");
});
```

Run `bun test tests/music.test.ts tests/music-history.test.ts tests/native-packaging.test.ts` and `bun run typecheck`; expect PASS. Reading the `.sdef` file for getter names is permitted; scanning the user's library is not an automated check.

- [ ] **Step 5: Separate reviewer checks the read-only action and limits, then commit.** Fix findings, rerun affected tests, stage the four listed files and commit `Read Music library statistics`.

## Task 5: Authenticated history routes and Music operation exclusion

**Files:**

- Modify: `src/server.ts`, Dependencies, request dispatch and Music operation guards
- Modify: `src/validation.ts`, `authorize`
- Modify: `src/index.ts`, transport ceiling and shutdown
- Modify: `src/jobs.ts`, active-job accessor
- Modify: `tests/jobs.test.ts`, active-job lifetime checks
- Create: `tests/history-server.test.ts`
- Modify: `tests/security.test.ts`
- Modify: `tests/native-packaging.test.ts`
- Create: `tests/fixtures/history-server.ts`

**Interfaces:**

Consumes `HistoryState`, `summarizeHistory`, `validateHistoryQuery` and `LibraryReadResult`. Extend Dependencies with optional `readLibraryHistory?: () => Promise<LibraryReadResult>` and `now?: () => number` so existing tests need no Music adapter changes. `src/index.ts` passes `music.readLibraryHistory`; missing adapters give an explicit unavailable error. `createApp()` adds `dispose(): void` to its returned `{token, fetch, jobs}`. Dispose history memory before helper/server/store shutdown.

Implement exactly these routes:

| Request | Successful response |
| --- | --- |
| Authenticated `GET /api/history` | `HistoryResponse` |
| `POST /api/history/library` with `{}` | Fresh `HistoryResponse`, from saved state after scan |
| `POST /api/history/preview` with raw CSV bytes | `HistoryPreview` |
| `POST /api/history/import` with token/replace | Fresh `HistoryResponse` |
| `POST /api/history/forget` with `{}` | `{ok:true}` |

Mutation responses use the same default query as the GET without a source. Native reloads its selected page with an explicit timezone after saving. Never return records in any history response. Keep historical GETs authenticated even when there are no sources.

- [ ] **Step 1: Write route auth, raw bytes and concurrent-operation tests.** `tests/fixtures/history-server.ts` exports `historyApp(options?: {read?: () => Promise<LibraryReadResult>; open?: () => Promise<void>; now?: () => number})` returning `{app,store,request,csv,dispose}`. It uses in-memory Store, empty discovery, mocked status/playlist adapter, and exports a separate `deferred<T>()`. The mocked openPlaylist calls options.open when supplied. `request(path, body?, changes?)` sends the correct existing Host/Origin/token/JSON headers; `csv(bytes, changes?)` sends a `Request` to `/api/history/preview` with `text/csv` and no path. Dispose calls app.dispose then store.close.

```ts
test("history reads require a token and CSV exception stays narrow", async () => {
  const fixture = historyApp();
  try {
    expect((await fixture.app.fetch(fixture.request("/api/history", undefined, {"x-wavelength-token": ""}))).status).toBe(403);
    expect((await fixture.app.fetch(fixture.csv(new TextEncoder().encode("Song Name,Event End Timestamp\nSong,")))).status).toBe(200);
    expect((await fixture.app.fetch(fixture.request("/api/drafts", {}, {"content-type": "text/csv"}))).status).toBe(403);
    expect((await fixture.app.fetch(fixture.request("/api/history/preview", {path: "/private/export.csv"}))).status).toBe(415);
  } finally { fixture.dispose(); }
});
test("forget wins over a delayed explicit scan", async () => {
  const waiting = deferred<LibraryReadResult>();
  const fixture = historyApp({read: () => waiting.promise});
  try {
    const scan = fixture.app.fetch(fixture.request("/api/history/library", {}));
    expect((await fixture.app.fetch(fixture.request("/api/history/forget", {}))).status).toBe(200);
    waiting.resolve({complete: true, declaredTrackCount: 1, tracks: [libraryTrack()], warnings: []});
    expect((await scan).status).toBe(409);
    expect(fixture.store.history()).toEqual([]);
  } finally { fixture.dispose(); }
});
```

- [ ] **Step 2: Run RED.** Run `bun test tests/history-server.test.ts tests/security.test.ts`. Expect the current unauthenticated GET/404 or CSV authorization failures.

- [ ] **Step 3: Implement exact-route auth and bounded body handling.** Determine pathname before choosing body parsing. Refactor `authorize` so its existing Host and POST Origin/token checks always run, then allow `text/csv` only on exact `POST /api/history/preview`. That route's incorrect media type returns 415. All other POSTs retain application/json enforcement. For `GET /api/history`, require the token, validate Host and reject a supplied hostile Origin; native GET need not send an Origin. Preserve existing GET session/bootstrap behavior. Do not make `/api/history/anything` part of the exception.

```ts
const path = new URL(request.url).pathname;
if (request.method === "GET" && path === "/api/history" &&
    request.headers.get("x-wavelength-token") !== token) {
  throw new Error("Invalid session token. Reload the app.");
}
```

Set Bun `maxRequestBodySize` to exactly `20 * 1024 * 1024`. Keep the existing JSON helper's 131072-byte announced and streamed limits unchanged. Pass a bounded async iterator of raw request-body chunks to `HistoryState.preview`; reject an announced length above 20 MiB early, validate nonnegative finite announced lengths, count actual bytes too, cancel the reader on rejection and release the reader lock in finally. Do not concatenate raw CSV text or parse raw CSV as JSON. Reject JSON objects, multipart uploads and any supplied path-shaped fields on non-preview history routes by requiring exact body keys.

Introduce one server-local Music operation lease for scans, preflights and opening a playlist, plus a public `Jobs.isActive(): boolean` accessor backed by `activeId` in `src/jobs.ts`. A scan starts only when there is no lease and no active job. A preflight starts only when there is no lease and no active job. Opening a playlist acquires the same lease for the entire awaited jobs.open call. Acquire the lease synchronously before the first await and release in finally. Reject `/api/jobs` and retry while a lease exists; reject scan/preflight/open while the job is queued/running, even during cancellation when the current song is still finishing. Do not hold the lease merely for an async call that starts a job; `Jobs.isActive()` protects the entire background job lifetime. Existing Jobs.available remains authoritative for concurrent writes. Cancellation of a playlist job is still allowed and does not falsely release an active write. No Music guard is required for pure CSV parsing, summaries or Forget history.

```ts
let musicRead: "scan" | "preflight" | "open" | undefined;
function acquireMusicRead(kind: "scan" | "preflight" | "open"): () => void {
  if (musicRead || jobs.isActive()) throw Object.assign(new Error("Music is busy. Wait for the current operation."), {status: 409});
  musicRead = kind;
  return () => { musicRead = undefined; };
}
```

Map superseded/forgotten scan/preview operations, missing replacement confirmation and expired tokens to 409 with useful existing error text. Keep 413 for byte/record/field size rejection and 400 for parse/invalid query/body errors. A denied/failed/timed-out scan preserves the prior library snapshot; saving is one finishScan call after complete validation. Import and forget invoke the synchronous state operations without an await between generation checks and transaction publication.

- [ ] **Step 4: Add transport/race and safety tests.** Run individual new tests RED then GREEN. Cover all routes with missing/wrong tokens, Host spoofing, hostile Origin, malformed media type and arbitrary paths; bounded rankings and no raw records; preview expiry/replacement; same-file replacement not accumulation; absent/incorrect replacement confirmation; import failure preserving prior report; forgetting history only; late scan and older-preview completion; failed scan releasing the Music lease; concurrent scan/scan, scan/preflight, preflight/scan, preflight/preflight, active job/scan and active job/preflight. Exercise create, retry and open rejection during scan/preflight, and ensure job cancellation does not unlock until its promise completes.

Use a `ReadableStream<Uint8Array>` with no content-length to send >20 MiB chunked data and a 4,001-character quoted field split across chunks. Send >128 KiB JSON without content-length to an existing POST and verify 413. Launch the real Bun server with temporary `WAVELENGTH_DATA_DIR` to pin both the raised transport ceiling and the preserved application limit. Keep these tests synthetic and inject the library reader. Assert rejected uploads cancel the producer and app.dispose drops preview memory. Test a new instance cannot consume another instance's token and pending completions after dispose cannot write to a closed Store.

Run `bun test tests/history-server.test.ts tests/server.test.ts tests/security.test.ts tests/jobs.test.ts tests/native-packaging.test.ts` and `bun run typecheck`; expect PASS. The existing playlist and provenance tests must stay green.

```ts
test("pending playlist open excludes a later scan", async () => {
  const waiting = deferred<void>();
  const fixture = historyApp({open: () => waiting.promise});
  fixture.store.put("job", "saved", {id: "saved", state: "complete", playlistId: "ABCDEF0123456789"});
  const opening = fixture.app.fetch(fixture.request("/api/jobs/saved/open", {}));
  expect((await fixture.app.fetch(fixture.request("/api/history/library", {}))).status).toBe(409);
  waiting.resolve();
  expect((await opening).status).toBe(200);
  fixture.dispose();
});
```

Repeat for pending open versus preflight and job creation/retry. A failed open must release its lease in finally.

- [ ] **Step 5: Separate reviewer checks auth, Music exclusion and streamed limits, then commit.** Fix findings, rerun affected tests, stage only this task's listed files, `src/jobs.ts` and any changed `tests/jobs.test.ts`, and commit `Add local history endpoints`.

## Task 6: Native history transport, state and guarded seed handoff

**Files:**

- Create: `native/App/HistoryTypes.swift`
- Create: `native/App/HistoryFileReader.swift`
- Modify: `native/App/APIClient.swift`
- Modify: `native/App/AppModel.swift`
- Create: `native/Tests/HistoryChecks.swift`
- Modify: `native/Tests/NativeChecks.swift`
- Modify: `tests/fixtures/pending-engine.ts`
- Modify: `scripts/check-native.ts`

**Interfaces:**

Mirror the Task 1/2/3 API types in Codable Swift structs named `HistoryDate`, `HistoryCoverage`, `HistorySuggestion`, `HistoryTotals`, `HistorySourceSummary`, `HistoryRow`, `HistoryPage`, `HistoryResponse`, `HistoryPreview`. JSON source/profile/kind fields are Strings for consistency with existing APITypes. Use optional Doubles for numeric metrics, Int for bounded counts, and optional HistoryDate for dates. `HistoryRow.id` and source summaries' computed `id = source` support native tables. Do not decode raw records.

`HistoryFileReader` exposes `static func read(_ url: URL) async throws -> Data`. It reads only the selected URL off the main actor in bounded 64 KiB chunks, stops after 20 MiB plus detection of one extra byte and closes its FileHandle with defer. Check the file's announced size first and actual bytes during reading to catch growth. Preserve cancellation and reject non-regular files. Return Data, never expose an absolute path to the engine or save it in model history. Security-scoped access, when provided by the picker, begins/ends around the read.

Extend APIClient with `func uploadCSV<T: Decodable>(_ data: Data) async throws -> T` and `func csvRequest(_ data: Data) throws -> URLRequest`. Use the existing URLSession, decoder, cancellation and 120-second timeout. `request()` attaches the token to `/api/history` GETs including queries, while bootstrap GETs stay unchanged. csvRequest uses the exact preview route, POST, Origin, token, `text/csv; charset=utf-8` and bytes; recheck the byte cap before creating the request.

AppModel adds these navigation/state contracts:

```swift
enum AppPage: String, CaseIterable { case getStarted, discover, listening }
enum HistoryOperation: Equatable { case idle, readingFile, parsing, scanning, importing, forgetting }
@Published var page: AppPage = .getStarted
@Published private(set) var history: HistoryResponse?
@Published private(set) var historyPreview: HistoryPreview?
@Published var historySource: String?
@Published private(set) var historyOperation: HistoryOperation = .idle
@Published private(set) var historyScanInFlight = false
@Published private(set) var pendingHistorySeed: HistorySuggestion?
```

Add methods `loadHistory(kind: String = "artists", offset: Int = 0) async`, `scanHistory() async`, `previewHistoryFile(_ url: URL) async`, `importHistory(replace: Bool) async`, `dismissHistoryPreview()`, `forgetHistory() async`, `requestHistorySeed(_ suggestion: HistorySuggestion)`, `confirmHistorySeed()`, and `cancelHistorySeed()`. Views obtain confirmation before calling destructive/replacement methods. `requestHistorySeed` immediately applies a card only if there is no draft to replace and no building/active job; a ready draft sets pendingHistorySeed. confirm rechecks guards before applying. On application set only mode=`artist`, seed=`artist`, page=`discover`, discard the confirmed old ready draft/selection/preflight locally, and leave `includeAI`, country, count and selection unchanged. No implicit preview, catalog request, preflight or write occurs.

Add separate `historyOperationRevision` and `historyQueryRevision`, plus the captured engine epoch. Starting a scan/file preview/import/Forget advances operationRevision; a source/kind/page query advances only queryRevision. Forget and engine shutdown/restart advance both. Operation completion and defer compare operationRevision and epoch, so changing a table/source cannot strand a running scan's busy state. Query completion compares queryRevision, source/kind/page and epoch. Mutation completion updates saved-source summaries without overwriting a newer selected page, then refreshes the currently selected page. A stale operation defer must not set a newer operation to idle. Keep history scans exclusive with `busy`, pending preflight and activeJob in the native model, with server checks as the second boundary. File reading/parsing has its own historyOperation and leaves UI/navigation responsive. Forget may invalidate a pending history read/parse/scan without waiting for that operation to finish.

`historyScanInFlight` tracks the outstanding scan independently of displayed historyOperation. A private scan-owner UUID and engine epoch control cleanup. Set it before posting; clear it in the request's defer only if that owner/epoch still matches, including after Forget invalidates the displayed result. Source queries never alter it. Add `!historyScanInFlight` to canCheck/canCreate and to the actual checkLibrary/create guards and jobAction for retry/open, not only disabled buttons. Job cancellation stays allowed. Forget does not unlock Music while the old scan is running. Shutdown clears scan ownership before changing engines.

Require `!historyScanInFlight` in scanHistory itself and Read/Refresh button guards before creating a new scan-owner UUID. After Forget, a second scan must not replace the owner of the original outstanding request or send a new request. Test this directly with the fixture's scan route counter while the original scan remains delayed.

- [ ] **Step 1: Write native transport and seed checks.** `HistoryChecks.run()` is called from NativeChecks.main. Add a fixture-based async `HistoryChecks.run(resources: URL)` after existing PendingChecks, and extend the synthetic fixture engine with history responses, delayed preview/scan/query operations and authenticated GET checking. Do not replace its existing pending-write scenarios.

```swift
let api = APIClient(baseURL: URL(string: "http://127.0.0.1:12345")!)
api.token = "fixture-token"
let read = try api.request("/api/history?source=library&timeZone=Australia%2FBrisbane")
precondition(read.value(forHTTPHeaderField: "x-wavelength-token") == "fixture-token")
let csv = try api.csvRequest(Data("Song Name,Event End Timestamp\nSong,".utf8))
precondition(csv.httpMethod == "POST")
precondition(csv.value(forHTTPHeaderField: "Content-Type") == "text/csv; charset=utf-8")
precondition(csv.value(forHTTPHeaderField: "Origin") == "http://127.0.0.1:12345")
let model = AppModel()
model.requestHistorySeed(HistorySuggestion(artist: "Fixture artist", kind: "top", basis: "3 activity records"))
precondition(model.page == .discover && model.settings.mode == "artist")
precondition(model.settings.seed == "Fixture artist" && !model.includeAI)
precondition(model.draft == nil && model.preflight == nil)
```

- [ ] **Step 2: Run RED.** Add new pure source files and HistoryChecks.swift to the explicit sources list in `scripts/check-native.ts` before running `bun run test:native`. Include `HistoryTypes`, `HistoryFileReader` alongside APITypes/APIClient/EngineController/AppModel, and compile `native/Tests/HistoryChecks.swift`. Expect missing method/type or assertion failures. `build-app.ts` already discovers every Swift app file; do not add a second source manifest there.

- [ ] **Step 3: Implement transport and model operations using captured revisions.** Saved-history load runs after engine token readiness; it never calls the library adapter. Startup chooses Get started unless a current draft or active/pending Music job requires Discover. A saved job restored by `/api/ready` still wins. Adding the history read must not block or break genres, polling or the existing readiness path; show a recoverable history error while leaving the app usable.

```swift
func csvRequest(_ data: Data) throws -> URLRequest {
    guard data.count <= 20 * 1024 * 1024 else { throw AppError(message: "CSV exceeds 20 MiB.") }
    var request = try self.request("/api/history/preview", body: [:])
    request.setValue("text/csv; charset=utf-8", forHTTPHeaderField: "Content-Type")
    request.httpBody = data
    return request
}
```

`loadHistory` URL-encodes each validated query value with URLComponents, passes the current native IANA zone and bounds page parameters. It selects historySource only if that source still exists, otherwise uses preferredSource. Changing source advances historyQueryRevision, clears the old page and requests the new page. Scan/import responses update summaries, then load the currently selected table. On failure or picker cancellation retain saved history. On successful Forget clear summaries and local preview immediately; any earlier response fails its epoch/revision checks.

`scanHistory` displays "Music may ask for Automation permission. Scanning only reads library metadata." before posting. The action is explicit and uses no Accessibility checks. Read errors are presented through the existing error UI. Invalidate current playlist preflight when a scan begins; an older preflight completion cannot enable Create.

`previewHistoryFile` sets readingFile, awaits the bounded off-main-thread reader, checks epoch/revision, sets parsing and uploads bytes. It never stores the URL in published history data. Import takes the reviewed token only; replacement is controlled by the explicit `replace` argument. Dismiss during readingFile/parsing advances historyOperationRevision, clears the local preview and returns that preview operation's state to idle, so a late read/upload cannot repopulate the review. Check the revision before uploading and before publishing the response. Dismiss does not invalidate an unrelated scan or an import already committing; disable dismissal during confirmed import and offer Forget separately. An abandoned engine token expires or is replaced. Shutdown clears local preview/state and advances both revisions before stopping the engine.

For seed handoff, validate the suggestion against the same 120-character/no-control-character rule as Task 2. Ready-draft confirmation rechecks building and activeJob after the sheet opened, then discards only the confirmed local draft display and its selected/removed/preflight state. Do not delete persisted drafts/jobs or bypass the normal discovery identity and provenance checks. A history seed itself has no known provenance.

- [ ] **Step 4: Add native workflow/race checks and run GREEN.** Decode synthetic summaries with null fields and all profiles. Test unsigned history GET rejection, query-token attachment, raw-upload headers and error messages. Test bounded selected-file reading at exactly 20 MiB and above, a file that grows while being read via a controlled test input, cancellation and proper file-handle closure. Tests can call an internal `readChunks(size: Int?, next: @Sendable () throws -> Data?) async throws -> Data` helper used by read(url), so growth does not rely on timing.

Use the fixture engine to verify startup requests saved summaries but never scans, source switching while a previous page query is pending, picker-cancel equivalent leaving state unchanged, import initial save/replacement/declined confirmation, error preserving prior data, Forget during delayed scan/preview, late responses after engine restart and idle state cleanup. Track route counters in the fixture to prove a card triggers zero preview/preflight/job calls. Ready draft prompts and decline preserves settings/selection; building/pending/running/unconfirmed jobs block handoff and scans; confirming a previously opened seed prompt after a job starts does nothing. AI off stays off, an already-on choice remains the user's choice, and provenance stays unknown until normal discovery.

Run `bun run test:native`, `bun test tests/native-engine.test.ts tests/native-packaging.test.ts`, and `bun run typecheck`; expect PASS. All original delayed Create/Retry, stale-preflight and process-ownership checks still run.

Add controlled query-during-scan and query-during-import checks: release delayed operations after switching source/page, then verify saved summaries refresh, the selected page stays current and operation/scan states clean up. Call checkLibrary/create/jobAction("retry")/jobAction("open") directly during a scan and assert their route counters do not change. Forget during a scan clears history but preserves scan ownership until the request settles. Dismiss during delayed file read/upload, then release it: historyPreview stays nil, no import runs and historyOperation stays idle. Use controlled fixture responses rather than timing sleeps.

- [ ] **Step 5: Separate reviewer checks actual native state transitions, then commit.** Fix findings, rerun affected checks, stage only the listed files and commit `Add native history workflow`.

## Task 7: Native navigation, import review and accessible Listening pages

**Files:**

- Create: `native/App/Palette.swift`
- Create: `native/App/HistoryViews.swift`
- Modify: `native/App/HistoryTypes.swift`, presentation formatting helpers
- Modify: `native/App/Views.swift`, Palette, ContentView workspace and sidebar navigation
- Modify: `native/Tests/HistoryChecks.swift`, presentation-value checks
- Modify: `README.md`, native use/privacy/verification sections
- Modify: `scripts/build-app.ts` only if verification exposes a bundle inclusion problem

**Interfaces:**

Consumes AppModel and History types from Task 6. Move the existing Palette enum verbatim to `Palette.swift` with internal visibility, preserving all five RGB values. Produce `GetStartedView(model: AppModel)`, `ListeningView(model: AppModel)`, `HistoryImportSheet(model: AppModel)` and internal `HistoryPageView(page: HistoryPage)` in HistoryViews.swift. Existing Discover workspace remains its current implementation; ContentView switches the workspace according to model.page and adds Get started/Discover/Listening to the existing sidebar. Discover seed/options remain available on Discover, with the current wide resizable window and keyboard shortcut.

`HistoryFilePicker` is an internal view helper that uses an NSOpenPanel, `allowsMultipleSelection=false`, file-only selection and CSV content types. On cancel do nothing. On a selected file call `Task { await model.previewHistoryFile(url) }`. It must not read the file itself; only the model and HistoryFileReader do that. It never opens on startup.

Presentation helpers in HistoryTypes.swift, exercised by native checks, provide `HistoryRow.metricText(for kind: String) -> String` and `HistorySourceSummary.sourceLabel: String`. A null metric displays "Unavailable". Library labels use "Library play count", "Last played", "Skip count" and "Favourites". Export labels use the profile's record label, "Last seen" and "Reported play duration". Formatting duration shows reported duration only; never fall back to media/track duration.

- [ ] **Step 1: Write failing presentation checks and a manual acceptance checklist.** Check null vs valid zero rendering, source labels, recently-played absence of event-chart presentation and instant/current-zone labels.

```swift
let row = HistoryRow(id: "track", label: "Song", artist: nil, album: nil,
    albumArtist: nil, genre: nil, libraryPlayCount: nil, activityRecords: 0,
    reportedDurationMs: nil, skippedCount: nil, favoriteTracks: nil, lastDate: nil)
precondition(row.metricText(for: "libraryPlayCount") == "Unavailable")
precondition(row.metricText(for: "activityRecords") == "0")
precondition(row.metricText(for: "reportedDurationMs") == "Unavailable")
```

Run `bun run test:native`; expect missing formatting methods or failed assertions before implementing them. UI layout behavior is verified through the running native app rather than source-string snapshots.

- [ ] **Step 2: Implement navigation, source cards and import review.** Get started shows the explicit Read Music library, Import Apple CSV and Continue to Discover actions in the empty state. With saved history it shows a source picker, source capture/import date, coverage wording and up to six suggestion cards with basis. Card buttons call requestHistorySeed and present pendingHistorySeed confirmation if required; they never call preview. Keep errors/scanning/reading/parsing states visible and controls disabled according to model guards.

The import sheet explains requesting Apple Media Services data at `https://privacy.apple.com` and extracting the archive. Provide a native file-picker button accepting one CSV, then display detected profile, accepted/rejected rows, available fields, missing-field counts, earliest/latest observed dates, duration/enrichment coverage and warnings. Show unsupported-format errors without losing current data. Initial import requires pressing Import; existing export shows an explicit replacement confirmation including the source and import date. Cancel/dismiss performs no import. Explain that the library snapshot remains separate and that current profile contracts are limited.

```swift
Button("Continue to Discover") { model.page = .discover }
Button("Read Music library") { Task { await model.scanHistory() } }
    .disabled(!model.connected || model.busy || model.activeJob || model.historyScanInFlight || model.historyOperation != .idle)
Button(suggestion.artist) { model.requestHistorySeed(suggestion) }
    .disabled(model.building || model.activeJob)
```

Refresh library calls the same explicit scan method. Replace export opens the import sheet and picker only through the user's action. Forget history presents confirmation stating it removes local history only and does not securely erase disk/backups, then calls forgetHistory; confirm can invalidate pending history work. Do not tie these history controls to the Include AI artists toggle.

- [ ] **Step 3: Implement bounded Listening tables and chart equivalents.** Source selection is available only when that source exists. Show source-specific totals and coverage notes above artist/album/track/genre tables. Page-size 50 with Previous/Next controls; display page range/total and excluded records. Zero-play library tracks remain accessible. Library track columns include last played, skipped count and favorite status. Absent artist/album/date stays unavailable. Genre comes only from supplied or exact-enriched library metadata.

Use Swift Charts, available in the existing macOS 14 target, for applicable daily/monthly/hourly pages. Chart bins use the same HistoryPage.rows shown in a native Table below, with metric, timeZone and excludedRows text. Chart page navigation advances the table and chart together; label them as the current page's observed dates. Recently played exposes last-seen track rankings and coverage, with no timeline controls. Library offers no daily totals/time-of-day/listening-minutes chart. Provide accessibility labels for source, refresh/import/forget buttons, table columns, chart metric/timezone and pagination; charts do not replace the table.

```swift
Table(page.rows) {
    TableColumn("Date or hour", value: \.label)
    TableColumn(page.metricLabel) { row in Text(row.metricText(for: "activityRecords")) }
    TableColumn("Reported play duration") { row in Text(row.metricText(for: "reportedDurationMs")) }
}
Text("\(page.metricLabel). \(page.excludedRows) records excluded. Time zone: \(page.timeZone ?? "Unavailable").")
```

Use page kind to choose ranking/date tables and labels, not profile guesses in the view. Preserve the existing Discover review, preflight/Create and job state UI, global errors and quit guard. Update README to describe explicit read-only scanning, reviewed one-file import/replacement, separate metrics, local storage, authenticated history reads, networked discovery after seed handoff and unverified real-export compatibility. Do not claim secure erase, complete lifetime history or fully offline playlist creation.

- [ ] **Step 4: Run complete automated and packaged verification.** Run these commands from the app repository and inspect every result:

```sh
bun test
bun run typecheck
bun run test:native
bun run build:app
```

`build:app` already emits a new bundle under `../builds.noindex/native-*/`, validates Info.plist and runs `codesign --verify --deep --strict` plus packaged engine checks. Inspect the new bundle to confirm history modules and `native/library.jxa` are present. Run `bun run test:native <new-bundle>/Contents/Resources` if the build did not already finish that check. No test scans Music or changes a playlist. Fix failures with focused tests; do not skip old tests to make the feature pass.

- [ ] **Step 5: Review and manually verify the actual new native bundle.** A separate reviewer checks the whole final diff and relevant automated results before installation. Run synthetic import/replacement/forget acceptance through packaged `EngineController(resources:dataDirectory:)` checks with an explicit temporary data directory. The native app's default EngineController does not honour a supplied `WAVELENGTH_DATA_DIR` environment variable; it overwrites that value. Do not use synthetic imports or Forget history against the user's real Application Support data. Use the native UI for layout, navigation, selected-file preview/cancel and accessibility checks that preserve saved data. If viewing privacy.apple.com, use Safari. Never substitute browser UI for native acceptance.

Keep screenshots and generated synthetic CSV fixtures in a newly numbered folder under `../history-acceptance/`. In the isolated packaged checks, verify empty/startup state, existing active-job startup going to Discover, all three import profiles, replacement decline/confirm, both source choices, table pagination, chart data and timezone wording, unavailable vs zero, ready-draft handoff confirmation, no automatic Preview/Create, AI off, Forget history and remaining unrelated draft/job/provenance data. In the actual native window, verify navigation, cancelled selection, preview cancel, unsupported input, keyboard focus, VoiceOver labels, 960-pixel minimum and a wide resized window. Report chart/layout checks that require populated history as unverified if the existing user data cannot supply them without mutation. Use mocked library fixtures for automated coverage; a real installed-library scan requires the user's explicit action.

If installing the reviewed bundle into an existing Applications location is already authorised, preserve the old app in a new versioned T3 backup path before replacement; resolve the exact app target first. Otherwise hand off the concrete verified bundle without inventing installation authority. Never discard older builds. Do not run a real export until the user supplies one.

- [ ] **Step 6: Fix review/acceptance findings, rerun affected checks, then commit and hand off.** Stage only the final task's changed files and commit `Add native Listening pages`. Report the plan's implementation result, test/native/package outcomes, new app/acceptance paths and any unresolved manual checks. State that real Apple-export compatibility remains unverified until a user export is supplied, and whether any real scan was explicitly performed. No push.

## Plan self-review and execution handoff

- [x] Confirm each spec section maps to Tasks 1 through 7: native navigation/import review, scan, parser semantics, analytics/suggestions, authenticated local integration/storage and verification.
- [x] Check the five Review Focus inputs against the named tests in Tasks 1, 2, 3, 5 and 6; no focus item is left as a manual-only hope.
- [x] Check source/profile/property names and JSON nullability against the contract blocks, especially `favorite`, `reportedDurationMs`, `HistoryPage.rows`, preview token/expiry, query timezone and separate generation/previewRevision.
- [x] Search this plan for placeholder instructions and repair any omissions before execution. Concrete test additions run RED before implementation and GREEN afterward; task review precedes local commits.
- [ ] Present this plan to the user for review. Preserve the worker plus separate reviewer execution method; do not implement until the user reviews the plan.
