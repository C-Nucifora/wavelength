import { libraryEnvelope, parseAppleCSV } from "../../src/history";
import type { ExportEnvelope, LibraryEnvelope, LibraryTrack } from "../../src/history-types";

export async function exportEnvelope(text: string, importedAt = "2026-10-10T00:00:00.000Z"): Promise<ExportEnvelope> {
  return { schemaVersion: 1, source: "export", importedAt, ...await parseAppleCSV(csvChunks(text)) };
}

export function savedLibrary(tracks: LibraryTrack[], capturedAt = "2026-10-10T00:00:00.000Z"): LibraryEnvelope {
  return libraryEnvelope({ complete: true, declaredTrackCount: tracks.length, tracks, warnings: [] }, capturedAt);
}

export async function* csvChunks(text: string, chunkBytes = 17): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    yield bytes.subarray(offset, offset + chunkBytes);
  }
}

export function libraryTrack(overrides: Partial<LibraryTrack> = {}): LibraryTrack {
  return {
    id: "0000000000000001", title: "Song", artist: "Artist", albumArtist: "Artist",
    album: "Album", genre: "Electronic", durationMs: 120000, playedCount: 3,
    skippedCount: null, playedAt: null, skippedAt: null, addedAt: null, favorite: null,
    ...overrides,
  };
}
