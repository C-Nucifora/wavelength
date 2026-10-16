import type {ArtistSearchResult, CatalogArtist, Draft, DraftTrack, Provenance, SeedRequest} from "./types";
import {artistSearch} from "./validation";

export type CatalogRequest = {action: "status" | "catalogArtists" | "catalogReleases" | "catalogTracks"; generation?: string; country?: string; term?: string; artistId?: string; releaseId?: string; offset?: number};
export type DiscographyOptions = {signal: AbortSignal; onProgress: (progress: Draft["progress"]) => void; provenance: (artistId: number) => Provenance | undefined};
type Invoke = (request: CatalogRequest) => Promise<unknown>;
type Release = {id: number; name: string; releaseDate: string; trackCount: number; url: string; artworkUrl?: string};
const malformed = () => new Error("Apple Music returned an incomplete or malformed catalog page. Preview stopped.");
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw malformed();
  return value as Record<string, unknown>;
};
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\u0000-\u001F\u007F]/.test(value)) throw malformed();
  return value;
}
function appleUrl(value: unknown, artwork = false): string {
  const url = new URL(text(value));
  if (url.protocol !== "https:" || url.username || url.password || url.port || (artwork ? !(url.hostname === "mzstatic.com" || url.hostname.endsWith(".mzstatic.com")) : !["music.apple.com", "itunes.apple.com"].includes(url.hostname))) throw malformed();
  return url.href;
}
function artwork(value: unknown): {artworkUrl?: string} { return value === undefined ? {} : {artworkUrl: appleUrl(value, true)}; }
async function generation(invoke: Invoke): Promise<string> {
  const result = record(await invoke({action: "status"}));
  if (typeof result.generation !== "string" || !result.generation) throw new Error("Connect to Apple Music before previewing a discography.");
  return result.generation;
}
function page(value: unknown, expectedGeneration: string, country: string): Record<string, unknown> {
  const result = record(value);
  if (result.generation !== expectedGeneration) throw new Error("The Apple Music connection changed. Preview the discography again.");
  if (result.storefront !== country.toLowerCase()) throw new Error("Your Apple Music storefront differs from the selected region. Choose your connected region and preview again.");
  return result;
}
function rows(value: unknown, limit: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > limit) throw malformed();
  return value.map(record);
}
function next(result: Record<string, unknown>, offset: number): number | undefined {
  if (result.nextOffset === undefined) return;
  if (!Number.isSafeInteger(result.nextOffset) || Number(result.nextOffset) <= offset || Number(result.nextOffset) > 10000) throw new Error("Apple Music returned invalid catalog pagination. Preview stopped.");
  return Number(result.nextOffset);
}
function date(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("A release has no valid full Apple release date. Its chronological order cannot be verified.");
  return value;
}
export async function searchCatalogArtists(term: string, country: string, invoke: Invoke): Promise<ArtistSearchResult> {
  const search = artistSearch({term, country});
  const current = await generation(invoke);
  const result = page(await invoke({action: "catalogArtists", generation: current, ...search}), current, country);
  const artists: CatalogArtist[] = rows(result.artists, 25).map(item => {
    if (!positive(item.id)) throw malformed();
    return {id: item.id, name: text(item.name), url: appleUrl(item.url), ...artwork(item.artworkUrl)};
  });
  if (new Set(artists.map(a => a.id)).size !== artists.length) throw malformed();
  return {artists, storefront: country.toLowerCase()};
}
export async function buildDiscography(request: SeedRequest, options: DiscographyOptions, invoke: Invoke): Promise<{tracks: DraftTrack[]; warnings: string[]}> {
  const {signal, onProgress, provenance} = options;
  signal.throwIfAborted();
  if (request.mode !== "discography" || !positive(request.artistId)) throw new Error("Choose an Apple Music artist before previewing a discography.");
  const current = await generation(invoke);
  const read = async (input: CatalogRequest) => {
    signal.throwIfAborted();
    const result = page(await invoke({...input, generation: current, country: request.country}), current, request.country);
    signal.throwIfAborted();
    return result;
  };
  const releases: Release[] = [];
  const releaseIds = new Set<number>();
  let offset: number | undefined = 0;
  do {
    onProgress({done: 0, total: 1, message: `Finding ${request.seed}'s albums, EPs and singles`});
    const result = await read({action: "catalogReleases", artistId: String(request.artistId), offset});
    for (const item of rows(result.releases, 25)) {
      if (!positive(item.id) || !positive(item.trackCount) || releaseIds.has(item.id)) throw malformed();
      releaseIds.add(item.id);
      releases.push({id: item.id, name: text(item.name), releaseDate: date(item.releaseDate), trackCount: item.trackCount, url: appleUrl(item.url), ...artwork(item.artworkUrl)});
    }
    if (releases.length > 1000) throw new Error("This discography exceeds the supported limit of 1,000 releases. No partial draft was created.");
    offset = next(result, offset);
  } while (offset !== undefined);
  if (!releases.length) throw new Error("Apple Music returned no artist-owned albums, EPs or singles in this storefront.");
  releases.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate) || a.name.localeCompare(b.name, "en") || a.id - b.id);
  const tracks: DraftTrack[] = [];
  let excludedAI = 0, skippedVideos = 0;
  for (const [index, release] of releases.entries()) {
    const releaseTracks: DraftTrack[] = [];
    const positions = new Set<string>();
    let count = 0;
    offset = 0;
    do {
      onProgress({done: index, total: releases.length, message: `Reading ${release.name}`});
      const result = await read({action: "catalogTracks", releaseId: String(release.id), offset});
      const videos = result.skippedMusicVideos ?? 0;
      if (!Number.isSafeInteger(videos) || Number(videos) < 0 || Number(videos) > 50) throw malformed();
      skippedVideos += Number(videos); count += Number(videos);
      for (const item of rows(result.tracks, 50)) {
        if (!positive(item.id) || !positive(item.artistId) || !positive(item.discNumber) || !positive(item.trackNumber) || !Number.isSafeInteger(item.durationMs) || Number(item.durationMs) < 0) throw malformed();
        const position = `${item.discNumber}:${item.trackNumber}`;
        if (positions.has(position)) throw new Error("Apple Music returned duplicate positions within a release. Preview stopped.");
        positions.add(position);
        const origin = provenance(item.artistId) ?? {kind: "unknown", evidence: []};
        releaseTracks.push({id: `apple:${release.id}:${position}:${item.id}`, catalogId: item.id, artistId: item.artistId, title: text(item.title), artist: text(item.artist), album: release.name,
          durationMs: Number(item.durationMs), releaseDate: release.releaseDate, ...artwork(item.artworkUrl ?? release.artworkUrl), url: appleUrl(item.url), source: "Apple Music artist discography", sourceUrl: release.url,
          match: "exact", provenance: origin, selected: true, releaseId: release.id, discNumber: item.discNumber, trackNumber: item.trackNumber});
        count++;
      }
      if (tracks.length + releaseTracks.length > 1000) throw new Error("This discography exceeds the supported limit of 1,000 songs. No partial draft was created.");
      if (count > release.trackCount) throw malformed();
      offset = next(result, offset);
    } while (offset !== undefined);
    if (count !== release.trackCount) throw new Error(`Apple Music returned an incomplete tracklist for ${release.name}. No partial draft was created.`);
    releaseTracks.sort((a, b) => a.discNumber! - b.discNumber! || a.trackNumber! - b.trackNumber!);
    for (const track of releaseTracks) {
      if (!request.includeAI && track.provenance.kind === "ai") excludedAI++;
      else tracks.push(track);
    }
  }
  signal.throwIfAborted();
  const warnings = ["Release dates and editions follow the current Apple Music storefront catalog. Songs repeated across releases are retained.", "Unknown AI provenance is not a claim that an artist is human. The AI filter excludes only artists with recorded evidence."];
  if (excludedAI) warnings.push(`Excluded ${excludedAI} songs from artists marked AI by recorded evidence.`);
  if (skippedVideos) warnings.push(`Skipped ${skippedVideos} music videos; this playlist contains songs.`);
  onProgress({done: releases.length, total: releases.length, message: `Discography ready: ${tracks.length} songs from ${releases.length} releases`});
  return {tracks, warnings};
}
