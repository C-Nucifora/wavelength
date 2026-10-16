import type {ArtistSearchResult, Draft, DraftTrack, MusicStatus, Provenance, SeedRequest} from "./types";
import {Store} from "./store";
import {Jobs, type MusicAdapter} from "./jobs";
import {artistSearch, authorize, playlistName, selectTracks, validateSeed} from "./validation";
import {HistoryState} from "./history-state";
import {summarizeHistory, validateHistoryQuery} from "./history-summary";
import {HISTORY_LIMITS, type LibraryReadResult} from "./history-types";
import {normalizeLibraryRead} from "./history";
import type {CatalogInspection} from "./web-music";
import type {DiscographyOptions} from "./discography";

type Discovery = {
  getGenres(): Promise<Array<{name: string; slug: string}>>;
  buildDraft(request: SeedRequest, options: {signal: AbortSignal; onProgress: (progress: Draft["progress"]) => void; provenance: (id: number) => Provenance | undefined}): Promise<{tracks: DraftTrack[]; warnings: string[]}>;
};
type Dependencies = {store: Store; port: number; discovery: Discovery; readLibraryHistory?: () => Promise<LibraryReadResult>; now?: () => number; music: MusicAdapter & {getMusicStatus(): Promise<MusicStatus>; inspectTracks?(tracks: DraftTrack[]): Promise<CatalogInspection>; searchArtists?(term: string, country: string): Promise<ArtistSearchResult>; buildDiscography?(request: SeedRequest, options: DiscographyOptions): Promise<{tracks: DraftTrack[]; warnings: string[]}>}};
const publicFiles: Record<string, {name: string; type: string}> = {
  "/": {name: "index.html", type: "text/html; charset=utf-8"},
  "/styles.css": {name: "styles.css", type: "text/css; charset=utf-8"},
  "/app.js": {name: "app.js", type: "text/javascript; charset=utf-8"},
};
const headers = {
  "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://*.mzstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const json = (value: unknown, status = 200) => Response.json(value, {status, headers});

export function createApp({store, port, discovery, music, readLibraryHistory, now = Date.now}: Dependencies) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const drafts = new Map<string, AbortController>();
  const provenance = (id: number) => store.get<Provenance>("provenance", String(id));
  const assess = (track: DraftTrack, includeAI: boolean) => {
    const latest = provenance(track.artistId) || track.provenance;
    if (!includeAI && latest.kind === "ai") throw new Error(`AI artists are off. ${track.artist} is now marked AI. Build a new draft to change your selection.`);
    return {...track, provenance: latest};
  };
  const jobs = new Jobs(store, music, assess);
  const history = new HistoryState(store, now);
  const historyResponse = () => summarizeHistory(store.history(), validateHistoryQuery(new URLSearchParams({timeZone: "UTC"})), now());
  let musicRead: "scan" | "preflight" | "open" | "catalog" | undefined;
  const busy = () => Object.assign(new Error("Music is busy. Wait for the current operation."), {status: 409});
  function acquireMusicRead(kind: "scan" | "preflight" | "open" | "catalog"): () => void {
    if (musicRead || jobs.isActive()) throw busy();
    musicRead = kind;
    return () => {musicRead = undefined;};
  }
  function exactKeys(input: Record<string, unknown>, keys: string[]) {
    if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) throw new Error("Send only the required history fields; filesystem paths are not accepted.");
  }
  async function* csvBody(request: Request): AsyncGenerator<Uint8Array> {
    const reader = request.body?.getReader();
    let complete = false;
    try {
      const announced = request.headers.get("content-length");
      if (announced !== null && (!/^\d+$/.test(announced) || !Number.isFinite(Number(announced)))) throw new Error("Invalid request content length.");
      if (Number(announced) > HISTORY_LIMITS.fileBytes) throw Object.assign(new Error("CSV file exceeds 20 MiB."), {status: 413});
      let length = 0;
      if (reader) while (true) {
        const {value, done} = await reader.read();
        if (done) {complete = true; break;}
        length += value.byteLength;
        if (length > HISTORY_LIMITS.fileBytes) throw Object.assign(new Error("CSV file exceeds 20 MiB."), {status: 413});
        yield value;
      }
    } finally {
      if (reader) {try {if (!complete) await reader.cancel();} finally {reader.releaseLock();}}
    }
  }
  const preflights = new Map<string, {key: string; checkedAt: number; generation?: string; unavailable?: number}>();
  const selectionKey = (input: Record<string, unknown>) => JSON.stringify([input.draftId, [...input.trackIds as string[]].sort(), input.includeAI]);
  for (const draft of store.all<Draft>("draft")) if (draft.status === "building") {
    draft.status = "failed";
    draft.error = "The app stopped while building this draft. Build it again.";
    store.put("draft", draft.id, draft);
  }
  async function build(draft: Draft, controller: AbortController) {
    let release: (() => void) | undefined;
    try {
      const options = {signal: controller.signal, provenance, onProgress: (progress: Draft["progress"]) => {
        if (!controller.signal.aborted) {draft.progress = progress; store.put("draft", draft.id, draft);}
      }};
      let result: {tracks: DraftTrack[]; warnings: string[]};
      if (draft.request.mode === "discography") {
        if (!music.buildDiscography) throw new Error("Apple Music discography lookup is unavailable.");
        release = acquireMusicRead("catalog");
        result = await music.buildDiscography(draft.request, options);
      } else result = await discovery.buildDraft(draft.request, options);
      if (!controller.signal.aborted) {draft.tracks = result.tracks; draft.warnings = result.warnings; draft.status = "ready";}
    } catch (error) {
      if (!controller.signal.aborted) {draft.status = "failed"; draft.error = error instanceof Error ? error.message : String(error);}
    } finally {release?.();}
    if (controller.signal.aborted) draft.status = "cancelled";
    store.put("draft", draft.id, draft);
    drafts.delete(draft.id);
  }
  async function body(request: Request): Promise<Record<string, unknown>> {
    if (Number(request.headers.get("content-length") || 0) > 131072) throw Object.assign(new Error("Request is too large."), {status: 413});
    const reader = request.body?.getReader();
    let length = 0;
    const chunks: Uint8Array[] = [];
    if (reader) while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 131072) {await reader.cancel(); throw Object.assign(new Error("Request is too large."), {status: 413});}
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
    try {
      const result = JSON.parse(new TextDecoder().decode(bytes));
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
      return result;
    } catch {throw new Error("Send a JSON object.");}
  }
  async function fetch(request: Request): Promise<Response> {
    try {authorize(request, port, token);} catch (error) {return json({error: (error as Error).message}, (error as {status?: number}).status || 403);}
    const path = new URL(request.url).pathname;
    if (!["GET", "POST"].includes(request.method)) return json({error: "Method not allowed."}, 405);
    try {
      if (request.method === "GET") {
        if (path === "/api/history") return json(summarizeHistory(store.history(), validateHistoryQuery(new URL(request.url).searchParams), now()));
        if (path === "/api/session") return json({token});
        if (path === "/api/ready") return json({ready: true, instance: process.env.WAVELENGTH_INSTANCE || "", activeJob: jobs.latest()});
        if (path === "/api/status") return json({music: await music.getMusicStatus(), activeJob: jobs.latest(), version: "0.1.0"});
        if (path === "/api/genres") return json({genres: await discovery.getGenres()});
        const draftId = path.match(/^\/api\/drafts\/([\w-]+)$/)?.[1];
        if (draftId) {const draft = store.get<Draft>("draft", draftId); return draft ? json(draft) : json({error: "Draft not found."}, 404);}
        const jobId = path.match(/^\/api\/jobs\/([\w-]+)$/)?.[1];
        if (jobId) {const job = jobs.get(jobId); return job ? json(job) : json({error: "Playlist job not found."}, 404);}
        const file = publicFiles[path];
        if (file) return new Response(Bun.file(new URL(`../public/${file.name}`, import.meta.url)), {headers: {...headers, "Content-Type": file.type}});
        return json({error: "Not found."}, 404);
      }
      if (path === "/api/history/preview") return json(await history.preview(csvBody(request)));
      const input = await body(request);
      if (path === "/api/history/library") {
        exactKeys(input, []);
        if (!readLibraryHistory) throw new Error("Music library history is unavailable.");
        const release = acquireMusicRead("scan");
        try {
          const generation = history.beginScan();
          const result = await readLibraryHistory();
          history.finishScan(generation, normalizeLibraryRead(result));
          return json(historyResponse());
        } finally {release();}
      }
      if (path === "/api/history/import") {
        exactKeys(input, ["token", "replace"]);
        if (typeof input.token !== "string" || !input.token || typeof input.replace !== "boolean") throw new Error("Send a preview token and explicit replacement choice.");
        history.importPreview(input.token, input.replace);
        return json(historyResponse());
      }
      if (path === "/api/history/forget") {exactKeys(input, []); history.forget(); return json({ok: true});}
      if (path === "/api/artists/search") {
        const search = artistSearch(input);
        if (!music.searchArtists) throw new Error("Apple Music artist search is unavailable.");
        const release = acquireMusicRead("catalog");
        try {return json(await music.searchArtists(search.term, search.country));} finally {release();}
      }
      if (path === "/api/drafts") {
        if (drafts.size) throw new Error("A draft is already building. Cancel it or wait first.");
        const seed = validateSeed(input);
        const draft: Draft = {id: crypto.randomUUID(), request: seed, status: "building", title: `${seed.seed} ${seed.mode === "discography" ? "discography" : seed.selection === "recent" ? "new releases" : "discovery"}`, tracks: [], warnings: [], progress: {done: 0, total: seed.mode === "discography" ? 1 : seed.count, message: seed.mode === "discography" ? "Finding artist releases" : "Finding artists"}, createdAt: new Date().toISOString()};
        store.put("draft", draft.id, draft);
        const controller = new AbortController();
        drafts.set(draft.id, controller);
        void build(draft, controller);
        return json(draft);
      }
      const draftId = path.match(/^\/api\/drafts\/([\w-]+)\/cancel$/)?.[1];
      if (draftId) {
        const draft = store.get<Draft>("draft", draftId);
        if (!draft) return json({error: "Draft not found."}, 404);
        drafts.get(draftId)?.abort();
        if (draft.status === "building") {draft.status = "cancelled"; store.put("draft", draft.id, draft);}
        return json(draft);
      }
      if (path === "/api/provenance") {
        if (!Number.isSafeInteger(input.artistId) || Number(input.artistId) <= 0 || !["ai", "human", "unknown"].includes(String(input.kind))) throw new Error("Choose an artist and a supported provenance label.");
        if (input.evidence !== undefined && (typeof input.evidence !== "string" || input.evidence.length > 2000)) throw new Error("Evidence must be text, up to 2000 characters.");
        store.put("provenance", String(input.artistId), {kind: input.kind, evidence: typeof input.evidence === "string" && input.evidence.trim() ? [input.evidence.trim()] : [], note: "Personal classification, not independently verified"});
        preflights.clear();
        return json({ok: true});
      }
      if (path === "/api/preflight" || path === "/api/jobs") {
        if (path === "/api/jobs" && musicRead) throw busy();
        if (typeof input.includeAI !== "boolean") throw new Error("Choose whether to include AI artists.");
        const draft = typeof input.draftId === "string" ? store.get<Draft>("draft", input.draftId) : undefined;
        const tracks = selectTracks(draft, input.trackIds, provenance, input.includeAI);
        if (path === "/api/preflight") {
          if (!music.inspectTracks) throw new Error("Library inspection is unavailable.");
          const release = acquireMusicRead("preflight");
          let result;
          try {result = await music.inspectTracks(tracks);} finally {release();}
          const id = crypto.randomUUID();
          if (preflights.size >= 64) preflights.delete(preflights.keys().next().value!);
          if (music.kind === "web-session" && !result.generation) throw new Error("Check the Apple Music connection again.");
          preflights.set(id, {key: selectionKey(input), checkedAt: Date.now(), generation: result.generation, unavailable: result.unavailableCatalogTracks});
          return json({id, ...result});
        }
        const check = typeof input.preflightId === "string" ? preflights.get(input.preflightId) : undefined;
        if (!check || check.key !== selectionKey(input) || Date.now() - check.checkedAt > 10 * 60_000) throw new Error("Check the library for this selection before creating the playlist.");
        if (check.unavailable) throw new Error("Some selected songs are unavailable in your Apple Music storefront. Change the selection and check again.");
        const job = jobs.create(playlistName(input.name), tracks, input.includeAI, check.generation);
        preflights.delete(input.preflightId as string);
        return json(job);
      }
      const coverAction = path.match(/^\/api\/jobs\/([\w-]+)\/cover-(retry|check|permission)$/);
      if (coverAction) {
        if (Object.keys(input).length) throw new Error("Send an empty JSON object for cover actions.");
        if (musicRead || jobs.isActive()) throw busy();
        return json(jobs.coverAction(coverAction[1]!, coverAction[2] as "retry" | "check" | "permission"));
      }
      const jobAction = path.match(/^\/api\/jobs\/([\w-]+)\/(cancel|retry|open)$/);
      if (jobAction) {
        const id = jobAction[1]!;
        if (jobAction[2] === "cancel") return json(jobs.cancel(id));
        if (jobAction[2] === "retry") {if (musicRead) throw busy(); return json(jobs.retry(id));}
        const release = acquireMusicRead("open");
        try {await jobs.open(id);} finally {release();}
        return json({ok: true});
      }
      return json({error: "Not found."}, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const conflict = /superseded or forgotten|Select the file again|Confirm replacement/.test(message);
      const oversized = /^(?:CSV|History fields|Library) (?:field )?exceeds? (?:20 MiB|4,000 characters|100,000 data rows|50,000 tracks)/.test(message);
      return json({error: message}, (error as {status?: number})?.status || (conflict ? 409 : oversized ? 413 : 400));
    }
  }
  return {token, fetch, jobs, dispose: () => history.dispose()};
}
