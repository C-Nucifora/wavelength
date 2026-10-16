import type {CoverContext, DraftTrack, MusicStatus, PlaylistCover, TrackWriteOutcome} from "./types";
import type {WebMusicAdapter} from "./jobs";
import {resolve} from "node:path";
import {buildDiscography, searchCatalogArtists, type DiscographyOptions} from "./discography";
import type {ArtistSearchResult, SeedRequest} from "./types";

type BridgeRequest = {action: "status" | "checkConnection" | "inspectTracks" | "ensurePlaylist" | "addTrackToPlaylist" | "rebindPlaylist" | "playlistCover" | "catalogArtists" | "catalogReleases" | "catalogTracks"; generation?: string; catalogIds?: string[]; position?: number; reconcileOnly?: boolean; playlistId?: string; name?: string; jobId?: string; coverMode?: CoverContext["mode"]; country?: string; term?: string; artistId?: string; releaseId?: string; offset?: number};
export type CatalogInspection = {generation?: string; storefront?: string; total: number; availableCatalogTracks?: number; unavailableCatalogTracks?: number; unavailableCatalogIds?: string[]; newLibraryAdditions: number; existingLibrarySongs: number};
const errorMessages: Record<string, string> = {
  "generation-changed": "The Apple Music connection changed. Check your selection again or explicitly retry the saved playlist.",
  busy: "Apple Music connection is busy. Wait for the current operation.",
  missing: "Connect to Apple Music before creating a playlist.",
  rejected: "Apple Music rejected this session or operation. Reconnect and check your saved playlist before retrying.",
  storage: "The local Apple Music connection could not be accessed.",
  "invalid-input": "The Apple Music operation was not valid.",
  unavailable: "Apple Music could not provide this resource.",
  "storefront-mismatch": "Your Apple Music storefront differs from the selected region. Choose your connected region and preview again.",
  "catalog-date": "A release has no valid full Apple release date. Its chronological order cannot be verified.",
};
function failure(code: string, uncertain: boolean): Error & {code: string; uncertain: boolean} {
  return Object.assign(new Error(errorMessages[code] || "The Apple Music bridge did not return a confirmed result. No write was automatically repeated."), {code, uncertain});
}
const children = new Set<Bun.Subprocess>();
export function stopOwnedHelpers() {for (const child of children) child.kill();}

export async function runBridgeRequest(input: BridgeRequest, options: {command?: string[]; timeoutMs?: number} = {}): Promise<unknown> {
  const allowed = ["action", "generation", "catalogIds", "position", "reconcileOnly", "playlistId", "name", "jobId", "coverMode", "country", "term", "artistId", "releaseId", "offset"];
  if (!input || Object.keys(input).some(key => !allowed.includes(key)) || !["status", "checkConnection", "inspectTracks", "ensurePlaylist", "addTrackToPlaylist", "rebindPlaylist", "playlistCover", "catalogArtists", "catalogReleases", "catalogTracks"].includes(input.action) ||
    Object.hasOwn(input, "jobId") && !["ensurePlaylist", "playlistCover"].includes(input.action) || Object.hasOwn(input, "coverMode") && input.action !== "playlistCover" ||
    input.action === "playlistCover" && (!["apply", "check", "authorize"].includes(input.coverMode || "") || Object.hasOwn(input, "position") || Object.hasOwn(input, "reconcileOnly"))) throw failure("invalid-input", false);
  const catalogAction = ["catalogArtists", "catalogReleases", "catalogTracks"].includes(input.action);
  const catalogKeys = ["country", "term", "artistId", "releaseId", "offset"];
  if (catalogAction) {
    const fields = ["action", "generation", "country", ...(input.action === "catalogArtists" ? ["term"] : input.action === "catalogReleases" ? ["artistId", "offset"] : ["releaseId", "offset"])];
    const id = input.action === "catalogReleases" ? input.artistId : input.releaseId;
    if (Object.keys(input).some(key => !fields.includes(key)) || !text(input.generation) || !["AU", "US", "GB", "CA", "JP", "DE"].includes(input.country || "") ||
      input.action === "catalogArtists" && (typeof input.term !== "string" || !input.term.trim() || input.term.length > 120 || /[\u0000-\u001F\u007F]/.test(input.term)) ||
      input.action !== "catalogArtists" && (typeof id !== "string" || !/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) ||
      Object.hasOwn(input, "offset") && (!Number.isInteger(input.offset) || Number(input.offset) < 0 || Number(input.offset) > 10000)) throw failure("invalid-input", false);
  } else if (catalogKeys.some(key => Object.hasOwn(input, key))) throw failure("invalid-input", false);
  const payload = JSON.stringify(input);
  if (Buffer.byteLength(payload) > 131072) throw failure("invalid-input", false);
  const write = input.action === "ensurePlaylist" || input.action === "addTrackToPlaylist" || input.action === "playlistCover" && input.coverMode === "apply";
  let child: Bun.Subprocess<"pipe", "pipe", "ignore">;
  try {child = Bun.spawn(options.command || [process.env.WAVELENGTH_WEB_MUSIC_BRIDGE || resolve("native/bin/WebMusicBridge")], {stdin: "pipe", stdout: "pipe", stderr: "ignore"});}
  catch {throw failure("unavailable", false);}
  children.add(child);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = async () => {
      child.stdin.write(payload);
      child.stdin.end();
      const reader = child.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 131072) {child.kill(); throw failure("malformed", write);}
        chunks.push(value);
      }} finally {reader.releaseLock();}
      if (await child.exited !== 0) throw failure("transport", write);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
      let envelope;
      try {envelope = JSON.parse(new TextDecoder().decode(bytes));} catch {throw failure("malformed", write);}
      if (!envelope || typeof envelope !== "object" || typeof envelope.ok !== "boolean") throw failure("malformed", write);
      if (!envelope.ok) {
        if (!envelope.error || typeof envelope.error.code !== "string" || typeof envelope.error.uncertain !== "boolean") throw failure("malformed", write);
        throw failure(envelope.error.code, envelope.error.uncertain);
      }
      if (!envelope.result || typeof envelope.result !== "object" || Array.isArray(envelope.result)) throw failure("malformed", write);
      return envelope.result as unknown;
    };
    return await Promise.race([operation(), new Promise<never>((_, reject) => {timer = setTimeout(() => {child.kill(); reject(failure("transport", write));}, options.timeoutMs ?? 120000);})]);
  } catch (error) {if (error instanceof Error && "uncertain" in error) throw error; throw failure("transport", write);}
  finally {if (timer) clearTimeout(timer); children.delete(child); if (child.exitCode === null) child.kill();}
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("malformed", false);
  return value as Record<string, unknown>;
}
const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128 ? value : undefined;
const coverCodes = new Set([...Object.keys(errorMessages), "malformed", "transport", "image-verified", "image-unconfirmed", "automation-permission", "permission-ready", "journal-missing", "unsafe-store", "invalid-image", "identity-mismatch", "music-unavailable"]);
export function createWebMusicAdapter(invoke: (input: BridgeRequest) => Promise<unknown> = runBridgeRequest): WebMusicAdapter & {getMusicStatus(): Promise<MusicStatus>; inspectTracks(tracks: DraftTrack[]): Promise<CatalogInspection>; searchArtists(term: string, country: string): Promise<ArtistSearchResult>; buildDiscography(request: SeedRequest, options: DiscographyOptions): Promise<{tracks: DraftTrack[]; warnings: string[]}>} {
  async function getMusicStatus(): Promise<MusicStatus> {
    const result = record(await invoke({action: "status"}));
    const generation = text(result.generation);
    return {platform: process.platform, running: false, accessibility: false, automation: "unknown", backend: "web-session", connection: generation ? "saved" : "missing", generation, storefront: text(result.storefront), message: generation ? "Apple Music web connection saved. Check your selection before writing." : "Connect to Apple Music to create playlists. No Accessibility permission is needed."};
  }
  return {
    kind: "web-session", getMusicStatus,
    searchArtists: (term, country) => searchCatalogArtists(term, country, invoke),
    buildDiscography: (request, options) => buildDiscography(request, options, invoke),
    async inspectTracks(tracks) {
      const status = await getMusicStatus();
      if (!status.generation) throw failure("missing", false);
      const catalogIds = tracks.map(track => String(track.catalogId));
      const result = record(await invoke({action: "inspectTracks", generation: status.generation, catalogIds}));
      if (result.generation !== status.generation || result.total !== tracks.length || !Number.isSafeInteger(result.availableCatalogTracks) || !Number.isSafeInteger(result.unavailableCatalogTracks) || Number(result.availableCatalogTracks) < 0 || Number(result.unavailableCatalogTracks) < 0 || Number(result.availableCatalogTracks) + Number(result.unavailableCatalogTracks) !== tracks.length || !text(result.storefront)) throw failure("malformed", false);
      const unavailableCatalogIds = result.unavailableCatalogIds;
      if (!Array.isArray(unavailableCatalogIds) || unavailableCatalogIds.some(id => typeof id !== "string" || !catalogIds.includes(id)) || new Set(unavailableCatalogIds).size !== unavailableCatalogIds.length || catalogIds.filter(id => unavailableCatalogIds.includes(id)).length !== result.unavailableCatalogTracks) throw failure("malformed", false);
      return {generation: status.generation, storefront: String(result.storefront), total: tracks.length, availableCatalogTracks: Number(result.availableCatalogTracks), unavailableCatalogTracks: Number(result.unavailableCatalogTracks), unavailableCatalogIds, newLibraryAdditions: 0, existingLibrarySongs: 0};
    },
    async ensurePlaylist(name, id, context) {
      const raw = await invoke({action: "ensurePlaylist", name, ...(id ? {playlistId: id} : {}), generation: context.connectionGeneration, catalogIds: context.expectedCatalogIds, ...(context.jobId ? {jobId: context.jobId} : {})});
      let result;
      try {result = record(raw);} catch {throw failure("malformed", !id);}
      if (typeof result.id !== "string" || !/^p\.[A-Za-z0-9_-]{1,120}$/.test(result.id)) throw failure("malformed", !id);
      return {id: result.id, name};
    },
    async addTrackToPlaylist(track, id, context): Promise<TrackWriteOutcome> {
      if (String(track.catalogId) !== context.expectedCatalogIds[context.position]) throw failure("invalid-input", false);
      let raw;
      try {raw = await invoke({action: "addTrackToPlaylist", playlistId: id, generation: context.connectionGeneration, catalogIds: context.expectedCatalogIds, position: context.position, reconcileOnly: context.reconcileOnly});}
      catch (error) {return {kind: (error as {uncertain?: boolean}).uncertain === false ? "not-added" : "uncertain", message: error instanceof Error ? error.message : failure("transport", true).message};}
      let result;
      try {result = record(raw);} catch {return {kind: "uncertain", message: failure("malformed", true).message};}
      if (result.kind === "confirmed" && result.catalogId === String(track.catalogId) && typeof result.alreadyPresent === "boolean") return {kind: "confirmed", catalogId: String(result.catalogId), alreadyPresent: result.alreadyPresent, ...(text(result.libraryId) ? {libraryId: String(result.libraryId)} : {})};
      if (result.kind === "not-added") return {kind: "not-added", message: "Apple Music did not add this song. Retry checks the playlist first."};
      if (result.kind === "conflict") return {kind: "conflict", message: "The playlist does not match the expected catalog order. The queue has stopped."};
      return {kind: "uncertain", message: "Apple Music has not confirmed this addition. Retry only reads the playlist for this song."};
    },
    async rebindPlaylist(id, context) {
      const result = record(await invoke({action: "rebindPlaylist", playlistId: id, generation: context.connectionGeneration, catalogIds: context.expectedCatalogIds, position: context.position, reconcileOnly: true}));
      if (result.generation !== context.connectionGeneration) throw failure("generation-changed", false);
      return {generation: context.connectionGeneration};
    },
    async playlistCover(id, context): Promise<PlaylistCover> {
      let raw;
      try {raw = await invoke({action: "playlistCover", playlistId: id, name: context.name, jobId: context.jobId, generation: context.connectionGeneration, catalogIds: context.expectedCatalogIds, coverMode: context.mode});}
      catch (error) {
        const value = error as {code?: unknown; uncertain?: unknown};
        const known = typeof value?.code === "string" && coverCodes.has(value.code);
        const blocked = known && value.uncertain === false && context.mode !== "check";
        return {state: blocked ? "blocked" : "uncertain", code: known ? String(value.code) : "connection-unconfirmed", helperAttempted: true, ...(blocked ? {writeAttempted: false} : {})};
      }
      let result;
      try {result = record(raw);} catch {return {state: "uncertain", code: "malformed", helperAttempted: true};}
      const hash = result.imageHash;
      if (Object.keys(result).some(key => !["state", "code", "writeAttempted", "imageHash"].includes(key)) ||
        typeof result.state !== "string" || !["verified", "blocked", "uncertain"].includes(result.state) || typeof result.code !== "string" || !coverCodes.has(result.code) ||
        typeof result.writeAttempted !== "boolean" || hash !== undefined && (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) ||
        result.state === "verified" && (result.code !== "image-verified" || hash === undefined) || result.code === "image-verified" && result.state !== "verified") {
        return {state: "uncertain", code: "malformed", helperAttempted: true, ...(result.writeAttempted === true ? {writeAttempted: true} : {})};
      }
      return {state: result.state === "blocked" && (result.writeAttempted || context.mode === "check") ? "uncertain" : result.state as PlaylistCover["state"], code: result.code, helperAttempted: true, writeAttempted: result.writeAttempted, ...(typeof hash === "string" ? {imageHash: hash} : {})};
    },
    async openPlaylist() {throw new Error("Open the playlist in your Apple Music library. A verified cloud playlist link is not available.");},
  };
}
