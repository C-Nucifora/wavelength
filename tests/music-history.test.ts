import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as music from "../src/music";

const script = readFileSync(new URL("../native/history.jxa", import.meta.url), "utf8");
const id = "0000000000000001";
const track = (changes: Record<string, unknown> = {}) => ({id, title: "Synthetic song", artist: "Synthetic artist", albumArtist: "Synthetic artist", album: "Synthetic album", genre: "Rock", durationMs: 120500, playedCount: 2, playedAt: "2026-01-02T03:04:05.000Z", skippedCount: 0, skippedAt: null, addedAt: null, favorite: false, ...changes});
const envelope = (changes: Record<string, unknown> = {}) => ({complete: true, declaredTrackCount: 1, tracks: [track()], warnings: [], ...changes});
const columns = (changes: Record<string, unknown> = {}) => ({persistentID: [id], name: ["Synthetic song"], artist: ["Synthetic artist"], albumArtist: ["Synthetic artist"], album: ["Synthetic album"], genre: ["Rock"], duration: [120.5], playedCount: [2], playedDate: [new Date("2026-01-02T03:04:05Z")], skippedCount: [0], skippedDate: [null], dateAdded: [null], favorited: [false], ...changes});

function bridge(values: Record<string, unknown> = columns(), options: {count?: number; running?: boolean; missingLibrary?: boolean; finalIds?: unknown[]; finalCount?: number; disappears?: boolean} = {}) {
  const reads: string[] = [];
  let idReads = 0, libraryReads = 0;
  const tracks = Object.fromEntries(Object.entries(values).map(([property, value]) => [property, () => {
    reads.push(property);
    if (property === "persistentID" && ++idReads > 1 && options.finalIds) return options.finalIds;
    if (value instanceof Error) throw value;
    return value;
  }]));
  Object.defineProperty(tracks, "length", {get: () => options.finalCount !== undefined && reads.length > 1 ? options.finalCount : options.count ?? 1});
  const forbidden = () => {throw new Error("WRITE WAS INVOKED");};
  const Music = {running: () => options.running ?? true, libraryPlaylists: () => {
    if (options.disappears && ++libraryReads > 1) return [];
    return options.missingLibrary ? [] : [{tracks}];
  }, make: forbidden, duplicate: forbidden, reveal: forbidden, activate: forbidden};
  const response = JSON.parse(runInNewContext(`${script}\nrun(['{"action":"history"}'])`, {Application: (name: string) => {
    expect(name).toBe("Music"); return Music;
  }}));
  return {response, reads};
}

describe("read-only Music library history JXA", () => {
  test("non-history actions are rejected before contacting Music", () => {
    for (const action of ["ensure", "insert", "open", "find", "inspect"]) {
      let contacts = 0;
      const response = JSON.parse(runInNewContext(`${script}\nrun([${JSON.stringify(JSON.stringify({action}))}])`, {Application: () => {contacts++; throw new Error("Forbidden");}}));
      expect(response.ok).toBe(false);
      expect(contacts).toBe(0);
    }
  });
  test("batches dictionary getters and converts statistics without writes", () => {
    const {response, reads} = bridge();
    expect(response).toEqual({ok: true, result: envelope()});
    expect(reads).toEqual(["persistentID", "name", "artist", "albumArtist", "album", "genre", "duration", "playedCount", "playedDate", "skippedCount", "skippedDate", "dateAdded", "favorited", "persistentID"]);
  });

  test("unavailable optional metadata is null with a property and count warning", () => {
    const {response} = bridge(columns({favorited: new Error("Event not handled (-1708)."), albumArtist: undefined}));
    expect(response.ok).toBe(true);
    expect(response.result.tracks[0].favorite).toBeNull();
    expect(response.result.tracks[0].albumArtist).toBeNull();
    expect(response.result.warnings).toContain("favorite unavailable for 1 library tracks.");
    expect(response.result.warnings).toContain("albumArtist unavailable for 1 library tracks.");
  });

  test("invalid numeric, date and text sentinels stay unavailable", () => {
    const {response} = bridge(columns({name: [null], artist: [""], duration: [NaN], playedCount: [-1], skippedCount: [1.5], playedDate: [new Date("bad")], skippedDate: [0], dateAdded: ["2026-01-02T03:04:05Z"], favorited: ["false"]}));
    expect(response.ok).toBe(true);
    expect(response.result.tracks[0]).toEqual(track({title: null, artist: null, durationMs: null, playedCount: null, skippedCount: null, playedAt: null, favorite: null}));
    expect(bridge(columns({duration: [-1]})).response.result.tracks[0].durationMs).toBeNull();
    expect(bridge(columns({duration: [1e308]})).response.result.tracks[0].durationMs).toBeNull();
    expect(bridge(columns({duration: [0], playedCount: [0]})).response.result.tracks[0].durationMs).toBe(0);
  });

  test("missing library, closed Music and oversized collections fail", () => {
    expect(bridge(columns(), {missingLibrary: true}).response.error).toContain("no readable library");
    expect(bridge(columns(), {running: false}).response.error).toContain("Open Music");
    const oversized = bridge(columns(), {count: 50001});
    expect(oversized.response.error).toContain("50,000");
    expect(oversized.reads).toHaveLength(0);
  });

  test("empty libraries produce a complete empty snapshot", () => {
    const empty = Object.fromEntries(Object.keys(columns()).map(property => [property, []]));
    expect(bridge(empty, {count: 0}).response).toEqual({ok: true, result: envelope({declaredTrackCount: 0, tracks: []})});
  });

  test("the 50,000 track boundary remains readable", () => {
    const values = Object.fromEntries(Object.entries(columns()).map(([property, value]) => [property,
      Array.from({length: 50000}, (_, index) => property === "persistentID" ? (index + 1).toString(16).padStart(16, "0") : (value as unknown[])[0])]));
    const {response} = bridge(values, {count: 50000});
    expect(response.ok).toBe(true);
    expect(response.result.complete).toBe(true);
    expect(response.result.declaredTrackCount).toBe(50000);
    expect(response.result.tracks).toHaveLength(50000);
    expect(response.result.tracks[49999].id).toBe("000000000000c350");
  });

  test("missing or duplicate persistent IDs fail before metadata reads", () => {
    for (const ids of [[null], [""], ["invalid"], [id, id], ["abcdef0123456789", "ABCDEF0123456789"], new Array(1)]) {
      const {response, reads} = bridge(columns({persistentID: ids}), {count: ids.length});
      expect(response.ok).toBe(false);
      expect(response.error).toContain("persistent ID");
      expect(reads).toEqual(["persistentID"]);
    }
  });

  test("every successful column must match the declared track count", () => {
    for (const property of Object.keys(columns())) {
      expect(bridge(columns({[property]: []})).response.error).toContain("incomplete");
      expect(bridge(columns({[property]: "unexpected scalar"})).response.error).toContain("incomplete");
    }
  });

  test("membership, order, count and library disappearance invalidate the scan", () => {
    expect(bridge(columns(), {finalIds: ["0000000000000002"]}).response.error).toContain("changed");
    const two = Object.fromEntries(Object.entries(columns()).map(([key, value]) => [key, key === "persistentID" ? [id, "0000000000000002"] : [...value as unknown[], ...value as unknown[]]]));
    expect(bridge(two, {count: 2, finalIds: ["0000000000000002", id]}).response.error).toContain("changed");
    expect(bridge(columns(), {finalCount: 0}).response.error).toContain("changed");
    expect(bridge(columns(), {disappears: true}).response.error).toContain("no readable library");
  });

  test("only unavailable optional getter failures can be recovered", () => {
    for (const message of ["Not authorized (-1743) SECRET TRACK", "AppleEvent timed out (-1712) SECRET TRACK", "Object not found (-1728) SECRET TRACK", "Disconnected (-609) SECRET TRACK", "Unexpected getter failure SECRET TRACK"]) {
      const {response} = bridge(columns({genre: new Error(message)}));
      expect(response.ok).toBe(false);
      expect(response.error).not.toContain("SECRET TRACK");
    }
    expect(bridge(columns({persistentID: new Error("Event not handled (-1708)")})).response.ok).toBe(false);
    for (const code of [-1743, -1712, -1728, -609]) {
      expect(bridge(columns({genre: Object.assign(new Error("Property unavailable"), {errorNumber: code})})).response.ok).toBe(false);
    }
  });

  test("text limits count code points before JSON serialization", () => {
    expect(bridge(columns({name: ["🎵".repeat(4000)]})).response.result.tracks[0].title).toHaveLength(8000);
    for (const property of ["name", "artist", "albumArtist", "album", "genre"]) {
      const {response} = bridge(columns({[property]: ["🎵".repeat(4001)]}));
      expect(response.ok).toBe(false);
      expect(response.error).toContain("4,000");
      expect(response.error).not.toContain("🎵");
    }
  });
});

describe("Music library history adapter", () => {
  test("statistics use a dedicated deadline and buffer with a fixed JSON command", async () => {
    let call: unknown;
    const result = await music.readLibraryHistory(async (command, options) => {
      call = {file: command.file, prefix: command.args.slice(0, 2), args: command.args.length, ...JSON.parse(command.args[3]!), ...options};
      expect(command.args[2]).toEndWith("/native/history.jxa");
      return JSON.stringify({ok: true, result: envelope({tracks: [track({playedCount: null})]})});
    });
    expect(call).toEqual({file: "/usr/bin/osascript", prefix: ["-l", "JavaScript"], args: 4, action: "history", timeout: 90000, maxBuffer: 33554432});
    expect(result.tracks[0]!.playedCount).toBeNull();
    expect(result.tracks[0]!.playedAt).toEqual({kind: "instant", value: "2026-01-02T03:04:05.000Z"});
    expect(result.warnings).toContain("playedCount unavailable for 1 library tracks.");
  });

  test("incomplete, mismatched and invalid identities never become snapshots", async () => {
    for (const result of [envelope({complete: false}), envelope({declaredTrackCount: 2}), envelope({tracks: [track({id: null})]}), envelope({declaredTrackCount: 2, tracks: [track(), track()]}), envelope({tracks: [track({title: "x".repeat(4001)})]}), envelope({declaredTrackCount: 50001, tracks: Array.from({length: 50001}, () => track())})]) {
      await expect(music.readLibraryHistory(async () => JSON.stringify({ok: true, result}))).rejects.toThrow();
    }
  });

  test("normalization keeps unavailable values null and discards raw bridge warnings", async () => {
    const result = await music.readLibraryHistory(async () => JSON.stringify({ok: true, result: envelope({tracks: [track({title: null, durationMs: -1, playedCount: NaN, skippedCount: -1, playedAt: "invalid", addedAt: 0, favorite: "false"})], warnings: ["SECRET TRACK"]})}));
    expect(result.tracks[0]).toMatchObject({title: null, durationMs: null, playedCount: null, skippedCount: null, playedAt: null, addedAt: null, favorite: null});
    expect(result.warnings.join(" ")).not.toContain("SECRET TRACK");
    expect(result.warnings).toContain("durationMs unavailable for 1 library tracks.");
  });

  test("transport errors are classified without leaking bridge contents", async () => {
    for (const [error, expected] of [
      [new Error("-1743 not authorized SECRET TRACK"), "Automation"],
      [Object.assign(new Error("SECRET TRACK"), {code: -1743}), "Automation"],
      [Object.assign(new Error("SECRET TRACK"), {errorNumber: -1743}), "Automation"],
      [Object.assign(new Error("SECRET TRACK"), {code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"}), "too large"],
      [Object.assign(new Error("SECRET TRACK"), {killed: true}), "timed out"],
      [new Error("SECRET TRACK"), "Music library"],
    ] as const) {
      try {await music.readLibraryHistory(async () => {throw error;}); throw new Error("unexpected success");}
      catch (failure) {expect((failure as Error).message).toContain(expected); expect((failure as Error).message).not.toContain("SECRET TRACK");}
    }
  });

  test("malformed output and bridge failures report safe recoverable errors", async () => {
    for (const output of ["SECRET TRACK", JSON.stringify({ok: false, error: "SECRET TRACK"}), JSON.stringify({ok: false, error: "-1743 SECRET TRACK"})]) {
      await expect(music.readLibraryHistory(async () => output)).rejects.toThrow();
      try {await music.readLibraryHistory(async () => output);} catch (error) {expect((error as Error).message).not.toContain("SECRET TRACK");}
    }
    await expect(music.readLibraryHistory(async () => JSON.stringify({ok: false, error: "Open Music and sign in to Apple Music before continuing."}))).rejects.toThrow("Open Music");
    await expect(music.readLibraryHistory(async () => JSON.stringify({ok: false, error: "Music has no readable library. Open Music and retry."}))).rejects.toThrow("no readable library");
  });
});
