import {expect, test} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApp} from "../src/server";
import {Store} from "../src/store";
import {createWebMusicAdapter} from "../src/web-music";
import type {Draft, DraftTrack, MusicJob, Provenance} from "../src/types";

type Invoke = NonNullable<Parameters<typeof createWebMusicAdapter>[0]>;
type Call = Parameters<Invoke>[0];
const pick = {draftId: "fresh-review", trackIds: ["41", "42"], includeAI: false};
function gate() {let release!: () => void; const promise = new Promise<void>(resolve => {release = resolve;}); return {promise, release};}
const song = (id: number): DraftTrack => ({id: String(id), catalogId: id, artistId: id, title: `Synthetic ${id}`, artist: `Artist ${id}`, album: "Review", durationMs: 1000, releaseDate: "2026-01-01", url: "https://example.invalid", source: "review", match: "exact", selected: true, provenance: {kind: "unknown", evidence: []}});
function setup(hook?: (call: Call) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "r21-review-state-"));
  const path = join(directory, "state.sqlite");
  let store = new Store(path), sql = new Database(path);
  const calls: Call[] = [];
  const music = createWebMusicAdapter(async call => {
    calls.push(structuredClone(call));
    await hook?.(call);
    switch (call.action) {
      case "status": case "rebindPlaylist": return {generation: "review-generation"};
      case "inspectTracks": return {generation: call.generation, storefront: "au", total: call.catalogIds!.length, availableCatalogTracks: call.catalogIds!.length, unavailableCatalogTracks: 0, unavailableCatalogIds: []};
      case "ensurePlaylist": return {id: "p.review-playlist"};
      case "addTrackToPlaylist": return {kind: "confirmed", catalogId: call.catalogIds![call.position!], alreadyPresent: true};
      case "playlistCover": return {state: "blocked", code: "automation-permission", writeAttempted: false};
      default: throw new Error(`Unexpected fake call ${call.action}`);
    }
  });
  store.put("draft", pick.draftId, {id: pick.draftId, status: "ready", request: {mode: "genre", includeAI: false}, tracks: [song(41), song(42)]});
  store.put("provenance", "99", {kind: "unknown", evidence: ["sentinel"]});
  const appFor = () => createApp({store, port: 18741, engineToken: "synthetic-review-token", music, discovery: {getGenres: async () => [], buildDraft: async () => ({tracks: [], warnings: []})}});
  let app = appFor();
  const request = (route: string, value?: unknown) => app.fetch(new Request(`http://127.0.0.1:18741${route}`, {method: value === undefined ? "GET" : "POST", headers: {host: "127.0.0.1:18741", origin: "http://127.0.0.1:18741", "x-wavelength-token": app.token, "content-type": "application/json"}, ...(value === undefined ? {} : {body: JSON.stringify(value)})}));
  return {get store() {return store;}, get app() {return app;}, get sql() {return sql;}, calls, request,
    storedJSON(kind: string, id: string) {return (sql.query("SELECT json FROM state WHERE kind=? AND id=?").get(kind, id) as {json: string} | null)?.json;},
    classify: (kind: unknown, artistId = 41, evidence: unknown = "fresh evidence") => request("/api/provenance", {artistId, kind, evidence}),
    async receipt(selection = pick) {const response = await request("/api/preflight", selection); expect(response.status).toBe(200); return (await response.json()).id as string;},
    create: (id: string, selection = pick) => request("/api/jobs", {...selection, name: "Synthetic review", preflightId: id}),
    async idle() {for (let n = 0; n < 500 && app.jobs.isActive(); n++) await Bun.sleep(1); expect(app.jobs.isActive()).toBe(false);},
    reopen() {expect(app.jobs.isActive()).toBe(false); app.dispose(); sql.close(); store.close(); store = new Store(path); sql = new Database(path); app = appFor();},
    close() {expect(store.get<unknown>("provenance", "99")).toEqual({kind: "unknown", evidence: ["sentinel"]}); app.dispose(); sql.close(); store.close(); rmSync(directory, {recursive: true, force: true});},
  };
}
const invalid: unknown[] = [[["ai"]], [[[["human"]]]], {toString: "ai"}, {0: "ai", length: 1}, "a\u200bi", "ai\u0000", "ＡＩ", "AI", null, false, 41, ["unknown", "ai"]];

test("fresh R2.1: 12 malformed requests preserve two receipts and the persisted/returned primitive label", async () => {
  const f = setup();
  try {
    expect((await f.classify("human", 41, "  first evidence\n")).status).toBe(200);
    const original = f.store.get<unknown>("provenance", "41");
    for (const kind of invalid) {
      const receipts = [await f.receipt(), await f.receipt()];
      const rejected = await f.classify(kind);
      expect(rejected.status).toBe(400); expect(typeof (await rejected.json()).error).toBe("string");
      expect(f.store.get<unknown>("provenance", "41")).toEqual(original);
      for (const receipt of receipts) {
        const response = await f.create(receipt); expect(response.status).toBe(200);
        const {id} = await response.json(); await f.idle();
        const wire = await (await f.request(`/api/jobs/${id}`)).json();
        expect(wire.state).toBe("complete"); expect(wire.tracks[0].track.provenance).toEqual(original);
        expect(f.store.get<unknown>("job", id)).toEqual(wire);
        expect((await f.create(receipt)).status).toBe(400);
      }
    }
    expect(f.calls.filter(c => c.action === "ensurePlaylist")).toHaveLength(24);
    expect(f.calls.filter(c => c.action === "addTrackToPlaylist")).toHaveLength(48);
    f.reopen(); expect(f.store.get<unknown>("provenance", "41")).toEqual(original);
    expect(f.store.all<MusicJob>("job").every(j => j.tracks[0]!.track.provenance.kind === "human")).toBe(true);
  } finally {await f.idle(); f.close();}
});

test("fresh R2.1: all nine valid label transitions invalidate issued receipts including no-op saves", async () => {
  const f = setup(); const include = {...pick, includeAI: true};
  try {
    for (const before of ["human", "unknown", "ai"]) for (const after of ["human", "unknown", "ai"]) {
      expect((await f.classify(before)).status).toBe(200);
      const r1 = await f.receipt(include), r2 = await f.receipt(include);
      const saved = await f.classify(after, 41, " \tupdate \n"); expect(saved.status).toBe(200); expect(await saved.json()).toEqual({ok: true});
      expect((await f.create(r1, include)).status).toBe(400); expect((await f.create(r2, include)).status).toBe(400);
      const fresh = await f.create(await f.receipt(include), include); expect(fresh.status).toBe(200);
      const {id} = await fresh.json(); await f.idle();
      const job = await (await f.request(`/api/jobs/${id}`)).json();
      expect(job.tracks[0].track.provenance).toEqual({kind: after, evidence: ["update"], note: "Personal classification, not independently verified"});
    }
    expect(f.calls.filter(c => c.action === "ensurePlaylist")).toHaveLength(9);
    f.reopen(); expect(f.store.get<{kind: string}>("provenance", "41")!.kind).toBe("ai");
    expect((await f.request("/api/preflight", pick)).status).toBe(400);
  } finally {await f.idle(); f.close();}
});

test.each(["INSERT", "UPDATE"])("fresh R2.1: AFTER %s rollback preserves classification and receipt until retry succeeds", async operation => {
  const f = setup();
  try {
    if (operation === "UPDATE") expect((await f.classify("human")).status).toBe(200);
    const previous = f.store.get<unknown>("provenance", "41"); const r1 = await f.receipt(), r2 = await f.receipt();
    f.sql.exec(`CREATE TRIGGER review_fail AFTER ${operation} ON state WHEN NEW.kind='provenance' AND NEW.id='41' BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END`);
    expect((await f.classify("ai")).status).toBe(400); expect(f.store.get<unknown>("provenance", "41")).toEqual(previous);
    const response = await f.create(r1); expect(response.status).toBe(200); await f.idle();
    f.sql.exec("DROP TRIGGER review_fail");
    expect((await f.classify("human")).status).toBe(200); expect((await f.create(r2)).status).toBe(400);
    const fresh = await f.receipt(); f.reopen(); expect((await f.create(fresh)).status).toBe(400);
    expect(f.store.get<{kind: string}>("provenance", "41")!.kind).toBe("human");
    expect((await f.create(await f.receipt())).status).toBe(200); await f.idle();
    expect(f.calls.filter(c => c.action === "ensurePlaylist")).toHaveLength(2);
  } finally {await f.idle(); f.close();}
});

for (const change of ["invalid", "rollback", "human", "ai"] as const) test(`fresh R2.1: pending preflight with ${change} classification`, async () => {
  const entered = gate(), resume = gate(); let pause = true;
  const f = setup(async call => {if (call.action === "inspectTracks" && pause) {entered.release(); await resume.promise;}});
  try {
    const pending = f.request("/api/preflight", pick); await entered.promise;
    if (change === "rollback") f.sql.exec("CREATE TRIGGER review_fail AFTER INSERT ON state WHEN NEW.kind='provenance' AND NEW.id='41' BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END");
    const changed = await f.classify(change === "invalid" ? [["ai"]] : change === "rollback" ? "ai" : change);
    expect(changed.status).toBe(change === "invalid" || change === "rollback" ? 400 : 200);
    resume.release(); pause = false;
    const response = await pending; const result = await response.json();
    let accepted = false;
    if (response.status === 200) {const created = await f.create(result.id); accepted = created.status === 200; await f.idle();}
    console.log(JSON.stringify({schedule: change, preflightStatus: response.status, accepted, creates: f.calls.filter(c => c.action === "ensurePlaylist").length}));
    expect(accepted).toBe(change === "invalid" || change === "rollback");
    expect(f.calls.filter(c => c.action === "ensurePlaylist")).toHaveLength(change === "invalid" || change === "rollback" ? 1 : 0);
  } finally {resume.release(); await f.idle(); f.close();}
});

test("fresh R2.1: change pending artist during append, reject invalid repair, reopen and retry exactly once", async () => {
  const entered = gate(), resume = gate(); let pause = true;
  const f = setup(async call => {if (call.action === "addTrackToPlaylist" && call.position === 0 && pause) {entered.release(); await resume.promise;}});
  try {
    const response = await f.create(await f.receipt()); expect(response.status).toBe(200); const {id} = await response.json();
    await entered.promise; expect((await f.classify("ai", 42)).status).toBe(200);
    expect((await f.classify([["human"]], 42)).status).toBe(400); resume.release(); pause = false; await f.idle();
    const partial = f.app.jobs.get(id)!; expect(partial.state).toBe("partial"); expect(partial.tracks[0]!.state).toBe("added");
    expect(f.calls.filter(c => c.action === "addTrackToPlaylist").map(c => c.position)).toEqual([0]);
    for (let i = 0; i < 2; i++) expect((await f.request(`/api/jobs/${id}/retry`, {})).status).toBe(400);
    expect(f.app.jobs.get(id)).toEqual(partial); f.reopen(); expect(f.app.jobs.get(id)).toEqual(partial);
    expect((await f.request(`/api/jobs/${id}/retry`, {})).status).toBe(400);
    expect((await f.classify("human", 42)).status).toBe(200); expect((await f.request(`/api/jobs/${id}/retry`, {})).status).toBe(200); await f.idle();
    const final = f.app.jobs.get(id)!; expect(final.state).toBe("complete"); expect(final.tracks[0]).toEqual(partial.tracks[0]); expect(final.tracks[1]!.track.provenance.kind).toBe("human");
    expect((await f.request(`/api/jobs/${id}/retry`, {})).status).toBe(400);
    expect(f.calls.filter(c => c.action === "ensurePlaylist")).toHaveLength(1);
    expect(f.calls.filter(c => c.action === "addTrackToPlaylist").map(c => c.position)).toEqual([0, 1]);
  } finally {resume.release(); await f.idle(); f.close();}
});

test("fresh R2.1: legacy saved array blocks new writes without changing stored rows or historical jobs", async () => {
  const f = setup();
  try {
    const legacy = {kind: [["ai"]], evidence: ["synthetic pre-fix row"]};
    const historical = {id: "historical", name: "Pre-fix snapshot", state: "complete", tracks: [{track: {...song(41), provenance: legacy}, state: "added"}], message: "Keep", createdAt: "2026-01-01", updatedAt: "2026-01-01"};
    f.store.put("provenance", "41", legacy); f.store.put("job", "historical", historical);
    const savedBytes = f.storedJSON("provenance", "41"), historicalBytes = f.storedJSON("job", "historical");
    f.reopen(); expect(f.storedJSON("provenance", "41")).toBe(savedBytes);
    expect((await f.classify(["human"])).status).toBe(400); expect(f.storedJSON("provenance", "41")).toBe(savedBytes);
    const checked = await f.request("/api/preflight", pick); const check = await checked.json();
    const response = await f.create(check.id || "unissued"); await f.idle();
    const creates = f.calls.filter(c => c.action === "ensurePlaylist").length;
    const appends = f.calls.filter(c => c.action === "addTrackToPlaylist").length;
    console.log(JSON.stringify({schedule: "legacy-saved-array", preflightStatus: checked.status, createStatus: response.status, creates, appends, storedBytesPreserved: f.storedJSON("provenance", "41") === savedBytes, historicalBytesPreserved: f.storedJSON("job", "historical") === historicalBytes}));
    expect(checked.status).toBe(400); expect(check.error).toMatch(/save.*(?:ai|human|unknown)/i);
    expect(response.status).toBe(400); expect((await response.json()).error).toMatch(/save.*(?:ai|human|unknown)/i);
    expect(creates).toBe(0); expect(appends).toBe(0);
    expect(f.storedJSON("provenance", "41")).toBe(savedBytes); expect(f.storedJSON("job", "historical")).toBe(historicalBytes);
    expect((await (await f.request("/api/jobs/historical")).json())).toEqual(historical);
    expect((await f.classify("human", 41, "  explicit repair  ")).status).toBe(200);
    const repaired = await f.create(await f.receipt()); expect(repaired.status).toBe(200); const {id} = await repaired.json(); await f.idle();
    expect(f.app.jobs.get(id)!.tracks[0]!.track.provenance).toEqual({kind: "human", evidence: ["explicit repair"], note: "Personal classification, not independently verified"});
    expect(f.calls.filter(c => c.action === "ensurePlaylist")).toHaveLength(1); expect(f.calls.filter(c => c.action === "addTrackToPlaylist")).toHaveLength(2);
    expect((await f.classify("ai")).status).toBe(200); expect((await f.request("/api/preflight", pick)).status).toBe(400);
    f.reopen(); expect(f.store.get<{kind: string}>("provenance", "41")!.kind).toBe("ai");
    expect(f.storedJSON("job", "historical")).toBe(historicalBytes);
    expect(await (await f.request("/api/jobs/historical")).json()).toEqual(historical);
  } finally {await f.idle(); f.close();}
});

test("fresh R2.1: malformed saved values cannot fall back to a valid draft or use an issued receipt", async () => {
  const f = setup();
  const malformed: unknown[] = [null, false, "ai", [], {}, ...invalid.map(kind => ({kind, evidence: ["keep exact evidence"]}))];
  try {
    for (const value of malformed) for (const includeAI of [false, true]) {
      const selection = {...pick, includeAI};
      expect((await f.classify("human")).status).toBe(200); const receipt = await f.receipt(selection);
      f.store.put("provenance", "41", value); const original = f.storedJSON("provenance", "41");
      for (const response of [await f.request("/api/preflight", selection), await f.create(receipt, selection)]) {
        expect(response.status).toBe(400); expect((await response.json()).error).toMatch(/save.*(?:ai|human|unknown)/i);
      }
      expect((await f.classify([["human"]])).status).toBe(400);
      expect(f.storedJSON("provenance", "41")).toBe(original);
      f.reopen(); expect(f.storedJSON("provenance", "41")).toBe(original);
      const response = await f.request("/api/preflight", selection);
      expect(response.status).toBe(400); expect((await response.json()).error).toMatch(/save.*(?:ai|human|unknown)/i);
      expect(f.storedJSON("provenance", "41")).toBe(original);
      expect(f.store.all("job")).toEqual([]);
    }
    expect(f.calls.filter(c => c.action === "ensurePlaylist" || c.action === "addTrackToPlaylist")).toEqual([]);
  } finally {await f.idle(); f.close();}
});

test("fresh R2.1: old draft provenance requires an explicit valid save before preflight or creation", async () => {
  const f = setup();
  try {
    const draft = f.store.get<Draft>("draft", pick.draftId)!;
    for (const value of [{kind: [["human"]], evidence: ["old draft"]}, null, {evidence: ["no label"]}]) {
      const receipt = await f.receipt();
      f.store.put("draft", pick.draftId, {...draft, tracks: [{...song(41), provenance: value}, song(42)]});
      const original = f.storedJSON("draft", pick.draftId);
      for (const includeAI of [false, true]) for (const response of [await f.request("/api/preflight", {...pick, includeAI}), await f.create(receipt, {...pick, includeAI})]) {
        expect(response.status).toBe(400); expect((await response.json()).error).toMatch(/save.*(?:ai|human|unknown)/i);
      }
      expect(f.storedJSON("draft", pick.draftId)).toBe(original);
      f.store.put("draft", pick.draftId, draft);
    }
    expect(f.calls.filter(c => c.action === "ensurePlaylist" || c.action === "addTrackToPlaylist")).toEqual([]);
    f.store.put("draft", pick.draftId, {...draft, tracks: [{...song(41), provenance: {kind: [["ai"]], evidence: ["keep cached bytes"]}}, song(42)]});
    const original = f.storedJSON("draft", pick.draftId);
    expect((await f.classify("unknown")).status).toBe(200);
    const response = await f.create(await f.receipt()); expect(response.status).toBe(200); const {id} = await response.json(); await f.idle();
    expect(f.app.jobs.get(id)!.tracks[0]!.track.provenance.kind).toBe("unknown");
    expect(f.storedJSON("draft", pick.draftId)).toBe(original);
  } finally {await f.idle(); f.close();}
});

for (const source of ["saved", "job"] as const) for (const includeAI of [false, true]) test(`fresh R2.1: malformed ${source} blocks retry with includeAI ${includeAI} and preserves a historical confirmed prefix`, async () => {
  const f = setup();
  try {
    const legacy = {kind: [["ai"]], evidence: ["preserve old snapshot"]};
    const prefix = {track: {...song(41), provenance: legacy}, state: "added", outcome: "confirmed", libraryId: "historical-library-id"};
    f.store.put("job", "partial-legacy", {id: "partial-legacy", name: "Continue same playlist", state: "partial", writer: "web-session", includeAI, playlistId: "p.review-playlist", connectionGeneration: "review-generation", creationState: "known", tracks: [prefix, {track: {...song(42), provenance: source === "job" ? legacy : song(42).provenance}, state: "failed", outcome: "not-added", error: "Previous stop"}], message: "Keep until explicit retry", createdAt: "2026-01-01", updatedAt: "2026-01-01"});
    if (source === "saved") f.store.put("provenance", "42", legacy);
    const original = f.storedJSON("job", "partial-legacy"), saved = f.storedJSON("provenance", "42");
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await f.request("/api/jobs/partial-legacy/retry", {}); await f.idle();
      expect(response.status).toBe(400); expect((await response.json()).error).toMatch(/save.*(?:ai|human|unknown)/i);
      expect(f.storedJSON("job", "partial-legacy")).toBe(original); expect(f.storedJSON("provenance", "42")).toBe(saved);
      f.reopen(); expect(f.storedJSON("job", "partial-legacy")).toBe(original);
    }
    expect(f.calls.filter(c => c.action === "ensurePlaylist" || c.action === "addTrackToPlaylist")).toEqual([]);
    expect((await f.classify("human", 42, "  explicit pending repair  ")).status).toBe(200);
    expect((await f.request("/api/jobs/partial-legacy/retry", {})).status).toBe(200); await f.idle();
    const complete = f.app.jobs.get("partial-legacy")!; expect(complete.state).toBe("complete"); expect<unknown>(complete.tracks[0]).toEqual(prefix);
    expect(complete.tracks[1]!.track.provenance).toEqual({kind: "human", evidence: ["explicit pending repair"], note: "Personal classification, not independently verified"});
    expect(f.calls.filter(c => c.action === "ensurePlaylist")).toHaveLength(0);
    expect(f.calls.filter(c => c.action === "addTrackToPlaylist").map(c => c.position)).toEqual([1]);
    const completeBytes = f.storedJSON("job", "partial-legacy"); f.reopen(); expect(f.storedJSON("job", "partial-legacy")).toBe(completeBytes);
  } finally {await f.idle(); f.close();}
});

test("fresh R2.1: malformed classification during append stops before consuming the pending track", async () => {
  const entered = gate(), resume = gate();
  const f = setup(async call => {if (call.action === "addTrackToPlaylist" && call.position === 0) {entered.release(); await resume.promise;}});
  try {
    const response = await f.create(await f.receipt()); expect(response.status).toBe(200); const {id} = await response.json();
    await entered.promise;
    f.store.put("provenance", "42", {kind: [["human"]], evidence: ["pre-fix state arriving during append"]});
    const original = f.storedJSON("provenance", "42"); resume.release(); await f.idle();
    const partial = f.app.jobs.get(id)!; expect(partial.state).toBe("partial"); expect(partial.tracks[0]!.state).toBe("added");
    expect(partial.tracks[1]!.error).toMatch(/save.*(?:ai|human|unknown)/i);
    expect(f.calls.filter(c => c.action === "addTrackToPlaylist").map(c => c.position)).toEqual([0]);
    expect(f.storedJSON("provenance", "42")).toBe(original);
    const partialBytes = f.storedJSON("job", id); f.reopen(); expect(f.storedJSON("job", id)).toBe(partialBytes);
    expect((await f.request(`/api/jobs/${id}/retry`, {})).status).toBe(400); expect(f.storedJSON("job", id)).toBe(partialBytes);
    expect((await f.classify("human", 42)).status).toBe(200);
    expect((await f.request(`/api/jobs/${id}/retry`, {})).status).toBe(200); await f.idle();
    expect(f.app.jobs.get(id)!.state).toBe("complete"); expect(f.app.jobs.get(id)!.tracks[0]).toEqual(partial.tracks[0]);
    expect(f.calls.filter(c => c.action === "ensurePlaylist")).toHaveLength(1);
    expect(f.calls.filter(c => c.action === "addTrackToPlaylist").map(c => c.position)).toEqual([0, 1]);
  } finally {resume.release(); await f.idle(); f.close();}
});

test("fresh R2.1: valid stored and cached labels retain their exact evidence and note", async () => {
  const f = setup();
  try {
    for (const source of ["draft", "saved"] as const) for (const kind of ["ai", "human", "unknown"] as const) {
      const value: Provenance = {kind, evidence: ["  retain whitespace  ", "https://example.invalid/evidence", ""], note: "Original saved note"};
      const draft = f.store.get<Draft>("draft", pick.draftId)!;
      if (source === "saved") f.store.put("provenance", "41", value);
      else {draft.tracks[0]!.provenance = value; f.store.put("draft", draft.id, draft);}
      const original = f.storedJSON(source === "saved" ? "provenance" : "draft", source === "saved" ? "41" : pick.draftId);
      if (kind === "ai") expect((await f.request("/api/preflight", pick)).status).toBe(400);
      const selection = {...pick, includeAI: kind === "ai"};
      const response = await f.create(await f.receipt(selection), selection); expect(response.status).toBe(200); const {id} = await response.json(); await f.idle();
      expect(f.app.jobs.get(id)!.tracks[0]!.track.provenance).toEqual(value);
      expect(f.storedJSON(source === "saved" ? "provenance" : "draft", source === "saved" ? "41" : pick.draftId)).toBe(original);
      f.reopen(); expect(f.app.jobs.get(id)!.tracks[0]!.track.provenance).toEqual(value);
    }
    expect(f.calls.filter(c => c.action === "ensurePlaylist")).toHaveLength(6);
    expect(f.calls.filter(c => c.action === "addTrackToPlaylist")).toHaveLength(12);
  } finally {await f.idle(); f.close();}
});
