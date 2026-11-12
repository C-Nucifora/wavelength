import {expect, test} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApp} from "../src/server";
import {Store} from "../src/store";
import {createWebMusicAdapter} from "../src/web-music";
import type {DraftTrack, MusicJob, Provenance} from "../src/types";
import type {ExportEnvelope, LibraryReadResult} from "../src/history-types";
import {deferred} from "./fixtures/history-server";
import {exportEnvelope, libraryTrack, savedLibrary} from "./fixtures/history";

// Round 2: actual routes/SQLite, synthetic Music only. Run serially under heavy.lock.
const track = (n: number): DraftTrack => ({id: String(n), catalogId: n, artistId: n,
  title: `Song ${n}`, artist: `Artist ${n}`, album: "Fixture", durationMs: 1000,
  releaseDate: "2026-01-01", url: "https://example.invalid", source: "fixture",
  match: "exact", selected: true, provenance: {kind: "unknown", evidence: []}});
const selection = {draftId: "draft", trackIds: ["1", "2"], includeAI: false};
const csv = (title = "Song") => `Song Name,Event End Timestamp,Album Name\n${title},,Album`;
const bytes = (text: string) => new TextEncoder().encode(text);
const library = (artist: string): LibraryReadResult => ({complete: true, declaredTrackCount: 1,
  tracks: [libraryTrack({artist, albumArtist: artist})], warnings: []});
type Invoke = NonNullable<Parameters<typeof createWebMusicAdapter>[0]>;
const good: Invoke = async input => {
  if (input.action === "status" || input.action === "rebindPlaylist") return {generation: "g1"};
  if (input.action === "inspectTracks") return {generation: input.generation, storefront: "au",
    total: input.catalogIds!.length, availableCatalogTracks: input.catalogIds!.length,
    unavailableCatalogTracks: 0, unavailableCatalogIds: []};
  if (input.action === "ensurePlaylist") return {id: "p.synthetic"};
  if (input.action === "addTrackToPlaylist") return {kind: "confirmed",
    catalogId: input.catalogIds![input.position!], alreadyPresent: true};
  if (input.action === "playlistCover") return {state: "blocked", code: "automation-permission", writeAttempted: false};
  throw new Error(`Unexpected synthetic action ${input.action}`);
};
const sentinel: MusicJob = {id: "sentinel", state: "complete", name: "Unrelated", tracks: [],
  message: "Keep", createdAt: "2026-01-01", updatedAt: "2026-01-01"};
function fixture(options: {read?: () => Promise<LibraryReadResult>; invoke?: Invoke} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "round2-history-"));
  const path = join(directory, "state.sqlite");
  const store = new Store(path);
  const connection = new Database(path);
  store.put("draft", "draft", {id: "draft", status: "ready", tracks: [track(1), track(2)], request: {mode: "genre", includeAI: false}});
  store.put("job", "sentinel", sentinel);
  store.put("provenance", "999", {kind: "human", evidence: ["unrelated"]});
  const makeApp = () => createApp({store, port: 8769, engineToken: crypto.randomUUID(),
    readLibraryHistory: options.read, music: createWebMusicAdapter(options.invoke || good),
    discovery: {getGenres: async () => [], buildDraft: async () => ({tracks: [], warnings: []})}});
  const app = makeApp();
  const request = (path: string, value?: unknown, owner = app) => new Request(`http://127.0.0.1:8769${path}`, {
    method: value === undefined ? "GET" : "POST", headers: {host: "127.0.0.1:8769", origin: "http://127.0.0.1:8769",
      "content-type": "application/json", "x-wavelength-token": owner.token},
    ...(value === undefined ? {} : {body: JSON.stringify(value)})});
  const post = (path: string, value: unknown = {}, owner = app) => owner.fetch(request(path, value, owner));
  const preview = (body: string | ReadableStream<Uint8Array> = csv(), owner = app) => owner.fetch(new Request("http://127.0.0.1:8769/api/history/preview", {
    method: "POST", headers: {host: "127.0.0.1:8769", origin: "http://127.0.0.1:8769",
      "content-type": "text/csv", "x-wavelength-token": owner.token}, body: typeof body === "string" ? bytes(body) : body}));
  return {store, connection, app, makeApp, request, post, preview,
    reopen: () => {app.dispose(); connection.close(); store.close(); return new Store(path);},
    close: () => {app.dispose(); connection.close(); store.close(); rmSync(directory, {recursive: true, force: true});},
    directory};
}
async function idle(app: ReturnType<typeof createApp>) {
  for (let i = 0; i < 200; i++) {if (!app.jobs.isActive()) return; await Bun.sleep(1);}
  throw new Error("Synthetic job did not settle within 200 ticks");
}
function unchanged(store: Store) {
  expect(store.get<MusicJob>("job", "sentinel")).toEqual(sentinel);
  expect(store.get<Provenance>("provenance", "999")).toEqual({kind: "human", evidence: ["unrelated"]});
  expect(store.get<{tracks: DraftTrack[]}>("draft", "draft")!.tracks).toEqual([track(1), track(2)]);
}
function delayedCSV() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const pulled = deferred<void>();
  const stream = new ReadableStream<Uint8Array>({start(value) {controller = value;}, pull() {pulled.resolve();}});
  return {stream, pulled: pulled.promise, finish(text = csv()) {controller.enqueue(bytes(text)); controller.close();}};
}

test("round2 history: 12 scan/forget/failure schedules preserve unrelated records and invalidate old work", async () => {
  // Exhaustive product, no randomness: three scan replies, two Forget outcomes, two preview orders.
  for (const scanReply of ["valid", "reject", "incomplete"] as const) for (const forgetFails of [false, true]) for (const previewFirst of [false, true]) {
    const entered = deferred<void>(), read = deferred<LibraryReadResult>();
    const f = fixture({read: () => {entered.resolve(); return read.promise;}});
    try {
      f.store.replaceHistory(savedLibrary(library("Before").tracks));
      const oldExport = await exportEnvelope(csv("Old"));
      f.store.replaceHistory(oldExport);
      const preview = previewFirst ? await (await f.preview()).json() : undefined;
      const scan = f.post("/api/history/library");
      await entered.promise;
      const token = preview?.token || (await (await f.preview()).json()).token;
      if (forgetFails) f.connection.exec("CREATE TRIGGER fail_forget BEFORE DELETE ON state WHEN OLD.kind='history' BEGIN SELECT RAISE(ABORT, 'round2 forget failed'); END");
      expect((await f.post("/api/history/forget")).status).toBe(forgetFails ? 400 : 200);
      expect((await f.post("/api/history/import", {token, replace: true})).status).toBe(409);
      expect((await f.post("/api/preflight", selection)).status).toBe(409);
      if (scanReply === "reject") read.reject(new Error("round2 read failed"));
      else read.resolve(scanReply === "valid" ? library("Late") : {...library("Late"), declaredTrackCount: 2});
      expect((await scan).status).toBe(scanReply === "valid" ? 409 : 400);
      expect(f.store.history()).toEqual(forgetFails ? [savedLibrary(library("Before").tracks), oldExport] : []);
      expect((await f.post("/api/preflight", selection)).status).toBe(200);
      unchanged(f.store);
      if (forgetFails) f.connection.exec("DROP TRIGGER fail_forget");
      expect((await f.post("/api/history/forget")).status).toBe(200);
      const current = await (await f.preview(csv("Current"))).json();
      expect((await f.post("/api/history/import", {token: current.token, replace: false})).status).toBe(200);
      expect(f.store.history()[0]!.records[0]!.title).toBe("Current");
    } finally {read.resolve(library("Cleanup")); f.close();}
  }
});

test.each(["scan-first", "import-first"] as const)("round2 history: failed import retains its enrichment snapshot across %s completion and reopen", async order => {
  const entered = deferred<void>(), read = deferred<LibraryReadResult>();
  const f = fixture({read: () => {entered.resolve(); return read.promise;}});
  let reopened: Store | undefined;
  try {
    f.store.replaceHistory(savedLibrary(library("Before").tracks));
    const oldExport = await exportEnvelope(csv("Old"));
    f.store.replaceHistory(oldExport);
    const scan = f.post("/api/history/library");
    await entered.promise;
    const preview = await (await f.preview()).json();
    f.connection.exec("CREATE TRIGGER fail_import AFTER UPDATE ON state WHEN NEW.kind='history' AND NEW.id='export' BEGIN SELECT RAISE(ABORT, 'round2 import rollback'); END");
    expect((await f.post("/api/history/import", {token: preview.token, replace: true})).status).toBe(400);
    expect(f.store.get<ExportEnvelope>("history", "export")).toEqual(oldExport);
    f.connection.exec("DROP TRIGGER fail_import");
    if (order === "scan-first") {read.resolve(library("After")); expect((await scan).status).toBe(200);}
    expect((await f.post("/api/history/import", {token: "wrong", replace: true})).status).toBe(409);
    expect((await f.post("/api/history/import", {token: preview.token, replace: false})).status).toBe(409);
    expect((await f.post("/api/history/import", {token: preview.token, replace: true})).status).toBe(200);
    if (order === "import-first") {read.resolve(library("After")); expect((await scan).status).toBe(200);}
    expect((await f.post("/api/history/import", {token: preview.token, replace: true})).status).toBe(409);
    const exported = f.store.get<ExportEnvelope>("history", "export")!;
    expect(exported.records[0]).toMatchObject({title: "Song", artist: "Before", enriched: ["artist", "genre"]});
    expect(f.store.get<{records: Array<{artist: string}>}>("history", "library")!.records[0]!.artist).toBe("After");
    unchanged(f.store);
    reopened = f.reopen();
    expect(reopened.get<ExportEnvelope>("history", "export")).toEqual(exported);
    unchanged(reopened);
  } finally {read.resolve(library("Cleanup")); if (reopened) {reopened.close(); rmSync(f.directory, {recursive: true, force: true});} else f.close();}
});

test.each(["valid", "invalid"] as const)("round2 history: old %s CSV completion cannot replace the receipt minted after failed Forget", async payload => {
  const f = fixture();
  const old = delayedCSV();
  try {
    f.store.replaceHistory(await exportEnvelope(csv("Saved")));
    const pending = f.preview(old.stream);
    await old.pulled;
    f.connection.exec("CREATE TRIGGER fail_forget BEFORE DELETE ON state WHEN OLD.kind='history' BEGIN SELECT RAISE(ABORT, 'round2 forget failed'); END");
    expect((await f.post("/api/history/forget")).status).toBe(400);
    const fresh = await (await f.preview(csv("Fresh"))).json();
    old.finish(payload === "valid" ? csv("Stale") : "Unsupported\ninvalid");
    expect((await pending).status).toBe(payload === "valid" ? 409 : 400);
    expect((await f.post("/api/history/import", {token: fresh.token, replace: true})).status).toBe(200);
    expect(f.store.history()[0]!.records[0]!.title).toBe("Fresh");
    unchanged(f.store);
  } finally {f.close();}
});

test("round2 history: reset rejects both old scan and streaming preview while the new session imports", async () => {
  const entered = deferred<void>(), read = deferred<LibraryReadResult>();
  const old = delayedCSV();
  const f = fixture({read: () => {entered.resolve(); return read.promise;}});
  let current: ReturnType<typeof createApp> | undefined;
  try {
    f.store.replaceHistory(savedLibrary(library("Before").tracks));
    const oldReceipt = await (await f.preview(csv("Receipt"))).json();
    const scan = f.post("/api/history/library"); await entered.promise;
    const pending = f.preview(old.stream); await old.pulled;
    f.app.dispose(); current = f.makeApp();
    expect((await current.fetch(f.request("/api/history?timeZone=UTC"))).status).toBe(403);
    expect((await f.post("/api/history/import", {token: oldReceipt.token, replace: true}, current)).status).toBe(409);
    expect((await f.post("/api/history/forget", {}, current)).status).toBe(200);
    const fresh = await (await f.preview(csv("Fresh"), current)).json();
    expect((await f.post("/api/history/import", {token: fresh.token, replace: false}, current)).status).toBe(200);
    read.resolve(library("Late")); old.finish(csv("Late"));
    expect((await scan).status).toBe(409); expect((await pending).status).toBe(409);
    expect(f.store.history().map(item => [item.source, item.records[0]!.title])).toEqual([["export", "Fresh"]]);
    unchanged(f.store);
  } finally {read.resolve(library("Cleanup")); current?.dispose(); f.close();}
});

test("round2 receipts: selection/name/storage failures retain the receipt until one successful create", async () => {
  let creates = 0;
  const f = fixture({invoke: async input => {if (input.action === "ensurePlaylist") creates++; return good(input);}});
  try {
    const receipt = await (await f.post("/api/preflight", selection)).json();
    const body = {...selection, name: "Synthetic", preflightId: receipt.id};
    for (const mutation of [{trackIds: ["2", "1"]}, {trackIds: ["1"]}, {includeAI: true},
      {draftId: "missing"}, {name: "\u0000"}, {name: []}, {preflightId: [receipt.id]}]) {
      expect((await f.post("/api/jobs", {...body, ...mutation})).status).toBe(400);
      expect(creates).toBe(0); expect(f.store.all("job")).toHaveLength(1);
    }
    f.connection.exec("CREATE TRIGGER fail_job AFTER INSERT ON state WHEN NEW.kind='job' AND NEW.id!='sentinel' BEGIN SELECT RAISE(ABORT, 'round2 job rollback'); END");
    expect((await f.post("/api/jobs", body)).status).toBe(400);
    expect(creates).toBe(0); expect(f.store.all("job")).toHaveLength(1);
    f.connection.exec("DROP TRIGGER fail_job");
    const accepted = await f.post("/api/jobs", body); expect(accepted.status).toBe(200);
    const job = await accepted.json(); await idle(f.app);
    expect(f.app.jobs.get(job.id)!.state).toBe("complete");
    expect((await f.post("/api/jobs", body)).status).toBe(400);
    expect(creates).toBe(1); unchanged(f.store);
  } finally {await idle(f.app); f.close();}
});

test("round2 receipts: a changed account consumes accepted intent but retry uses the new generation once", async () => {
  let generation = "g1", creates = 0, attempts = 0;
  const f = fixture({invoke: async input => {
    if (input.action === "status") return {generation};
    if (input.action === "ensurePlaylist") {
      attempts++;
      if (input.generation !== generation) throw Object.assign(new Error("generation changed"), {uncertain: false});
      creates++;
    }
    return good(input);
  }});
  try {
    const receipt = await (await f.post("/api/preflight", selection)).json(); generation = "g2";
    const body = {...selection, name: "Synthetic", preflightId: receipt.id};
    const response = await f.post("/api/jobs", body); expect(response.status).toBe(200);
    const {id} = await response.json(); await idle(f.app);
    expect(f.app.jobs.get(id)).toMatchObject({state: "failed", creationState: "not-started", connectionGeneration: "g1"});
    expect(creates).toBe(0);
    expect((await f.post("/api/jobs", body)).status).toBe(400);
    expect((await f.post(`/api/jobs/${id}/retry`)).status).toBe(200); await idle(f.app);
    expect(f.app.jobs.get(id)).toMatchObject({state: "complete", connectionGeneration: "g2"});
    expect(creates).toBe(1); expect(attempts).toBe(2); unchanged(f.store);
  } finally {await idle(f.app); f.close();}
});

test("round2 provenance: partial failure and later classification preserve the confirmed prefix across reopen", async () => {
  let creates = 0; const additions: string[] = [];
  const f = fixture({invoke: async input => {
    if (input.action === "ensurePlaylist") creates++;
    if (input.action === "addTrackToPlaylist") {
      additions.push(input.catalogIds![input.position!]!);
      if (input.position === 1) return {kind: "not-added"};
    }
    return good(input);
  }});
  let reopened: Store | undefined;
  try {
    const receipt = await (await f.post("/api/preflight", selection)).json();
    const job = await (await f.post("/api/jobs", {...selection, name: "Synthetic", preflightId: receipt.id})).json(); await idle(f.app);
    expect(f.app.jobs.get(job.id)!.state).toBe("partial");
    const prefix = f.app.jobs.get(job.id)!.tracks[0];
    expect((await f.post("/api/provenance", {artistId: 1, kind: "human", evidence: "new label"})).status).toBe(200);
    expect((await f.post("/api/provenance", {artistId: 2, kind: "ai", evidence: "stop pending"})).status).toBe(200);
    expect((await f.post(`/api/jobs/${job.id}/retry`)).status).toBe(400);
    expect(f.app.jobs.get(job.id)!.tracks[0]).toEqual(prefix);
    expect(additions).toEqual(["1", "2"]); expect(creates).toBe(1);
    const saved = f.app.jobs.get(job.id)!;
    reopened = f.reopen(); expect(reopened.get<MusicJob>("job", job.id)).toEqual(saved);
    unchanged(reopened);
  } finally {if (reopened) {reopened.close(); rmSync(f.directory, {recursive: true, force: true});} else {await idle(f.app); f.close();}}
});

test.each(["ai", "human", "unknown"])("round2 regression: provenance kind array [%s] must not overwrite a saved label", async kind => {
  const f = fixture();
  try {
    const original = {kind: "ai", evidence: ["saved classification"]};
    f.store.put("provenance", "1", original);
    const response = await f.post("/api/provenance", {artistId: 1, kind: [kind], evidence: "malformed replacement"});
    const saved = f.store.get<unknown>("provenance", "1");
    expect({status: response.status, saved}).toEqual({status: 400, saved: original});
  } finally {f.close();}
});

test("round2 provenance: invalid kind types and labels preserve saved classification and evidence", async () => {
  const f = fixture();
  try {
    const original: Provenance = {kind: "ai", evidence: ["saved classification"]};
    f.store.put("provenance", "1", original);
    for (const kind of [undefined, null, true, false, 0, 1, {}, {kind: "ai"}, [], ["ai", "human"],
      [["ai"]], [["human"]], [["unknown"]], "", "AI", " ai", "ai ", "made-up"]) {
      expect((await f.post("/api/provenance", {artistId: 1, kind, evidence: "malformed replacement"})).status).toBe(400);
      expect(f.store.get<Provenance>("provenance", "1")).toEqual(original);
    }
    unchanged(f.store);
  } finally {f.close();}
});

test("round2 provenance: valid string labels retain evidence validation and normalization", async () => {
  const f = fixture();
  try {
    for (const kind of ["ai", "human", "unknown"] as const) {
      for (const evidence of [undefined, "", " \t\n ", "  saved classification \n", "x".repeat(2000)]) {
        expect((await f.post("/api/provenance", {artistId: 1, kind, evidence})).status).toBe(200);
        expect(f.store.get<Provenance>("provenance", "1")).toEqual({kind,
          evidence: evidence?.trim() ? [evidence.trim()] : [], note: "Personal classification, not independently verified"});
      }
      const saved = f.store.get<Provenance>("provenance", "1");
      for (const evidence of [null, 0, ["text"], "x".repeat(2001)]) {
        expect((await f.post("/api/provenance", {artistId: 1, kind, evidence})).status).toBe(400);
        expect(f.store.get<Provenance>("provenance", "1")).toEqual(saved);
      }
    }
    unchanged(f.store);
  } finally {f.close();}
});

test("round2 regression: malformed AI label cannot authorize playlist writes with includeAI false", async () => {
  let creates = 0; const additions: string[] = [];
  const f = fixture({invoke: async input => {
    if (input.action === "ensurePlaylist") creates++;
    if (input.action === "addTrackToPlaylist") additions.push(input.catalogIds![input.position!]!);
    return good(input);
  }});
  try {
    expect((await f.post("/api/provenance", {artistId: 1, kind: "ai"})).status).toBe(200);
    expect((await f.post("/api/preflight", selection)).status).toBe(400);
    const saved = f.store.get<Provenance>("provenance", "1");
    const malformed = await f.post("/api/provenance", {artistId: 1, kind: [["ai"]]});
    const preflight = await f.post("/api/preflight", selection);
    if (preflight.status === 200) {
      const receipt = await preflight.json();
      const response = await f.post("/api/jobs", {...selection, name: "Excluded artist", preflightId: receipt.id});
      expect(response.status).toBe(200); await idle(f.app);
    }
    expect({malformedStatus: malformed.status, preflightStatus: preflight.status, creates, additions})
      .toEqual({malformedStatus: 400, preflightStatus: 400, creates: 0, additions: []});
    expect(f.store.get<Provenance>("provenance", "1")).toEqual(saved);
  } finally {await idle(f.app); f.close();}
});
