import {test, expect} from "bun:test";
import {createApp} from "../src/server";
import {Store} from "../src/store";
import type {DraftTrack, MusicJob} from "../src/types";
import {createWebMusicAdapter} from "../src/web-music";

test("cover-only API actions require empty authenticated bodies and exclude Music reads", async () => {
  const store = new Store(":memory:");
  const id = crypto.randomUUID();
  const track = {id: "one", catalogId: 1, artistId: 2, provenance: {kind: "unknown", evidence: []}} as unknown as DraftTrack;
  store.put("draft", "cover-test", {id: "cover-test", status: "ready", tracks: [track], request: {includeAI: false}});
  store.put("job", id, {id, name: "Test", writer: "web-session", coverEligible: true, connectionGeneration: "old", creationState: "known", state: "complete", playlistId: "p.test", tracks: [{track, state: "added", outcome: "confirmed"}], message: "Songs complete", createdAt: "now", updatedAt: "now", cover: {state: "blocked", code: "automation-permission", helperAttempted: true, writeAttempted: false}});
  const modes: string[] = [];
  let releaseCover!: () => void, releaseScan!: () => void;
  let holdCover = false;
  const coverWait = new Promise<void>(resolve => releaseCover = resolve);
  const scanWait = new Promise<void>(resolve => releaseScan = resolve);
  const music = createWebMusicAdapter(async input => {
    if (input.action === "status") return {generation: "current"};
    if (input.action !== "playlistCover") throw new Error("Songs must not be resent");
    expect(input.generation).toBe("current");
    modes.push(input.coverMode!);
    if (holdCover) await coverWait;
    return {state: "blocked", code: "automation-permission", writeAttempted: false};
  });
  const app = createApp({store, port: 8769, discovery: {getGenres: async () => [], buildDraft: async () => ({tracks: [], warnings: []})}, music, readLibraryHistory: async () => {await scanWait; throw new Error("Fixture ended");}});
  const req = (path: string, value: unknown = {}, origin = "http://127.0.0.1:8769") => new Request(`http://127.0.0.1:8769${path}`, {method: "POST", headers: {host: "127.0.0.1:8769", origin, "content-type": "application/json", "x-wavelength-token": app.token}, body: JSON.stringify(value)});
  const route = (action: string) => `/api/jobs/${id}/cover-${action}`;
  expect((await app.fetch(req(route("retry"), {}, "https://evil.test"))).status).toBe(403);
  for (const value of [{path: "/secret"}, {generation: "forged"}, [], null]) expect((await app.fetch(req(route("retry"), value))).status).toBe(400);
  expect(modes).toEqual([]);
  for (const action of ["permission", "retry", "check"]) {
    expect((await app.fetch(req(route(action)))).status).toBe(200);
    for (let i = 0; i < 100 && app.jobs.isActive(); i++) await Bun.sleep(5);
  }
  expect(modes).toEqual(["authorize", "apply", "check"]);
  expect(store.get<MusicJob>("job", id)).toMatchObject({state: "complete", message: "Songs complete"});
  holdCover = true;
  expect((await app.fetch(req(route("retry")))).status).toBe(200);
  expect((await app.fetch(req(route("permission")))).status).toBe(409);
  expect((await app.fetch(req("/api/history/library"))).status).toBe(409);
  expect((await app.fetch(req("/api/preflight", {draftId: "cover-test", trackIds: ["one"], includeAI: false}))).status).toBe(409);
  expect((await app.fetch(req("/api/jobs", {draftId: "cover-test", trackIds: ["one"], includeAI: false}))).status).toBe(400);
  releaseCover();
  for (let i = 0; i < 100 && app.jobs.isActive(); i++) await Bun.sleep(5);
  const scan = app.fetch(req("/api/history/library"));
  await Bun.sleep(1);
  expect((await app.fetch(req(route("retry")))).status).toBe(409);
  expect((await app.fetch(req("/api/jobs", {draftId: "cover-test", trackIds: ["one"], includeAI: false}))).status).toBe(409);
  releaseScan(); await scan;
  app.dispose(); store.close();
});

test("local API builds server-owned draft and rejects foreign writes", async () => {
  const store = new Store(":memory:");
  const track: DraftTrack = {id: "one", catalogId: 1, artistId: 2, title: "Song", artist: "Artist", album: "Album", durationMs: 120000, releaseDate: "2026-01-01", url: "https://music.apple.com/", source: "test", match: "exact", provenance: {kind: "unknown", evidence: []}, selected: true};
  const app = createApp({store, port: 8769, discovery: {getGenres: async () => [{name: "ambient", slug: "ambient"}], buildDraft: async (_request, opts) => {opts.onProgress({done: 1, total: 1, message: "Found"}); return {tracks: [track], warnings: []};}}, music: {getMusicStatus: async () => ({platform: "darwin", running: true, accessibility: true, automation: "granted", message: "Ready"}), ensurePlaylist: async name => ({id: "ABCDEF1234567890", name}), addTrackToPlaylist: async () => ({libraryId: "one", alreadyPresent: false}), openPlaylist: async () => {}}});
  const request = (path: string, body?: unknown, changes = {}) => new Request(`http://127.0.0.1:8769${path}`, {method: body === undefined ? "GET" : "POST", headers: {host: "127.0.0.1:8769", origin: "http://127.0.0.1:8769", "content-type": "application/json", "x-wavelength-token": app.token, ...changes}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const seed = {mode: "genre", seed: "ambient", count: 1, perArtist: 1, selection: "mix", includeAI: false, country: "AU"};
  expect((await app.fetch(request("/api/drafts", seed, {origin: "https://evil.test"}))).status).toBe(403);
  const response = await app.fetch(request("/api/drafts", seed));
  expect(response.status).toBe(200);
  const draft = await response.json();
  await Bun.sleep(5);
  const ready = await (await app.fetch(request(`/api/drafts/${draft.id}`))).json();
  expect(ready.status).toBe("ready");
  expect(ready.tracks[0].catalogId).toBe(1);
  const forged = await app.fetch(request("/api/jobs", {draftId: draft.id, name: "Test", trackIds: ["forged"], includeAI: false}));
  expect(forged.status).toBe(400);
  expect((await forged.json()).error).toContain("Song not found");
  await app.fetch(request("/api/provenance", {artistId: 2, kind: "ai", evidence: "Artist self-disclosure"}));
  const excluded = await app.fetch(request("/api/jobs", {draftId: draft.id, name: "Test", trackIds: ["one"], includeAI: false}));
  expect(excluded.status).toBe(400);
  expect((await excluded.json()).error).toContain("AI artists are off");
  expect((await app.fetch(request("/api/provenance", {artistId: 2, kind: "made-up"}))).status).toBe(400);
  expect((await app.fetch(request("/native/library.jxa"))).status).toBe(404);
  expect((await app.fetch(request("/api/drafts", {big: "x".repeat(140000)}))).status).toBe(413);
  store.close();
});

test("cancelled discovery cannot overwrite itself with ready results", async () => {
  const store = new Store(":memory:");
  let release!: () => void;
  const wait = new Promise<void>(resolve => release = resolve);
  const app = createApp({store, port: 8769, discovery: {getGenres: async () => [], buildDraft: async () => {await wait; return {tracks: [], warnings: []};}}, music: {getMusicStatus: async () => {throw new Error("unused");}, ensurePlaylist: async () => {throw new Error("unused");}, addTrackToPlaylist: async () => {throw new Error("unused");}, openPlaylist: async () => {}}});
  const req = (path: string, body: unknown) => new Request(`http://127.0.0.1:8769${path}`, {method: "POST", headers: {host: "127.0.0.1:8769", origin: "http://127.0.0.1:8769", "content-type": "application/json", "x-wavelength-token": app.token}, body: JSON.stringify(body)});
  const draft = await (await app.fetch(req("/api/drafts", {mode: "artist", seed: "Autechre", count: 1, perArtist: 1, selection: "mix", includeAI: false, country: "AU"}))).json();
  await app.fetch(req(`/api/drafts/${draft.id}/cancel`, {}));
  release();
  await Bun.sleep(5);
  expect(store.get<{status: string}>("draft", draft.id)?.status).toBe("cancelled");
  store.close();
});

test("creation requires a library preflight for the same selection and AI choice", async () => {
  const store = new Store(":memory:");
  const track: DraftTrack = {id: "one", catalogId: 1, artistId: 2, title: "Song", artist: "Artist", album: "Album", durationMs: 120000, releaseDate: "2026-01-01", url: "https://music.apple.com/", source: "test", match: "exact", provenance: {kind: "unknown", evidence: []}, selected: true};
  store.put("draft", "draft", {id: "draft", status: "ready", tracks: [track], request: {includeAI: false}});
  const app = createApp({store, port: 8769, discovery: {getGenres: async () => [], buildDraft: async () => ({tracks: [], warnings: []})}, music: {getMusicStatus: async () => ({platform: "darwin", running: true, accessibility: true, automation: "granted", message: "Ready"}), inspectTracks: async tracks => ({newLibraryAdditions: tracks.length, existingLibrarySongs: 0, total: tracks.length}), ensurePlaylist: async name => ({id: "ABCDEF1234567890", name}), addTrackToPlaylist: async () => ({libraryId: "one", alreadyPresent: false}), openPlaylist: async () => {}}});
  const req = (path: string, body: unknown) => new Request(`http://127.0.0.1:8769${path}`, {method: "POST", headers: {host: "127.0.0.1:8769", origin: "http://127.0.0.1:8769", "content-type": "application/json", "x-wavelength-token": app.token}, body: JSON.stringify(body)});
  const selection = {draftId: "draft", trackIds: ["one"], includeAI: false};
  expect((await app.fetch(req("/api/jobs", {...selection, name: "Test"}))).status).toBe(400);
  const check = await (await app.fetch(req("/api/preflight", selection))).json();
  expect(check.newLibraryAdditions).toBe(1);
  expect((await app.fetch(req("/api/jobs", {...selection, includeAI: true, name: "Test", preflightId: check.id}))).status).toBe(400);
  const result = await app.fetch(req("/api/jobs", {...selection, name: "Test", preflightId: check.id}));
  expect(result.status).toBe(200);
  const job = await result.json();
  expect(job.includeAI).toBe(false);
  await Bun.sleep(5);
  store.close();
});

test("web selection receipt persists its checked generation and stale setup starts no write", async () => {
  const store = new Store(":memory:");
  const track: DraftTrack = {id: "one", catalogId: 1, artistId: 2, title: "Song", artist: "Artist", album: "Album", durationMs: 120000, releaseDate: "2026-01-01", url: "https://music.apple.com/", source: "test", match: "exact", provenance: {kind: "unknown", evidence: []}, selected: true};
  store.put("draft", "draft", {id: "draft", status: "ready", tracks: [track], request: {includeAI: false}});
  let generation = "g1";
  let available = 1;
  let writes = 0;
  const music = createWebMusicAdapter(async input => {
    if (input.action === "status") return {generation};
    if (input.generation !== generation) throw Object.assign(new Error("Connection changed"), {uncertain: false});
    if (input.action === "inspectTracks") return {generation, storefront: "au", total: 1, availableCatalogTracks: available, unavailableCatalogTracks: 1 - available, unavailableCatalogIds: available ? [] : ["1"]};
    writes++; return {id: "p.test", name: "Test"};
  });
  const app = createApp({store, port: 8769, discovery: {getGenres: async () => [], buildDraft: async () => ({tracks: [], warnings: []})}, music});
  const req = (path: string, body: unknown) => new Request(`http://127.0.0.1:8769${path}`, {method: "POST", headers: {host: "127.0.0.1:8769", origin: "http://127.0.0.1:8769", "content-type": "application/json", "x-wavelength-token": app.token}, body: JSON.stringify(body)});
  const selection = {draftId: "draft", trackIds: ["one"], includeAI: false};
  const check = await (await app.fetch(req("/api/preflight", selection))).json();
  expect(check).toMatchObject({generation: "g1", availableCatalogTracks: 1, unavailableCatalogIds: [], total: 1});
  generation = "g2";
  const response = await app.fetch(req("/api/jobs", {...selection, name: "Test", preflightId: check.id}));
  expect(response.status).toBe(200);
  const job = await response.json();
  await Bun.sleep(10);
  expect(app.jobs.get(job.id)).toMatchObject({writer: "web-session", connectionGeneration: "g1", state: "failed", creationState: "not-started"});
  expect(writes).toBe(0);
  available = 0;
  const unavailable = await (await app.fetch(req("/api/preflight", selection))).json();
  expect(unavailable).toMatchObject({total: 1, availableCatalogTracks: 0, unavailableCatalogTracks: 1, unavailableCatalogIds: ["1"]});
  expect((await app.fetch(req("/api/jobs", {...selection, name: "Test", preflightId: unavailable.id}))).status).toBe(400);
  expect(writes).toBe(0);
  app.dispose(); store.close();
});
