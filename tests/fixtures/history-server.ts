import {createApp} from "../../src/server";
import {Store} from "../../src/store";
import type {LibraryReadResult} from "../../src/history-types";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
}

export function historyApp(options: {read?: () => Promise<LibraryReadResult>; open?: () => Promise<void>; now?: () => number} = {}) {
  const store = new Store(":memory:");
  const app = createApp({store, port: 8769, now: options.now, readLibraryHistory: options.read,
    discovery: {getGenres: async () => [], buildDraft: async () => ({tracks: [], warnings: []})},
    music: {getMusicStatus: async () => ({platform: "darwin", running: true, accessibility: true, automation: "granted", message: "Ready"}),
      inspectTracks: async tracks => ({newLibraryAdditions: tracks.length, existingLibrarySongs: 0, total: tracks.length}),
      ensurePlaylist: async name => ({id: "ABCDEF0123456789", name}),
      addTrackToPlaylist: async () => ({libraryId: "one", alreadyPresent: false}), openPlaylist: async () => {await options.open?.();}}});
  const headers = {host: "127.0.0.1:8769", origin: "http://127.0.0.1:8769", "x-wavelength-token": app.token};
  const request = (path: string, body?: unknown, changes: Record<string, string> = {}) => new Request(`http://127.0.0.1:8769${path}`, {
    method: body === undefined ? "GET" : "POST", headers: {...headers, "content-type": "application/json", ...changes},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  const csv = (bytes: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>, changes: Record<string, string> = {}) => new Request("http://127.0.0.1:8769/api/history/preview", {
    method: "POST", headers: {...headers, "content-type": "text/csv", ...changes}, body: bytes,
  });
  return {app, store, request, csv, dispose: () => {app.dispose(); store.close();}};
}
