import type {
  ExportRecord, HistoryCoverage, HistoryDate, HistoryEnvelope, HistoryKind, HistoryQuery,
  HistoryResponse, HistoryRow, HistorySourceSummary, HistorySuggestion, LibraryTrack,
} from "./history-types";
import { HISTORY_LIMITS } from "./history-types";

function availableSum(values: readonly (number | null)[]): number | null {
  const available = values.filter((value): value is number => value !== null);
  if (!available.length) return null;
  const total = available.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total)) throw new Error("History metric total overflow; the supplied values cannot be summed safely.");
  return total;
}

function exactCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function identity(record: LibraryTrack | ExportRecord, kind: HistoryKind): string | null {
  if (kind === "tracks") return JSON.stringify([record.title, record.artist, record.album, record.albumArtist]);
  if (kind === "albums") return record.album === null ? null : JSON.stringify([record.album, record.albumArtist ?? record.artist]);
  const field = kind === "artists" ? record.artist : record.genre;
  return field === null ? null : JSON.stringify([field]);
}

function dateNumber(date: HistoryDate): number {
  return Date.parse(date.kind === "date" ? `${date.value}T00:00:00Z` : date.value);
}

function lastDate(a: HistoryDate | null, b: HistoryDate | null): HistoryDate | null {
  if (!a) return b;
  if (!b) return a;
  if (a.kind === "unresolved") return b.kind === "unresolved" && exactCompare(a.value, b.value) > 0 ? a : b;
  if (b.kind === "unresolved") return a;
  return dateNumber(a) >= dateNumber(b) ? a : b;
}

function metricLabel(envelope: HistoryEnvelope): string {
  return envelope.source === "library" ? "Library play count" : envelope.profile === "recently-played"
    ? "Last-seen records" : envelope.profile === "daily-tracks" ? "Date-associated records" : "Activity records";
}

function ranking(envelope: HistoryEnvelope, kind: HistoryKind): { rows: HistoryRow[]; excludedRows: number } {
  const grouped = new Map<string, HistoryRow>();
  let excludedRows = 0;
  for (const record of envelope.records) {
    const id = identity(record, kind);
    if (id === null) { excludedRows++; continue; }
    const library = envelope.source === "library" ? record as LibraryTrack : null;
    const exported = envelope.source === "export" ? record as ExportRecord : null;
    const row: HistoryRow = {
      id, label: (kind === "tracks" ? record.title : kind === "artists" ? record.artist : kind === "albums" ? record.album : record.genre) ?? "Unknown title",
      artist: record.artist, album: record.album, albumArtist: record.albumArtist, genre: record.genre,
      libraryPlayCount: library?.playedCount ?? null, activityRecords: exported ? 1 : null,
      reportedDurationMs: exported?.reportedDurationMs ?? null, skippedCount: library?.skippedCount ?? null,
      favoriteTracks: library?.favorite === null || !library ? null : Number(library.favorite),
      lastDate: library ? library.playedAt : exported!.date,
    };
    const previous = grouped.get(id);
    if (!previous) { grouped.set(id, row); continue; }
    for (const field of ["libraryPlayCount", "activityRecords", "reportedDurationMs", "skippedCount", "favoriteTracks"] as const) {
      previous[field] = availableSum([previous[field], row[field]]);
    }
    for (const field of ["artist", "album", "albumArtist", "genre"] as const) {
      if (previous[field] !== row[field]) previous[field] = null;
    }
    previous.lastDate = lastDate(previous.lastDate, row.lastDate);
  }
  const rows = [...grouped.values()].sort((a, b) => {
    const left = envelope.source === "library" ? a.libraryPlayCount : a.activityRecords;
    const right = envelope.source === "library" ? b.libraryPlayCount : b.activityRecords;
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    return (right ?? 0) - (left ?? 0) || exactCompare(a.label, b.label) || exactCompare(a.id, b.id);
  });
  return { rows, excludedRows };
}

function canSeed(artist: string): boolean {
  return artist.trim().length > 0 && artist.length <= 120 && !/[\u0000-\u001F\u007F]/.test(artist);
}

function suggestions(envelope: HistoryEnvelope, artists: HistoryRow[], now: number): HistorySuggestion[] {
  const result: HistorySuggestion[] = artists.filter(row => canSeed(row.label)).slice(0, 6).map(row => ({
    artist: row.label, kind: "top", basis: `${row.libraryPlayCount ?? row.activityRecords ?? "Unavailable"} ${metricLabel(envelope).toLowerCase()}.`,
  }));
  if (envelope.source !== "library") return result;
  const eligible = envelope.records.filter(track => track.artist !== null && canSeed(track.artist) &&
    track.playedCount !== null && track.playedCount > 0 && track.playedAt?.kind === "instant" &&
    dateNumber(track.playedAt) <= now - 90 * 86400000).sort((a, b) =>
    b.playedCount! - a.playedCount! || dateNumber(a.playedAt!) - dateNumber(b.playedAt!) || exactCompare(identity(a, "tracks")!, identity(b, "tracks")!));
  const older = eligible[0];
  if (older) {
    const aggregateCount = artists.find(row => row.label === older.artist)!.libraryPlayCount;
    const card: HistorySuggestion = { artist: older.artist!, kind: "older-favorite",
      basis: `${aggregateCount} library play count for artist; ${older.playedCount} for ${older.title ?? "Unknown title"}; last played ${older.playedAt!.value}.` };
    const existing = result.findIndex(suggestion => suggestion.artist === card.artist);
    if (existing >= 0) result[existing] = card;
    else { if (result.length === 6) result.pop(); result.push(card); }
  }
  return result;
}

function summary(envelope: HistoryEnvelope, now: number): HistorySourceSummary {
  const artists = ranking(envelope, "artists").rows;
  const tracks = ranking(envelope, "tracks").rows;
  const coverage: HistoryCoverage = { ...envelope.coverage, missing: { ...envelope.coverage.missing },
    availableFields: [...envelope.coverage.availableFields], warnings: [...envelope.coverage.warnings] };
  if (envelope.source === "library") {
    // Reclassify saved snapshots too, without requiring another Music scan.
    coverage.warnings = coverage.warnings.filter(warning => !/^(playedAt|skippedAt|artist|albumArtist|album|genre) unavailable for \d+ library tracks\.$/.test(warning));
    const missingMetadata = envelope.records.filter(track => [track.artist, track.albumArtist, track.album, track.genre].some(value => value === null)).length;
    if (missingMetadata) coverage.warnings.push(`Music supplied incomplete artist, album artist, album or genre metadata for ${missingMetadata} library entries. These entries are kept. Rankings use the metadata Music supplied.`);
    for (const [countField, dateField, label] of [["playedCount", "playedAt", "plays"], ["skippedCount", "skippedAt", "skips"]] as const) {
      const count = envelope.records.filter(track => (track[countField] ?? 0) > 0 && track[dateField] === null).length;
      if (count) coverage.warnings.push(`Music reports ${label} but no last ${label === "plays" ? "played" : "skipped"} date for ${count} library entries. Their counts are included; their dates remain unavailable.`);
    }
    for (const field of ["playedCount", "skippedCount", "favorite"] as const) {
      const missing = envelope.records.filter(track => track[field] === null).length;
      const warning = `${field} unavailable for ${missing} library tracks.`;
      if (missing && !coverage.warnings.includes(warning)) coverage.warnings.push(warning);
    }
  } else if (envelope.profile !== "recently-played" && coverage.missing.reportedDurationMs) {
    coverage.warnings.push(`Reported play duration unavailable for ${coverage.missing.reportedDurationMs} records; duration totals include only supplied values.`);
  }
  return {
    source: envelope.source, savedAt: envelope.source === "library" ? envelope.capturedAt : envelope.importedAt,
    profile: envelope.source === "export" ? envelope.profile : null, metricLabel: metricLabel(envelope), coverage,
    totals: { tracks: tracks.length, artists: artists.length, albums: ranking(envelope, "albums").rows.length,
      libraryPlayCount: availableSum(tracks.map(row => row.libraryPlayCount)),
      activityRecords: envelope.source === "export" ? envelope.records.length : null,
      reportedDurationMs: availableSum(tracks.map(row => row.reportedDurationMs)),
      skippedCount: availableSum(tracks.map(row => row.skippedCount)), favoriteTracks: availableSum(tracks.map(row => row.favoriteTracks)) },
    suggestions: suggestions(envelope, artists, now), trendsAvailable: envelope.source === "export" && envelope.profile !== "recently-played",
  };
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  if (!timeZone || timeZone.length > 100 || /^[+-]/.test(timeZone)) throw new Error("An explicit IANA time zone is required.");
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, calendar: "gregory", numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", era: "short" });
  } catch {
    throw new Error("Invalid IANA time zone.");
  }
}

function calendarYear(year: number): string {
  return year >= 0 && year <= 9999 ? String(year).padStart(4, "0") : `${year < 0 ? "-" : "+"}${String(Math.abs(year)).padStart(6, "0")}`;
}

function trends(envelope: HistoryEnvelope, kind: HistoryKind, timeZone: string): { rows: HistoryRow[]; excludedRows: number } {
  if (envelope.source !== "export" || envelope.profile === "recently-played") throw new Error("Activity trends are unavailable for this history source.");
  const dates = formatter(timeZone);
  const grouped = new Map<string, HistoryRow>();
  let excludedRows = 0;
  for (const record of envelope.records) {
    const date = record.date;
    if (!date || date.kind === "unresolved" || kind === "hourly" && date.kind !== "instant") { excludedRows++; continue; }
    let calendar = date.value;
    let hour = "";
    if (date.kind === "instant") {
      const parts = Object.fromEntries(dates.formatToParts(new Date(date.value)).map(part => [part.type, part.value]));
      const year = parts.era === "BC" ? 1 - Number(parts.year) : Number(parts.year);
      calendar = `${calendarYear(year)}-${parts.month}-${parts.day}`;
      hour = String(Number(parts.hour));
    }
    const label = kind === "hourly" ? hour : kind === "monthly" ? calendar.slice(0, -3) : calendar;
    const previous = grouped.get(label);
    if (previous) {
      previous.activityRecords!++;
      previous.reportedDurationMs = availableSum([previous.reportedDurationMs, record.reportedDurationMs]);
      previous.lastDate = lastDate(previous.lastDate, date);
    } else {
      grouped.set(label, { id: JSON.stringify([kind, label]), label, artist: null, album: null, albumArtist: null, genre: null,
        libraryPlayCount: null, activityRecords: 1, reportedDurationMs: record.reportedDurationMs,
        skippedCount: null, favoriteTracks: null, lastDate: date });
    }
  }
  const rows = [...grouped.values()].sort((a, b) => kind === "hourly" ? Number(a.label) - Number(b.label) :
    dateNumber({ kind: "date", value: kind === "monthly" ? `${a.label}-01` : a.label }) -
    dateNumber({ kind: "date", value: kind === "monthly" ? `${b.label}-01` : b.label }));
  return { rows, excludedRows };
}

export function summarizeHistory(envelopes: readonly HistoryEnvelope[], query: HistoryQuery, now: number): HistoryResponse {
  const sources = envelopes.map(envelope => summary(envelope, now));
  const preferredSource = query.source ?? sources.find(source => source.source === "export" && source.suggestions.length)?.source ??
    sources.find(source => source.source === "library")?.source ?? sources[0]?.source ?? null;
  if (preferredSource === null) return { sources, preferredSource, page: null };
  const envelope = envelopes.find(source => source.source === preferredSource);
  if (!envelope) throw Object.assign(new Error("Selected history source is unavailable."), { status: 404 });
  const kind = query.kind ?? "artists";
  const isTrend = kind === "daily" || kind === "monthly" || kind === "hourly";
  const { rows, excludedRows } = isTrend ? trends(envelope, kind, query.timeZone) : ranking(envelope, kind);
  return { sources, preferredSource, page: { source: envelope.source, kind, offset: query.offset, limit: query.limit,
    total: rows.length, rows: rows.slice(query.offset, query.offset + query.limit), metricLabel: metricLabel(envelope), excludedRows, timeZone: isTrend ? query.timeZone : null } };
}

export function validateHistoryQuery(params: URLSearchParams): HistoryQuery {
  const allowed = ["source", "kind", "offset", "limit", "timeZone"];
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new Error("Unknown or duplicate history query parameter.");
  }
  const source = params.get("source");
  const kind = params.get("kind");
  if (source !== null && source !== "library" && source !== "export") throw new Error("Invalid history source.");
  if (kind !== null && !["artists", "albums", "tracks", "genres", "daily", "monthly", "hourly"].includes(kind)) throw new Error("Invalid history kind.");
  function integer(key: string, fallback: number, min: number, max: number): number {
    const value = params.get(key);
    if (value === null) return fallback;
    if (value.length > 6 || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`Invalid history ${key}.`);
    return Number(value);
  }
  const timeZone = params.get("timeZone") ?? "";
  formatter(timeZone);
  return { ...(source ? { source } : {}), ...(kind ? { kind: kind as HistoryKind } : {}),
    offset: integer("offset", 0, 0, HISTORY_LIMITS.exportRows), limit: integer("limit", HISTORY_LIMITS.pageSize, 1, HISTORY_LIMITS.maxPageSize), timeZone };
}
