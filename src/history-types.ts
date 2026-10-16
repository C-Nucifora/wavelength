export const HISTORY_LIMITS = {
  fileBytes: 20 * 1024 * 1024, exportRows: 100_000, libraryTracks: 50_000,
  fieldCharacters: 4_000, previewMs: 10 * 60_000, scanMs: 90_000,
  scanBufferBytes: 32 * 1024 * 1024, pageSize: 50, maxPageSize: 100,
} as const;

export type HistorySource = "library" | "export";
export type ExportProfile = "play-activity" | "daily-tracks" | "recently-played";
export type HistoryDate = { kind: "instant" | "date" | "unresolved"; value: string };
export type MetadataField = "artist" | "album" | "genre";
export type LibraryTrack = {
  id: string; title: string | null; artist: string | null;
  albumArtist: string | null; album: string | null; genre: string | null;
  durationMs: number | null; playedCount: number | null; playedAt: HistoryDate | null;
  skippedCount: number | null; skippedAt: HistoryDate | null; addedAt: HistoryDate | null;
  favorite: boolean | null;
};
export type ExportRecord = {
  title: string; artist: string | null; album: string | null;
  albumArtist: string | null; genre: string | null; date: HistoryDate | null;
  reportedDurationMs: number | null; mediaDurationMs: number | null; enriched: MetadataField[];
};
export type HistoryCoverage = {
  inputRows: number; acceptedRows: number; rejectedRows: number;
  missing: { artist: number; album: number; genre: number; date: number;
    reportedDurationMs: number; mediaDurationMs: number };
  firstDate: HistoryDate | null; lastDate: HistoryDate | null;
  datedRows: number; instantRows: number; durationRows: number;
  enrichedRows: number; unmatchedRows: number; availableFields: string[]; warnings: string[];
};
export type ParsedExport = { profile: ExportProfile; records: ExportRecord[]; coverage: HistoryCoverage };
export type LibraryReadResult = { complete: true; declaredTrackCount: number; tracks: LibraryTrack[]; warnings: string[] };
export type LibraryEnvelope = {
  schemaVersion: 1; source: "library"; capturedAt: string; records: LibraryTrack[]; coverage: HistoryCoverage;
};
export type ExportEnvelope = {
  schemaVersion: 1; source: "export"; importedAt: string; profile: ExportProfile;
  records: ExportRecord[]; coverage: HistoryCoverage;
};
export type HistoryEnvelope = LibraryEnvelope | ExportEnvelope;
export type HistoryPreview = {
  token: string; expiresAt: string; profile: ExportProfile;
  coverage: HistoryCoverage; replacesExport: boolean;
};

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
