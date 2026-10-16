import {expect, test} from "bun:test";
import {createWebMusicAdapter, runBridgeRequest} from "../src/web-music";
import type {DraftTrack} from "../src/types";
import {Store} from "../src/store";
import {Jobs} from "../src/jobs";

const track = (id: number) => ({catalogId: id}) as DraftTrack;
const coverContext = {jobId: "12345678-1234-1234-1234-123456789abc", name: "Test", connectionGeneration: "g1", expectedCatalogIds: ["1"], mode: "apply" as const};

test("cover adapter sends marked identity and validates typed native results", async () => {
  const commands: unknown[] = [];
  const adapter = createWebMusicAdapter(async input => {commands.push(input); return input.action === "ensurePlaylist" ? {id: "p.test"} : {state: "verified", code: "image-verified", writeAttempted: true, imageHash: "a".repeat(64)};});
  await adapter.ensurePlaylist("Test", undefined, {...coverContext});
  expect(await adapter.playlistCover("p.test", coverContext)).toEqual({state: "verified", code: "image-verified", helperAttempted: true, writeAttempted: true, imageHash: "a".repeat(64)});
  expect(commands).toEqual([
    {action: "ensurePlaylist", name: "Test", generation: "g1", catalogIds: ["1"], jobId: coverContext.jobId},
    {action: "playlistCover", name: "Test", playlistId: "p.test", generation: "g1", catalogIds: ["1"], jobId: coverContext.jobId, coverMode: "apply"},
  ]);
});

test("malformed or lost cover results are uncertain and never expose native text or paths", async () => {
  for (const result of [null, [], {}, {state: "blocked", code: "automation-permission", writeAttempted: "false"}, {state: "blocked", code: "secret", writeAttempted: false}, {state: "verified", code: "image-verified", writeAttempted: false}, {state: "blocked", code: "automation-permission", writeAttempted: false, imageHash: "A".repeat(64)}, {state: "blocked", code: "automation-permission", writeAttempted: false, path: "/secret/image.jpg"}]) {
    const adapter = createWebMusicAdapter(async () => result);
    expect(await adapter.playlistCover("p.test", coverContext)).toEqual({state: "uncertain", code: "malformed", helperAttempted: true});
  }
  const lost = createWebMusicAdapter(async () => {throw new Error("secret native text");});
  expect(await lost.playlistCover("p.test", coverContext)).toEqual({state: "uncertain", code: "connection-unconfirmed", helperAttempted: true});
  const rejected = createWebMusicAdapter(async () => {throw Object.assign(new Error("secret"), {code: "generation-changed", uncertain: false});});
  expect(await rejected.playlistCover("p.test", coverContext)).toEqual({state: "blocked", code: "generation-changed", helperAttempted: true, writeAttempted: false});
  expect(await rejected.playlistCover("p.test", {...coverContext, mode: "check"})).toMatchObject({state: "uncertain", code: "generation-changed"});
});

test("cover IPC accepts cover fields and treats lost apply replies as potentially mutating", async () => {
  const request = {action: "playlistCover" as const, playlistId: "p.test", generation: "g1", jobId: coverContext.jobId, name: "Test", catalogIds: ["1"], coverMode: "apply" as const};
  expect(await runBridgeRequest(request, {command: [process.execPath, "-e", "console.log(JSON.stringify({ok:true,result:{state:'blocked',code:'automation-permission',writeAttempted:false}}))"]})).toMatchObject({state: "blocked"});
  for (const script of ["console.log('secret')", "process.exit(1)", "console.log('s'.repeat(140000))", "await Bun.sleep(1000)"]) {
    await expect(runBridgeRequest(request, {command: [process.execPath, "-e", script], timeoutMs: 50})).rejects.toMatchObject({uncertain: true});
  }
});

test("cover validation rejects coerced state and retains intent in malformed native replies", async () => {
  const malformed = createWebMusicAdapter(async () => ({state: ["blocked"], code: "automation-permission", writeAttempted: false}));
  expect(await malformed.playlistCover("p.test", coverContext)).toEqual({state: "uncertain", code: "malformed", helperAttempted: true});
  const intent = createWebMusicAdapter(async () => ({state: "bad", code: "secret native detail", writeAttempted: true}));
  expect(await intent.playlistCover("p.test", coverContext)).toEqual({state: "uncertain", code: "malformed", helperAttempted: true, writeAttempted: true});
  const matched = createWebMusicAdapter(async () => ({state: "verified", code: "image-verified", writeAttempted: false, imageHash: "b".repeat(64)}));
  expect(await matched.playlistCover("p.test", coverContext)).toMatchObject({state: "verified", writeAttempted: false});
});

test("bridge cover keys cannot be smuggled into unrelated operations", async () => {
  for (const input of [{action: "status", jobId: null}, {action: "ensurePlaylist", coverMode: null}, {action: "playlistCover", coverMode: "apply", position: null}, {action: "playlistCover", coverMode: "apply", reconcileOnly: null}]) {
    await expect(runBridgeRequest(input as never, {command: [process.execPath, "-e", "process.exit(42)"]})).rejects.toMatchObject({code: "invalid-input", uncertain: false});
  }
});

test("catalog IPC rejects unscoped fields and invalid IDs before invoking a helper", async () => {
  for (const input of [
    {action: "status", country: "AU"},
    {action: "ensurePlaylist", artistId: "7"},
    {action: "catalogArtists", country: "AU", term: "Band", releaseId: "10"},
    {action: "catalogArtists", country: "AU", term: "Band", offset: 0},
    {action: "catalogReleases", country: "AU", artistId: "https://evil.test", offset: 0},
    {action: "catalogTracks", country: "AU", releaseId: "10", offset: -1},
    {action: "catalogTracks", country: "ZZ", releaseId: "10", offset: 0},
  ]) await expect(runBridgeRequest(input as never, {command: [process.execPath, "-e", "console.log(JSON.stringify({ok:true,result:{}}))"]})).rejects.toMatchObject({code: "invalid-input", uncertain: false});
});

test("catalog date failures explain why chronological preview stopped", async () => {
  await expect(runBridgeRequest({action: "catalogReleases", generation: "g1", country: "AU", artistId: "7", offset: 0}, {command: [process.execPath, "-e", "console.log(JSON.stringify({ok:false,error:{code:'catalog-date',uncertain:false}}))"]})).rejects.toThrow("full Apple release date");
});
test("web adapter binds availability and ordered writes to the native generation", async () => {
  const commands: unknown[] = [];
  const adapter = createWebMusicAdapter(async input => {
    commands.push(input);
    if (input.action === "status") return {platform: "darwin", running: false, accessibility: false, automation: "unknown", backend: "web-session", connection: "saved", generation: "g1", message: "Saved"};
    if (input.action === "inspectTracks") return {generation: "g1", storefront: "au", total: 2, availableCatalogTracks: 2, unavailableCatalogTracks: 0, unavailableCatalogIds: [], newLibraryAdditions: 0, existingLibrarySongs: 0};
    if (input.action === "ensurePlaylist") return {id: "p.test", name: "Test"};
    return {kind: "confirmed", catalogId: "1", alreadyPresent: false};
  });
  expect(await adapter.inspectTracks([track(1), track(2)])).toMatchObject({generation: "g1", availableCatalogTracks: 2, unavailableCatalogIds: []});
  await adapter.ensurePlaylist("Test", undefined, {connectionGeneration: "g1", expectedCatalogIds: ["1", "2"]});
  expect(await adapter.addTrackToPlaylist(track(1), "p.test", {connectionGeneration: "g1", expectedCatalogIds: ["1", "2"], position: 0, reconcileOnly: false})).toEqual({kind: "confirmed", catalogId: "1", alreadyPresent: false});
  expect(commands).toEqual([
    {action: "status"},
    {action: "inspectTracks", generation: "g1", catalogIds: ["1", "2"]},
    {action: "ensurePlaylist", name: "Test", generation: "g1", catalogIds: ["1", "2"]},
    {action: "addTrackToPlaylist", playlistId: "p.test", generation: "g1", catalogIds: ["1", "2"], position: 0, reconcileOnly: false},
  ]);
});

test("catalog inspection identifies unavailable songs and rejects malformed ID lists", async () => {
  const inspect = async (unavailableCatalogIds: unknown, unavailableCatalogTracks = 1, tracks = [track(1), track(2)]) => {
    const adapter = createWebMusicAdapter(async input => input.action === "status" ? {generation: "g1"} : {generation: "g1", storefront: "au", total: tracks.length, availableCatalogTracks: tracks.length - unavailableCatalogTracks, unavailableCatalogTracks, unavailableCatalogIds});
    return adapter.inspectTracks(tracks);
  };
  expect(await inspect(["2"])).toMatchObject({availableCatalogTracks: 1, unavailableCatalogTracks: 1, unavailableCatalogIds: ["2"]});
  for (const ids of [undefined, null, "2", [2], ["3"], ["2", "2"], [], ["1", "2"]]) await expect(inspect(ids)).rejects.toMatchObject({uncertain: false});
  expect(await inspect(["2"], 2, [track(1), track(2), track(2)])).toMatchObject({availableCatalogTracks: 1, unavailableCatalogTracks: 2, unavailableCatalogIds: ["2"]});
});

test("bridge IPC sends metadata on stdin, never argv, and discards diagnostics", async () => {
  const result = await runBridgeRequest({action: "status"}, {command: [process.execPath, "-e", `const text = await Bun.stdin.text(); console.error('do-not-expose'); console.log(JSON.stringify({ok:true,result:{action:JSON.parse(text).action, argv:process.argv.slice(2)}}));`]});
  expect(result).toEqual({action: "status", argv: []});
});

test("lost or malformed create replies stay uncertain and redact process output", async () => {
  for (const script of [`console.error('secret-diagnostic');process.exit(1)`, `console.log('secret-not-json')`, `console.log(JSON.stringify({ok:false,error:{code:'storage',message:'secret-diagnostic',uncertain:false}}))`]) {
    try {await runBridgeRequest({action: "ensurePlaylist", generation: "g1", name: "Test", catalogIds: ["1"]}, {command: [process.execPath, "-e", script]}); throw new Error("Unexpected success");}
    catch (error) {
      expect((error as Error).message).not.toContain("secret");
      expect((error as {uncertain: boolean}).uncertain).toBe(script.includes("code:'storage'") ? false : true);
    }
  }
});

test("bounded IPC rejects credential operations before starting a helper", async () => {
  for (const input of [{action: "saveConnection", credentials: {bearer: "fake", user: "fake"}}, {action: "status", credentials: {bearer: "fake", user: "fake"}}, {action: "ensurePlaylist", name: "x".repeat(140000)}]) {
    await expect(runBridgeRequest(input as never, {command: ["/definitely-not-a-helper"]})).rejects.toMatchObject({uncertain: false});
  }
});

test("bridge output size and deadline cannot leak errors or repeat a write", async () => {
  for (const script of [`console.log('s'.repeat(140000))`, `await Bun.sleep(1000)`]) {
    await expect(runBridgeRequest({action: "addTrackToPlaylist", generation: "g1", playlistId: "p.test", catalogIds: ["1"], position: 0}, {command: [process.execPath, "-e", script], timeoutMs: 30})).rejects.toMatchObject({uncertain: true});
  }
});

test("malformed successful create reply blocks a second create", async () => {
  const store = new Store(":memory:");
  let creates = 0;
  const adapter = createWebMusicAdapter(async input => {
    if (input.action === "status") return {generation: "g1"};
    creates++;
    return runBridgeRequest(input, {command: [process.execPath, "-e", "console.log(JSON.stringify({ok:true,result:[]}))"]});
  });
  const jobs = new Jobs(store, adapter);
  const job = jobs.create("Test", [track(1)], false, "g1");
  for (let i = 0; i < 100 && jobs.isActive(); i++) await Bun.sleep(5);
  expect(jobs.get(job.id)?.creationState).toBe("unknown");
  expect(() => jobs.retry(job.id)).toThrow("unknown");
  expect(creates).toBe(1);
  store.close();
});

test("malformed successful append is uncertain, never eligible for a blind POST retry", async () => {
  const adapter = createWebMusicAdapter(async () => []);
  expect(await adapter.addTrackToPlaylist(track(1), "p.test", {connectionGeneration: "g1", expectedCatalogIds: ["1"], position: 0, reconcileOnly: false})).toMatchObject({kind: "uncertain"});
  await expect(adapter.ensurePlaylist("Test", undefined, {connectionGeneration: "g1", expectedCatalogIds: ["1"]})).rejects.toMatchObject({uncertain: true});
});

test("retry after malformed append reads only when delayed addition is absent", async () => {
  const store = new Store(":memory:");
  let posts = 0;
  const reconciliations: number[] = [];
  const adapter = createWebMusicAdapter(async input => {
    if (input.action === "status") return {generation: "g1"};
    if (input.action === "ensurePlaylist") return {id: "p.test"};
    if (input.action === "rebindPlaylist") return {generation: "g1"};
    if (input.position === 0) return {kind: "confirmed", catalogId: "1", alreadyPresent: true};
    if (input.reconcileOnly) {reconciliations.push(input.position!); return {kind: "uncertain", message: "Delayed write is not visible"};}
    posts++; return [];
  });
  const jobs = new Jobs(store, adapter);
  const job = jobs.create("Test", [track(1), track(2)], false, "g1");
  for (let i = 0; i < 100 && jobs.isActive(); i++) await Bun.sleep(5);
  expect(jobs.get(job.id)?.tracks.map(t => t.state)).toEqual(["added", "failed"]);
  jobs.retry(job.id);
  for (let i = 0; i < 100 && jobs.isActive(); i++) await Bun.sleep(5);
  expect(posts).toBe(1);
  expect(reconciliations).toEqual([1]);
  expect(jobs.get(job.id)?.tracks[1]?.outcome).toBe("uncertain");
  store.close();
});
