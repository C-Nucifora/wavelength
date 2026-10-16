import {expect, test} from "bun:test";
import {createWebMusicAdapter} from "../src/web-music";
import {validateSeed, selectTracks} from "../src/validation";
import type {Draft, SeedRequest} from "../src/types";

const request = {mode: "discography", artistId: 7, seed: "Band", country: "AU", count: 1, perArtist: 1, selection: "mix", includeAI: false} as SeedRequest;
const options = () => ({signal: new AbortController().signal, onProgress: () => {}, provenance: () => undefined});
const release = (id: number, name: string, releaseDate: string, trackCount = 1) => ({id, name, releaseDate, trackCount, url: `https://music.apple.com/au/album/${id}`});
const song = (id: number, discNumber = 1, trackNumber = 1) => ({id, artistId: 7, title: `Song ${id}`, artist: "Band", album: "Album", durationMs: 1000, discNumber, trackNumber, url: `https://music.apple.com/au/song/${id}`});
const envelope = (value: object) => ({generation: "g1", storefront: "au", ...value});

test("discography orders complete releases and discs while retaining repeated songs across releases", async () => {
  const adapter = createWebMusicAdapter(async input => {
    if (input.action === "status") return {generation: "g1"};
    if (input.action === "catalogReleases") return input.offset ? envelope({releases: [release(20, "Album", "2001-01-01", 3)]}) : envelope({releases: [release(30, "Later", "2002-01-01"), release(10, "Single", "2000-01-01")], nextOffset: 2});
    if (input.action === "catalogTracks") {
      if (input.releaseId === "10") return envelope({tracks: [song(5)]});
      if (input.releaseId === "20") return input.offset ? envelope({tracks: [song(5, 1, 1)]}) : envelope({tracks: [song(7, 2, 1), song(6, 1, 2)], nextOffset: 2});
      return envelope({tracks: [song(8)]});
    }
    throw new Error("Unexpected catalog operation");
  });
  const result = await adapter.buildDiscography(request, options());
  expect(result.tracks.map(t => [t.releaseId, t.catalogId, t.discNumber, t.trackNumber])).toEqual([[10, 5, 1, 1], [20, 5, 1, 1], [20, 6, 1, 2], [20, 7, 2, 1], [30, 8, 1, 1]]);
  expect(new Set(result.tracks.map(t => t.id)).size).toBe(5);
  expect(result.tracks.map(t => t.releaseDate)).toEqual(["2000-01-01", "2001-01-01", "2001-01-01", "2001-01-01", "2002-01-01"]);
  expect(result.tracks.every(t => t.selected && t.match === "exact" && t.provenance.kind === "unknown")).toBe(true);
});

test("discography rejects incomplete tracklists, invalid dates, looping pages and oversized catalogs", async () => {
  for (const variant of ["missing-track", "date", "loop", "too-many", "duplicate-position", "generation", "storefront"] as const) {
    const adapter = createWebMusicAdapter(async input => {
      if (input.action === "status") return {generation: "g1"};
      if (input.action === "catalogReleases") {
        const releases = [release(10, "Album", variant === "date" ? "2000-02-30" : "2000-01-01", variant === "missing-track" ? 2 : variant === "too-many" ? 1001 : variant === "duplicate-position" ? 2 : 1)];
        return envelope({releases, ...(variant === "loop" ? {nextOffset: 0} : {}), ...(variant === "generation" ? {generation: "g2"} : {}), ...(variant === "storefront" ? {storefront: "us"} : {})});
      }
      return envelope({tracks: variant === "duplicate-position" ? [song(5), song(6)] : [song(5)]});
    });
    await expect(adapter.buildDiscography(request, options())).rejects.toThrow();
  }
});

test("discography stops cancelled requests and applies local AI assessments without relaxing default filtering", async () => {
  let calls = 0;
  const adapter = createWebMusicAdapter(async input => {
    calls++;
    if (input.action === "status") return {generation: "g1"};
    if (input.action === "catalogReleases") return envelope({releases: [release(10, "Single", "2000-01-01")]});
    return envelope({tracks: [song(5)]});
  });
  const controller = new AbortController(); controller.abort();
  await expect(adapter.buildDiscography(request, {...options(), signal: controller.signal})).rejects.toMatchObject({name: "AbortError"});
  expect(calls).toBe(0);
  const result = await adapter.buildDiscography(request, {...options(), provenance: () => ({kind: "ai" as const, evidence: ["Self disclosure"]})});
  expect(result.tracks).toHaveLength(0);
  expect(result.warnings.join(" ")).toContain("AI");
});

test("artist search returns exact selectable catalog identities and rejects storefront or generation changes", async () => {
  for (const variant of ["valid", "storefront", "generation", "bad-id"] as const) {
    const adapter = createWebMusicAdapter(async input => input.action === "status" ? {generation: "g1"} : envelope({artists: [{id: variant === "bad-id" ? 0 : 7, name: "Band", url: "https://music.apple.com/au/artist/7"}], ...(variant === "storefront" ? {storefront: "us"} : {}), ...(variant === "generation" ? {generation: "g2"} : {})}));
    if (variant === "valid") expect(await adapter.searchArtists("Band", "AU")).toEqual({artists: [{id: 7, name: "Band", url: "https://music.apple.com/au/artist/7"}], storefront: "au"});
    else await expect(adapter.searchArtists("Band", "AU")).rejects.toThrow();
  }
});

test("catalog artist links retain trusted iTunes URLs while rejecting other hosts", async () => {
  for (const url of ["https://itunes.apple.com/au/artist/7", "https://evil.test/artist/7"]) {
    const adapter = createWebMusicAdapter(async input => input.action === "status" ? {generation: "g1"} : envelope({artists: [{id: 7, name: "Band", url}]}));
    if (url.startsWith("https://itunes.apple.com/")) expect((await adapter.searchArtists("Band", "AU")).artists[0]?.url).toBe("https://itunes.apple.com/au/artist/7");
    else await expect(adapter.searchArtists("Band", "AU")).rejects.toThrow();
  }
});

test("discography validation ignores discovery caps and restores canonical draft order for occurrence selection", () => {
  expect(validateSeed({...request, count: 1000, perArtist: 1000})).toMatchObject({mode: "discography", artistId: 7});
  for (const artistId of [undefined, 0, -1, "7", 1.5]) expect(() => validateSeed({...request, artistId})).toThrow();
  const tracks = Array.from({length: 51}, (_, i) => ({id: `occurrence:${i}`, catalogId: i === 0 ? 5 : i, artistId: 7, title: "Song", artist: "Band", album: "Album", durationMs: 1000, releaseDate: "2000-01-01", url: "https://music.apple.com/au/song/5", source: "test", selected: true, match: "exact" as const, provenance: {kind: "unknown" as const, evidence: []}}));
  const draft: Draft = {id: "draft", title: "Band", warnings: [], progress: {done: 1, total: 1, message: "Ready"}, createdAt: "now", status: "ready", request, tracks};
  expect(selectTracks(draft, tracks.map(t => t.id).reverse(), () => undefined).map(t => t.id)).toEqual(tracks.map(t => t.id));
  expect(() => selectTracks({...draft, request: {...request, mode: "artist"}}, tracks.map(t => t.id), () => undefined)).toThrow();
});

test("discography reads beyond 200 songs and refuses to return a truncated draft beyond 1000 occurrences", async () => {
  for (const count of [1000, 1001]) {
    const adapter = createWebMusicAdapter(async input => {
      if (input.action === "status") return {generation: "g1"};
      if (input.action === "catalogReleases") return envelope({releases: [release(10, "Complete", "2000-01-01", count)]});
      const offset = input.offset ?? 0;
      return envelope({tracks: Array.from({length: Math.min(50, count - offset)}, (_, i) => song(5, 1, offset + i + 1)), ...(offset + 50 < count ? {nextOffset: offset + 50} : {})});
    });
    if (count === 1000) {
      const result = await adapter.buildDiscography(request, options());
      expect(result.tracks).toHaveLength(1000);
      expect(result.tracks[999]?.trackNumber).toBe(1000);
      expect(new Set(result.tracks.map(t => t.id)).size).toBe(1000);
    } else await expect(adapter.buildDiscography(request, options())).rejects.toThrow("1,000 songs");
  }
});

test("same-date releases sort by name then ID and video-only rows are accounted for without entering the playlist", async () => {
  const adapter = createWebMusicAdapter(async input => {
    if (input.action === "status") return {generation: "g1"};
    if (input.action === "catalogReleases") return envelope({releases: [release(30, "B", "2000-01-01", 2), release(20, "A", "2000-01-01"), release(10, "A", "2000-01-01")]});
    return envelope({tracks: [song(Number(input.releaseId))], skippedMusicVideos: input.releaseId === "30" ? 1 : 0});
  });
  const result = await adapter.buildDiscography(request, options());
  expect(result.tracks.map(t => t.releaseId)).toEqual([10, 20, 30]);
  expect(result.warnings.join(" ")).toContain("1 music videos");
});

test("catalog cancellation after a page prevents subsequent helper reads", async () => {
  const controller = new AbortController();
  let reads = 0;
  const adapter = createWebMusicAdapter(async input => {
    if (input.action === "status") return {generation: "g1"};
    reads++;
    controller.abort();
    return envelope({releases: [release(10, "Album", "2000-01-01")], nextOffset: 1});
  });
  await expect(adapter.buildDiscography(request, {...options(), signal: controller.signal})).rejects.toMatchObject({name: "AbortError"});
  expect(reads).toBe(1);
});
