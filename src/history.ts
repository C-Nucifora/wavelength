import { HISTORY_LIMITS } from "./history-types";
import type { ExportRecord, HistoryCoverage, HistoryDate, LibraryEnvelope, LibraryReadResult, LibraryTrack, ParsedExport } from "./history-types";

const profiles = [
  { id: "play-activity", required: ["song name", "event end timestamp"], album: "album name",
    artist: "artist", reported: "play duration milliseconds", media: "media duration in milliseconds" },
  { id: "daily-tracks", required: ["track description", "date played"], album: "container description",
    artist: null, reported: "play duration milliseconds", media: null },
  { id: "recently-played", required: ["track description", "last event end timestamp"], album: "container description",
    artist: null, reported: null, media: "media duration in millis" },
] as const;

export function parseHistoryDate(value: string): HistoryDate | null {
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?)?$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) return null;
  if (match[4] === undefined) return { kind: "date", value: text };
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return null;
  const zone = match[8];
  if (!zone) return { kind: "unresolved", value: text };
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return null;
  const instant = new Date(text);
  return Number.isFinite(instant.getTime()) ? { kind: "instant", value: instant.toISOString() } : null;
}

function boundedText(value: string): void {
  let characters = 0;
  for (const _character of value) {
    if (++characters > HISTORY_LIMITS.fieldCharacters) throw new Error("History fields exceed 4,000 characters.");
  }
}

function nullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  boundedText(value);
  return value.trim() ? value : null;
}

function nonnegative(value: unknown, integer = false): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && (!integer || Number.isInteger(value)) ? value : null;
}

function libraryDate(value: unknown): HistoryDate | null {
  if (typeof value === "string") { boundedText(value); return parseHistoryDate(value); }
  if (!value || typeof value !== "object") return null;
  const date = value as Record<string, unknown>;
  if (typeof date.value !== "string") return null;
  boundedText(date.value);
  const parsed = parseHistoryDate(date.value);
  return parsed?.kind === date.kind ? parsed : null;
}

export function normalizeLibraryRead(value: unknown): LibraryReadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid library response.");
  const input = value as Record<string, unknown>;
  if (input.complete !== true || !Array.isArray(input.tracks)) throw new Error("Library scan is incomplete.");
  if (input.tracks.length > HISTORY_LIMITS.libraryTracks) throw new Error("Library exceeds 50,000 tracks.");
  if (!Number.isInteger(input.declaredTrackCount) || input.declaredTrackCount !== input.tracks.length) throw new Error("Library track count does not match the complete scan.");
  const ids = new Set<string>();
  const missing = new Map<string, number>();
  const tracks = input.tracks.map((value: unknown): LibraryTrack => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid library track.");
    const track = value as Record<string, unknown>;
    for (const property of Object.values(track)) if (typeof property === "string") boundedText(property);
    if (typeof track.id !== "string" || !/^[A-Fa-f0-9]{16}$/.test(track.id)) throw new Error("Invalid library persistent ID.");
    const id = track.id.toUpperCase();
    if (ids.has(id)) throw new Error("Duplicate library persistent ID.");
    ids.add(id);
    const normalized: LibraryTrack = {
      id, title: nullableText(track.title), artist: nullableText(track.artist), albumArtist: nullableText(track.albumArtist),
      album: nullableText(track.album), genre: nullableText(track.genre), durationMs: nonnegative(track.durationMs),
      playedCount: nonnegative(track.playedCount, true), playedAt: libraryDate(track.playedAt),
      skippedCount: nonnegative(track.skippedCount, true), skippedAt: libraryDate(track.skippedAt), addedAt: libraryDate(track.addedAt),
      favorite: typeof track.favorite === "boolean" ? track.favorite : null,
    };
    for (const [field, property] of Object.entries(normalized)) {
      if (property === null) missing.set(field, (missing.get(field) || 0) + 1);
    }
    return normalized;
  });
  const warnings = [...missing].map(([field, count]) => `${field} unavailable for ${count} library tracks.`);
  // Known missing-field notices already appear above. Keep unknown bridge text private.
  if (Array.isArray(input.warnings)) {
    const unknownWarnings = input.warnings.reduce((count: number, warning: unknown) => {
      if (typeof warning === "string" && warnings.includes(warning)) return count;
      const aggregate = typeof warning === "string" ? /^Library scan reported ([1-9]\d*) warnings\.$/.exec(warning) : null;
      const value = aggregate ? Number(aggregate[1]) : 1;
      return Math.min(Number.MAX_SAFE_INTEGER, count + (Number.isSafeInteger(value) ? value : 1));
    }, 0);
    if (unknownWarnings) warnings.push(`Library scan reported ${unknownWarnings} warnings.`);
  }
  return { complete: true, declaredTrackCount: tracks.length, tracks, warnings };
}

function emptyCoverage(availableFields: string[] = [], warnings: string[] = []): HistoryCoverage {
  return {
    inputRows: 0, acceptedRows: 0, rejectedRows: 0,
    missing: { artist: 0, album: 0, genre: 0, date: 0, reportedDurationMs: 0, mediaDurationMs: 0 },
    firstDate: null, lastDate: null, datedRows: 0, instantRows: 0, durationRows: 0,
    enrichedRows: 0, unmatchedRows: 0, availableFields, warnings: [...warnings],
  };
}

function compareDates(left: HistoryDate, right: HistoryDate): number {
  if (left.kind === "instant" && right.kind === "instant") return Date.parse(left.value) - Date.parse(right.value);
  const a = /^([+-]?\d+)-(\d{2})-(\d{2})/.exec(left.value)!;
  const b = /^([+-]?\d+)-(\d{2})-(\d{2})/.exec(right.value)!;
  for (let component = 1; component <= 3; component++) {
    const difference = Number(a[component]) - Number(b[component]);
    if (difference) return difference;
  }
  return 0;
}

function observeDate(coverage: HistoryCoverage, date: HistoryDate | null): void {
  if (!date) { coverage.missing.date++; return; }
  if (date.kind === "unresolved") return;
  coverage.datedRows++;
  if (date.kind === "instant") coverage.instantRows++;
  if (!coverage.firstDate || compareDates(date, coverage.firstDate) < 0) coverage.firstDate = date;
  if (!coverage.lastDate || compareDates(date, coverage.lastDate) > 0) coverage.lastDate = date;
}

export function libraryEnvelope(result: LibraryReadResult, capturedAt: string): LibraryEnvelope {
  const coverage = emptyCoverage([
    "title", "artist", "albumArtist", "album", "genre", "durationMs", "playedCount", "playedAt", "skippedCount", "skippedAt", "addedAt", "favorite",
  ], result.warnings);
  coverage.inputRows = coverage.acceptedRows = result.tracks.length;
  coverage.missing.reportedDurationMs = result.tracks.length;
  const unresolved = { playedAt: 0, skippedAt: 0, addedAt: 0 };
  for (const track of result.tracks) {
    for (const field of ["artist", "album", "genre"] as const) if (track[field] === null) coverage.missing[field]++;
    if (track.durationMs === null) coverage.missing.mediaDurationMs++;
    observeDate(coverage, track.playedAt);
    for (const field of ["playedAt", "skippedAt", "addedAt"] as const) {
      if (track[field]?.kind === "unresolved") unresolved[field]++;
    }
  }
  for (const [field, count] of Object.entries(unresolved)) {
    if (count) coverage.warnings.push(`${count} library ${field} dates are unzoned and unresolved.`);
  }
  return { schemaVersion: 1, source: "library", capturedAt, records: result.tracks, coverage };
}

function decimalDuration(value: string | null): number | null {
  return value !== null && /^\d+(?:\.\d+)?$/.test(value.trim()) ? nonnegative(Number(value)) : null;
}

function enrichmentIndex(library: readonly LibraryTrack[]): Map<string, Map<string, LibraryTrack>> {
  const index = new Map<string, Map<string, LibraryTrack>>();
  for (const track of library) {
    const title = track.title?.trim(), album = track.album?.trim();
    if (!title || !album) continue;
    const key = JSON.stringify([title, album]);
    let matches = index.get(key);
    if (!matches) { matches = new Map(); index.set(key, matches); }
    const identity = JSON.stringify([track.id.toUpperCase(), track.artist?.trim() || null, track.albumArtist?.trim() || null]);
    matches.set(identity, track);
  }
  return index;
}

export async function parseAppleCSV(chunks: AsyncIterable<Uint8Array>, library: readonly LibraryTrack[] = []): Promise<ParsedExport> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const index = enrichmentIndex(library);
  const records: ExportRecord[] = [];
  const coverage = emptyCoverage();
  let profile: typeof profiles[number] | undefined;
  let headers: string[] | undefined;
  let state: "field" | "quoted" | "afterQuote" = "field";
  let pendingCR = false, rowStarted = false, firstCharacter = true;
  let bytes = 0, characters = 0, field = "";
  let row: string[] = [];
  let unresolved = 0;

  function append(character: string): void {
    if (++characters > HISTORY_LIMITS.fieldCharacters) throw new Error("CSV field exceeds 4,000 characters.");
    field += character;
  }
  function finishField(): void {
    row.push(field); field = ""; characters = 0; state = "field";
  }
  function finishRow(): void {
    finishField();
    if (!headers) {
      headers = row.map((header, position) => (position === 0 ? header.replace(/^\uFEFF/, "") : header).trim().toLowerCase());
      if (new Set(headers).size !== headers.length) throw new Error("Duplicate CSV headers.");
      const matched = profiles.filter(profile => profile.required.every(header => headers!.includes(header)));
      if (matched.length !== 1) throw new Error("Unsupported CSV format. Recognised profiles: Play activity, Daily tracks, Recently played.");
      profile = matched[0]!;
      coverage.availableFields = headers;
    } else {
      if (++coverage.inputRows > HISTORY_LIMITS.exportRows) throw new Error("CSV exceeds 100,000 data rows.");
      const blankRow = row.length === 1 && !row[0]!.trim();
      if (!blankRow && row.length !== headers.length) throw new Error("CSV row has mismatched columns.");
      const cell = (name: string | null): string | null => name === null ? null : nullableText(row[headers!.indexOf(name)]);
      const title = cell(profile!.required[0]);
      if (!title) coverage.rejectedRows++;
      else {
        const record: ExportRecord = {
          title, artist: cell(profile!.artist), album: cell(profile!.album), albumArtist: null, genre: null,
          date: parseHistoryDate(cell(profile!.required[1]) || ""), reportedDurationMs: decimalDuration(cell(profile!.reported)),
          mediaDurationMs: decimalDuration(cell(profile!.media)), enriched: [],
        };
        const matches = record.album ? index.get(JSON.stringify([record.title.trim(), record.album.trim()])) : undefined;
        if (matches?.size === 1) {
          const track = matches.values().next().value!;
          for (const field of ["artist", "album", "genre"] as const) {
            const value = nullableText(track[field]);
            if (record[field] === null && value !== null) { record[field] = value; record.enriched.push(field); }
          }
          record.albumArtist = nullableText(track.albumArtist);
        } else coverage.unmatchedRows++;
        if (record.enriched.length) coverage.enrichedRows++;
        for (const field of ["artist", "album", "genre", "reportedDurationMs", "mediaDurationMs"] as const) {
          if (record[field] === null) coverage.missing[field]++;
        }
        observeDate(coverage, record.date);
        if (record.date?.kind === "unresolved") unresolved++;
        if (record.reportedDurationMs !== null) coverage.durationRows++;
        coverage.acceptedRows++; records.push(record);
      }
    }
    row = []; rowStarted = false;
  }
  function consume(text: string): void {
    for (const character of text) {
      if (firstCharacter) { firstCharacter = false; if (character === "\uFEFF") continue; }
      if (pendingCR) { pendingCR = false; if (character === "\n") continue; }
      if (state === "quoted") {
        if (character === '"') state = "afterQuote";
        else append(character);
        continue;
      }
      if (state === "afterQuote" && character === '"') { append('"'); state = "quoted"; continue; }
      if (character === ",") { finishField(); rowStarted = true; }
      else if (character === "\r" || character === "\n") { finishRow(); pendingCR = character === "\r"; }
      else if (state === "afterQuote") throw new Error("Malformed CSV quoting after closing quote.");
      else if (character === '"') {
        if (field.length) throw new Error("Malformed CSV quote in unquoted field.");
        state = "quoted"; rowStarted = true;
      } else { append(character); rowStarted = true; }
    }
  }
  function decode(chunk?: Uint8Array): string {
    try { return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true }); }
    catch { throw new Error("CSV contains invalid or incomplete UTF-8."); }
  }
  function finish(): void {
    if (state === "quoted") throw new Error("Malformed CSV quoting: unclosed quote.");
    if (rowStarted) finishRow();
    if (!records.length) throw new Error("No supported records in CSV.");
    if (unresolved) coverage.warnings.push(`${unresolved} unzoned dates remain unresolved and are excluded from observed date bounds and hourly charts.`);
  }
  for await (const chunk of chunks) {
    bytes += chunk.byteLength;
    if (bytes > HISTORY_LIMITS.fileBytes) throw new Error("CSV exceeds 20 MiB.");
    consume(decode(chunk));
  }
  consume(decode());
  finish();
  return { profile: profile!.id, records, coverage };
}
