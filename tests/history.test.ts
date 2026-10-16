import { expect, test } from "bun:test";
import { libraryEnvelope, normalizeLibraryRead, parseAppleCSV, parseHistoryDate } from "../src/history";
import { csvChunks, libraryTrack } from "./fixtures/history";

const header = "Song Name,Event End Timestamp";

test("BOM, CRLF and multiline Unicode survive small chunks", async () => {
  const text = '\uFEFF Song Name , Event End Timestamp , Artist ,Album Name\r\n' +
    '"曲, one\nline","2026-10-01T14:00:00+10:00","A ""quoted"" artist",Set\r\n';
  const result = await parseAppleCSV(csvChunks(text, 1));
  expect(result.profile).toBe("play-activity");
  expect(result.records[0]).toMatchObject({ title: "曲, one\nline", artist: 'A "quoted" artist' });
  expect(result.records[0]!.date).toEqual({ kind: "instant", value: "2026-10-01T04:00:00.000Z" });
});

test("a UTF-8 BOM before a quoted first header is accepted", async () => {
  const result = await parseAppleCSV(csvChunks('\uFEFF"Song Name","Event End Timestamp"\r\n"Song",', 1));
  expect(result.records[0]!.title).toBe("Song");
});

test("internal whitespace-only rows are rejected and CR-only row endings are supported", async () => {
  const result = await parseAppleCSV(csvChunks(`${header}\rSong,\r \t\rSong,\r`, 1));
  expect(result.coverage).toMatchObject({ inputRows: 3, acceptedRows: 2, rejectedRows: 1 });
});

test.each([
  ["Track Description,Date Played\nSong,2026-10-01", "daily-tracks"],
  ["Track Description,Last Event End Timestamp\nSong,2026-10-01T10:00:00Z", "recently-played"],
] as const)("required headers select %s", async (text, profile) => {
  expect((await parseAppleCSV(csvChunks(text))).profile).toBe(profile);
});

test("ambiguous exact title/album matches never choose an artist", async () => {
  const library = [libraryTrack({ artist: "One" }), libraryTrack({ artist: "Two", id: "0000000000000002" })];
  const result = await parseAppleCSV(csvChunks(`${header},Album Name\nSong,,Album`), library);
  expect(result.records[0]!.artist).toBeNull();
  expect(result.coverage.unmatchedRows).toBe(1);
});

test.each([
  ["", "No supported records"], [header, "No supported records"],
  [`${header}\n,`, "No supported records"],
  ["Title,Date\nSong,2026-10-01", "Unsupported CSV format"],
  ["Song Name,Event End Timestamp,Track Description,Date Played\nSong,,,", "Unsupported CSV format"],
  [`${header}, SONG NAME \nSong,,Song`, "Duplicate"],
  [`${header}\nSo\"ng,`, "quot"], [`${header}\n\"Song\"extra,`, "quot"],
  [`${header}\n\"Song,`, "quot"], [`${header}\nSong`, "columns"],
  [`${header}\nSong,,extra`, "columns"],
] as const)("rejects invalid CSV %s", async (text, message) => {
  await expect(parseAppleCSV(csvChunks(text, 1))).rejects.toThrow(message);
});

test.each([{ bytes: [0xff] }, { bytes: [0xe6, 0x9b] }])("rejects invalid or incomplete UTF-8 %j", async ({ bytes }) => {
  async function* input() { yield new TextEncoder().encode(`${header}\nSong,`); yield new Uint8Array(bytes); }
  await expect(parseAppleCSV(input())).rejects.toThrow("UTF-8");
});

test("profile optional fields use only their exact mappings", async () => {
  const activity = await parseAppleCSV(csvChunks(`${header},Artist,Album Name,Play Duration Milliseconds,Media Duration In Milliseconds,Genre\nSong,,,Album,0,120000,Ignored`));
  expect(activity.records[0]).toEqual({ title: "Song", artist: null, album: "Album", albumArtist: null, genre: null,
    date: null, reportedDurationMs: 0, mediaDurationMs: 120000, enriched: [] });
  const daily = await parseAppleCSV(csvChunks('Track Description,Date Played,Container Description,Play Duration Milliseconds,Artist,Media Duration In Milliseconds\nArtist - Song,2026-10-01,Album,12.5,Ignored,999'));
  expect(daily.records[0]).toMatchObject({ title: "Artist - Song", artist: null, album: "Album", reportedDurationMs: 12.5, mediaDurationMs: null,
    date: { kind: "date", value: "2026-10-01" } });
  const recent = await parseAppleCSV(csvChunks('Track Description,Last Event End Timestamp,Container Description,Media duration in millis,Play Duration Milliseconds\nSong,2026-10-01,Album,500,100'));
  expect(recent.records[0]).toMatchObject({ artist: null, album: "Album", reportedDurationMs: null, mediaDurationMs: 500 });
});

test("formula text and repeated rows remain records; internal blank titles are rejected", async () => {
  const result = await parseAppleCSV(csvChunks(`${header}\n"=SUM(1,2)",\n,\n\nSong,\nSong,\n`));
  expect(result.records.map(row => row.title)).toEqual(["=SUM(1,2)", "Song", "Song"]);
  expect(result.coverage).toMatchObject({ inputRows: 5, acceptedRows: 3, rejectedRows: 2, unmatchedRows: 3,
    missing: { artist: 3, album: 3, genre: 3, date: 3, reportedDurationMs: 3, mediaDurationMs: 3 } });
});

test.each(["", "-1", "NaN", "Infinity", "0x10", "1e3", "12ms", "."])("duration %s is unavailable", async value => {
  const result = await parseAppleCSV(csvChunks(`${header},Play Duration Milliseconds,Media Duration In Milliseconds\nSong,,${value},${value}`));
  expect(result.records[0]).toMatchObject({ reportedDurationMs: null, mediaDurationMs: null });
  expect(result.coverage.durationRows).toBe(0);
});

test.each(["2026-02-30", "2025-02-29", "2026-04-31", "03/04/2026", "2026-10-01T24:00:00Z", "2026-10-01T10:60:00Z", "2026-10-01T10:00:60Z", "2026-10-01T10:00:00+24:00", "2026-10-01T10:00:00+10:60", "2026-10-01 10:00:00", "2026-1-1"])("date %s is invalid", value => {
  expect(parseHistoryDate(value)).toBeNull();
});

test.each([
  ["2024-02-29", { kind: "date", value: "2024-02-29" }],
  ["2026-10-01T09:00:00", { kind: "unresolved", value: "2026-10-01T09:00:00" }],
  ["2026-10-01T09:00:00.123", { kind: "unresolved", value: "2026-10-01T09:00:00.123" }],
  ["2026-10-01T09:00:00-05:30", { kind: "instant", value: "2026-10-01T14:30:00.000Z" }],
] as const)("date %s retains its precision", (value, expected) => {
  expect(parseHistoryDate(value)).toEqual(expected);
});

test("coverage uses observed dates and excludes unresolved dates from bounds", async () => {
  const result = await parseAppleCSV(csvChunks(`${header},Play Duration Milliseconds\nOne,2026-10-01,0\nTwo,2026-10-03T09:00:00Z,30\nThree,2020-01-01T10:00:00,\nFour,2026-02-30,`));
  expect(result.coverage).toMatchObject({ firstDate: { kind: "date", value: "2026-10-01" },
    lastDate: { kind: "instant", value: "2026-10-03T09:00:00.000Z" }, datedRows: 2, instantRows: 1,
    durationRows: 2, missing: { date: 1 }, availableFields: ["song name", "event end timestamp", "play duration milliseconds"] });
  expect(result.coverage.warnings.some(warning => /unzoned|unresolved/i.test(warning))).toBe(true);
});

test.each([
  { earlier: "9999-12-31T23:00:00Z", expected: { kind: "instant", value: "9999-12-31T23:00:00.000Z" } },
  { earlier: "9999-12-31", expected: { kind: "date", value: "9999-12-31" } },
])("observed bounds order expanded-year instants with $earlier", async ({ earlier, expected }) => {
  const result = await parseAppleCSV(csvChunks(`${header}\nLater,9999-12-31T23:30:00-01:00\nEarlier,${earlier}`));
  expect(result.coverage.firstDate).toEqual(expected);
  expect(result.coverage.lastDate).toEqual({ kind: "instant", value: "+010000-01-01T00:30:00.000Z" });
});

test("unique exact trimmed identity enriches missing fields and deduplicates persistent IDs", async () => {
  const track = libraryTrack({ title: " Song ", album: " Album ", albumArtist: "Album artist" });
  const result = await parseAppleCSV(csvChunks(`${header},Album Name\nSong,,Album`), [track, { ...track }]);
  expect(result.records[0]).toMatchObject({ artist: "Artist", genre: "Electronic", albumArtist: "Album artist", enriched: ["artist", "genre"] });
  expect(result.coverage).toMatchObject({ enrichedRows: 1, unmatchedRows: 0, missing: { artist: 0, genre: 0 } });
});

test("nonempty text is preserved while exact enrichment trims only matching keys", async () => {
  const result = await parseAppleCSV(csvChunks(`${header},Artist,Album Name\n" Song ",,," Album "`), [libraryTrack({ artist: " Artist " })]);
  expect(result.records[0]).toMatchObject({ title: " Song ", album: " Album ", artist: " Artist ", genre: "Electronic" });
  const normalized = normalizeLibraryRead({ complete: true, declaredTrackCount: 1, tracks: [libraryTrack({ title: " Song ", artist: " Artist " })] });
  expect(normalized.tracks[0]).toMatchObject({ title: " Song ", artist: " Artist " });
});

test("enrichment never folds case or accents, matches albumless rows, or overwrites an artist", async () => {
  const result = await parseAppleCSV(csvChunks(`${header},Artist,Album Name\nSong,,Provided,Album\nsong,,,Album\nSóng,,,Album\nSong,,,`), [libraryTrack()]);
  expect(result.records[0]).toMatchObject({ artist: "Provided", genre: "Electronic", enriched: ["genre"] });
  expect(result.records.slice(1).every(row => row.artist === null)).toBe(true);
  expect(result.coverage.unmatchedRows).toBe(3);
});

test("distinct album artists and conflicting duplicate-ID metadata are ambiguous", async () => {
  for (const library of [
    [libraryTrack(), libraryTrack({ id: "0000000000000002", albumArtist: "Other" })],
    [libraryTrack(), libraryTrack({ artist: "Other" })],
  ]) {
    const result = await parseAppleCSV(csvChunks(`${header},Album Name\nSong,,Album`), library);
    expect(result.records[0]!.artist).toBeNull();
    expect(result.coverage.unmatchedRows).toBe(1);
  }
});

test("4,000 Unicode code points are allowed in quoted fields split across bytes", async () => {
  const result = await parseAppleCSV(csvChunks(`${header}\n"${"🎵".repeat(4000)}",`, 1));
  expect(result.records[0]!.title).toBe("🎵".repeat(4000));
  await expect(parseAppleCSV(csvChunks(`${header}\n"${"🎵".repeat(4001)}",`, 1))).rejects.toThrow("4,000");
  await expect(parseAppleCSV(csvChunks(`${header}\n${"x".repeat(4001)},`))).rejects.toThrow("4,000");
});

test("100,000 rows are allowed and rejected rows count toward the limit", async () => {
  const accepted = await parseAppleCSV(csvChunks(`${header}\n${"Song,\n".repeat(100000)}`, 65536));
  expect(accepted.coverage.acceptedRows).toBe(100000);
  await expect(parseAppleCSV(csvChunks(`${header}\nSong,\n${",\n".repeat(100000)}`, 65536))).rejects.toThrow("100,000");
});

test("20 MiB is allowed and the next byte rejects before decoding", async () => {
  const limit = 20 * 1024 * 1024;
  const prefix = `${header}\n`;
  const rows = Math.floor((limit - prefix.length) / 4000);
  const remainder = limit - prefix.length - rows * 4000;
  const text = prefix + `${"x".repeat(3998)},\n`.repeat(rows) + "x," + " ".repeat(remainder - 2);
  expect(new TextEncoder().encode(text).byteLength).toBe(limit);
  expect((await parseAppleCSV(csvChunks(text, 65536))).records.length).toBe(rows + 1);
  async function* tooLarge() { yield new TextEncoder().encode(text); yield new Uint8Array([0xff]); }
  await expect(parseAppleCSV(tooLarge())).rejects.toThrow("20 MiB");
});

test("library normalization preserves null and zero and reports property counts", () => {
  const result = normalizeLibraryRead({ complete: true, declaredTrackCount: 1, tracks: [libraryTrack({ playedCount: 0, durationMs: 0, artist: null, favorite: false })], warnings: [] });
  expect(result.tracks[0]).toMatchObject({ playedCount: 0, durationMs: 0, artist: null, favorite: false });
  expect(result.warnings.some(warning => warning.includes("artist") && warning.includes("1"))).toBe(true);
  const envelope = libraryEnvelope(result, "2026-10-01T10:00:00.000Z");
  expect(envelope).toMatchObject({ schemaVersion: 1, source: "library", capturedAt: "2026-10-01T10:00:00.000Z",
    coverage: { inputRows: 1, acceptedRows: 1, durationRows: 0, missing: { artist: 1, reportedDurationMs: 1, mediaDurationMs: 0 } } });
});

test.each([
  null, [], { complete: false, declaredTrackCount: 0, tracks: [] },
  { declaredTrackCount: 0, tracks: [] }, { complete: true, declaredTrackCount: 1, tracks: [] },
  { complete: true, declaredTrackCount: 0, tracks: {} },
  { complete: true, declaredTrackCount: 2, tracks: [libraryTrack(), libraryTrack()] },
  { complete: true, declaredTrackCount: 1, tracks: [libraryTrack({ id: "invalid" })] },
  { complete: true, declaredTrackCount: 1, tracks: [libraryTrack({ title: "x".repeat(4001) })] },
].map((value, index) => ({ value, index })))("rejects incomplete or malformed library response $index", ({ value }) => {
  expect(() => normalizeLibraryRead(value)).toThrow();
});

test("library invalid numbers and dates become null with warnings", () => {
  const result = normalizeLibraryRead({ complete: true, declaredTrackCount: 1, tracks: [{ ...libraryTrack(),
    playedCount: 1.5, skippedCount: -1, durationMs: Infinity, playedAt: "2026-02-30", skippedAt: "03/04/2026",
    addedAt: "2026-10-01T10:00:00+10:00", favorite: "yes" }] });
  expect(result.tracks[0]).toMatchObject({ playedCount: null, skippedCount: null, durationMs: null,
    playedAt: null, skippedAt: null, addedAt: { kind: "instant", value: "2026-10-01T00:00:00.000Z" }, favorite: null });
  expect(result.warnings.length).toBeGreaterThan(0);
});

test("library accepts normalized dates and 4,000 code points without treating track length as listening duration", () => {
  const result = normalizeLibraryRead({ complete: true, declaredTrackCount: 1, tracks: [libraryTrack({ title: "🎵".repeat(4000),
    playedAt: { kind: "date", value: "2026-10-01" }, skippedAt: { kind: "unresolved", value: "2026-10-01T12:00:00" } })] });
  expect(result.tracks[0]!.playedAt).toEqual({ kind: "date", value: "2026-10-01" });
  expect(libraryEnvelope(result, "2026-10-01T10:00:00Z").coverage).toMatchObject({ durationRows: 0, datedRows: 1, instantRows: 0 });
});

test("library warnings identify unzoned skipped and added dates with zoned played dates", () => {
  const result = normalizeLibraryRead({ complete: true, declaredTrackCount: 1, tracks: [libraryTrack({
    playedAt: { kind: "instant", value: "2026-10-01T10:00:00Z" },
    skippedAt: { kind: "unresolved", value: "2026-10-02T11:00:00" },
    addedAt: { kind: "unresolved", value: "2026-10-03T12:00:00" },
  })] });
  const coverage = libraryEnvelope(result, "2026-10-04T10:00:00Z").coverage;
  expect(coverage.warnings.some(warning => /1.*skippedAt.*unzoned.*unresolved/.test(warning))).toBe(true);
  expect(coverage.warnings.some(warning => /1.*addedAt.*unzoned.*unresolved/.test(warning))).toBe(true);
  expect(coverage.warnings.some(warning => /playedAt.*unzoned/.test(warning))).toBe(false);
  expect(coverage).toMatchObject({ datedRows: 1, instantRows: 1 });
});

test("library accepts 50,000 tracks but rejects 50,001", () => {
  const tracks = Array.from({ length: 50000 }, (_, index) => libraryTrack({ id: (index + 1).toString(16).padStart(16, "0") }));
  expect(normalizeLibraryRead({ complete: true, declaredTrackCount: 50000, tracks }).tracks).toHaveLength(50000);
  tracks.push(libraryTrack({ id: "FFFFFFFFFFFFFFFF" }));
  expect(() => normalizeLibraryRead({ complete: true, declaredTrackCount: 50001, tracks })).toThrow("50,000");
});
