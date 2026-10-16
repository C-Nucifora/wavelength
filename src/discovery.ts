import { createHash } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Draft, DraftTrack, Provenance, SeedRequest } from "./types";

type ArtistSeed = { name: string; representative?: string; source: string; sourceUrl: string };
type CatalogSong = { kind?: string; trackId?: number; artistId?: number; artistName?: string; trackName?: string;
  collectionName?: string; trackTimeMillis?: number; releaseDate?: string; artworkUrl100?: string; trackViewUrl?: string };
type CatalogResponse = { results?: CatalogSong[] };
type SongCandidate = { song: CatalogSong; representative?: string; selection: "Essentials" | "Recent" | "Catalog search review" };
type Options = { signal: AbortSignal; onProgress: (progress: Draft["progress"]) => void;
  provenance: (artistId: number) => Provenance | undefined };
const NOISE = "https://everynoise.com/";
const USER_AGENT = "Wavelength/0.1.0 (local music discovery; https://everynoise.com/)";
const nextRequest = new Map<string, number>();
const DAY = 86_400_000;

const entities: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ",
  raquo: "»", laquo: "«", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  hellip: "…", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", yen: "¥", cent: "¢", middot: "·" };
const accents = { grave: "\u0300", acute: "\u0301", circ: "\u0302", tilde: "\u0303", uml: "\u0308", ring: "\u030a", cedil: "\u0327" };
function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, (whole, key: string) => {
    if (key.startsWith("#")) {
      const n = key[1]?.toLowerCase() === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : whole;
    }
    if (entities[key]) return entities[key];
    const accent = key.match(/^([a-z])(grave|acute|circ|tilde|uml|ring|cedil)$/i);
    if (accent) return (accent[1]! + accents[accent[2] as keyof typeof accents]).normalize("NFC");
    return ({ Oslash: "Ø", oslash: "ø", AElig: "Æ", aelig: "æ", szlig: "ß", ETH: "Ð", eth: "ð", THORN: "Þ", thorn: "þ" } as Record<string, string>)[key] ?? whole;
  });
}

export async function parseGenreIndex(html: string): Promise<Array<{ name: string; slug: string }>> {
  const rows: Array<{ name: string; slug: string }> = [];
  let name = "";
  let inLink = false;
  let slug = "";
  const rewriter = new HTMLRewriter().on("div.genre", {
    element(e) { name = ""; slug = ""; inLink = false; e.onEndTag(() => {
      const label = decode(name).trim();
      if (label && slug) rows.push({ name: label, slug });
    }); },
    text(t) { if (!inLink) name += t.text; },
  }).on("div.genre a", {
    element(e) { inLink = true; const href = e.getAttribute("href") ?? "";
      const match = href.match(/^engenremap-([a-z0-9_-]+)\.html$/);
      if (match) slug = match[1]!;
      e.onEndTag(() => { inLink = false; });
    },
  });
  await rewriter.transform(new Response(html)).text();
  return [...new Map(rows.map(row => [row.slug, row])).values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function parseArtists(html: string): Promise<ArtistSeed[]> {
  const rows: ArtistSeed[] = [];
  let row: ArtistSeed | undefined;
  let text = "";
  let inLink = false;
  const rewriter = new HTMLRewriter().on("div.genre.scanme", {
    element(e) {
      const title = decode(e.getAttribute("title") ?? "");
      const sample = title.match(/^e\.g\.\s+(.+?)\s+"(.+)"\s*$/s);
      text = ""; inLink = false;
      row = { name: sample?.[1] ?? "", ...(sample?.[2] ? { representative: sample[2] } : {}), source: "Every Noise", sourceUrl: NOISE };
      e.onEndTag(() => {
        if (row) { row.name = decode(text).trim() || row.name; if (row.name) rows.push(row); }
        row = undefined;
      });
    },
    text(t) { if (!inLink) text += t.text; },
  }).on("div.genre.scanme a", {
    element(e) {
      inLink = true;
      const href = e.getAttribute("href") ?? "";
      if (row && /^artistprofile\.html\?id=[a-zA-Z0-9]+$/.test(href)) row.sourceUrl = new URL(href, NOISE).href;
      e.onEndTag(() => { inLink = false; });
    },
  });
  await rewriter.transform(new Response(html)).text();
  return [...new Map(rows.map(r => [normalize(r.name), r])).values()];
}

function normalize(value: string): string {
  const cleaned = value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return cleaned || value.trim().toLowerCase();
}
function titleIdentity(value: string): string {
  // A remaster label describes mastering. Live, remix, edit, and numbered parts remain part of identity.
  return normalize(value.replace(/\s*(?:[-–—]\s*|[\[(])(?:\d{4}\s+)?(?:digital\s+)?remaster(?:ed)?(?:\s+(?:in\s+)?\d{4})?[\])]?(?=\s*$)/i, ""));
}
export function matchTrack(sourceArtist: string, sourceTitle: string | undefined, artist: string, title: string): "exact" | "review" {
  return normalize(sourceArtist) === normalize(artist) && (!sourceTitle || titleIdentity(sourceTitle) === titleIdentity(title)) ? "exact" : "review";
}

export function selectTracks(tracks: DraftTrack[], count: number, perArtist: number, includeAI: boolean): DraftTrack[] {
  const seen = new Set<number>();
  const artists = new Map<number, number>();
  return tracks.filter(t => {
    if (seen.has(t.catalogId) || (!includeAI && t.provenance.kind === "ai") || (artists.get(t.artistId) ?? 0) >= perArtist) return false;
    seen.add(t.catalogId); artists.set(t.artistId, (artists.get(t.artistId) ?? 0) + 1); return true;
  }).slice(0, count);
}

function cancelled(signal: AbortSignal): void { signal.throwIfAborted(); }
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  cancelled(signal);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

async function cached(url: string, ttl: number, signal: AbortSignal): Promise<string> {
  cancelled(signal);
  const root = process.env.WAVELENGTH_DATA_DIR || join(homedir(), "Library", "Application Support", "Wavelength");
  const file = join(root, "discovery-cache", createHash("sha256").update(url).digest("hex") + ".json");
  try {
    const saved = JSON.parse(await readFile(file, "utf8")) as { savedAt: number; text: string };
    if (typeof saved.text === "string" && Date.now() - saved.savedAt < ttl) { cancelled(signal); return saved.text; }
  } catch (error) { cancelled(signal); }
  const host = new URL(url).hostname;
  const interval = host === "itunes.apple.com" ? 3100 : 1100;
  const slot = Math.max(Date.now(), nextRequest.get(host) ?? 0);
  nextRequest.set(host, slot + interval);
  await delay(slot - Date.now(), signal);
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]), headers: { "User-Agent": USER_AGENT, Accept: "application/json,text/html" } });
  if (!response.ok) {
    if (response.status === 429) nextRequest.set(host, Date.now() + Math.max(60_000, Number(response.headers.get("retry-after") || 0) * 1000));
    throw new Error(`${host} returned HTTP ${response.status}${response.status === 429 ? "; wait a minute and try again" : ""}`);
  }
  const text = await response.text();
  cancelled(signal);
  if (host !== "everynoise.com" && new URL(url).pathname !== "/similar-artists") JSON.parse(text);
  // Cache persistence is optional; discovery still works when this directory is read-only.
  try {
    await mkdir(join(root, "discovery-cache"), { recursive: true });
    const temporary = file + "." + crypto.randomUUID() + ".tmp";
    await Bun.write(temporary, JSON.stringify({ savedAt: Date.now(), text }));
    await rename(temporary, file);
  } catch { /* An unwritable cache must not hide a successful response. */ }
  return text;
}
async function json<T>(url: string, ttl: number, signal: AbortSignal): Promise<T> {
  try { return JSON.parse(await cached(url, ttl, signal)) as T; }
  catch (error) { cancelled(signal); throw error; }
}

export async function getGenres(): Promise<Array<{ name: string; slug: string }>> {
  const genres = await parseGenreIndex(await cached(NOISE + "engenremap.html", 7 * DAY, new AbortController().signal));
  if (!genres.length) throw new Error("Every Noise returned no genre links. Its page format may have changed.");
  return genres;
}

async function relatedArtists(seed: string, limit: number, signal: AbortSignal, warnings: string[]): Promise<ArtistSeed[]> {
  const fallback: ArtistSeed = { name: seed, source: "Artist seed", sourceUrl: "https://musicbrainz.org/" };
  try {
    const query = new URL("https://musicbrainz.org/ws/2/artist/");
    query.search = new URLSearchParams({ query: `artist:"${seed.replace(/[+\-!(){}\[\]^"~*?:\\/]/g, "\\$&")}"`, fmt: "json", limit: "8" }).toString();
    const result = await json<{ artists?: Array<{ id: string; name: string; score?: number }> }>(query.href, 7 * DAY, signal);
    const exact = (result.artists ?? []).filter(a => normalize(a.name) === normalize(seed));
    if (exact.length !== 1) throw new Error(exact.length ? "the artist name is ambiguous in MusicBrainz" : "MusicBrainz has no exact artist match");
    const artist = exact[0]!;
    fallback.sourceUrl = `https://musicbrainz.org/artist/${artist.id}`;
    const form = await cached("https://labs.api.listenbrainz.org/similar-artists", DAY, signal);
    let algorithm = "";
    await new HTMLRewriter().on("select#algorithm option", { element(e) { algorithm ||= e.getAttribute("value") || e.getAttribute("id") || ""; } }).transform(new Response(form)).text();
    if (!algorithm) throw new Error("ListenBrainz has no similarity algorithm available");
    const similarURL = new URL("https://labs.api.listenbrainz.org/similar-artists/json");
    similarURL.search = new URLSearchParams({ artist_mbids: artist.id, algorithm }).toString();
    const similar = await json<Array<{ name?: string; artist_mbid?: string; reference_mbid?: string }>>(similarURL.href, DAY, signal);
    if (!Array.isArray(similar)) throw new Error("ListenBrainz returned an unexpected response");
    const names = new Set([normalize(seed)]);
    const related: ArtistSeed[] = [];
    for (const item of similar) {
      if (!item.name || !item.artist_mbid || names.has(normalize(item.name)) || (item.reference_mbid && item.reference_mbid !== artist.id)) continue;
      names.add(normalize(item.name));
      related.push({ name: item.name, source: `ListenBrainz similar to ${artist.name}`, sourceUrl: similarURL.href });
      if (related.length >= limit - 1) break;
    }
    if (!related.length) throw new Error("ListenBrainz has no similar-artist coverage for this seed");
    return [fallback, ...related];
  } catch (error) {
    cancelled(signal);
    warnings.push(`Related artists unavailable: ${error instanceof Error ? error.message : String(error)}. Showing seed artist tracks only.`);
    return [fallback];
  }
}

async function songsForArtist(seed: ArtistSeed, request: SeedRequest, signal: AbortSignal, artistIndex: number): Promise<SongCandidate[]> {
  const selection = request.selection === "mix" && request.perArtist === 1 ? (artistIndex % 2 === 0 ? "essentials" : "recent") : request.selection;
  const query = new URL("https://itunes.apple.com/search");
  const representative = selection !== "recent" ? seed.representative : undefined;
  query.search = new URLSearchParams({ term: `${seed.name}${representative ? " " + representative.replace(/\s+-\s+.*remaster.*$/i, "") : ""}`, country: request.country || "AU", entity: "song", limit: "100" }).toString();
  const result = await json<CatalogResponse>(query.href, DAY, signal);
  const songs = (result.results ?? []).filter(song => song.kind === "song" && Number.isSafeInteger(song.trackId) && Number.isSafeInteger(song.artistId) && song.artistName && song.trackName && song.trackViewUrl);
  const sameArtist = songs.filter(song => normalize(song.artistName!) === normalize(seed.name));
  if (representative) sameArtist.sort((a, b) => Number(matchTrack(seed.name, representative, b.artistName!, b.trackName!) === "exact") - Number(matchTrack(seed.name, representative, a.artistName!, a.trackName!) === "exact"));
  const essentials: SongCandidate[] = sameArtist.map(song => ({ song, representative, selection: "Essentials" }));
  if (selection === "essentials") return essentials;
  // Resolve the Apple artist before lookup. Same-name artists remain review candidates rather than being merged.
  const ids = [...new Set(sameArtist.map(s => s.artistId!))];
  if (ids.length !== 1) return selection === "mix" ? essentials : sameArtist.map(song => ({ song, selection: "Catalog search review" }));
  const lookup = new URL("https://itunes.apple.com/lookup");
  lookup.search = new URLSearchParams({ id: String(ids[0]), entity: "song", sort: "recent", limit: "200", country: request.country || "AU" }).toString();
  const recent = await json<CatalogResponse>(lookup.href, DAY, signal);
  const latest: SongCandidate[] = (recent.results ?? []).filter(s => s.kind === "song" && s.artistId === ids[0] && Number.isSafeInteger(s.trackId) && s.trackName && s.trackViewUrl)
    .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "")).map(song => ({ song, selection: "Recent" }));
  if (selection === "recent") return latest;
  const mixed: SongCandidate[] = [];
  const seen = new Set<number>();
  let essentialIndex = 0;
  let recentIndex = 0;
  while (essentialIndex < essentials.length || recentIndex < latest.length) {
    for (const lane of ["essentials", "recent"] as const) {
      const choices = lane === "essentials" ? essentials : latest;
      while ((lane === "essentials" ? essentialIndex : recentIndex) < choices.length) {
        const candidate = choices[lane === "essentials" ? essentialIndex++ : recentIndex++]!;
        if (seen.has(candidate.song.trackId!)) continue;
        seen.add(candidate.song.trackId!); mixed.push(candidate); break;
      }
    }
  }
  return mixed;
}

export async function buildDraft(request: SeedRequest, options: Options): Promise<{ tracks: DraftTrack[]; warnings: string[] }> {
  const { signal, onProgress, provenance } = options;
  cancelled(signal);
  const warnings = ["Apple search metadata does not guarantee subscription availability. Music.app verifies additions.", "Unknown AI provenance is not a claim that an artist is human. The AI filter excludes only artists with recorded evidence."];
  onProgress({ done: 0, total: 1, message: "Finding source artists…" });
  let artists: ArtistSeed[];
  const maxArtists = Math.min(80, Math.max(12, request.count * 2));
  if (request.mode === "genre") {
    const genres = await parseGenreIndex(await cached(NOISE + "engenremap.html", 7 * DAY, signal));
    const genre = genres.find(g => normalize(g.name) === normalize(request.seed) || g.slug === request.seed);
    if (!genre) throw new Error(`Every Noise genre not found: ${request.seed}`);
    const pageURL = `${NOISE}engenremap-${genre.slug}.html`;
    artists = await parseArtists(await cached(pageURL, 7 * DAY, signal));
    if (!artists.length) throw new Error("Every Noise returned no artists for this genre. Its page format may have changed.");
    artists = artists.map(a => ({ ...a, source: `Every Noise · ${genre.name}`, sourceUrl: pageURL }));
    if (request.selection === "mix") {
      // Sample across this one genre page, keeping discovery to user-triggered pages only.
      artists = artists.map(a => ({ a, order: Math.random() })).sort((a, b) => a.order - b.order).map(v => v.a);
    }
    artists = artists.slice(0, maxArtists);
  } else {
    artists = await relatedArtists(request.seed, maxArtists, signal, warnings);
    if (request.selection !== "recent") warnings.push("Artist essentials use Apple search ranking. This source does not provide a verified greatest-hits list.");
  }
  if (request.selection !== "essentials") warnings.push("Recent sorts returned catalog releases by metadata date. Reissues and incomplete catalog coverage may affect the result.");
  const candidates: DraftTrack[] = [];
  let failureCount = 0;
  let excludedAI = 0;
  let examined = 0;
  for (let i = 0; i < artists.length; i++) {
    cancelled(signal);
    const seed = artists[i]!;
    examined = i + 1;
    onProgress({ done: i, total: artists.length, message: `Matching ${seed.name} in Apple Music…` });
    try {
      const songs = await songsForArtist(seed, request, signal, i);
      const ids = new Set(songs.map(s => s.song.artistId));
      let kept = 0;
      for (const candidate of songs) {
        const { song, representative } = candidate;
        if (kept >= request.perArtist) break;
        const origin = provenance(song.artistId!) ?? { kind: "unknown", evidence: [] };
        if (!request.includeAI && origin.kind === "ai") { excludedAI++; continue; }
        const match = ids.size > 1 ? "review" : matchTrack(seed.name, representative, song.artistName!, song.trackName!);
        if (candidates.some(t => t.catalogId === song.trackId)) continue;
        candidates.push({ id: `apple:${song.trackId}`, catalogId: song.trackId!, artistId: song.artistId!, title: song.trackName!, artist: song.artistName!,
          album: song.collectionName ?? "", durationMs: song.trackTimeMillis ?? 0, releaseDate: song.releaseDate ?? "", artworkUrl: song.artworkUrl100,
          url: song.trackViewUrl!, source: `${seed.source} · ${candidate.selection}`, sourceUrl: seed.sourceUrl, match, provenance: origin, selected: match === "exact" });
        kept++;
      }
    } catch (error) {
      cancelled(signal);
      failureCount++;
      warnings.push(`${seed.name}: ${error instanceof Error ? error.message : String(error)}`);
      if (failureCount >= 3) { warnings.push("Stopped after three catalog request failures. Try again later."); break; }
    }
    if (selectTracks(candidates.filter(t => t.selected), request.count, request.perArtist, request.includeAI).length >= request.count) break;
  }
  cancelled(signal);
  if (request.selection === "recent") candidates.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
  const tracks = selectTracks([...candidates.filter(t => t.selected), ...candidates.filter(t => !t.selected)], request.count, request.perArtist, request.includeAI);
  const selectedCount = tracks.filter(t => t.selected).length;
  if (excludedAI) warnings.push("Excluded catalog results from artists marked AI by recorded evidence.");
  if (tracks.some(t => t.match === "review")) warnings.push("Some artist identities or song versions need review and are unselected.");
  if (selectedCount < request.count) warnings.push(`Found ${selectedCount} selected tracks for a request of ${request.count}. Artist caps, catalog coverage, and match review may leave a shortfall.`);
  onProgress({ done: examined, total: examined, message: `Draft ready: ${selectedCount} selected tracks` });
  return { tracks, warnings: [...new Set(warnings)] };
}
