import {afterEach, expect, test} from "bun:test";
import {chmod, link, mkdir, mkdtemp, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {parseAppleCSV, normalizeLibraryRead, libraryEnvelope} from "../src/history";
import {summarizeHistory} from "../src/history-summary";
import {buildDiscography} from "../src/discography";
import {parseArtists, parseGenreIndex, matchTrack, buildDraft} from "../src/discovery";
import {captureSnapshot, verifyFiles, validateSnapshot} from "../scripts/release";
import {createWebMusicAdapter} from "../src/web-music";
import type {ExportEnvelope, LibraryTrack} from "../src/history-types";
import type {SeedRequest} from "../src/types";

// Only synthetic input; run this file alone with the required flock and TMPDIR.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true}); });
async function scratch() { const root = await mkdtemp(join(tmpdir(), "round1-data-")); roots.push(root); return root; }
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const header = "Song Name,Event End Timestamp,Artist,Album Name,Play Duration Milliseconds,Media Duration In Milliseconds";
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
async function* chunks(bytes: Uint8Array, widths: number[]) {
  let offset = 0, index = 0;
  while (offset < bytes.length) { const end = offset + widths[index++ % widths.length]!; yield bytes.subarray(offset, end); offset = end; }
}
const encoded = (value: string, widths = [17]) => chunks(new TextEncoder().encode(value), widths);
function random(seed: number) { let state = seed >>> 0; return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0); }
const track = (overrides: Partial<LibraryTrack> = {}): LibraryTrack => ({id: "0000000000000001", title: "Song", artist: "Artist", albumArtist: "Artist", album: "Album", genre: "Genre", durationMs: 1000, playedCount: 1, playedAt: null, skippedCount: null, skippedAt: null, addedAt: null, favorite: null, ...overrides});
const query = {source: "export" as const, offset: 0, limit: 100, timeZone: "UTC"};

// 48 seeds, 12 rows each, five byte partition schedules per seed.
test("D: seeded CSV round trips and chunk-invariant summaries", async () => {
  const atoms = ["é", "🎧", "汉", "e\u0301", ',', '"', '\r', '\n', '__proto__', 'constructor', 'toString', ' '];
  for (let seed = 1; seed <= 48; seed++) {
    const rng = random(seed);
    const rows = Array.from({length: 12}, (_, i) => [`Song${i} ` + Array.from({length: 6}, () => atoms[rng() % atoms.length]).join(""), "2026-10-01T00:00:00Z", atoms[i % atoms.length]!.trim() || "Artist", "Album", String(i * 3), "99999"]);
    const csv = "\uFEFF" + header + "\r\n" + rows.map(row => row.map(quote).join(",")).join("\r\n") + "\r\n";
    const baseline = await parseAppleCSV(encoded(csv, [100000]));
    expect(baseline.records.map(record => record.title)).toEqual(rows.map(row => row[0]!));
    expect(baseline.coverage.acceptedRows).toBe(12);
    for (const widths of [[1], [2], [3], [7], [1 + rng() % 13, 1 + rng() % 13, 1 + rng() % 13]]) {
      expect(await parseAppleCSV(encoded(csv, widths))).toEqual(baseline);
    }
    const envelope: ExportEnvelope = {schemaVersion: 1, source: "export", importedAt: "2026-10-02T00:00:00Z", ...baseline};
    for (const kind of ["tracks", "artists", "daily", "monthly", "hourly"] as const) {
      const summary = summarizeHistory([envelope], {...query, kind}, 0);
      expect(summary.sources[0]!.totals.reportedDurationMs).toBe(198);
      expect(summary.page!.rows.reduce((sum, row) => sum + (row.activityRecords ?? 0), 0)).toBe(12);
      expect(summarizeHistory([{...envelope, records: [...envelope.records].reverse()}], {...query, kind}, 0)).toEqual(summary);
    }
  }
});

test("D: invalid UTF-8 rejects at every split", async () => {
  const prefix = new TextEncoder().encode(header + "\nSong,,Artist,Album,0,0");
  const invalid = [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82], [0xff], [0x80]];
  for (const bytes of invalid) {
    const input = new Uint8Array([...prefix, ...bytes]);
    for (const width of [1, 2, 3, 17]) await expect(parseAppleCSV(chunks(input, [width]))).rejects.toThrow(/UTF-8/);
  }
});

test("D: malformed CSV grammar, ambiguous profiles and normalized duplicate headers reject", async () => {
  const inputs = [header + '\n"unterminated', header + '\n"Song"x,,,,,', header + '\nSo"ng,,,,,', header + '\nSong,', 'Song Name,Event End Timestamp, song NAME\nSong,,', 'Song Name,Event End Timestamp,Track Description,Date Played\nSong,,Other,'];
  for (const input of inputs) for (const width of [1, 2, 7]) await expect(parseAppleCSV(encoded(input, [width]))).rejects.toThrow();
});

test("D: Unicode field bound counts code points across split UTF-8", async () => {
  expect((await parseAppleCSV(encoded(header + '\n' + '🎧'.repeat(4000) + ',,,,,', [1]))).records[0]!.title).toBe('🎧'.repeat(4000));
  await expect(parseAppleCSV(encoded(header + '\n' + '🎧'.repeat(4001) + ',,,,,', [3]))).rejects.toThrow(/4,000/);
});

test("D: contradictory supplied artist never borrows other library metadata", async () => {
  for (const artist of ["Other", "artist", "Ártist", "__proto__", "constructor"]) {
    const parsed = await parseAppleCSV(encoded(header + '\nSong,2026-10-01,' + artist + ',Album,0,1000', [1]), [track()]);
    expect(parsed.records[0]).toMatchObject({artist, genre: null, albumArtist: null, enriched: [], reportedDurationMs: 0});
    expect(parsed.coverage.unmatchedRows).toBe(1);
  }
});

test("D: library contradictory counts and prototype-like metadata stay bounded and explicit", () => {
  for (const bad of [-1, Infinity, NaN, true, "12", 1.5]) {
    const result = normalizeLibraryRead({complete: true, declaredTrackCount: 1, tracks: [track({artist: "__proto__", playedCount: bad as number})]});
    expect(result.tracks[0]!.playedCount).toBeNull();
    const summary = summarizeHistory([libraryEnvelope(result, "2026-10-02T00:00:00Z")], {...query, source: "library", kind: "artists"}, 0);
    expect(summary.page!.rows[0]!.label).toBe("__proto__");
    expect(summary.sources[0]!.totals.libraryPlayCount).toBeNull();
  }
});

const request: SeedRequest = {mode: "discography", seed: "Synthetic", artistId: 7, count: 1, perArtist: 1, selection: "essentials", includeAI: false, country: "AU"};
const options = () => ({signal: new AbortController().signal, onProgress: () => {}, provenance: (id: number) => id === 8 ? {kind: "ai" as const, evidence: ["https://example.invalid/evidence"]} : undefined});
const release = (id: number, trackCount: number) => ({id, name: `Release ${id}`, releaseDate: "2026-01-01", trackCount, url: `https://music.apple.com/au/album/${id}`});
const song = (id: number, position = id) => ({id, artistId: 7, artist: "Synthetic", title: `Song ${id}`, discNumber: 1, trackNumber: position, durationMs: 1000, url: `https://music.apple.com/au/song/${id}`});
const page = (value: object) => ({generation: "synthetic-generation", storefront: "au", ...value});

test("E: 32 generated catalogs retain occurrences, canonical order and per-artist provenance", async () => {
  for (let seed = 101; seed <= 132; seed++) {
    const count = 1 + random(seed)() % 9;
    const output = await buildDiscography(request, options(), async input => {
      if (input.action === "status") return {generation: "synthetic-generation"};
      if (input.action === "catalogReleases") return page({releases: [release(20, count), release(10, count)]});
      const offset = input.offset ?? 0;
      const end = Math.min(count, offset + 3);
      return page({tracks: Array.from({length: end - offset}, (_, i) => ({...song(100 + i + offset, i + offset + 1), artistId: (i + offset) % 3 === 0 ? 8 : 7})).reverse(), ...(end < count ? {nextOffset: end} : {})});
    });
    const expected = [10, 20].flatMap(id => Array.from({length: count}, (_, i) => ({id, i})).filter(({i}) => i % 3 !== 0).map(({id, i}) => `apple:${id}:1:${i + 1}:${100 + i}`));
    expect(output.tracks.map(track => track.id)).toEqual(expected);
    expect(output.tracks.every(track => track.provenance.kind !== "ai")).toBe(true);
  }
});

test("E: malformed next values, changed generation and incomplete tracklists reject", async () => {
  for (const nextOffset of [null, 0, -1, "1", 0.5, 10001, Infinity]) {
    let calls = 0;
    await expect(buildDiscography(request, options(), async input => {
      if (input.action === "status") return {generation: "synthetic-generation"};
      calls++;
      return page({releases: [release(10, 1)], nextOffset});
    })).rejects.toThrow();
    expect(calls).toBe(1);
  }
  for (const fault of [{generation: "changed"}, {storefront: "us"}, {tracks: []}, {tracks: [song(1), song(2)]}]) {
    await expect(buildDiscography(request, options(), async input => input.action === "status" ? {generation: "synthetic-generation"} : input.action === "catalogReleases" ? page({releases: [release(10, 1)]}) : page({tracks: [song(1)], ...fault}))).rejects.toThrow();
  }
});

test("E: version and artist identity fuzz leaves remixes, live takes and same-name ambiguity for review", () => {
  for (let seed = 201; seed <= 248; seed++) {
    const title = `Song ${random(seed)()}`;
    for (const suffix of [" (Live)", " (Remix)", " (Radio Edit)", " Part 2", " II"]) expect(matchTrack("Artist", title, "Artist", title + suffix)).toBe("review");
    expect(matchTrack("Artist", title, "Other Artist", title)).toBe("review");
    expect(matchTrack("Artist", title, "Artist", title + " - 2026 Remaster")).toBe("exact");
  }
});

// Unknown entities, including inherited object keys, must remain literal.
test.each(["constructor", "toString", "valueOf", "hasOwnProperty", "eAcute", "EACUTE", "notAnEntity"])("E regression: unknown entity &%s; stays literal", async key => {
  const name = `Artist &${key};`;
  const parsed = await parseArtists(`<div class="genre scanme" title='e.g. ${name} "${name}"'>${name}</div>`);
  const fallback = await parseArtists(`<div class="genre scanme" title='e.g. ${name} "${name}"'></div>`);
  const genres = await parseGenreIndex(`<div class="genre">${name}<a href="engenremap-synthetic.html">go</a></div>`);
  expect({artist: parsed[0]!.name, genre: genres[0]!.name}).toEqual({artist: name, genre: name});
  expect(parsed[0]!.representative).toBe(name);
  expect(fallback[0]!.name).toBe(name);
});

test("E: supported named, accented and numeric entities still decode", async () => {
  const pairs = [
    ["amp", "&"], ["quot", '"'], ["apos", "'"], ["lt", "<"], ["gt", ">"], ["nbsp", " "],
    ["raquo", "»"], ["laquo", "«"], ["ndash", "–"], ["mdash", "—"], ["lsquo", "‘"], ["rsquo", "’"], ["ldquo", "“"], ["rdquo", "”"],
    ["hellip", "…"], ["copy", "©"], ["reg", "®"], ["trade", "™"], ["euro", "€"], ["pound", "£"], ["yen", "¥"], ["cent", "¢"], ["middot", "·"],
    ["Oslash", "Ø"], ["oslash", "ø"], ["AElig", "Æ"], ["aelig", "æ"], ["szlig", "ß"], ["ETH", "Ð"], ["eth", "ð"], ["THORN", "Þ"], ["thorn", "þ"],
    ["Eacute", "É"], ["eacute", "é"], ["Agrave", "À"], ["ocirc", "ô"], ["ntilde", "ñ"], ["Uuml", "Ü"], ["Aring", "Å"], ["ccedil", "ç"],
    ["#233", "é"], ["#x1f3a7", "🎧"],
  ];
  const source = pairs.map(([key]) => `&${key};`).join(" | ");
  const expected = pairs.map(([, value]) => value).join(" | ");
  const artists = await parseArtists(`<div class="genre scanme">${source}</div>`);
  const fallback = await parseArtists('<div class="genre scanme" title="e.g. &Eacute; &eacute; &Oslash; &amp; &quot;Song&quot;"></div>');
  const genres = await parseGenreIndex(`<div class="genre">${source}<a href="engenremap-synthetic.html">go</a></div>`);
  expect(artists[0]!.name).toBe(expected);
  expect(fallback[0]!.name).toBe("É é Ø &");
  expect(genres[0]!.name).toBe(expected);
});

test("F: contradictory artwork success and prototype-like result fields fail closed", async () => {
  const context = {jobId: "00000000-0000-4000-8000-000000000001", name: "Synthetic", connectionGeneration: "synthetic", expectedCatalogIds: ["1"], mode: "apply" as const};
  const values = [
    {state: "verified", code: "image-verified", writeAttempted: false},
    {state: "blocked", code: "image-verified", writeAttempted: false, imageHash: "a".repeat(64)},
    {state: "verified", code: "unsafe-store", writeAttempted: true, imageHash: "a".repeat(64)},
    JSON.parse('{"state":"verified","code":"image-verified","writeAttempted":true,"imageHash":"' + 'a'.repeat(64) + '","__proto__":{"polluted":true}}'),
  ];
  for (const value of values) expect(await createWebMusicAdapter(async () => value).playlistCover!("p.synthetic", context)).toMatchObject({state: "uncertain", code: "malformed"});
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test("F: release path matrix rejects traversal, duplicates, symlinks, hash and permission changes", async () => {
  const root = await scratch();
  await writeFile(join(root, "resource"), "synthetic"); await chmod(join(root, "resource"), 0o644);
  const entry = {path: "resource", sha256: sha("synthetic"), mode: 0o644};
  await expect(verifyFiles(root, [entry])).resolves.toBeUndefined();
  for (const path of ["", "/resource", "../resource", "./resource", "x/../resource", "x//resource", "x\\resource", "resource\n", "resource\0"]) await expect(verifyFiles(root, [{...entry, path}])).rejects.toThrow();
  await expect(verifyFiles(root, [entry, entry])).rejects.toThrow(/Duplicate/);
  await symlink(join(root, "resource"), join(root, "alias"));
  await expect(verifyFiles(root, [{...entry, path: "alias"}])).rejects.toThrow(/regular file/);
  await mkdir(join(root, "directory")); await writeFile(join(root, "directory", "resource"), "synthetic");
  await symlink(join(root, "directory"), join(root, "directory-alias"));
  await expect(verifyFiles(root, [{...entry, path: "directory-alias/resource"}])).rejects.toThrow(/regular file/);
  await chmod(join(root, "resource"), 0o755);
  await expect(verifyFiles(root, [entry])).rejects.toThrow(/Mode/);
  await chmod(join(root, "resource"), 0o644); await writeFile(join(root, "resource"), "altered");
  await expect(verifyFiles(root, [entry])).rejects.toThrow(/Hash/);
});

test("F: snapshot includes all synthetic source and detects changed hardlink aliases", async () => {
  const root = await scratch();
  expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
  await writeFile(join(root, "resource"), "synthetic"); await chmod(join(root, "resource"), 0o644);
  await link(join(root, "resource"), join(root, "hardlink"));
  const snapshot = await captureSnapshot(root, ["resource", "hardlink"]);
  expect(snapshot.files).toHaveLength(2);
  await expect(validateSnapshot(root, {files: snapshot.files.slice(0, 1)})).rejects.toThrow(/Unaccounted/);
  await writeFile(join(root, "hardlink"), "changed via alias");
  await expect(validateSnapshot(root, snapshot)).rejects.toThrow(/Hash/);
});

test("D: daily and recently-played profiles preserve dates without inventing duration", async () => {
  for (let seed = 401; seed <= 416; seed++) {
    for (const profile of ["daily-tracks", "recently-played"] as const) {
      const dateHeader = profile === "daily-tracks" ? "Date Played" : "Last Event End Timestamp";
      const csv = `Track Description,${dateHeader},Container Description,Media duration in millis\n` + Array.from({length: 8}, (_, i) => [quote(`Song ${seed}-${i} 🎧`), `2026-10-${String(i + 1).padStart(2, "0")}`, quote("__proto__"), "300000"].join(",")).join("\n");
      const parsed = await parseAppleCSV(encoded(csv, [1, 2, 3, 7]));
      expect(parsed.profile).toBe(profile);
      expect(parsed.coverage).toMatchObject({acceptedRows: 8, instantRows: 0, datedRows: 8, durationRows: 0});
      const envelope: ExportEnvelope = {schemaVersion: 1, source: "export", importedAt: "2026-10-09T00:00:00Z", ...parsed};
      const summary = summarizeHistory([envelope], {...query, kind: "tracks"}, 0);
      expect(summary.sources[0]!.totals.reportedDurationMs).toBeNull();
      expect(summary.sources[0]!.trendsAvailable).toBe(profile === "daily-tracks");
      if (profile === "daily-tracks") expect(summarizeHistory([envelope], {...query, kind: "hourly"}, 0).page).toMatchObject({total: 0, excludedRows: 8});
      else expect(() => summarizeHistory([envelope], {...query, kind: "daily"}, 0)).toThrow(/unavailable/);
    }
  }
});

test("E: 16 generated discovery catalogs preserve provenance and ambiguous identities", async () => {
  const originalDirectory = process.env.WAVELENGTH_DATA_DIR;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => { throw new Error("round1-data forbids external fetch"); }, {preconnect: originalFetch.preconnect}) as typeof fetch;
  try {
    for (let seed = 301; seed <= 316; seed++) {
      const root = await scratch(); process.env.WAVELENGTH_DATA_DIR = root;
      const cache = join(root, "discovery-cache"); await mkdir(cache);
      const cacheURL = async (url: string, text: string) => writeFile(join(cache, sha(url) + ".json"), JSON.stringify({savedAt: Date.now(), text}));
      await cacheURL("https://everynoise.com/engenremap.html", '<div class="genre">fixture<a href="engenremap-fixture.html">go</a></div>');
      await cacheURL("https://everynoise.com/engenremap-fixture.html", '<div class="genre scanme">Synthetic</div>');
      const search = new URL("https://itunes.apple.com/search");
      search.search = new URLSearchParams({term: "Synthetic", country: "AU", entity: "song", limit: "100"}).toString();
      const ambiguous = seed % 2 === 0;
      const songs = Array.from({length: 5}, (_, i) => ({kind: "song", trackId: seed * 10 + i, artistId: ambiguous && i % 2 ? 8 : 7, artistName: "Synthetic", trackName: `Song ${i}`, trackViewUrl: `https://music.apple.com/au/song/${seed * 10 + i}`}));
      await cacheURL(search.href, JSON.stringify({results: songs}));
      const output = await buildDraft({...request, mode: "genre", seed: "fixture", count: 5, perArtist: 5}, options());
      expect(output.tracks.map(track => track.catalogId)).toEqual(songs.filter(song => song.artistId !== 8).map(song => song.trackId));
      expect(output.tracks.every(track => track.selected === !ambiguous && track.match === (ambiguous ? "review" : "exact"))).toBe(true);
      expect(output.tracks.every(track => track.provenance.kind === "unknown" && track.sourceUrl === "https://everynoise.com/engenremap-fixture.html")).toBe(true);
      expect(output.warnings.some(warning => warning.includes("round1-data forbids"))).toBe(false);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDirectory === undefined) delete process.env.WAVELENGTH_DATA_DIR; else process.env.WAVELENGTH_DATA_DIR = originalDirectory;
  }
});

// Bound the intentionally blocking input in a child; kill/reap it before cleanup.
test.each(["direct", "leaf symlink", "parent symlink"])("F regression: snapshot capture rejects a FIFO before hashing, %s", async kind => {
  const root = await scratch();
  expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
  const directory = kind === "parent symlink" ? join(root, "nested") : root;
  if (directory !== root) await mkdir(directory);
  const pipe = join(directory, "round1-data-pipe");
  expect(Bun.spawnSync(["mkfifo", pipe]).exitCode).toBe(0);
  const path = kind === "leaf symlink" ? "round1-data-alias" : kind === "parent symlink" ? "nested-alias/round1-data-pipe" : "round1-data-pipe";
  if (kind === "leaf symlink") await symlink(pipe, join(root, path));
  if (kind === "parent symlink") await symlink(directory, join(root, "nested-alias"));
  const script = join(await scratch(), "round1-data-fifo.ts");
  await writeFile(script, `import {captureSnapshot} from ${JSON.stringify(join(import.meta.dir, "../scripts/release.ts"))};\nconsole.log("ready");\ntry { await captureSnapshot(${JSON.stringify(root)}, [${JSON.stringify(path)}]); console.log("accepted"); process.exitCode=2; } catch (error) { if (!(error instanceof Error) || !/regular file/.test(error.message)) throw error; console.log("rejected"); }\n`);
  const child = Bun.spawn([process.execPath, script], {stdout: "pipe", stderr: "pipe"});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const completed = await Promise.race([child.exited.then(() => true), new Promise<boolean>(resolve => {timer = setTimeout(() => {timedOut = true; child.kill("SIGKILL"); resolve(false);}, 1500);})]);
    await child.exited;
    const [output, errors] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({completed, timedOut, output}).toEqual({completed: true, timedOut: false, output: "ready\nrejected\n"});
    expect(errors).toBe("");
    expect(child.exitCode).toBe(0);
  } finally { if (timer) clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
}, 5000);

test("F regression: snapshot validates root and parent directory types and preserves nested file modes", async () => {
  const root = await scratch();
  expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "script"), "synthetic executable");
  await chmod(join(root, "nested", "script"), 0o755);
  const entry = {path: "nested/script", sha256: sha("synthetic executable"), mode: 0o755};
  expect(await captureSnapshot(root, [entry.path])).toEqual({files: [entry]});
  await expect(captureSnapshot(root, [entry.path, entry.path])).rejects.toThrow(/Duplicate/);
  await expect(captureSnapshot(root, ["nested"])).rejects.toThrow(/regular file/);
  await expect(captureSnapshot(root, ["nested/script/child"])).rejects.toThrow(/regular file/);
  const alias = join(await scratch(), "root-alias");
  await symlink(root, alias);
  await expect(captureSnapshot(alias, [entry.path])).rejects.toThrow(/regular file/);
  await expect(verifyFiles(alias, [entry])).rejects.toThrow(/regular file/);
});
