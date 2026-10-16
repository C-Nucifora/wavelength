import {test, expect} from "bun:test";
import {Jobs, type WebMusicAdapter} from "../src/jobs";
import {Store} from "../src/store";
import type {CoverContext, DraftTrack, MusicJob, PlaylistCover, WriterContext} from "../src/types";

const track = (id: number): DraftTrack => ({id: String(id), catalogId: id, artistId: id, title: `Song ${id}`, artist: "Artist", album: "Album", durationMs: 120000, releaseDate: "2026-01-01", url: "https://music.apple.com/", source: "test", match: "exact", provenance: {kind: "unknown", evidence: []}, selected: true});
async function finished(jobs: Jobs, id: string) {
  for (let i = 0; i < 100; i++) {
    const job = jobs.get(id)!;
    if (!["queued", "running"].includes(job.state) && !jobs.isActive()) return job;
    await Bun.sleep(5);
  }
  throw new Error("Job did not finish");
}
function adapter(overrides: Record<string, unknown> = {}) {
  return {kind: "web-session", ensurePlaylist: async () => ({id: "p.test", name: "Test"}),
    getMusicStatus: async () => ({generation: "new"}), rebindPlaylist: async () => ({generation: "new"}),
    addTrackToPlaylist: async (t: DraftTrack) => ({kind: "confirmed", catalogId: String(t.catalogId), alreadyPresent: false}),
    playlistCover: async () => ({state: "blocked", code: "automation-permission", helperAttempted: true, writeAttempted: false}),
    openPlaylist: async () => {}, ...overrides} as unknown as WebMusicAdapter;
}
const create = (jobs: Jobs, tracks = [track(1), track(2), track(3)]) => jobs.create("Test", tracks, false, "initial");

test("web queue stops at uncertainty and retry reconciles before advancing", async () => {
  const store = new Store(":memory:");
  const calls: unknown[] = [];
  let retry = false;
  const jobs = new Jobs(store, adapter({addTrackToPlaylist: async (t: DraftTrack, id: string, context: unknown) => {
    calls.push({catalogId: t.catalogId, id, context});
    return t.catalogId === 2 && !retry ? {kind: "uncertain", message: "Readback pending"} : {kind: "confirmed", catalogId: String(t.catalogId), alreadyPresent: retry && t.catalogId === 2};
  }}));
  const first = await finished(jobs, create(jobs).id);
  expect(first.tracks.map(t => t.state)).toEqual(["added", "failed", "pending"]);
  expect(first.tracks[1]).toMatchObject({outcome: "uncertain"});
  expect(first).toMatchObject({writer: "web-session", connectionGeneration: "initial", creationState: "known"});
  expect(calls).toEqual([
    {catalogId: 1, id: "p.test", context: {connectionGeneration: "initial", expectedCatalogIds: ["1", "2", "3"], position: 0, reconcileOnly: true}},
    {catalogId: 2, id: "p.test", context: {connectionGeneration: "initial", expectedCatalogIds: ["1", "2", "3"], position: 1, reconcileOnly: false}},
  ]);
  retry = true;
  jobs.retry(first.id);
  const last = await finished(jobs, first.id);
  expect(last.state).toBe("complete");
  expect(calls.slice(2)).toEqual([
    {catalogId: 2, id: "p.test", context: {connectionGeneration: "new", expectedCatalogIds: ["1", "2", "3"], position: 1, reconcileOnly: true}},
    {catalogId: 3, id: "p.test", context: {connectionGeneration: "new", expectedCatalogIds: ["1", "2", "3"], position: 2, reconcileOnly: false}},
  ]);
  store.close();
});

test("song completion and pending cover persist together before dispatch, holding the job lock", async () => {
  const store = new Store(":memory:");
  const saved: MusicJob[] = [];
  const put = store.put.bind(store);
  store.put = (kind, id, value) => {if (kind === "job") saved.push(structuredClone(value as MusicJob)); put(kind, id, value);};
  let finishCover!: (value: PlaylistCover) => void;
  const deferred = new Promise<PlaylistCover>(resolve => finishCover = resolve);
  let appends = 0;
  const jobs = new Jobs(store, adapter({
    ensurePlaylist: async (_name: string, _id: string, context: {jobId: string}) => {
      expect(store.get<MusicJob>("job", context.jobId)?.coverEligible).toBe(true);
      return {id: "p.test", name: "Test"};
    },
    addTrackToPlaylist: async () => {appends++; return {kind: "confirmed", catalogId: "1", alreadyPresent: false};},
    playlistCover: async (_id: string, context: CoverContext) => {
      expect(context).toMatchObject({name: "Test", expectedCatalogIds: ["1"], mode: "apply", connectionGeneration: "initial"});
      expect(saved.find(j => j.state === "complete")).toMatchObject({cover: {state: "pending", helperAttempted: false}});
      return deferred;
    },
  }));
  const job = create(jobs, [track(1)]);
  for (let i = 0; i < 100 && jobs.get(job.id)?.cover?.state !== "applying"; i++) await Bun.sleep(5);
  expect(jobs.get(job.id)).toMatchObject({state: "complete", cover: {state: "applying", helperAttempted: true}});
  expect(jobs.isActive()).toBe(true);
  expect(() => create(jobs)).toThrow("already running");
  expect(() => jobs.retry(job.id)).toThrow("already running");
  finishCover({state: "verified", code: "image-verified", helperAttempted: true, writeAttempted: true, imageHash: "a".repeat(64)});
  expect(await finished(jobs, job.id)).toMatchObject({state: "complete", cover: {state: "verified"}});
  expect(appends).toBe(1);
  store.close();
});

test("lost cover IPC and later pre-write rejection never make cover retry write again", async () => {
  const store = new Store(":memory:");
  const modes: string[] = [];
  let appends = 0, creates = 0;
  const jobs = new Jobs(store, adapter({
    ensurePlaylist: async () => {creates++; return {id: "p.test", name: "Test"};},
    addTrackToPlaylist: async () => {appends++; return {kind: "confirmed", catalogId: "1", alreadyPresent: false};},
    playlistCover: async (_id: string, context: CoverContext) => {
      modes.push(context.mode);
      if (modes.length === 1) throw new Error("secret native failure");
      expect(context.connectionGeneration).toBe("new");
      return {state: "blocked", code: modes.length === 2 ? "identity-mismatch" : "journal-missing", helperAttempted: true, writeAttempted: false};
    },
  }));
  const first = await finished(jobs, create(jobs, [track(1)]).id);
  expect(first).toMatchObject({state: "complete", cover: {state: "uncertain", code: "connection-unconfirmed"}});
  expect(first.message).toContain("Playlist is ready");
  for (const action of ["retry", "check", "retry"] as const) {
    jobs.coverAction(first.id, action);
    expect(await finished(jobs, first.id)).toMatchObject({state: "complete", cover: {state: "uncertain"}});
  }
  expect(modes).toEqual(["apply", "check", "check", "check"]);
  expect([creates, appends]).toEqual([1, 1]);
  store.close();
});

function completed(id = crypto.randomUUID()): MusicJob {
  return {id, name: "Test", writer: "web-session", connectionGeneration: "saved", creationState: "known", coverEligible: true, playlistId: "p.test", state: "complete", tracks: [{track: track(1), state: "added", outcome: "confirmed"}], message: "Songs complete", createdAt: "now", updatedAt: "now"};
}

test("restart after the final confirmed save waits for explicit read-only completion", async () => {
  const original = new Store(":memory:");
  let interrupted!: MusicJob;
  const put = original.put.bind(original);
  original.put = (kind, id, value) => {
    const job = value as MusicJob;
    if (kind === "job" && job.state === "running" && job.tracks.every(item => item.state === "added" && item.outcome === "confirmed")) interrupted = structuredClone(job);
    put(kind, id, value);
  };
  const initial = new Jobs(original, adapter());
  await finished(initial, create(initial, [track(1)]).id);
  expect(interrupted).toMatchObject({state: "running", coverEligible: true, creationState: "known"});
  expect(interrupted.cover).toBeUndefined();
  original.close();
  const store = new Store(":memory:");
  store.put("job", interrupted.id, interrupted);
  let creates = 0, appends = 0;
  const reads: WriterContext[] = [], covers: CoverContext[] = [], saved: MusicJob[] = [];
  const save = store.put.bind(store);
  store.put = (kind, id, value) => {if (kind === "job") saved.push(structuredClone(value as MusicJob)); save(kind, id, value);};
  const jobs = new Jobs(store, adapter({
    ensurePlaylist: async () => {creates++; throw new Error("No second create");},
    addTrackToPlaylist: async () => {appends++; throw new Error("No second append");},
    rebindPlaylist: async (id: string, context: WriterContext) => {
      expect(id).toBe("p.test");
      expect(jobs.get(interrupted.id)?.message).toBe("Verifying completed playlist");
      reads.push(context); return {generation: "new"};
    },
    playlistCover: async (_id: string, context: CoverContext) => {covers.push(context); return {state: "blocked", helperAttempted: true, writeAttempted: false};},
  }));
  expect(jobs.get(interrupted.id)).toMatchObject({state: "interrupted"});
  expect(jobs.isActive()).toBe(false);
  expect(covers).toHaveLength(0);
  jobs.retry(interrupted.id);
  expect(await finished(jobs, interrupted.id)).toMatchObject({state: "complete", connectionGeneration: "new", cover: {state: "blocked"}});
  expect(reads).toEqual([{connectionGeneration: "new", expectedCatalogIds: ["1"], position: 1, reconcileOnly: true}]);
  expect(saved.find(job => job.state === "complete")).toMatchObject({cover: {state: "pending", helperAttempted: false}});
  expect(covers).toEqual([{jobId: interrupted.id, name: "Test", connectionGeneration: "new", expectedCatalogIds: ["1"], mode: "apply"}]);
  expect([creates, appends]).toEqual([0, 0]);
  store.close();
});

test("cancellation during the final append stays cancelled until explicit finish", async () => {
  const store = new Store(":memory:");
  let release!: () => void, started!: () => void;
  const wait = new Promise<void>(resolve => release = resolve), start = new Promise<void>(resolve => started = resolve);
  let creates = 0, appends = 0, covers = 0;
  const reads: WriterContext[] = [];
  const jobs = new Jobs(store, adapter({
    ensurePlaylist: async () => {creates++; return {id: "p.test", name: "Test"};},
    addTrackToPlaylist: async () => {appends++; started(); await wait; return {kind: "confirmed", catalogId: "1", alreadyPresent: false};},
    rebindPlaylist: async (_id: string, context: WriterContext) => {reads.push(context); return {generation: "new"};},
    playlistCover: async () => {covers++; return {state: "verified", helperAttempted: true, writeAttempted: true};},
  }));
  const job = create(jobs, [track(1)]);
  await start; jobs.cancel(job.id); release();
  expect(await finished(jobs, job.id)).toMatchObject({state: "cancelled", tracks: [{state: "added", outcome: "confirmed"}]});
  expect(jobs.get(job.id)?.cover).toBeUndefined();
  expect(covers).toBe(0);
  jobs.retry(job.id);
  expect(await finished(jobs, job.id)).toMatchObject({state: "complete", cover: {state: "verified"}});
  expect(reads).toEqual([{connectionGeneration: "new", expectedCatalogIds: ["1"], position: 1, reconcileOnly: true}]);
  expect([creates, appends, covers]).toEqual([1, 1, 1]);
  store.close();
});

test("all-confirmed finish preserves old eligibility and blocks a conflicting saved order", async () => {
  for (const conflict of [false, true]) {
    const store = new Store(":memory:");
    const job = {...completed(), state: "interrupted", coverEligible: conflict ? true : undefined};
    store.put("job", job.id, job);
    let creates = 0, appends = 0, covers = 0;
    const jobs = new Jobs(store, adapter({
      ensurePlaylist: async () => {creates++; throw new Error("No create");},
      addTrackToPlaylist: async () => {appends++; throw new Error("No append");},
      playlistCover: async () => {covers++; throw new Error("No retroactive cover");},
      rebindPlaylist: async () => {if (conflict) throw new Error("Conflicting full catalog order"); return {generation: "new"};},
    }));
    jobs.retry(job.id);
    const result = await finished(jobs, job.id);
    expect(result.state).toBe(conflict ? "failed" : "complete");
    expect(result.connectionGeneration).toBe(conflict ? "saved" : "new");
    expect(result.coverEligible).toBe(conflict ? true : undefined);
    expect(result.cover).toBeUndefined();
    expect([creates, appends, covers]).toEqual([0, 0, 0]);
    store.close();
  }
});

test("restart persists applying as uncertain before serialized check-only recovery", async () => {
  const store = new Store(":memory:");
  const first = {...completed(), cover: {state: "applying", helperAttempted: true} as PlaylistCover};
  const second = {...completed(), cover: {state: "pending", helperAttempted: false} as PlaylistCover};
  store.put("job", first.id, first); store.put("job", second.id, second);
  const states: string[] = [];
  const put = store.put.bind(store);
  store.put = (kind, id, value) => {if (id === first.id) states.push((value as MusicJob).cover!.state); put(kind, id, value);};
  let release!: () => void;
  const wait = new Promise<void>(resolve => release = resolve);
  const calls: CoverContext[] = [];
  const jobs = new Jobs(store, adapter({playlistCover: async (_id: string, context: CoverContext) => {
    calls.push(context);
    if (calls.length === 1) await wait;
    return {state: "blocked", code: calls.length === 1 ? "identity-mismatch" : "journal-missing", writeAttempted: false, helperAttempted: true};
  }}));
  expect(jobs.isActive()).toBe(true);
  expect(() => create(jobs)).toThrow("already running");
  expect(calls).toHaveLength(1);
  expect(states).toEqual(["uncertain", "applying"]);
  release();
  await finished(jobs, second.id);
  expect(calls.map(c => c.connectionGeneration)).toEqual(["saved", "saved"]);
  expect(jobs.get(first.id)).toMatchObject({state: "complete", cover: {state: "uncertain"}});
  expect(jobs.get(second.id)).toMatchObject({state: "complete", cover: {state: "uncertain", code: "journal-missing"}});
  for (const action of ["retry", "permission", "retry"] as const) {jobs.coverAction(first.id, action); await finished(jobs, first.id);}
  expect(calls.map(c => c.mode)).toEqual(["check", "check", "check", "authorize", "check"]);
  expect(jobs.get(first.id)?.cover?.state).toBe("uncertain");
  store.close();
});

test("older jobs do not gain automatic cover eligibility on retry or restart", async () => {
  const store = new Store(":memory:");
  const old = {...completed(), coverEligible: undefined, cover: {state: "pending", helperAttempted: false} as PlaylistCover};
  store.put("job", old.id, old);
  let covers = 0;
  const jobs = new Jobs(store, adapter({playlistCover: async () => {covers++; throw new Error("Old playlist must be untouched");}}));
  expect(jobs.isActive()).toBe(false);
  expect(jobs.get(old.id)).toEqual(JSON.parse(JSON.stringify(old)));
  const partial = {...completed(), coverEligible: undefined, state: "partial", tracks: [{track: track(1), state: "failed"}]} as MusicJob;
  store.put("job", partial.id, partial);
  jobs.retry(partial.id);
  expect(await finished(jobs, partial.id)).toMatchObject({state: "complete"});
  expect(jobs.get(partial.id)?.cover).toBeUndefined();
  expect(covers).toBe(0);
  store.close();
});

test("native setter intent survives permission, generation and identity rejection", async () => {
  const store = new Store(":memory:");
  const job = {...completed(), cover: {state: "uncertain", helperAttempted: true, writeAttempted: true} as PlaylistCover};
  store.put("job", job.id, job);
  const modes: string[] = [];
  let statusFails = true;
  const jobs = new Jobs(store, adapter({getMusicStatus: async () => {if (statusFails) throw new Error("Lost status"); return {generation: "new"};}, playlistCover: async (_id: string, context: CoverContext) => {
    modes.push(context.mode);
    return {state: "blocked", code: context.mode === "authorize" ? "automation-permission" : "identity-mismatch", helperAttempted: true, writeAttempted: false};
  }}));
  jobs.coverAction(job.id, "retry");
  expect(await finished(jobs, job.id)).toMatchObject({state: "complete", cover: {state: "uncertain", writeAttempted: true}});
  statusFails = false;
  for (const action of ["permission", "retry"] as const) {
    jobs.coverAction(job.id, action);
    expect(await finished(jobs, job.id)).toMatchObject({state: "complete", cover: {state: "uncertain", writeAttempted: true}});
  }
  expect(modes).toEqual(["authorize", "check"]);
  store.close();
});

test("cover actions reject old, unmarked and unfinished jobs without touching them", () => {
  const store = new Store(":memory:");
  const jobs = new Jobs(store, adapter());
  for (const changes of [{coverEligible: undefined}, {writer: undefined}, {id: "not-a-uuid"}, {creationState: "unknown"}, {state: "partial"}, {state: "cancelled"}, {tracks: [{track: track(1), state: "added"}]}]) {
    const job = {...completed(), ...changes} as MusicJob;
    store.put("job", job.id, job);
    for (const action of ["retry", "check", "permission"] as const) expect(() => jobs.coverAction(job.id, action)).toThrow("eligible");
    expect(jobs.get(job.id)).toEqual(job);
  }
  store.close();
});

test("known pre-write blocks can apply again but permission only authorizes", async () => {
  const store = new Store(":memory:");
  const job = {...completed(), cover: {state: "blocked", code: "automation-permission", helperAttempted: true, writeAttempted: false} as PlaylistCover};
  store.put("job", job.id, job);
  const calls: string[] = [];
  const jobs = new Jobs(store, adapter({playlistCover: async (_id: string, context: CoverContext) => {
    calls.push(context.mode);
    return {state: "blocked", code: "permission-ready", helperAttempted: true, writeAttempted: false};
  }}));
  for (const action of ["permission", "retry", "check"] as const) {jobs.coverAction(job.id, action); await finished(jobs, job.id);}
  expect(calls).toEqual(["authorize", "apply", "check"]);
  store.close();
});

test("web retry protects legacy jobs without changing them", () => {
  const store = new Store(":memory:");
  const old: MusicJob = {id: "old", name: "Old", playlistId: "ABCDEF1234567890", state: "partial", tracks: [{track: track(1), state: "added"}, {track: track(2), state: "failed"}], message: "Old", createdAt: "now", updatedAt: "now"};
  store.put("job", old.id, old);
  const jobs = new Jobs(store, adapter());
  expect(() => jobs.retry(old.id)).toThrow("legacy");
  expect(jobs.get(old.id)).toEqual(old);
  store.close();
});

test("unknown create never retries a playlist POST", async () => {
  const store = new Store(":memory:");
  let creates = 0;
  const jobs = new Jobs(store, adapter({ensurePlaylist: async () => {creates++; throw Object.assign(new Error("Create reply lost"), {uncertain: true});}}));
  const job = await finished(jobs, create(jobs).id);
  expect(job).toMatchObject({state: "failed", creationState: "unknown"});
  expect(() => jobs.retry(job.id)).toThrow("unknown");
  expect(creates).toBe(1);
  store.close();
});

test("restart retains interrupted append uncertainty and unknown create", () => {
  const store = new Store(":memory:");
  for (const [id, playlistId] of [["append", "p.test"], ["create", undefined]] as const) {
    store.put("job", id, {id, name: "Test", writer: "web-session", connectionGeneration: "initial", creationState: "in-flight", playlistId, state: "running", tracks: [{track: track(1), state: "adding"}, {track: track(2), state: "pending"}], message: "Working", createdAt: "now", updatedAt: "now"});
  }
  const jobs = new Jobs(store, adapter());
  expect(jobs.get("append")).toMatchObject({state: "interrupted", creationState: "known", tracks: [{state: "failed", outcome: "uncertain"}, {state: "pending"}]});
  expect(jobs.get("create")).toMatchObject({state: "interrupted", creationState: "unknown"});
  store.close();
});

test("unconfirmed identity and rejected additions stop later songs", async () => {
  for (const outcome of [{kind: "confirmed", catalogId: "99", alreadyPresent: false}, {kind: "not-added", message: "Rejected"}, {kind: "conflict", message: "Edited"}]) {
    const store = new Store(":memory:");
    const calls: number[] = [];
    const jobs = new Jobs(store, adapter({addTrackToPlaylist: async (t: DraftTrack) => {calls.push(t.catalogId); return outcome;}}));
    const job = await finished(jobs, create(jobs).id);
    expect(job.state).toBe("failed");
    expect(job.tracks.map(t => t.state)).toEqual(["failed", "pending", "pending"]);
    expect(calls).toEqual([1]);
    store.close();
  }
});

test("rebind rejection preserves known job and starts no append", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const jobs = new Jobs(store, adapter({rebindPlaylist: async () => {throw new Error("Not in this account");}, addTrackToPlaylist: async () => {calls++; return {kind: "not-added", message: "Expired"};}}));
  const job = await finished(jobs, create(jobs).id);
  jobs.retry(job.id);
  const retry = await finished(jobs, job.id);
  expect(retry).toMatchObject({playlistId: "p.test", connectionGeneration: "initial", state: "failed"});
  expect(calls).toBe(1);
  store.close();
});

test("web cancel keeps the settling uncertain result", async () => {
  const store = new Store(":memory:");
  let release!: () => void;
  let started!: () => void;
  const wait = new Promise<void>(resolve => release = resolve);
  const start = new Promise<void>(resolve => started = resolve);
  const jobs = new Jobs(store, adapter({addTrackToPlaylist: async () => {started(); await wait; return {kind: "uncertain", message: "Pending"};}}));
  const job = create(jobs);
  await start;
  jobs.cancel(job.id);
  release();
  expect(await finished(jobs, job.id)).toMatchObject({state: "cancelled", tracks: [{state: "failed", outcome: "uncertain"}, {state: "pending"}, {state: "pending"}]});
  store.close();
});
