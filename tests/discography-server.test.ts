import {expect, test} from "bun:test";
import {createApp} from "../src/server";
import {createWebMusicAdapter} from "../src/web-music";
import {Store} from "../src/store";
import type {Draft} from "../src/types";

test("artist search requires local authorization and validates terms before returning catalog identities", async () => {
  const store = new Store(":memory:");
  let searches = 0;
  const music = createWebMusicAdapter(async input => {
    if (input.action === "status") return {generation: "g1"};
    if (input.action !== "catalogArtists") throw new Error("Unexpected catalog operation");
    searches++;
    return {generation: "g1", storefront: "au", artists: [{id: 7, name: "Band", url: "https://music.apple.com/au/artist/7"}]};
  });
  const app = createApp({store, port: 8769, music, discovery: {getGenres: async () => [], buildDraft: async () => {throw new Error("Not discovery");}}});
  const req = (body: unknown, origin = "http://127.0.0.1:8769") => new Request("http://127.0.0.1:8769/api/artists/search", {method: "POST", headers: {host: "127.0.0.1:8769", origin, "content-type": "application/json", "x-wavelength-token": app.token}, body: JSON.stringify(body)});
  try {
    expect((await app.fetch(req({term: "Band", country: "AU"}, "https://evil.test"))).status).toBe(403);
    for (const body of [{term: "", country: "AU"}, {term: "Band", country: "ZZ"}, {term: "Band", country: "AU", url: "https://evil.test"}]) expect((await app.fetch(req(body))).status).toBe(400);
    expect(searches).toBe(0);
    const response = await app.fetch(req({term: "Band", country: "AU"}));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({artists: [{id: 7, name: "Band", url: "https://music.apple.com/au/artist/7"}], storefront: "au"});
    expect(searches).toBe(1);
  } finally {app.dispose(); store.close();}
});

test("discography draft uses authenticated catalog and submits selected occurrences in release order", async () => {
  const store = new Store(":memory:");
  let finishCreation!: () => void;
  const hold = new Promise<void>(resolve => finishCreation = resolve);
  let orderedIds: string[] = [];
  const music = createWebMusicAdapter(async input => {
    if (input.action === "status") return {generation: "g1"};
    if (input.action === "catalogReleases") return {generation: "g1", storefront: "au", releases: [{id: 9, name: "Early", releaseDate: "2000-01-01", trackCount: 1, url: "https://music.apple.com/au/album/9"}, {id: 10, name: "Later", releaseDate: "2001-01-01", trackCount: 1, url: "https://music.apple.com/au/album/10"}]};
    if (input.action === "catalogTracks") return {generation: "g1", storefront: "au", tracks: [{id: 5, artistId: 7, title: "Song", artist: "Band", album: "Album", durationMs: 1000, discNumber: 1, trackNumber: 1, url: "https://music.apple.com/au/song/5"}]};
    if (input.action === "inspectTracks") return {generation: "g1", storefront: "au", total: 2, availableCatalogTracks: 2, unavailableCatalogTracks: 0, unavailableCatalogIds: []};
    if (input.action === "ensurePlaylist") {orderedIds = input.catalogIds!; await hold; throw Object.assign(new Error("Fixture stops creation"), {uncertain: false});}
    throw new Error("Unexpected writer action");
  });
  const app = createApp({store, port: 8769, music, discovery: {getGenres: async () => [], buildDraft: async () => {throw new Error("Related artists must not be consulted");}}});
  const req = (path: string, body: unknown) => new Request(`http://127.0.0.1:8769${path}`, {method: "POST", headers: {host: "127.0.0.1:8769", origin: "http://127.0.0.1:8769", "content-type": "application/json", "x-wavelength-token": app.token}, body: JSON.stringify(body)});
  try {
    const response = await app.fetch(req("/api/drafts", {mode: "discography", artistId: 7, seed: "Band", country: "AU", count: 30, perArtist: 1, selection: "mix", includeAI: false}));
    expect(response.status).toBe(200);
    const initial = await response.json();
    for (let i = 0; i < 100 && store.get<Draft>("draft", initial.id)?.status === "building"; i++) await Bun.sleep(1);
    const draft = store.get<Draft>("draft", initial.id)!;
    expect(draft.status).toBe("ready");
    expect(draft.title).toContain("discography");
    expect(draft.tracks.map(t => t.releaseId)).toEqual([9, 10]);
    const selection = {draftId: draft.id, trackIds: draft.tracks.map(t => t.id).reverse(), includeAI: false};
    const check = await app.fetch(req("/api/preflight", selection));
    expect(check.status).toBe(200);
    const receipt = await check.json();
    const result = await app.fetch(req("/api/jobs", {...selection, name: "Band discography", preflightId: receipt.id}));
    expect(result.status).toBe(200);
    const job = await result.json();
    expect(job.tracks.map((item: {track: {releaseId: number}}) => item.track.releaseId)).toEqual([9, 10]);
    expect(orderedIds).toEqual(["5", "5"]);
  } finally {
    finishCreation();
    for (let i = 0; i < 100 && app.jobs.isActive(); i++) await Bun.sleep(1);
    app.dispose(); store.close();
  }
});
