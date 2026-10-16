import {expect, test} from "bun:test";
import {Jobs} from "../src/jobs";
import {Store} from "../src/store";
import {createWebMusicAdapter} from "../src/web-music";
import type {DraftTrack, MusicJob} from "../src/types";

const track = (id: number): DraftTrack => ({id: String(id), catalogId: id, artistId: id, title: `Song ${id}`, artist: "Artist", album: "Album", durationMs: 120000, releaseDate: "2026-01-01", url: "https://music.apple.com/", source: "test", match: "exact", provenance: {kind: "unknown", evidence: []}, selected: true});
async function finished(jobs: Jobs, id: string) {
  for (let i = 0; i < 100 && jobs.isActive(); i++) await Bun.sleep(5);
  expect(jobs.isActive()).toBe(false);
  return jobs.get(id)!;
}

test("seed intent is saved before create and verified before ordered duplicate additions and cover", async () => {
  const store = new Store(":memory:");
  const saved: MusicJob[] = [], commands: unknown[] = [], writes: number[] = [];
  let createIntent: MusicJob | undefined;
  const contents = ["1"];
  const put = store.put.bind(store);
  store.put = (kind, id, value) => {if (kind === "job") saved.push(structuredClone(value as MusicJob)); put(kind, id, value);};
  const music = createWebMusicAdapter(async input => {
    commands.push(input);
    if (input.action === "ensurePlaylist") {createIntent = store.get<MusicJob>("job", input.jobId!); return {id: "p.seed"};}
    if (input.action === "addTrackToPlaylist") {
      const position = input.position!;
      if (!input.reconcileOnly) {writes.push(position); contents.push(input.catalogIds![position]!);}
      return {kind: "confirmed", catalogId: contents[position], alreadyPresent: input.reconcileOnly === true};
    }
    if (input.action === "playlistCover") {
      expect(contents).toEqual(["1", "1", "2"]);
      expect(store.get<MusicJob>("job", input.jobId!)?.tracks.every(t => t.state === "added" && t.outcome === "confirmed")).toBe(true);
      return {state: "blocked", code: "automation-permission", writeAttempted: false};
    }
    throw new Error("Unexpected boundary request");
  });
  const jobs = new Jobs(store, music);
  const result = await finished(jobs, jobs.create("Seed", [track(1), track(1), track(2)], false, "g1").id);
  expect(createIntent).toMatchObject({creationState: "in-flight", tracks: [{state: "adding", outcome: "uncertain"}, {state: "pending"}, {state: "pending"}]});
  expect(createIntent?.playlistId).toBeUndefined();
  expect(saved.find(j => j.creationState === "known")?.tracks[0]).toMatchObject({state: "adding", outcome: "uncertain"});
  expect(result).toMatchObject({state: "complete", cover: {state: "blocked"}});
  expect(writes).toEqual([1, 2]);
  expect(commands).toEqual([
    {action: "ensurePlaylist", name: "Seed", generation: "g1", catalogIds: ["1", "1", "2"], jobId: result.id},
    ...[0, 1, 2].map(position => ({action: "addTrackToPlaylist", playlistId: "p.seed", generation: "g1", catalogIds: ["1", "1", "2"], position, reconcileOnly: position === 0})),
    {action: "playlistCover", playlistId: "p.seed", name: "Seed", generation: "g1", catalogIds: ["1", "1", "2"], jobId: result.id, coverMode: "apply"},
  ]);
  store.close();
});

test("unconfirmed seed reads and definite read errors never permit an append on known-ID retry", async () => {
  for (const reply of [{kind: "uncertain"}, {}, {kind: "not-added"}, new Error("Lost read"), Object.assign(new Error("Stale generation"), {uncertain: false})]) {
    const store = new Store(":memory:");
    let creates = 0, writes = 0, covers = 0;
    const reads: boolean[] = [];
    const music = createWebMusicAdapter(async input => {
      if (input.action === "status" || input.action === "rebindPlaylist") return {generation: "g2"};
      if (input.action === "ensurePlaylist") {creates++; return {id: "p.seed"};}
      if (input.action === "playlistCover") {covers++; throw new Error("No cover before confirmation");}
      reads.push(input.reconcileOnly === true);
      if (!input.reconcileOnly) writes++;
      if (reply instanceof Error) throw reply;
      return reply;
    });
    const jobs = new Jobs(store, music);
    const first = await finished(jobs, jobs.create("Seed", [track(1), track(2)], false, "g1").id);
    expect(first).toMatchObject({state: "failed", creationState: "known", playlistId: "p.seed", tracks: [{state: "failed", outcome: "uncertain"}, {state: "pending"}]});
    expect(first.cover).toBeUndefined();
    jobs.retry(first.id);
    const retried = await finished(jobs, first.id);
    expect(retried.state).toBe("failed");
    expect(retried.tracks[0]?.outcome).toBe("uncertain");
    expect(reads).toEqual([true, true]);
    expect([creates, writes, covers]).toEqual([1, 0, 0]);
    store.close();
  }
});

test("lost seeded create reply preserves possible seed and blocks a second create", async () => {
  const store = new Store(":memory:");
  let creates = 0;
  const jobs = new Jobs(store, createWebMusicAdapter(async () => {creates++; throw new Error("Lost reply");}));
  const result = await finished(jobs, jobs.create("Seed", [track(1)], false, "g1").id);
  expect(result).toMatchObject({creationState: "unknown", tracks: [{outcome: "uncertain"}]});
  expect(result.cover).toBeUndefined();
  expect(() => jobs.retry(result.id)).toThrow("unknown");
  expect(creates).toBe(1);
  store.close();
});

test("restart before and after known-ID save preserves seeded uncertainty without automatic cover", async () => {
  const original = new Store(":memory:");
  const snapshots: MusicJob[] = [];
  const jobs = new Jobs(original, createWebMusicAdapter(async input => {
    if (input.action === "ensurePlaylist") {snapshots.push(original.all<MusicJob>("job")[0]!); return {id: "p.seed"};}
    snapshots.push(original.all<MusicJob>("job")[0]!);
    return {kind: "uncertain"};
  }));
  await finished(jobs, jobs.create("Seed", [track(1)], false, "g1").id);
  for (const snapshot of snapshots) {
    const store = new Store(":memory:");
    store.put("job", snapshot.id, snapshot);
    const actions: string[] = [];
    const recovered = new Jobs(store, createWebMusicAdapter(async input => {
      actions.push(input.action);
      if (input.action === "status" || input.action === "rebindPlaylist") return {generation: "g2"};
      expect(input.reconcileOnly).toBe(true);
      return {kind: "uncertain"};
    }));
    expect(recovered.get(snapshot.id)).toMatchObject({state: "interrupted", tracks: [{outcome: "uncertain"}]});
    expect(actions).toEqual([]);
    if (!snapshot.playlistId) expect(() => recovered.retry(snapshot.id)).toThrow("unknown");
    else {
      recovered.retry(snapshot.id);
      expect(await finished(recovered, snapshot.id)).toMatchObject({tracks: [{outcome: "uncertain"}]});
      expect(actions).toEqual(["status", "rebindPlaylist", "addTrackToPlaylist"]);
    }
    store.close();
  }
  original.close();
});

test("cancellation during seeded creation retains possible seed without cover or append", async () => {
  const store = new Store(":memory:");
  let release!: (value: unknown) => void;
  const wait = new Promise(resolve => release = resolve);
  const actions: string[] = [];
  const jobs = new Jobs(store, createWebMusicAdapter(async input => {actions.push(input.action); return wait;}));
  const job = jobs.create("Seed", [track(1), track(2)], false, "g1");
  jobs.cancel(job.id);
  release({id: "p.seed"});
  const result = await finished(jobs, job.id);
  expect(result).toMatchObject({state: "cancelled", creationState: "known", tracks: [{outcome: "uncertain"}, {state: "pending"}]});
  expect(result.cover).toBeUndefined();
  expect(actions).toEqual(["ensurePlaylist"]);
  store.close();
});

test("seed assessment rejection prevents playlist creation", async () => {
  const store = new Store(":memory:");
  const actions: string[] = [];
  const jobs = new Jobs(store, createWebMusicAdapter(async input => {actions.push(input.action); return {id: "p.seed"};}), () => {throw new Error("AI artists are off");});
  const result = await finished(jobs, jobs.create("Seed", [track(1)], false, "g1").id);
  expect(result).toMatchObject({state: "failed", creationState: "not-started"});
  expect(actions).toEqual([]);
  store.close();
});

test("assessment failure after seeded create cannot erase possible-write intent", async () => {
  const store = new Store(":memory:");
  let assessments = 0;
  const actions: unknown[] = [];
  const jobs = new Jobs(store, createWebMusicAdapter(async input => {
    actions.push(input);
    if (input.action === "ensurePlaylist") return {id: "p.seed"};
    if (input.action === "status" || input.action === "rebindPlaylist") return {generation: "g2"};
    return {kind: "uncertain"};
  }), t => {if (++assessments === 2) throw new Error("AI artists are off"); return t;});
  const first = await finished(jobs, jobs.create("Seed", [track(1)], false, "g1").id);
  expect(first).toMatchObject({state: "failed", tracks: [{outcome: "uncertain"}]});
  expect(first.tracks[0]?.error).toBe("AI artists are off");
  jobs.retry(first.id);
  expect(await finished(jobs, first.id)).toMatchObject({state: "failed", tracks: [{outcome: "uncertain"}]});
  expect(actions).toEqual([
    {action: "ensurePlaylist", name: "Seed", generation: "g1", catalogIds: ["1"], jobId: first.id},
    {action: "status"},
    {action: "rebindPlaylist", playlistId: "p.seed", generation: "g2", catalogIds: ["1"], position: 0, reconcileOnly: true},
    {action: "addTrackToPlaylist", playlistId: "p.seed", generation: "g2", catalogIds: ["1"], position: 0, reconcileOnly: true},
  ]);
  store.close();
});

test("old known unseeded not-added jobs retain append behavior and cover eligibility", async () => {
  const store = new Store(":memory:");
  const old: MusicJob = {id: "old", name: "Old", writer: "web-session", connectionGeneration: "g1", creationState: "known", playlistId: "p.old", state: "failed", tracks: [{track: track(1), state: "failed", outcome: "not-added"}], message: "Stopped", createdAt: "now", updatedAt: "now"};
  store.put("job", old.id, old);
  const actions: unknown[] = [];
  const jobs = new Jobs(store, createWebMusicAdapter(async input => {
    actions.push(input);
    if (input.action === "status" || input.action === "rebindPlaylist") return {generation: "g2"};
    return {kind: "confirmed", catalogId: "1", alreadyPresent: false};
  }));
  expect(jobs.get(old.id)).toEqual(old);
  jobs.retry(old.id);
  const result = await finished(jobs, old.id);
  expect(result.state).toBe("complete");
  expect(result.coverEligible).toBeUndefined();
  expect(result.cover).toBeUndefined();
  expect(actions).toEqual([{action: "status"}, {action: "rebindPlaylist", playlistId: "p.old", generation: "g2", catalogIds: ["1"], position: 0, reconcileOnly: true}, {action: "addTrackToPlaylist", playlistId: "p.old", generation: "g2", catalogIds: ["1"], position: 0, reconcileOnly: false}]);
  store.close();
});
