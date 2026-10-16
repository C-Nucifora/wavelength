import {test, expect} from "bun:test";
import {Store} from "../src/store";
import {Jobs} from "../src/jobs";
import type {DraftTrack, MusicJob} from "../src/types";

const track = (id: number): DraftTrack => ({id: String(id), catalogId: id, artistId: id, title: `Song ${id}`, artist: "Artist", album: "Album", durationMs: 120000, releaseDate: "2026-01-01", url: "https://music.apple.com/", source: "test", match: "exact", provenance: {kind: "unknown", evidence: []}, selected: true});
async function finished(jobs: Jobs, id: string) {
  for (let i = 0; i < 100; i++) {
    const job = jobs.get(id)!;
    if (!["queued", "running"].includes(job.state)) return job;
    await Bun.sleep(5);
  }
  throw new Error("Job did not finish");
}

test("retry keeps playlist ID and skips completed tracks", async () => {
  const store = new Store(":memory:");
  let fail = true;
  const additions: number[] = [];
  const playlistIds: (string | undefined)[] = [];
  const jobs = new Jobs(store, {
    ensurePlaylist: async (_name, id) => {playlistIds.push(id); return {id: id || "ABCDEF1234567890", name: "Test"};},
    addTrackToPlaylist: async t => {additions.push(t.catalogId); if (t.catalogId === 2 && fail) throw new Error("unavailable"); return {libraryId: String(t.catalogId), alreadyPresent: false};},
    openPlaylist: async () => {},
  });
  const first = jobs.create("Test", [track(1), track(2)]);
  expect((await finished(jobs, first.id)).state).toBe("partial");
  fail = false;
  jobs.retry(first.id);
  const retried = await finished(jobs, first.id);
  expect(retried.state).toBe("complete");
  expect(retried.tracks.map(t => t.state)).toEqual(["added", "added"]);
  expect(additions).toEqual([1, 2, 2]);
  expect(playlistIds).toEqual([undefined, "ABCDEF1234567890"]);
  store.close();
});

test("cancel stops after current addition and retains its result", async () => {
  const store = new Store(":memory:");
  let release!: () => void;
  const wait = new Promise<void>(resolve => release = resolve);
  let started!: () => void;
  const start = new Promise<void>(resolve => started = resolve);
  const jobs = new Jobs(store, {ensurePlaylist: async () => ({id: "ABCDEF1234567890", name: "Test"}), addTrackToPlaylist: async () => {started(); await wait; return {libraryId: "one", alreadyPresent: false};}, openPlaylist: async () => {}});
  expect(jobs.isActive()).toBe(false);
  const job = jobs.create("Test", [track(1), track(2)]);
  expect(jobs.isActive()).toBe(true);
  await start;
  expect(() => jobs.create("Other", [track(3)])).toThrow("already running");
  jobs.cancel(job.id);
  expect(jobs.isActive()).toBe(true);
  release();
  const result = await finished(jobs, job.id);
  expect(jobs.isActive()).toBe(false);
  expect(result.state).toBe("cancelled");
  expect(result.tracks.map(t => t.state)).toEqual(["added", "pending"]);
  store.close();
});

test("restart marks an unfinished job interrupted", () => {
  const store = new Store(":memory:");
  const job: MusicJob = {id: "old", name: "Test", playlistId: "ABCDEF1234567890", state: "running", tracks: [{track: track(1), state: "added"}, {track: track(2), state: "adding"}], message: "Adding", createdAt: "now", updatedAt: "now"};
  store.put("job", job.id, job);
  const jobs = new Jobs(store, {ensurePlaylist: async () => ({id: "ABCDEF1234567890", name: "Test"}), addTrackToPlaylist: async () => ({libraryId: "one", alreadyPresent: false}), openPlaylist: async () => {}});
  expect(jobs.get("old")?.state).toBe("interrupted");
  expect(jobs.get("old")?.tracks.map(t => t.state)).toEqual(["added", "failed"]);
  store.close();
});

test("playlist creation failure does not claim additions", async () => {
  const store = new Store(":memory:");
  const jobs = new Jobs(store, {ensurePlaylist: async () => {throw new Error("Permission denied");}, addTrackToPlaylist: async () => {throw new Error("Should not add");}, openPlaylist: async () => {}});
  const job = await finished(jobs, jobs.create("Test", [track(1)]).id);
  expect(job.state).toBe("failed");
  expect(job.playlistId).toBeUndefined();
  expect(job.message).toBe("Permission denied");
  expect(job.tracks[0]?.state).toBe("pending");
  store.close();
});

test("retry preserves AI-off policy and checks current artist assessments", async () => {
  const store = new Store(":memory:");
  let isAI = false;
  const jobs = new Jobs(store, {ensurePlaylist: async () => ({id: "ABCDEF1234567890", name: "Test"}), addTrackToPlaylist: async () => {throw new Error("Temporary failure");}, openPlaylist: async () => {}}, (t, includeAI) => {
    if (isAI && !includeAI) throw new Error("AI artists are off.");
    return t;
  });
  const job = await finished(jobs, jobs.create("Test", [track(1)], false).id);
  isAI = true;
  expect(() => jobs.retry(job.id)).toThrow("AI");
  expect(jobs.get(job.id)?.state).toBe("failed");
  store.close();
});

test("status returns an older active retry rather than a newer completed job", async () => {
  const store = new Store(":memory:");
  let retry = false;
  let release!: () => void;
  const wait = new Promise<void>(resolve => release = resolve);
  const jobs = new Jobs(store, {ensurePlaylist: async () => ({id: "ABCDEF1234567890", name: "Test"}), addTrackToPlaylist: async t => {
    if (t.catalogId === 1) {if (!retry) throw new Error("Failed"); await wait;}
    return {libraryId: String(t.catalogId), alreadyPresent: false};
  }, openPlaylist: async () => {}});
  const older = await finished(jobs, jobs.create("Old", [track(1)]).id);
  await finished(jobs, jobs.create("New", [track(2)]).id);
  retry = true;
  jobs.retry(older.id);
  expect(jobs.latest()?.id).toBe(older.id);
  release();
  await finished(jobs, older.id);
  expect(jobs.latest()?.id).toBe(older.id);
  store.close();
});
