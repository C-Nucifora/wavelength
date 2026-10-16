import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { DraftTrack, MusicStatus } from "./types";
import { normalizeLibraryRead } from "./history";
import { HISTORY_LIMITS, type LibraryReadResult } from "./history-types";

const nativeDirectory = fileURLToPath(new URL("../native/", import.meta.url));
const buildDirectory = fileURLToPath(new URL("../.build/", import.meta.url));
const helperPath = process.env.WAVELENGTH_MUSIC_BRIDGE || `${buildDirectory}MusicBridge`;
const ownedHelpers = new Set<ReturnType<typeof execFile>>();
export function stopOwnedHelpers() {for (const child of ownedHelpers) child.kill("SIGTERM"); ownedHelpers.clear();}
let compilation: Promise<void> | undefined;

export function validateMusicTrack(track: DraftTrack): void {
  if (!Number.isSafeInteger(track.catalogId) || track.catalogId <= 0 ||
      !Number.isFinite(track.durationMs) || track.durationMs <= 0 ||
      [track.title, track.artist, track.album].some(value => typeof value !== "string" || !value.trim() || value.length > 1000)) {
    throw new Error("The song needs a catalog ID, title, artist, album and duration before it can be added.");
  }
}

export function validatePlaylistId(id: string): void {
  if (!/^[A-Fa-f0-9]{16}$/.test(id)) throw new Error("Invalid Music playlist ID.");
}

export function libraryCommand(input: Record<string, unknown>): {file: string; args: string[]} {
  // User data is one JSON argument, never executable JXA or shell text.
  return {file: "/usr/bin/osascript", args: ["-l", "JavaScript", `${nativeDirectory}${input.action === "history" ? "history.jxa" : "library.jxa"}`, JSON.stringify(input)]};
}

function execute(file: string, args: string[], timeout = 30_000, maxBuffer = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {timeout, maxBuffer}, (error, stdout, stderr) => {
      ownedHelpers.delete(child);
      if (error) {
        const detail = stderr.trim() || error.message;
        reject(Object.assign(new Error(error.killed ? "Music automation timed out. Retry after closing any Music dialog." : detail), {code: error.code, killed: error.killed}));
      } else resolve(stdout.trim());
    });
    ownedHelpers.add(child);
  });
}

export type HistoryBridgeRunner = (
  command: ReturnType<typeof libraryCommand>,
  options: {timeout: number; maxBuffer: number},
) => Promise<string>;

function historyFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const detail = error as {code?: unknown; errorNumber?: unknown; number?: unknown; killed?: unknown} | null;
  const code = detail?.errorNumber || detail?.number || detail?.code;
  if (code === -1743 || /1743|not authorized|not permitted/i.test(message)) return new Error("Allow this app to control Music in System Settings > Privacy & Security > Automation, then retry.");
  if (detail?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer|buffer.*exceed/i.test(message)) return new Error("Music library snapshot is too large for the 32 MiB response limit.");
  if (code === -1712 || detail?.killed || /1712|timed out|timeout/i.test(message)) return new Error("Music automation timed out. Retry after closing any Music dialog.");
  const safe = [
    "Open Music and sign in to Apple Music before continuing.",
    "Music has no readable library. Open Music and retry.",
    "Music library exceeds 50,000 tracks.",
    "Music returned an incomplete library snapshot. Retry.",
    "Music library changed during the scan. Retry.",
    "Invalid or duplicate Music library persistent ID.",
    "Music library fields exceed 4,000 characters.",
  ];
  return new Error(safe.includes(message) ? message : "Could not read the Music library. Open Music and retry.");
}

export async function readLibraryHistory(runner: HistoryBridgeRunner = (command, options) => execute(command.file, command.args, options.timeout, options.maxBuffer)): Promise<LibraryReadResult> {
  let result: unknown;
  try {
    result = decode<unknown>(await runner(libraryCommand({action: "history"}), {timeout: HISTORY_LIMITS.scanMs, maxBuffer: HISTORY_LIMITS.scanBufferBytes}));
  } catch (error) { throw historyFailure(error); }
  return normalizeLibraryRead(result);
}

function decode<T>(output: string): T {
  const response = JSON.parse(output) as {ok: boolean; result?: T; error?: string};
  if (!response.ok) throw new Error(response.error || "Music automation failed.");
  return response.result as T;
}

async function jxa<T>(input: Record<string, unknown>): Promise<T> {
  const command = libraryCommand(input);
  try { return decode<T>(await execute(command.file, command.args)); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/1743|not authorized|not permitted/i.test(message)) {
      throw new Error("Allow this app to control Music in System Settings > Privacy & Security > Automation, then retry.");
    }
    throw error;
  }
}

async function compileHelper(): Promise<void> {
  if (process.env.WAVELENGTH_MUSIC_BRIDGE) {
    const binary = await stat(helperPath);
    if (!binary.isFile()) throw new Error("The bundled Music bridge is missing. Rebuild the app.");
    return;
  }
  const sourcePath = `${nativeDirectory}MusicBridge.swift`;
  const [source, binary] = await Promise.all([stat(sourcePath), stat(helperPath).catch(() => null)]);
  if (binary && binary.mtimeMs >= source.mtimeMs) return;
  await mkdir(buildDirectory, {recursive: true});
  await execute("/usr/bin/xcrun", ["swiftc", sourcePath, "-o", helperPath], 120_000);
}

async function native<T>(input: Record<string, unknown>): Promise<T> {
  if (!compilation) compilation = compileHelper().catch(error => { compilation = undefined; throw error; });
  await compilation;
  return decode<T>(await execute(helperPath, [JSON.stringify(input)], 60_000));
}

export async function getMusicStatus(): Promise<MusicStatus> {
  if (process.platform !== "darwin") return {platform: process.platform, running: false, accessibility: false, automation: "unknown", message: "Creating playlists requires Music on macOS."};
  try { return await native<MusicStatus>({action: "status"}); }
  catch (error) { return {platform: "darwin", running: false, accessibility: false, automation: "unknown", message: error instanceof Error ? error.message : String(error)}; }
}

export async function ensurePlaylist(name: string, existingId?: string): Promise<{id: string; name: string}> {
  if (typeof name !== "string" || !name.trim() || name.length > 200) throw new Error("Enter a playlist name between 1 and 200 characters.");
  if (existingId) validatePlaylistId(existingId);
  return jxa({action: "ensure", name: name.trim(), existingId});
}

export async function inspectTracks(tracks: DraftTrack[]): Promise<{tracks: Array<{id: string; libraryId: string | null}>; newLibraryAdditions: number; existingLibrarySongs: number; total: number}> {
  if (!Array.isArray(tracks) || tracks.length > 1000) throw new Error("Too many songs to inspect.");
  tracks.forEach(validateMusicTrack);
  if (!tracks.length) return {tracks: [], newLibraryAdditions: 0, existingLibrarySongs: 0, total: 0};
  const identities = tracks.map(track => ({id: track.id, title: track.title, artist: track.artist, album: track.album, durationMs: track.durationMs}));
  const inspected = await jxa<Array<{id: string; libraryId: string | null}>>({action: "inspect", tracks: identities});
  if (inspected.length !== tracks.length || inspected.some((result, index) => result.id !== tracks[index]!.id)) {
    throw new Error("Music returned an incomplete library inspection. Retry before creating the playlist.");
  }
  const missing = new Set(inspected.flatMap((result, index) => result.libraryId ? [] : [tracks[index]!.catalogId]));
  return {tracks: inspected, newLibraryAdditions: missing.size, existingLibrarySongs: inspected.filter(result => result.libraryId).length, total: tracks.length};
}

export async function addTrackToPlaylist(track: DraftTrack, playlistId: string): Promise<{libraryId: string; alreadyPresent: boolean}> {
  validateMusicTrack(track);
  validatePlaylistId(playlistId);
  const identity = {title: track.title, artist: track.artist, album: track.album, durationMs: track.durationMs};
  const found = await jxa<{libraryId: string | null}>({action: "find", track: identity, playlistId});
  if (!found.libraryId) {
    await native({action: "add", catalogId: track.catalogId, title: track.title, artist: track.artist});
    let confirmed = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await jxa<{libraryId: string | null}>({action: "find", track: identity});
      if (result.libraryId) { confirmed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    if (!confirmed) throw new Error("Music did not confirm the expected title, artist, album and duration in your library. Check Music and retry.");
  }
  return jxa({action: "insert", playlistId, track: identity});
}

export async function openPlaylist(playlistId: string): Promise<void> {
  validatePlaylistId(playlistId);
  await jxa({action: "open", playlistId});
}
