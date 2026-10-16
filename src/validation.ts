import type {Draft, DraftTrack, Provenance, SeedRequest} from "./types";

export function authorize(request: Request, port: number, token: string) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(request.headers.get("host") || "")) throw new Error("Invalid local host.");
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/api/history") {
    if (request.headers.get("x-wavelength-token") !== token) throw new Error("Invalid session token. Reload the app.");
    const origin = request.headers.get("origin");
    if (origin !== null && !hosts.map(host => `http://${host}`).includes(origin)) throw new Error("Only the local app can read history.");
  }
  if (request.method === "POST") {
    if (!hosts.map(host => `http://${host}`).includes(request.headers.get("origin") || "")) throw new Error("Only the local app can make changes.");
    if (request.headers.get("x-wavelength-token") !== token) throw new Error("Invalid session token. Reload the app.");
    if (path === "/api/history/preview") {
      if (!/^text\/csv(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(request.headers.get("content-type") || "")) throw Object.assign(new Error("Send UTF-8 CSV bytes with text/csv."), {status: 415});
    } else if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw new Error("JSON requests are required.");
  }
}
export function validateSeed(value: unknown): SeedRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid discovery request.");
  const v = value as Record<string, unknown>;
  if (!(["genre", "artist", "discography"] as unknown[]).includes(v.mode) || !(["mix", "essentials", "recent"] as unknown[]).includes(v.selection)) throw new Error("Choose a supported discovery mode and song selection.");
  if (typeof v.seed !== "string" || !v.seed.trim() || v.seed.length > 120) throw new Error("Enter an artist or genre, up to 120 characters.");
  if (v.mode === "discography") {
    if (!Number.isSafeInteger(v.artistId) || Number(v.artistId) <= 0) throw new Error("Choose an Apple Music artist before previewing a discography.");
  } else if (!Number.isInteger(v.count) || Number(v.count) < 1 || Number(v.count) > 50 || !Number.isInteger(v.perArtist) || Number(v.perArtist) < 1 || Number(v.perArtist) > 3) throw new Error("Choose 1 to 50 songs and 1 to 3 songs per artist.");
  if (typeof v.includeAI !== "boolean") throw new Error("Choose whether to include AI artists.");
  if (typeof v.country !== "string" || !["AU", "US", "GB", "CA", "JP", "DE"].includes(v.country)) throw new Error("Choose a supported Apple Music region.");
  return {...v, ...(v.mode === "discography" ? {count: 1000, perArtist: 1000} : {}), seed: v.seed.trim()} as SeedRequest;
}
export function artistSearch(value: unknown): {term: string; country: string} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Enter an artist search.");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["term", "country"].includes(key)) || typeof v.term !== "string" || !v.term.trim() || v.term.length > 120 || /[\u0000-\u001F\u007F]/.test(v.term)) throw new Error("Enter an artist name, up to 120 characters.");
  if (typeof v.country !== "string" || !["AU", "US", "GB", "CA", "JP", "DE"].includes(v.country)) throw new Error("Choose a supported Apple Music region.");
  return {term: v.term.trim(), country: v.country};
}
export function playlistName(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 150 || /[\u0000-\u001F]/.test(value)) throw new Error("Enter a playlist name, up to 150 characters.");
  return value.trim();
}
export function selectTracks(draft: Draft | undefined, ids: unknown, provenance: (artistId: number) => Provenance | undefined, includeAI = draft?.request.includeAI === true): DraftTrack[] {
  if (!draft || draft.status !== "ready") throw new Error("Build and review a playlist draft first.");
  if (!Array.isArray(ids) || !ids.length || ids.length > (draft.request.mode === "discography" ? 1000 : 50) || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) throw new Error("Select unique songs from this draft.");
  const tracks = ids.map(id => {
    const track = draft.tracks.find(track => track.id === id);
    if (!track) throw new Error("Song not found in this draft.");
    const latest = provenance(track.artistId) || track.provenance;
    if (!includeAI && latest.kind === "ai") throw new Error(`AI artists are off. Remove ${track.artist} or turn AI artists on.`);
    return {...track, provenance: latest};
  });
  return draft.request.mode === "discography" ? tracks.sort((a, b) => draft.tracks.findIndex(t => t.id === a.id) - draft.tracks.findIndex(t => t.id === b.id)) : tracks;
}
