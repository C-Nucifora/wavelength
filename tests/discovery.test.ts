import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDraft, parseArtists, parseGenreIndex, matchTrack, selectTracks } from "../src/discovery";
import type { DraftTrack, SeedRequest } from "../src/types";

describe("Every Noise HTML", () => {
  test("decodes genre labels and takes only genre navigation links", async () => {
    const html = '<div class="genre scanme">r&amp;b<a class="navlink" href="engenremap-rb.html">&raquo;</a></div><a href="evil.html">other</a>';
    expect(await parseGenreIndex(html)).toEqual([{ name: "r&b", slug: "rb" }]);
  });
  test("keeps artist, representative title, and profile together", async () => {
    const html = '<div class="genre scanme" title="e.g. A &amp; B &quot;A Song (Live) &amp; More&quot;">A &amp; B<a class="navlink" href="artistprofile.html?id=abc123">&raquo;</a></div>';
    expect(await parseArtists(html)).toEqual([{ name: "A & B", representative: "A Song (Live) & More", source: "Every Noise", sourceUrl: "https://everynoise.com/artistprofile.html?id=abc123" }]);
  });
});

describe("catalog identity", () => {
  test("ignores remaster labels but preserves meaningful subtitles", () => {
    expect(matchTrack("Brian Eno", "An Ending (Ascent) - Remastered 2005", "Brian Eno", "An Ending (Ascent)")).toBe("exact");
    expect(matchTrack("Beyoncé", "Halo", "Beyonce", "Halo")).toBe("exact");
    expect(matchTrack("A", "Song (Part 1)", "A", "Song (Part 2)")).toBe("review");
  });
  test("does not select covers, live versions, or remixes as the original", () => {
    expect(matchTrack("A", "Song", "B", "Song")).toBe("review");
    expect(matchTrack("A", "Song", "A", "Song (Live)")).toBe("review");
    expect(matchTrack("A", "Song (Live)", "A", "Song (Radio Mix)")).toBe("review");
    expect(matchTrack("A", "Song", "A", "Song (Club Remix)")).toBe("review");
  });
});

const track = (catalogId: number, artistId: number, kind: "ai" | "unknown" = "unknown"): DraftTrack => ({
  id: `apple:${catalogId}`, catalogId, artistId, title: "Song", artist: "A", album: "Album", durationMs: 1000,
  releaseDate: "2025-01-01", url: "https://music.apple.com/au/song/1", source: "Every Noise", match: "exact",
  provenance: { kind, evidence: [] }, selected: true,
});

test("excludes known AI, keeps unknown visible, deduplicates and applies artist cap", () => {
  const result = selectTracks([track(1, 1), track(1, 1), track(2, 1), track(3, 1), track(4, 2, "ai"), track(5, 3)], 10, 2, false);
  expect(result.map(t => t.catalogId)).toEqual([1, 2, 5]);
  expect(result[0]?.provenance.kind).toBe("unknown");
  expect(selectTracks([track(4, 2, "ai")], 10, 2, true)).toHaveLength(1);
});

test("an already cancelled build makes no requests", async () => {
  const request: SeedRequest = { mode: "artist", seed: "Brian Eno", count: 10, selection: "mix", perArtist: 2, includeAI: false, country: "AU" };
  const controller = new AbortController();
  controller.abort();
  await expect(buildDraft(request, { signal: controller.signal, onProgress: () => {}, provenance: () => undefined })).rejects.toMatchObject({ name: "AbortError" });
});

const request: SeedRequest = { mode: "genre", seed: "ambient", count: 3, selection: "essentials", perArtist: 2, includeAI: false, country: "AU" };
async function withFetch(handler: (url: string) => Response | Promise<Response>, run: () => Promise<void>) {
  const original = globalThis.fetch;
  const originalDir = process.env.WAVELENGTH_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), "wavelength-discovery-test-"));
  process.env.WAVELENGTH_DATA_DIR = directory;
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => handler(String(input)), { preconnect: original.preconnect }) as typeof fetch;
  try { await run(); } finally {
    globalThis.fetch = original;
    if (originalDir === undefined) delete process.env.WAVELENGTH_DATA_DIR; else process.env.WAVELENGTH_DATA_DIR = originalDir;
    await rm(directory, { recursive: true, force: true });
  }
}
test("build uses recorded provenance and leaves same-name catalog artists unselected", async () => {
  await withFetch(url => {
    if (url.endsWith("engenremap.html")) return new Response('<div class="genre">ambient<a href="engenremap-ambient.html">»</a></div>');
    if (url.endsWith("engenremap-ambient.html")) return new Response('<div class="genre scanme" title="e.g. Synthetic &quot;Song&quot;">Synthetic</div><div class="genre scanme" title="e.g. Band &quot;Song&quot;">Band</div>');
    const artist = new URL(url).searchParams.get("term")!.startsWith("Synthetic") ? "Synthetic" : "Band";
    const ids = artist === "Synthetic" ? [1] : [2, 3];
    return Response.json({ results: ids.map(id => ({ kind: "song", trackId: id, artistId: id, artistName: artist, trackName: "Song", trackViewUrl: `https://music.apple.com/au/song/${id}` })) });
  }, async () => {
    const result = await buildDraft(request, { signal: new AbortController().signal, onProgress: () => {}, provenance: id => id === 1 ? { kind: "ai", evidence: ["https://example.com/artist-statement"] } : undefined });
    expect(result.tracks.map(t => t.catalogId)).toEqual([2, 3]);
    expect(result.tracks.every(t => !t.selected && t.match === "review")).toBe(true);
    expect(result.warnings.some(w => w.includes("Excluded"))).toBe(true);
  });
}, 15000);

test("upstream failures return a visible fallback and shortfall", async () => {
  await withFetch(() => new Response("down", { status: 503 }), async () => {
    const result = await buildDraft({ ...request, mode: "artist", seed: "Unavailable" }, { signal: new AbortController().signal, onProgress: () => {}, provenance: () => undefined });
    expect(result.tracks).toEqual([]);
    expect(result.warnings.some(w => w.includes("seed artist tracks only"))).toBe(true);
    expect(result.warnings.some(w => w.includes("HTTP 503"))).toBe(true);
    expect(result.warnings.some(w => w.includes("shortfall"))).toBe(true);
  });
}, 15000);

test("abort during a source request propagates rather than producing a fallback", async () => {
  const controller = new AbortController();
  await withFetch(() => { controller.abort(); throw new DOMException("Cancelled", "AbortError"); }, async () => {
    await expect(buildDraft({ ...request, mode: "artist" }, { signal: controller.signal, onProgress: () => {}, provenance: () => undefined })).rejects.toMatchObject({ name: "AbortError" });
  });
}, 15000);

test("mix combines the exact representative with a recent release, skipping duplicate catalog IDs", async () => {
  await withFetch(url => {
    if (url.endsWith("engenremap.html")) return new Response('<div class="genre">ambient<a href="engenremap-ambient.html">»</a></div>');
    if (url.endsWith("engenremap-ambient.html")) return new Response('<div class="genre scanme" title="e.g. Band &quot;Classic&quot;">Band</div>');
    const song = (id: number, title: string, date: string) => ({ kind: "song", trackId: id, artistId: 10, artistName: "Band", trackName: title, releaseDate: date, trackViewUrl: `https://music.apple.com/au/song/${id}` });
    if (new URL(url).pathname === "/lookup") return Response.json({ results: [song(11, "Classic", "1990-01-01"), song(12, "Latest", "2026-01-01")] });
    return Response.json({ results: [song(13, "Classic (Club Remix)", "2025-01-01"), song(11, "Classic", "1990-01-01")] });
  }, async () => {
    const result = await buildDraft({ ...request, selection: "mix", count: 2 }, { signal: new AbortController().signal, onProgress: () => {}, provenance: () => undefined });
    expect(result.tracks.map(t => t.catalogId)).toEqual([11, 12]);
    expect(result.tracks.every(t => t.selected)).toBe(true);
    expect(result.tracks[0]?.source).toContain("Essentials");
    expect(result.tracks[1]?.source).toContain("Recent");
    expect(result.warnings.some(w => w.includes("Reissues"))).toBe(true);
  });
}, 15000);

test("mix with one song per artist alternates essentials and recent across artists", async () => {
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    await withFetch(url => {
      if (url.endsWith("engenremap.html")) return new Response('<div class="genre">ambient<a href="engenremap-ambient.html">»</a></div>');
      if (url.endsWith("engenremap-ambient.html")) return new Response('<div class="genre scanme" title="e.g. A &quot;Classic&quot;">A</div><div class="genre scanme" title="e.g. B &quot;Classic&quot;">B</div>');
      const parsed = new URL(url);
      if (parsed.pathname === "/lookup") return Response.json({ results: [{ kind: "song", trackId: 22, artistId: 20, artistName: "B", trackName: "Latest", releaseDate: "2026-01-01", trackViewUrl: "https://music.apple.com/au/song/22" }] });
      const artist = parsed.searchParams.get("term")!.startsWith("A") ? "A" : "B";
      const id = artist === "A" ? 10 : 20;
      return Response.json({ results: [{ kind: "song", trackId: id + 1, artistId: id, artistName: artist, trackName: "Classic", releaseDate: "1990-01-01", trackViewUrl: `https://music.apple.com/au/song/${id + 1}` }] });
    }, async () => {
      const result = await buildDraft({ ...request, selection: "mix", perArtist: 1, count: 2 }, { signal: new AbortController().signal, onProgress: () => {}, provenance: () => undefined });
      expect(result.tracks.map(t => t.catalogId)).toEqual([11, 22]);
      expect(result.tracks[0]?.source).toContain("Essentials");
      expect(result.tracks[1]?.source).toContain("Recent");
    });
  } finally { Math.random = originalRandom; }
}, 20000);
