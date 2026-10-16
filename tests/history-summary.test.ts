import { expect, test } from "bun:test";
import { summarizeHistory, validateHistoryQuery } from "../src/history-summary";
import { exportEnvelope, libraryTrack, savedLibrary } from "./fixtures/history";

const query = { offset: 0, limit: 50, timeZone: "UTC" };
const now = Date.parse("2026-10-10T00:00:00Z");
const activity = "Song Name,Event End Timestamp,Artist,Album Name,Play Duration Milliseconds,Media Duration In Milliseconds";

test("sources never combine play counts and activity records", async () => {
  const library = savedLibrary([libraryTrack({ playedCount: 12 })]);
  const exported = await exportEnvelope(`${activity}\nSong,2026-10-01T00:00:00Z,Artist,Album,10,120000\nSong,2026-10-01T00:00:00Z,Artist,Album,,120000`);
  const result = summarizeHistory([library, exported], query, now);
  expect(result.sources.find(s => s.source === "library")!.totals).toMatchObject({ tracks: 1, libraryPlayCount: 12, activityRecords: null, reportedDurationMs: null });
  expect(result.sources.find(s => s.source === "export")!.totals).toMatchObject({ tracks: 1, activityRecords: 2, reportedDurationMs: 10, libraryPlayCount: null, skippedCount: null, favoriteTracks: null });
  expect(result.preferredSource).toBe("export");
  expect(result.page!.rows[0]!.activityRecords).toBe(2);
  expect(result.sources[1]!.coverage.missing.reportedDurationMs).toBe(1);
  expect(result.sources[1]!.coverage.warnings.some(w => /duration/i.test(w))).toBe(true);
});

test.each(["artists", "tracks", "daily", "monthly", "hourly"] as const)("%s rejects duration aggregate overflow rather than returning Infinity", async kind => {
  const duration = `1${"0".repeat(308)}`;
  const saved = await exportEnvelope(`${activity}\nFirst,2026-10-01T09:30:00Z,One,Album,${duration},1000\nSecond,2026-10-01T09:30:00Z,Two,Album,${duration},1000`);
  expect(saved.records.every(record => record.reportedDurationMs === 1e308)).toBe(true);
  expect(() => summarizeHistory([saved], { ...query, kind }, now)).toThrow(/metric.*overflow/i);
});

test("grouped export duration overflow returns an explicit error", async () => {
  const duration = `1${"0".repeat(308)}`;
  const saved = await exportEnvelope(`${activity}\nSong,2026-10-01T09:30:00Z,Artist,Album,${duration},1000\nSong,2026-10-01T09:30:00Z,Artist,Album,${duration},1000`);
  expect(() => summarizeHistory([saved], { ...query, kind: "tracks" }, now)).toThrow(/metric.*overflow/i);
});

test.each(["playedCount", "skippedCount"] as const)("library %s aggregate overflow returns an explicit error", field => {
  const saved = savedLibrary([libraryTrack({ artist: "One", [field]: 1e308 }),
    libraryTrack({ id: "0000000000000002", artist: "Two", [field]: 1e308 })]);
  expect(() => summarizeHistory([saved], query, now)).toThrow(/metric.*overflow/i);
});

test("large finite duration sums remain available", async () => {
  const duration = `1${"0".repeat(307)}`;
  const saved = await exportEnvelope(`${activity}\nSong,2026-10-01T09:30:00Z,Artist,Album,${duration},1000\nSong,2026-10-01T09:30:00Z,Artist,Album,${duration},1000`);
  const result = summarizeHistory([saved], { ...query, kind: "hourly" }, now);
  expect(result.sources[0]!.totals.reportedDurationMs).toBe(2e307);
  expect(result.page!.rows[0]!.reportedDurationMs).toBe(2e307);
});

test("recently played never supplies event trends or listening duration", async () => {
  const exported = await exportEnvelope("Track Description,Last Event End Timestamp,Media duration in millis\nSong,2026-10-01T10:00:00Z,120000");
  const result = summarizeHistory([exported], { ...query, source: "export", kind: "tracks" }, now);
  expect(result.sources[0]!.trendsAvailable).toBe(false);
  expect(result.sources[0]!.totals.reportedDurationMs).toBeNull();
  expect(result.sources[0]!.metricLabel).toBe("Last-seen records");
  expect(result.page!.metricLabel).toBe("Last-seen records");
  expect(result.page!.rows[0]!.lastDate?.kind).toBe("instant");
});

test("unusable seeds remain metadata but cannot become artist suggestions", () => {
  const tracks = [libraryTrack({ artist: "a".repeat(121) }), libraryTrack({ id: "0000000000000002", artist: "bad\nseed" })];
  const result = summarizeHistory([savedLibrary(tracks)], { ...query, source: "library", kind: "artists" }, now);
  expect(result.page!.total).toBe(2);
  expect(result.page!.rows.map(row => row.label)).toContain("a".repeat(121));
  expect(result.sources[0]!.suggestions).toEqual([]);
});

test("album artists separate equally named albums and paginate", () => {
  const tracks = [libraryTrack({ albumArtist: "One" }), libraryTrack({ id: "0000000000000002", albumArtist: "Two" })];
  const result = summarizeHistory([savedLibrary(tracks)], { ...query, source: "library", kind: "albums", limit: 1 }, now);
  expect(result.page!.total).toBe(2);
  expect(result.page!.rows).toHaveLength(1);
  expect(result.page!.rows[0]!.albumArtist).toBe("One");
});

test("track and album identities use exact tuples without separator collisions", () => {
  const tracks = [
    libraryTrack({ title: "A|B", artist: "C", album: "D", albumArtist: null }),
    libraryTrack({ id: "0000000000000002", title: "A", artist: "B|C", album: "D", albumArtist: null }),
    libraryTrack({ id: "0000000000000003", title: "A|B", artist: "C", album: "D", albumArtist: "E" }),
  ];
  expect(summarizeHistory([savedLibrary(tracks)], { ...query, kind: "tracks" }, now).page!.total).toBe(3);
  expect(summarizeHistory([savedLibrary(tracks)], { ...query, kind: "albums" }, now).page!.total).toBe(3);
});

test("missing metadata is excluded only from its affected page", () => {
  const saved = savedLibrary([libraryTrack({ title: null, artist: null, album: null, genre: null, playedCount: 0 })]);
  const tracks = summarizeHistory([saved], { ...query, kind: "tracks" }, now);
  expect(tracks.page).toMatchObject({ total: 1, excludedRows: 0 });
  expect(tracks.page!.rows[0]!.libraryPlayCount).toBe(0);
  for (const kind of ["artists", "albums", "genres"] as const) {
    expect(summarizeHistory([saved], { ...query, kind }, now).page).toMatchObject({ total: 0, excludedRows: 1 });
  }
});

test("available zero does not hide absent library metrics", () => {
  const absent = savedLibrary([libraryTrack({ playedCount: null })]);
  expect(summarizeHistory([absent], query, now).sources[0]!.totals).toMatchObject({ libraryPlayCount: null, skippedCount: null, favoriteTracks: null });
  const partial = savedLibrary([libraryTrack({ playedCount: null }), libraryTrack({ id: "0000000000000002", playedCount: 0, skippedCount: 0, favorite: false })]);
  const summary = summarizeHistory([partial], query, now).sources[0]!;
  expect(summary.totals).toMatchObject({ libraryPlayCount: 0, skippedCount: 0, favoriteTracks: 0, reportedDurationMs: null });
  expect(summary.coverage.warnings).toEqual(expect.arrayContaining([
    expect.stringMatching(/playedCount.*1/), expect.stringMatching(/skippedCount.*1/), expect.stringMatching(/favorite.*1/),
  ]));
  expect(partial.coverage.warnings).toEqual([]);
});

test("summary does not duplicate missing-field warnings already captured by the scan", () => {
  const saved = savedLibrary([libraryTrack({ playedCount: null })]);
  saved.coverage.warnings.push("playedCount unavailable for 1 library tracks.");
  const result = summarizeHistory([saved], query, now);
  expect(result.sources[0]!.coverage.warnings.filter(w => w === "playedCount unavailable for 1 library tracks.")).toHaveLength(1);
});

test("library favorite and skip sums preserve nullable values and last played", () => {
  const tracks = [libraryTrack({ playedCount: 4, skippedCount: 2, favorite: true, playedAt: { kind: "instant", value: "2026-10-01T00:00:00.000Z" } }),
    libraryTrack({ id: "0000000000000002", playedCount: 7, skippedCount: 3, favorite: false, playedAt: { kind: "instant", value: "2026-10-02T00:00:00.000Z" } })];
  const result = summarizeHistory([savedLibrary(tracks)], { ...query, kind: "tracks" }, now);
  expect(result.sources[0]!.totals).toMatchObject({ tracks: 1, libraryPlayCount: 11, skippedCount: 5, favoriteTracks: 1, reportedDurationMs: null });
  expect(result.page!.rows[0]!.lastDate!.value).toBe("2026-10-02T00:00:00.000Z");
});

test("rankings and suggestions retain exact artist text regardless of provenance", () => {
  const saved = savedLibrary([libraryTrack({ artist: "AI Artist", playedCount: 5 }), libraryTrack({ id: "0000000000000002", artist: "Unknown Artist", playedCount: 7 }),
    libraryTrack({ id: "0000000000000003", artist: " AI Artist ", playedCount: 5 })]);
  const result = summarizeHistory([saved], { ...query, kind: "artists" }, now);
  expect(result.page!.rows.map(row => row.label)).toEqual(["Unknown Artist", " AI Artist ", "AI Artist"]);
  expect(result.sources[0]!.suggestions.map(s => s.artist)).toEqual(["Unknown Artist", " AI Artist ", "AI Artist"]);
  expect(result.sources[0]!.suggestions[0]!.basis).toContain("7");
});

test("suggestions are at most six distinct artists and accept 120 characters", () => {
  const tracks = Array.from({ length: 8 }, (_, index) => libraryTrack({ id: index.toString(16).padStart(16, "0"), artist: index ? `Artist ${index}` : "a".repeat(120), playedCount: 20 - index }));
  tracks.push(libraryTrack({ id: "0000000000000009", artist: "Artist 1", playedCount: 0 }));
  const suggestions = summarizeHistory([savedLibrary(tracks)], query, now).sources[0]!.suggestions;
  expect(suggestions.map(s => s.artist)).toEqual(["a".repeat(120), "Artist 1", "Artist 2", "Artist 3", "Artist 4", "Artist 5"]);
});

test("older favorite needs positive plays and an instant at least 90 days old", () => {
  const date90 = new Date(now - 90 * 86400000).toISOString();
  const date89 = new Date(now - 89 * 86400000).toISOString();
  const tracks = [libraryTrack({ artist: "Top", playedCount: 100 }),
    libraryTrack({ id: "0000000000000002", artist: "Boundary", playedCount: 4, favorite: false, playedAt: { kind: "instant", value: date90 } }),
    libraryTrack({ id: "0000000000000003", artist: "Recent", playedCount: 9, playedAt: { kind: "instant", value: date89 } }),
    libraryTrack({ id: "0000000000000004", artist: "Zero", playedCount: 0, playedAt: { kind: "instant", value: "2020-01-01T00:00:00.000Z" } }),
    libraryTrack({ id: "0000000000000005", artist: "Calendar", playedCount: 20, playedAt: { kind: "date", value: "2020-01-01" } }),
    libraryTrack({ id: "0000000000000006", artist: "Unzoned", playedCount: 20, playedAt: { kind: "unresolved", value: "2020-01-01T00:00:00" } })];
  const suggestions = summarizeHistory([savedLibrary(tracks)], query, now).sources[0]!.suggestions;
  expect(suggestions[0]!.artist).toBe("Top");
  const older = suggestions.filter(s => s.kind === "older-favorite");
  expect(older).toHaveLength(1);
  expect(older[0]!.artist).toBe("Boundary");
  expect(older[0]!.basis).toContain("4");
  expect(older[0]!.basis).toContain(date90);
  expect(new Set(suggestions.map(s => s.artist)).size).toBe(suggestions.length);
});

test.each([
  { playedCount: 0, playedAt: { kind: "instant" as const, value: "2020-01-01T00:00:00.000Z" } },
  { playedCount: null, playedAt: { kind: "instant" as const, value: "2020-01-01T00:00:00.000Z" } },
  { playedCount: 10, playedAt: null },
  { playedCount: 10, playedAt: { kind: "date" as const, value: "2020-01-01" } },
  { playedCount: 10, playedAt: { kind: "unresolved" as const, value: "2020-01-01T00:00:00" } },
  { playedCount: 10, playedAt: { kind: "instant" as const, value: "2026-10-01T00:00:00.000Z" } },
])("no older favorite without positive dated evidence %j", track => {
  const result = summarizeHistory([savedLibrary([libraryTrack(track)])], query, now);
  expect(result.sources[0]!.suggestions.some(card => card.kind === "older-favorite")).toBe(false);
});

test("export rankings count repeats and tie by exact label then identity", async () => {
  const saved = await exportEnvelope(`${activity}\nZ,,Zed,Z album,,1000\nZ,,Zed,Z album,,1000\nSame,,B,B album,100,1000\nSame,,A,A album,,1000\nUnknown,,,,,1000`);
  const page = summarizeHistory([saved], { ...query, kind: "tracks" }, now).page!;
  expect(page.rows.map(row => [row.label, row.artist, row.activityRecords])).toEqual([["Z", "Zed", 2], ["Same", "A", 1], ["Same", "B", 1], ["Unknown", null, 1]]);
  expect(summarizeHistory([saved], { ...query, kind: "artists" }, now).page).toMatchObject({ total: 3, excludedRows: 1 });
  expect(summarizeHistory([saved], { ...query, kind: "genres" }, now).page).toMatchObject({ total: 0, excludedRows: 5 });
});

test("library genre groups and album artist fallback retain reported counts", () => {
  const saved = savedLibrary([libraryTrack({ artist: "One", albumArtist: null, genre: "Jazz", playedCount: 2 }),
    libraryTrack({ id: "0000000000000002", artist: "Two", albumArtist: null, genre: "Jazz", playedCount: 4 }),
    libraryTrack({ id: "0000000000000003", genre: null, playedCount: null })]);
  expect(summarizeHistory([saved], { ...query, kind: "albums" }, now).page!.total).toBe(3);
  const page = summarizeHistory([saved], { ...query, kind: "genres" }, now).page!;
  expect(page).toMatchObject({ total: 1, excludedRows: 1 });
  expect(page.rows[0]).toMatchObject({ label: "Jazz", libraryPlayCount: 6 });
});

test("older favorite picks highest track count then oldest date and identity within six cards", () => {
  const tracks = Array.from({ length: 8 }, (_, i) => libraryTrack({ id: i.toString(16).padStart(16, "0"), artist: `Top ${i}`, playedCount: 100 - i }));
  tracks.push(libraryTrack({ id: "0000000000000010", artist: "Later", playedCount: 3, playedAt: { kind: "instant", value: "2020-02-01T00:00:00.000Z" } }),
    libraryTrack({ id: "0000000000000011", artist: "Z older", playedCount: 3, playedAt: { kind: "instant", value: "2020-01-01T00:00:00.000Z" } }),
    libraryTrack({ id: "0000000000000012", artist: "A older", playedCount: 3, playedAt: { kind: "instant", value: "2020-01-01T00:00:00.000Z" } }));
  const suggestions = summarizeHistory([savedLibrary(tracks)], query, now).sources[0]!.suggestions;
  expect(suggestions).toHaveLength(6);
  expect(suggestions[0]!.artist).toBe("Top 0");
  expect(suggestions.find(s => s.kind === "older-favorite")!.artist).toBe("A older");
});

test("default source falls back to library when export cannot seed an artist", async () => {
  const library = savedLibrary([libraryTrack()]);
  const exported = await exportEnvelope("Track Description,Date Played\nSong,2026-10-01");
  expect(summarizeHistory([exported, library], query, now).preferredSource).toBe("library");
  expect(summarizeHistory([exported, library], { ...query, source: "export" }, now).preferredSource).toBe("export");
  expect(summarizeHistory([exported], query, now).preferredSource).toBe("export");
  expect(summarizeHistory([], query, now)).toEqual({ sources: [], preferredSource: null, page: null });
});

test("older favorite preserves highest-ranked artist first and distinguishes track and artist counts", () => {
  const saved = savedLibrary([libraryTrack({ title: "Old", playedCount: 4, playedAt: { kind: "instant", value: "2020-01-01T00:00:00.000Z" } }),
    libraryTrack({ id: "0000000000000002", title: "New", playedCount: 5 }), libraryTrack({ id: "0000000000000003", artist: "Second", playedCount: 8 })]);
  const result = summarizeHistory([saved], query, now);
  expect(result.sources[0]!.suggestions.map(card => card.artist)).toEqual(["Artist", "Second"]);
  expect(result.sources[0]!.suggestions[0]!.kind).toBe("older-favorite");
  expect(result.sources[0]!.suggestions[0]!.basis).toContain("9 library play count for artist");
  expect(result.sources[0]!.suggestions[0]!.basis).toContain("4");
  expect(result.sources[0]!.suggestions[0]!.basis).toContain("2020-01-01T00:00:00.000Z");
});

test("time zone changes instant daily and monthly bins but preserves calendar dates", async () => {
  const saved = await exportEnvelope(`${activity}\nInstant,2026-10-01T00:30:00Z,Artist,,5,1000\nCalendar,2026-10-01,Artist,,0,1000`);
  const la = summarizeHistory([saved], { ...query, kind: "daily", timeZone: "America/Los_Angeles" }, now).page!;
  expect(la.rows.map(row => [row.label, row.activityRecords, row.reportedDurationMs])).toEqual([["2026-09-30", 1, 5], ["2026-10-01", 1, 0]]);
  expect(la.timeZone).toBe("America/Los_Angeles");
  const brisbane = summarizeHistory([saved], { ...query, kind: "daily", timeZone: "Australia/Brisbane" }, now).page!;
  expect(brisbane.rows.map(row => [row.label, row.activityRecords])).toEqual([["2026-10-01", 2]]);
  expect(summarizeHistory([saved], { ...query, kind: "monthly", timeZone: "America/Los_Angeles" }, now).page!.rows.map(row => row.label)).toEqual(["2026-09", "2026-10"]);
});

test("time zone combines both occurrences of a repeated local hour", async () => {
  const saved = await exportEnvelope(`${activity}\nFirst,2026-11-01T08:30:00Z,Artist,,10,1000\nSecond,2026-11-01T09:30:00Z,Artist,,20,1000`);
  const page = summarizeHistory([saved], { ...query, kind: "hourly", timeZone: "America/Los_Angeles" }, now).page!;
  expect(page.rows.map(row => [row.label, row.activityRecords, row.reportedDurationMs])).toEqual([["1", 2, 30]]);
  expect(page.excludedRows).toBe(0);
});

test("time zone hour zero never becomes hour twenty-four", async () => {
  const saved = await exportEnvelope(`${activity}\nMidnight,2026-10-01T00:30:00Z,Artist,,,1000`);
  expect(summarizeHistory([saved], { ...query, kind: "hourly" }, now).page!.rows.map(row => row.label)).toEqual(["0"]);
});

test("unresolved, missing and date-only timestamps have explicit hourly exclusions", async () => {
  const saved = await exportEnvelope(`${activity}\nInstant,2026-10-01T09:30:00Z,Artist,,,1000\nUnresolved,2026-10-01T09:30:00,Artist,,,1000\nDate,2026-10-01,Artist,,,1000\nMissing,,Artist,,,1000`);
  const hourly = summarizeHistory([saved], { ...query, kind: "hourly" }, now).page!;
  expect(hourly).toMatchObject({ total: 1, excludedRows: 3, metricLabel: "Activity records" });
  expect(hourly.rows[0]).toMatchObject({ activityRecords: 1, reportedDurationMs: null, libraryPlayCount: null, favoriteTracks: null, skippedCount: null });
  const daily = summarizeHistory([saved], { ...query, kind: "daily" }, now).page!;
  expect(daily).toMatchObject({ total: 1, excludedRows: 2 });
  expect(daily.rows[0]!.activityRecords).toBe(2);
  expect(saved.coverage.warnings.some(w => /1 unzoned/.test(w))).toBe(true);
});

test("daily-tracks calendar bins use date-associated records and no invented hours", async () => {
  const saved = await exportEnvelope("Track Description,Date Played,Play Duration Milliseconds\nSong,2026-10-01,0\nSong,2026-10-01,\nSong,2026-10-03,5");
  const daily = summarizeHistory([saved], { ...query, kind: "daily", offset: 1, limit: 1 }, now).page!;
  expect(daily).toMatchObject({ total: 2, excludedRows: 0, metricLabel: "Date-associated records" });
  expect(daily.rows.map(row => [row.label, row.activityRecords, row.reportedDurationMs])).toEqual([["2026-10-03", 1, 5]]);
  expect(summarizeHistory([saved], { ...query, kind: "hourly" }, now).page).toMatchObject({ total: 0, excludedRows: 3 });
});

test("sparse trends paginate actual calendar bins chronologically across expanded years", async () => {
  const saved = await exportEnvelope(`${activity}\nLate,9999-12-31T23:30:00-01:00,Artist,,,1000\nEarly,0001-01-01,Artist,,,1000\nBefore,9999-12-31,Artist,,,1000\nZero,0000-01-01T00:00:00Z,Artist,,,1000`);
  expect(summarizeHistory([saved], { ...query, kind: "daily" }, now).page!.rows.map(row => row.label)).toEqual(["0000-01-01", "0001-01-01", "9999-12-31", "+010000-01-01"]);
  const monthly = summarizeHistory([saved], { ...query, kind: "monthly", offset: 2, limit: 1 }, now).page!;
  expect(monthly.total).toBe(4);
  expect(monthly.rows[0]!.label).toBe("9999-12");
});

test("last-seen dates sort expanded-year instants numerically", async () => {
  const saved = await exportEnvelope(`${activity}\nSong,9999-12-31T23:00:00Z,Artist,,,1000\nSong,9999-12-31T23:30:00-01:00,Artist,,,1000`);
  expect(summarizeHistory([saved], { ...query, kind: "tracks" }, now).page!.rows[0]!.lastDate!.value).toBe("+010000-01-01T00:30:00.000Z");
});

test("negative expanded-year instants retain calendar order and year-zero meaning", async () => {
  const saved = await exportEnvelope(`${activity}\nZero,0000-01-01T00:00:00Z,Artist,,,1000\nBefore,0000-01-01T00:00:00+01:00,Artist,,,1000`);
  expect(summarizeHistory([saved], { ...query, kind: "daily" }, now).page!.rows.map(row => row.label)).toEqual(["-000001-12-31", "0000-01-01"]);
});

test("library and recently-played trends return unavailable errors", async () => {
  const saved = await exportEnvelope("Track Description,Last Event End Timestamp\nSong,2026-10-01T10:00:00Z");
  for (const kind of ["daily", "monthly", "hourly"] as const) {
    expect(() => summarizeHistory([savedLibrary([libraryTrack()])], { ...query, kind }, now)).toThrow(/unavailable/i);
    expect(() => summarizeHistory([saved], { ...query, kind }, now)).toThrow(/unavailable/i);
  }
});

test("explicit unavailable source returns a not-found error", () => {
  try {
    summarizeHistory([], { ...query, source: "export" }, now);
    throw new Error("Expected unavailable source");
  } catch (error) {
    expect(error).toMatchObject({ status: 404 });
  }
});

test("valid query defaults and bounds preserve explicit IANA time zone", () => {
  expect(validateHistoryQuery(new URLSearchParams("timeZone=Australia/Brisbane"))).toEqual({ offset: 0, limit: 50, timeZone: "Australia/Brisbane" });
  expect(validateHistoryQuery(new URLSearchParams("source=export&kind=hourly&offset=100000&limit=100&timeZone=America/Los_Angeles"))).toEqual({ source: "export", kind: "hourly", offset: 100000, limit: 100, timeZone: "America/Los_Angeles" });
});

test.each([
  "", "timeZone=", "timeZone=Mars/Olympus", "timeZone=%2B02:00", "timeZone=UTC&source=other", "timeZone=UTC&source=",
  "timeZone=UTC&kind=other", "timeZone=UTC&kind=", "timeZone=UTC&limit=0", "timeZone=UTC&limit=101", "timeZone=UTC&limit=1.5",
  "timeZone=UTC&limit=1e2", "timeZone=UTC&limit=", "timeZone=UTC&offset=-1", "timeZone=UTC&offset=100001",
  "timeZone=UTC&offset=9007199254740993", "timeZone=UTC&offset=NaN", "timeZone=UTC&offset=", "timeZone=UTC&extra=1",
  "timeZone=UTC&timeZone=UTC", "timeZone=UTC&source=library&source=export", "timeZone=UTC&kind=tracks&kind=artists",
  "timeZone=UTC&limit=1&limit=2", "timeZone=UTC&offset=0&offset=0", `timeZone=${"a".repeat(2000)}`,
])("rejects invalid, duplicate or oversized query %s", text => {
  expect(() => validateHistoryQuery(new URLSearchParams(text))).toThrow();
});
