const token = "fixture-session";
const parentPID = process.ppid;
setInterval(() => {try {process.kill(parentPID, 0);} catch {process.exit(0);}}, 100);
const track = {id: "one", catalogId: 1, artistId: 2, title: "Fixture song", artist: "Fixture artist", album: "Fixture album", durationMs: 120000, releaseDate: "2026-01-01", url: "https://music.apple.com/", source: "fixture", match: "exact", provenance: {kind: "unknown", evidence: []}, selected: true};
const draft = {id: "draft", request: {mode: "genre", seed: "ambient", count: 1, selection: "mix", perArtist: 1, includeAI: false, country: "AU"}, status: "ready", title: "Fixture playlist", tracks: [track], warnings: [], progress: {done: 1, total: 1, message: "Ready"}, createdAt: "2026-01-01"};
const availabilityDraft = {...draft, id: "availability", tracks: [track, {...track, id: "two", catalogId: 2, title: "Unavailable fixture song"}, {...track, id: "ai", catalogId: 3, provenance: {kind: "ai", evidence: []}}]};
const discographyTracks = [
  {...track, id: "z-single", releaseId: 10, discNumber: 1, trackNumber: 1},
  {...track, id: "a-album-first", catalogId: 2, releaseId: 20, discNumber: 1, trackNumber: 1},
  {...track, id: "b-album-second", releaseId: 20, discNumber: 1, trackNumber: 2},
];
let job: Record<string, unknown> | undefined = process.env.WAVELENGTH_HISTORY_ACTIVE_JOB ? {id: "job", name: "Fixture playlist", includeAI: false, state: "running", tracks: [{track, state: "pending"}], message: "Restored synthetic job", createdAt: "2026-01-01", updatedAt: "2026-01-01"} : undefined;
let release: (() => void) | undefined;
let failure = false;
let startedOnFailure = false;
let readinessFailures = 0;
const counters: Record<string, number> = {};
const gates = new Map<string, {failure: boolean; release?: () => void}>();
let historyGeneration = 0;
let savedSources = ["library", "export"];
const savedAt: Record<string, string> = {library: "2026-01-01", export: "2026-01-01"};
let previewToken: string | undefined;
const coverage = {inputRows: 3, acceptedRows: 3, rejectedRows: 0, missing: {artist: 0, album: 0, genre: 3, date: 3, reportedDurationMs: 3, mediaDurationMs: 3}, firstDate: null, lastDate: null, datedRows: 0, instantRows: 0, durationRows: 0, enrichedRows: 0, unmatchedRows: 3, availableFields: ["title", "artist"], warnings: ["Synthetic missing dates"]};
function fixtureHistory(profile = "play-activity", query?: URLSearchParams) {
  const sources = savedSources.map(source => ({source, savedAt: savedAt[source], profile: source === "library" ? null : profile, metricLabel: source === "library" ? "Library play count" : "Activity records", totals: {tracks: 3, artists: 1, albums: 1, libraryPlayCount: source === "library" ? 4 : null, activityRecords: source === "export" ? 3 : null, reportedDurationMs: null, skippedCount: null, favoriteTracks: null}, coverage, suggestions: [{artist: "Fixture artist", kind: "top", basis: "Synthetic records"}], trendsAvailable: false}));
  const source = query?.get("source");
  return {sources, preferredSource: savedSources.includes("export") ? "export" : savedSources[0] ?? null, page: source && savedSources.includes(source) ? {source, kind: query!.get("kind") ?? "artists", offset: Number(query!.get("offset") ?? 0), limit: 50, total: 75, rows: [{id: "synthetic", label: "Fixture artist", artist: "Fixture artist", album: null, albumArtist: null, genre: null, libraryPlayCount: source === "library" ? 4 : null, activityRecords: source === "export" ? 3 : null, reportedDurationMs: null, skippedCount: null, favoriteTracks: null, lastDate: null}], metricLabel: "Synthetic records", excludedRows: 0, timeZone: query!.get("timeZone")} : null};
}
async function delayed(route: string) {
  const gate = gates.get(route);
  if (!gate || gate.release) return false;
  await new Promise<void>(resolve => {gate.release = resolve;});
  gates.delete(route);
  return gate.failure;
}
const server = Bun.serve({hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  counters[path] = (counters[path] ?? 0) + 1;
  if (request.method === "POST" && (request.headers.get("origin") !== `http://127.0.0.1:${server.port}` || request.headers.get("x-wavelength-token") !== token)) return Response.json({error: "Fixture write lacked exact headers"}, {status: 403});
  if (path === "/api/ready") {
    if (readinessFailures > 0) {readinessFailures--; return Response.json({error: "Fixture saved-state read failed"}, {status: 503});}
    return Response.json({ready: true, instance: process.env.WAVELENGTH_INSTANCE, activeJob: job});
  }
  if (path === "/api/session") return Response.json({token});
  if (path === "/api/genres") return Response.json({genres: []});
  if (path === "/api/artists/search") {
    const body = await request.json();
    if (body.term !== "Fixture" || body.country !== "AU") return Response.json({error: "Artist query changed"}, {status: 400});
    if (await delayed("artists")) return Response.json({error: "Outdated artist search failed"}, {status: 503});
    return Response.json({artists: [{id: 2, name: "Fixture artist", url: "https://music.apple.com/au/artist/fixture/2"}, {id: 3, name: "Fixture artist", url: "https://music.apple.com/au/artist/fixture/3"}], storefront: "au"});
  }
  if (path === "/api/drafts") {
    const body = await request.json();
    if (body.mode !== "discography" || body.artistId !== 2 || body.seed !== "Fixture artist" || body.includeAI !== false || body.country !== "AU") return Response.json({error: "Discography preview lacked the selected artist"}, {status: 400});
    return Response.json({...draft, id: "discography", request: body, tracks: discographyTracks});
  }
  if (path === "/api/test-history-state") return Response.json({counters, pending: [...gates].filter(([, gate]) => gate.release).map(([route]) => route)});
  if (path === "/api/test-history-gate") {const body = await request.json(); gates.set(body.route, {failure: body.failure}); return Response.json({ok: true});}
  if (path === "/api/test-history-release") {const body = await request.json(); gates.get(body.route)?.release?.(); return Response.json({ok: true});}
  if (path === "/api/test-history-profile") return Response.json(fixtureHistory(url.searchParams.get("profile")!));
  if (path === "/api/history") {
    if (request.headers.get("x-wavelength-token") !== token) return Response.json({error: "Invalid history token"}, {status: 403});
    if (!url.searchParams.get("timeZone")) return Response.json({error: "Missing current native time zone"}, {status: 400});
    const result = fixtureHistory("play-activity", url.searchParams);
    if (await delayed("query") || process.env.WAVELENGTH_HISTORY_READ_FAILURE) return Response.json({error: "Synthetic history read unavailable"}, {status: 503});
    return Response.json(result);
  }
  if (path === "/api/history/preview") {
    if (request.headers.get("content-type") !== "text/csv; charset=utf-8" || !(await request.text()).startsWith("Song Name,")) return Response.json({error: "Preview must contain raw selected CSV bytes"}, {status: 400});
    const generation = historyGeneration;
    await delayed("preview");
    if (generation !== historyGeneration) return Response.json({error: "Forgotten preview"}, {status: 409});
    previewToken = "synthetic-preview";
    return Response.json({token: previewToken, expiresAt: "2026-01-01", profile: "play-activity", coverage, replacesExport: savedSources.includes("export")});
  }
  if (path === "/api/history/library") {
    if (Object.keys(await request.json()).length) return Response.json({error: "Scan body must be empty"}, {status: 400});
    const generation = historyGeneration;
    if (await delayed("scan")) return Response.json({error: "Automation denied in synthetic fixture"}, {status: 503});
    if (generation !== historyGeneration) return Response.json({error: "Forgotten scan"}, {status: 409});
    if (!savedSources.includes("library")) savedSources.unshift("library");
    savedAt.library = "2026-02-01";
    return Response.json(fixtureHistory());
  }
  if (path === "/api/history/import") {
    const body = await request.json();
    if (Object.keys(body).sort().join() !== "replace,token" || body.token !== previewToken || typeof body.replace !== "boolean") return Response.json({error: "Import requires only token and replacement choice"}, {status: 400});
    if (savedSources.includes("export") && !body.replace) return Response.json({error: "Confirm export replacement"}, {status: 409});
    const generation = historyGeneration;
    await delayed("import");
    if (generation !== historyGeneration) return Response.json({error: "Forgotten import"}, {status: 409});
    if (!savedSources.includes("export")) savedSources.push("export");
    savedAt.export = "2026-03-01";
    previewToken = undefined;
    return Response.json(fixtureHistory());
  }
  if (path === "/api/history/forget") {if (Object.keys(await request.json()).length) return Response.json({error: "Forget body must be empty"}, {status: 400}); historyGeneration++; savedSources = []; previewToken = undefined; return Response.json({ok: true});}
  if (path === "/api/test-draft") return Response.json(draft);
  if (path === "/api/test-availability-draft") return Response.json(availabilityDraft);
  if (path === "/api/test-pending") return Response.json({ok: release !== undefined});
  if (path === "/api/test-release") { release?.(); return Response.json({ok: true}); }
  if (path === "/api/test-failure") {
    const config = await request.json();
    failure = true; startedOnFailure = config.started; readinessFailures = config.readinessFailures || 0;
    return Response.json({ok: true});
  }
  if (path === "/api/test-cover") {
    const cover = await request.json();
    job = {id: "042F266F-7190-4AF7-9138-442B04ECDE30", name: "Fixture playlist", writer: "web-session", creationState: "known", coverEligible: true, state: "complete", tracks: [{track, state: "added"}], message: "All songs added.", createdAt: "2026-01-01", updatedAt: "2026-01-01", cover};
    return Response.json(job);
  }
  if (/^\/api\/jobs\/042F266F-7190-4AF7-9138-442B04ECDE30\/cover-(retry|check|permission)$/.test(path)) {
    if (Object.keys(await request.json()).length) return Response.json({error: "Cover body must be empty"}, {status: 400});
    job!.cover = {state: "applying", helperAttempted: true};
    if (await delayed("cover")) return Response.json({error: "Cover response lost after dispatch"}, {status: 503});
    return Response.json(job);
  }
  if (path === "/api/jobs/042F266F-7190-4AF7-9138-442B04ECDE30") return Response.json(job);
  if (path === "/api/preflight") {
    const body = await request.json();
    if (body.draftId === "discography") {
      if (body.trackIds.join() !== "z-single,a-album-first,b-album-second") return Response.json({error: "Release order was scrambled"}, {status: 400});
      return Response.json({id: "discography-checked", newLibraryAdditions: 0, existingLibrarySongs: 0, total: 3, generation: "g1", storefront: "au", availableCatalogTracks: 3, unavailableCatalogTracks: 0, unavailableCatalogIds: []});
    }
    await delayed("preflight");
    const unavailableCatalogIds = body.trackIds.includes("two") ? ["2"] : [];
    return Response.json({id: "checked", newLibraryAdditions: 0, existingLibrarySongs: 0, total: body.trackIds.length, generation: "g1", storefront: "au", availableCatalogTracks: body.trackIds.length - unavailableCatalogIds.length, unavailableCatalogTracks: unavailableCatalogIds.length, unavailableCatalogIds});
  }
  if (path === "/api/jobs" || path === "/api/jobs/job/retry") {
    const body = await request.json();
    if (path === "/api/jobs" && (body.includeAI !== false || body.name !== "Fixture playlist" || body.trackIds?.join() !== "one" || body.preflightId !== "checked")) return Response.json({error: "Submitted selection changed"}, {status: 400});
    if (!failure || startedOnFailure) job = {id: "job", name: "Fixture playlist", writer: "web-session", creationState: "known", includeAI: false, state: "running", tracks: [{track, state: "pending"}], message: "Started before response", createdAt: "2026-01-01", updatedAt: "2026-01-01"};
    await new Promise<void>(resolve => { release = resolve; });
    release = undefined;
    if (failure) return Response.json({error: "Fixture response failed"}, {status: 503});
    job!.state = "partial";
    return Response.json(job);
  }
  if (path === "/api/jobs/job") return Response.json(job);
  if (path === "/api/jobs/job/open") return Response.json({ok: true});
  return Response.json({error: "No fixture route"}, {status: 404});
}});
console.log(`Wavelength is ready at http://127.0.0.1:${server.port}`);
process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
