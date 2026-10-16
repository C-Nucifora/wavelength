import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { libraryCommand, validateMusicTrack, validatePlaylistId } from "../src/music";
import type { DraftTrack } from "../src/types";

const script = readFileSync(new URL("../native/library.jxa", import.meta.url), "utf8");
const expected = {title: "An Ending (Ascent)", artist: "Brian Eno", album: "Apollo", durationMs: 260000};

describe("Music input and identity", () => {
  test("default execution retains playlist limits and cleans up owned children", async () => {
    const source = readFileSync(new URL("../src/music.ts", import.meta.url), "utf8");
    const start = source.indexOf("function execute(");
    const executeSource = source.slice(start, source.indexOf("\n}\n", start) + 3);
    const stopSource = source.match(/^export function stopOwnedHelpers.*$/m)![0].replace(/^export /, "");
    const callbacks: Array<(error: unknown, stdout: string, stderr: string) => void> = [];
    const options: unknown[] = [];
    let killed = 0;
    const ownedHelpers = new Set();
    const transpiler = new Bun.Transpiler({loader: "ts"});
    const {execute, stopOwnedHelpers} = runInNewContext(`${transpiler.transformSync(`${executeSource}\n${stopSource}`)}\n({execute, stopOwnedHelpers})`, {ownedHelpers, execFile: (_file: string, _args: string[], option: unknown, callback: typeof callbacks[number]) => {
      options.push(option); callbacks.push(callback); return {kill: () => {killed++;}};
    }});
    const success = execute("mock-helper", []);
    expect(options[0]).toEqual({timeout: 30000, maxBuffer: 2097152});
    expect(ownedHelpers.size).toBe(1);
    callbacks[0]!(null, " output ", "");
    expect(await success).toBe("output");
    expect(ownedHelpers.size).toBe(0);
    const failure = execute("mock-helper", [], 90000, 33554432);
    expect(options[1]).toEqual({timeout: 90000, maxBuffer: 33554432});
    stopOwnedHelpers();
    expect(killed).toBe(1);
    expect(ownedHelpers.size).toBe(0);
    callbacks[1]!(Object.assign(new Error("failure"), {killed: true}), "", "");
    await expect(failure).rejects.toThrow("timed out");
    expect(ownedHelpers.size).toBe(0);
    const overflow = execute("mock-helper", [], 90000, 33554432);
    callbacks[2]!(Object.assign(new Error("maxBuffer exceeded"), {code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true}), "", "");
    try {await overflow;} catch (error) {expect((error as {code: unknown}).code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");}
    expect(ownedHelpers.size).toBe(0);
  });

  test("sends untrusted names as one JSON argument to a fixed script", () => {
    const name = 'quote"; $(touch /tmp/noise-injection) `whoami`\\\n音乐';
    const command = libraryCommand({action: "ensure", name});
    expect(command.file).toBe("/usr/bin/osascript");
    expect(command.args.slice(0, 2)).toEqual(["-l", "JavaScript"]);
    expect(command.args[2]).toEndWith("/native/library.jxa");
    expect(command.args).toHaveLength(4);
    expect(JSON.parse(command.args[3]!)).toEqual({action: "ensure", name});
    expect(script).not.toContain(name);
  });

  test("matches complete identity and refuses another recording", () => {
    const context = {metadata: {...expected}, expected};
    expect(runInNewContext(`${script}\nmatches(metadata, expected)`, context)).toBe(true);
    for (const altered of [
      {...expected, artist: "Someone Else"},
      {...expected, title: "An Ending (Ascent) (Live)"},
      {...expected, album: "Another Album"},
      {...expected, durationMs: 280000},
    ]) {
      expect(runInNewContext(`${script}\nmatches(metadata, expected)`, {...context, metadata: altered})).toBe(false);
    }
    expect(runInNewContext(`${script}\nmatches(metadata, expected)`, {...context, metadata: {...expected, artist: "  BRIAN   ENO  ", durationMs: 262000}})).toBe(true);
  });

  test("rejects unusable metadata before automation", () => {
    const track = {...expected, catalogId: 1462266178} as DraftTrack;
    expect(() => validateMusicTrack(track)).not.toThrow();
    for (const value of [{...track, catalogId: -1}, {...track, durationMs: NaN}, {...track, album: ""}]) {
      expect(() => validateMusicTrack(value)).toThrow();
    }
    expect(() => validatePlaylistId("ABCDEF0123456789")).not.toThrow();
    expect(() => validatePlaylistId('foo";delete')).toThrow();
  });

  test("reuses playlist identity and verifies insertion without duplicates", () => {
    let duplicates = 0;
    let creations = 0;
    const track = {name: () => expected.title, artist: () => expected.artist, album: () => expected.album, duration: () => expected.durationMs / 1000, persistentID: () => "0000000000000001"};
    const p = {name: () => "Existing name", persistentID: () => "ABCDEF0123456789", tracks: {whose: () => () => duplicates ? [track] : []}};
    const Music = {running: () => true, userPlaylists: {whose: () => () => [p]}, libraryPlaylists: [{tracks: {whose: () => () => [track]}}], duplicate: () => { duplicates++; }, make: () => { creations++; return p; }};
    const context = {Application: () => Music};
    const invoke = (input: unknown) => JSON.parse(runInNewContext(`${script}\nrun([${JSON.stringify(JSON.stringify(input))}])`, context)).result;
    expect(invoke({action: "ensure", name: "New name", existingId: "ABCDEF0123456789"})).toEqual({id: "ABCDEF0123456789", name: "Existing name"});
    expect(creations).toBe(0);
    expect(invoke({action: "insert", playlistId: "ABCDEF0123456789", track: expected})).toEqual({libraryId: "0000000000000001", alreadyPresent: false});
    expect(invoke({action: "insert", playlistId: "ABCDEF0123456789", track: expected})).toEqual({libraryId: "0000000000000001", alreadyPresent: true});
    expect(duplicates).toBe(1);
  });

  test("a missing saved playlist fails instead of silently creating one", () => {
    let created = false;
    const Music = {running: () => true, userPlaylists: {whose: () => () => []}, make: () => { created = true; }};
    const response = JSON.parse(runInNewContext(`${script}\nrun([JSON.stringify({action:'ensure',name:'Test',existingId:'ABCDEF0123456789'})])`, {Application: () => Music}));
    expect(response.ok).toBe(false);
    expect(response.error).toContain("no longer exists");
    expect(created).toBe(false);
  });

  test("batch inspection uses the same exact identity without writes", () => {
    const existing = {name: () => expected.title, artist: () => expected.artist, album: () => expected.album, duration: () => expected.durationMs / 1000, persistentID: () => "0000000000000001"};
    let queries = 0;
    const Music = {running: () => true, libraryPlaylists: [{tracks: {whose: () => () => { queries++; return [existing]; }}}]};
    const tracks = [{...expected, id: "present"}, {...expected, id: "wrong-album", album: "Another recording"}];
    const response = JSON.parse(runInNewContext(`${script}\nrun([${JSON.stringify(JSON.stringify({action: "inspect", tracks}))}])`, {Application: () => Music}));
    expect(response).toEqual({ok: true, result: [{id: "present", libraryId: "0000000000000001"}, {id: "wrong-album", libraryId: null}]});
    expect(queries).toBe(1);
  });
});
