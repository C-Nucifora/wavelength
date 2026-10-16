import {expect, test} from "bun:test";
import type {LibraryReadResult} from "../src/history-types";
import {historyApp, deferred} from "./fixtures/history-server";
import {libraryTrack, savedLibrary} from "./fixtures/history";
import {createApp} from "../src/server";
import {Store} from "../src/store";
import type {DraftTrack} from "../src/types";

const bytes = (text = "Song Name,Event End Timestamp\nSong,") => new TextEncoder().encode(text);
const track: DraftTrack = {id: "one", catalogId: 1, artistId: 2, title: "Song", artist: "Artist", album: "Album", durationMs: 120000, releaseDate: "2026-01-01", url: "https://music.apple.com/", source: "test", match: "exact", provenance: {kind: "unknown", evidence: []}, selected: true};
const selection = {draftId: "draft", trackIds: ["one"], includeAI: false};
function ready(store: Store) {
  store.put("draft", "draft", {id: "draft", status: "ready", tracks: [track], request: {includeAI: false}});
  store.put("job", "saved", {id: "saved", state: "complete", playlistId: "ABCDEF0123456789"});
}

test("history reads require a token and CSV exception stays narrow", async () => {
  const fixture = historyApp();
  try {
    expect((await fixture.app.fetch(fixture.request("/api/history?timeZone=UTC", undefined, {"x-wavelength-token": ""}))).status).toBe(403);
    expect((await fixture.app.fetch(fixture.csv(bytes()))).status).toBe(200);
    expect((await fixture.app.fetch(fixture.request("/api/drafts", {}, {"content-type": "text/csv"}))).status).toBe(403);
    expect((await fixture.app.fetch(fixture.request("/api/history/preview", {path: "/private/export.csv"}))).status).toBe(415);
  } finally {fixture.dispose();}
});

test("every history route checks token, Host and supplied Origin", async () => {
  const fixture = historyApp();
  try {
    for (const path of ["/api/history?timeZone=UTC", "/api/history/library", "/api/history/import", "/api/history/forget", "/api/history/preview"]) {
      for (const changes of [{"x-wavelength-token": ""}, {"x-wavelength-token": "wrong"}, {host: "evil.test:8769"}, {origin: "https://evil.test"}] as Record<string, string>[]) {
        const request = path.endsWith("preview") ? fixture.csv(bytes(), changes) : fixture.request(path, path.startsWith("/api/history?") ? undefined : {}, changes);
        expect((await fixture.app.fetch(request)).status).toBe(403);
      }
    }
    const native = fixture.request("/api/history?timeZone=UTC");
    native.headers.delete("origin");
    expect((await fixture.app.fetch(native)).status).toBe(200);
    expect((await fixture.app.fetch(fixture.request("/api/session", undefined, {"x-wavelength-token": ""}))).status).toBe(200);
  } finally {fixture.dispose();}
});

test("raw CSV accepts only UTF-8 text/csv on the exact preview route", async () => {
  const fixture = historyApp();
  try {
    expect((await fixture.app.fetch(fixture.csv(bytes(), {"content-type": "text/csv; charset=UTF-8"}))).status).toBe(200);
    for (const type of ["application/json", "multipart/form-data", "text/plain", "text/csv; charset=utf-16", "text/csv; extra=yes", "text/csvx"]) {
      expect((await fixture.app.fetch(fixture.csv(bytes(), {"content-type": type}))).status).toBe(415);
    }
    expect((await fixture.app.fetch(fixture.request("/api/history/preview/extra", {}, {"content-type": "text/csv"}))).status).toBe(403);
    for (const path of ["/api/history/library", "/api/history/forget", "/api/history/import"]) {
      expect((await fixture.app.fetch(fixture.request(path, {path: "/private/file.csv"}))).status).toBe(400);
    }
    expect((await fixture.app.fetch(fixture.request("/api/history/import", {token: "fake", replace: "yes"}))).status).toBe(400);
    expect((await fixture.app.fetch(fixture.request("/api/history/import", {token: "fake"}))).status).toBe(400);
  } finally {fixture.dispose();}
});

test("saved history is paginated and contains no raw records", async () => {
  const fixture = historyApp({read: async () => ({complete: true, declaredTrackCount: 120, warnings: [], tracks: Array.from({length: 120}, (_, n) => libraryTrack({id: n.toString(16).padStart(16, "0"), artist: `Artist ${n}`}))})});
  try {
    const scan = await fixture.app.fetch(fixture.request("/api/history/library", {}));
    expect(scan.status).toBe(200);
    const result = await scan.json();
    expect(result.page.rows.length).toBe(50);
    expect(result.sources[0].totals.libraryPlayCount).toBe(360);
    expect(JSON.stringify(result)).not.toContain('"records"');
    const page = await (await fixture.app.fetch(fixture.request("/api/history?timeZone=Australia%2FBrisbane&limit=100&offset=100"))).json();
    expect(page.page).toMatchObject({offset: 100, limit: 100, total: 120});
    expect(page.page.rows.length).toBe(20);
    for (const query of ["", "timeZone=UTC&limit=101", "timeZone=UTC&path=/private/file", "timeZone=UTC&timeZone=UTC", "timeZone=UTC&source=unknown"]) {
      expect((await fixture.app.fetch(fixture.request(`/api/history?${query}`))).status).toBe(400);
    }
    expect((await fixture.app.fetch(fixture.request("/api/history?timeZone=UTC&source=export"))).status).toBe(404);
    expect((await fixture.app.fetch(fixture.request("/api/history?timeZone=UTC&kind=daily"))).status).toBe(400);
  } finally {fixture.dispose();}
});

test("export confirmation replaces records once and expiry requires a new preview", async () => {
  let now = 0;
  const fixture = historyApp({now: () => now});
  try {
    const first = await (await fixture.app.fetch(fixture.csv(bytes()))).json();
    expect(first.replacesExport).toBe(false);
    expect((await fixture.app.fetch(fixture.request("/api/history/import", {token: first.token, replace: false}))).status).toBe(200);
    const second = await (await fixture.app.fetch(fixture.csv(bytes()))).json();
    expect(second.replacesExport).toBe(true);
    const old = fixture.store.history();
    expect((await fixture.app.fetch(fixture.request("/api/history/import", {token: second.token, replace: false}))).status).toBe(409);
    expect(fixture.store.history()).toEqual(old);
    expect((await fixture.app.fetch(fixture.request("/api/history/import", {token: second.token, replace: true}))).status).toBe(200);
    expect(fixture.store.history()[0]!.records.length).toBe(1);
    const expired = await (await fixture.app.fetch(fixture.csv(bytes()))).json();
    now = 600000;
    expect((await fixture.app.fetch(fixture.request("/api/history/import", {token: expired.token, replace: true}))).status).toBe(409);
    expect(fixture.store.history()[0]!.records.length).toBe(1);
  } finally {fixture.dispose();}
});

test("failed scans preserve history and release the Music lease", async () => {
  let fail = true;
  const fixture = historyApp({read: async () => {
    if (fail) throw new Error("Synthetic denied or timed-out scan");
    return {complete: true, declaredTrackCount: 1, tracks: [libraryTrack({title: "New"})], warnings: []};
  }});
  try {
    const old = savedLibrary([libraryTrack()]);
    fixture.store.replaceHistory(old);
    expect((await fixture.app.fetch(fixture.request("/api/history/library", {}))).status).toBe(400);
    expect(fixture.store.history()).toEqual([old]);
    fail = false;
    expect((await fixture.app.fetch(fixture.request("/api/history/library", {}))).status).toBe(200);
    expect(fixture.store.history()[0]!.records[0]!.title).toBe("New");
  } finally {fixture.dispose();}
});

test("missing library adapter reports an explicit unavailable error", async () => {
  const fixture = historyApp();
  try {
    const response = await fixture.app.fetch(fixture.request("/api/history/library", {}));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("unavailable");
  } finally {fixture.dispose();}
});

test("rejected aggregate import preserves the prior report and current token", async () => {
  const fixture = historyApp();
  try {
    const first = await (await fixture.app.fetch(fixture.csv(bytes()))).json();
    await fixture.app.fetch(fixture.request("/api/history/import", {token: first.token, replace: false}));
    const old = fixture.store.history();
    const huge = "1" + "0".repeat(308);
    const preview = await (await fixture.app.fetch(fixture.csv(bytes(`Song Name,Event End Timestamp,Play Duration Milliseconds\nNew,,${huge}\nOther,,${huge}`)))).json();
    for (let n = 0; n < 2; n++) {
      const response = await fixture.app.fetch(fixture.request("/api/history/import", {token: preview.token, replace: true}));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("overflow");
      expect(fixture.store.history()).toEqual(old);
    }
  } finally {fixture.dispose();}
});

test("incomplete and aggregate-overflow scans cannot replace the prior report", async () => {
  let result: unknown = {complete: false, declaredTrackCount: 1, tracks: [libraryTrack()], warnings: []};
  const fixture = historyApp({read: async () => result as LibraryReadResult});
  try {
    const old = savedLibrary([libraryTrack()]);
    fixture.store.replaceHistory(old);
    expect((await fixture.app.fetch(fixture.request("/api/history/library", {}))).status).toBe(400);
    expect(fixture.store.history()).toEqual([old]);
    result = {complete: true, declaredTrackCount: 2, tracks: [libraryTrack({playedCount: 1e308}), libraryTrack({id: "0000000000000002", playedCount: 1e308})], warnings: []};
    expect((await fixture.app.fetch(fixture.request("/api/history/library", {}))).status).toBe(400);
    expect(fixture.store.history()).toEqual([old]);
  } finally {fixture.dispose();}
});

test("CSV stream limits cancel producers and preserve saved data", async () => {
  const fixture = historyApp();
  try {
    fixture.store.replaceHistory(savedLibrary([libraryTrack()]));
    const old = fixture.store.history();
    for (const chunks of [[new Uint8Array(20 * 1024 * 1024 + 1)], [bytes('Song Name,Event End Timestamp\n"' + "x".repeat(2000)), bytes("x".repeat(2001) + '",')], [bytes("Song Name,Event End Timestamp\n" + "Song,\n".repeat(100001))]]) {
      let cancelled = false;
      const pending = [...chunks];
      const stream = new ReadableStream<Uint8Array>({pull(controller) {const chunk = pending.shift(); if (chunk) controller.enqueue(chunk);}, cancel() {cancelled = true;}});
      expect((await fixture.app.fetch(fixture.csv(stream))).status).toBe(413);
      expect(cancelled).toBe(true);
      expect(stream.locked).toBe(false);
      expect(fixture.store.history()).toEqual(old);
    }
    for (const length of ["-1", "Infinity", "1.5", "NaN"]) expect((await fixture.app.fetch(fixture.csv(bytes(), {"content-length": length}))).status).toBe(400);
    expect((await fixture.app.fetch(fixture.csv(bytes(), {"content-length": String(20 * 1024 * 1024 + 1)}))).status).toBe(413);
  } finally {fixture.dispose();}
});

test("chunked JSON retains the 128 KiB application limit", async () => {
  const fixture = historyApp();
  try {
    const stream = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(bytes(JSON.stringify({data: "x".repeat(131073)}))); controller.close();}});
    const request = fixture.request("/api/drafts", {});
    expect((await fixture.app.fetch(new Request(request.url, {method: "POST", headers: request.headers, body: stream}))).status).toBe(413);
  } finally {fixture.dispose();}
});

test("forget clears only history and pending preview tokens", async () => {
  const fixture = historyApp();
  try {
    ready(fixture.store);
    fixture.store.put("provenance", "one", {kind: "unknown"});
    fixture.store.replaceHistory(savedLibrary([libraryTrack()]));
    const preview = await (await fixture.app.fetch(fixture.csv(bytes()))).json();
    expect((await fixture.app.fetch(fixture.request("/api/history/forget", {}))).status).toBe(200);
    expect(fixture.store.history()).toEqual([]);
    expect((await fixture.app.fetch(fixture.request("/api/history/import", {token: preview.token, replace: true}))).status).toBe(409);
    for (const [kind, id] of [["draft", "draft"], ["job", "saved"], ["provenance", "one"]]) expect(fixture.store.get(kind!, id!)).toBeDefined();
  } finally {fixture.dispose();}
});

test("new previews supersede older completion and disposal rejects late writes", async () => {
  const fixture = historyApp();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({start(value) {controller = value;}});
  try {
    const old = fixture.app.fetch(fixture.csv(stream));
    const current = await (await fixture.app.fetch(fixture.csv(bytes()))).json();
    controller.enqueue(bytes()); controller.close();
    expect((await old).status).toBe(409);
    fixture.app.dispose();
    expect((await fixture.app.fetch(fixture.request("/api/history/import", {token: current.token, replace: true}))).status).toBe(409);
  } finally {fixture.dispose();}
  const read = deferred<LibraryReadResult>();
  const late = historyApp({read: () => read.promise});
  const scan = late.app.fetch(late.request("/api/history/library", {}));
  await Bun.sleep(0);
  late.dispose();
  read.resolve({complete: true, declaredTrackCount: 1, tracks: [libraryTrack()], warnings: []});
  expect((await scan).status).toBe(409);
  const parsing = historyApp();
  let closing!: ReadableStreamDefaultController<Uint8Array>;
  const pending = parsing.app.fetch(parsing.csv(new ReadableStream<Uint8Array>({start(value) {closing = value;}})));
  parsing.dispose();
  closing.enqueue(bytes()); closing.close();
  expect((await pending).status).toBe(409);
});

test("a new app instance cannot consume another app's token", async () => {
  const first = historyApp(); const second = historyApp();
  try {
    const preview = await (await first.app.fetch(first.csv(bytes()))).json();
    expect((await second.app.fetch(second.request("/api/history/import", {token: preview.token, replace: false}))).status).toBe(409);
    expect(second.store.history()).toEqual([]);
  } finally {first.dispose(); second.dispose();}
});

test.each(["scan", "open"] as const)("pending %s excludes scans, preflights, open, creation and retry", async operation => {
  const waiting = deferred<void>(); const entered = deferred<void>();
  const fixture = historyApp({read: async () => {entered.resolve(); await waiting.promise; return {complete: true, declaredTrackCount: 1, tracks: [libraryTrack()], warnings: []};}, open: async () => {entered.resolve(); await waiting.promise;}});
  ready(fixture.store);
  try {
    const pending = fixture.app.fetch(fixture.request(operation === "scan" ? "/api/history/library" : "/api/jobs/saved/open", {}));
    await entered.promise;
    for (const [path, body] of [["/api/history/library", {}], ["/api/preflight", selection], ["/api/jobs/saved/open", {}], ["/api/jobs", {...selection, name: "Test"}], ["/api/jobs/saved/retry", {}]] as const) expect((await fixture.app.fetch(fixture.request(path, body))).status).toBe(409);
    waiting.resolve();
    expect((await pending).status).toBe(200);
  } finally {waiting.resolve(); fixture.dispose();}
});

test("failed playlist open releases its lease", async () => {
  const fixture = historyApp({open: async () => {throw new Error("Synthetic open failure");}, read: async () => ({complete: true, declaredTrackCount: 1, tracks: [libraryTrack()], warnings: []})});
  ready(fixture.store);
  try {
    expect((await fixture.app.fetch(fixture.request("/api/jobs/saved/open", {}))).status).toBe(400);
    expect((await fixture.app.fetch(fixture.request("/api/history/library", {}))).status).toBe(200);
  } finally {fixture.dispose();}
});

test.each(["preflight", "job"] as const)("pending %s excludes Music operations through cancellation", async operation => {
  const store = new Store(":memory:"); const waiting = deferred<void>(); const entered = deferred<void>();
  const pause = async () => {entered.resolve(); await waiting.promise;};
  const app = createApp({store, port: 8769, readLibraryHistory: async () => ({complete: true, declaredTrackCount: 1, tracks: [libraryTrack()], warnings: []}),
    discovery: {getGenres: async () => [], buildDraft: async () => ({tracks: [], warnings: []})},
    music: {getMusicStatus: async () => {throw new Error("unused");}, inspectTracks: async () => {await pause(); return {newLibraryAdditions: 1, existingLibrarySongs: 0, total: 1};}, ensurePlaylist: async name => ({id: "ABCDEF0123456789", name}), addTrackToPlaylist: async () => {await pause(); return {libraryId: "one", alreadyPresent: false};}, openPlaylist: async () => {}}});
  const request = (path: string, body: unknown) => new Request(`http://127.0.0.1:8769${path}`, {method: "POST", headers: {host: "127.0.0.1:8769", origin: "http://127.0.0.1:8769", "content-type": "application/json", "x-wavelength-token": app.token}, body: JSON.stringify(body)});
  ready(store);
  try {
    const pending = operation === "preflight" ? app.fetch(request("/api/preflight", selection)) : undefined;
    const job = operation === "job" ? app.jobs.create("Test", [track]) : undefined;
    await entered.promise;
    if (job) expect((await app.fetch(request(`/api/jobs/${job.id}/cancel`, {}))).status).toBe(200);
    for (const [path, body] of [["/api/history/library", {}], ["/api/preflight", selection], ["/api/jobs/saved/open", {}]] as const) expect((await app.fetch(request(path, body))).status).toBe(409);
    if (pending) {
      for (const [path, body] of [["/api/jobs", {...selection, name: "Test"}], ["/api/jobs/saved/retry", {}]] as const) expect((await app.fetch(request(path, body))).status).toBe(409);
    }
    waiting.resolve();
    if (pending) expect((await pending).status).toBe(200);
    while (app.jobs.isActive()) await Bun.sleep(0);
    expect((await app.fetch(request("/api/history/library", {}))).status).toBe(200);
  } finally {waiting.resolve(); app.dispose(); store.close();}
});

test("failed preflight releases its lease for the next scan", async () => {
  const store = new Store(":memory:");
  const app = createApp({store, port: 8769, readLibraryHistory: async () => ({complete: true, declaredTrackCount: 1, tracks: [libraryTrack()], warnings: []}),
    discovery: {getGenres: async () => [], buildDraft: async () => ({tracks: [], warnings: []})},
    music: {getMusicStatus: async () => {throw new Error("unused");}, inspectTracks: async () => {throw new Error("Synthetic inspection failure");}, ensurePlaylist: async name => ({id: "ABCDEF0123456789", name}), addTrackToPlaylist: async () => ({libraryId: "one", alreadyPresent: false}), openPlaylist: async () => {}}});
  const request = (path: string, body: unknown) => new Request(`http://127.0.0.1:8769${path}`, {method: "POST", headers: {host: "127.0.0.1:8769", origin: "http://127.0.0.1:8769", "content-type": "application/json", "x-wavelength-token": app.token}, body: JSON.stringify(body)});
  ready(store);
  try {
    expect((await app.fetch(request("/api/preflight", selection))).status).toBe(400);
    expect((await app.fetch(request("/api/history/library", {}))).status).toBe(200);
  } finally {app.dispose(); store.close();}
});

test("forget wins over a delayed explicit scan", async () => {
  const waiting = deferred<LibraryReadResult>();
  const fixture = historyApp({read: () => waiting.promise});
  try {
    const scan = fixture.app.fetch(fixture.request("/api/history/library", {}));
    await Bun.sleep(0);
    expect((await fixture.app.fetch(fixture.request("/api/history/forget", {}))).status).toBe(200);
    waiting.resolve({complete: true, declaredTrackCount: 1, tracks: [libraryTrack()], warnings: []});
    expect((await scan).status).toBe(409);
    expect(fixture.store.history()).toEqual([]);
  } finally {fixture.dispose();}
});
