import {test, expect} from "bun:test";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import type {Draft, DraftTrack, MusicJob} from "../src/types";

type Handler = (event: {preventDefault(): void}) => void | Promise<void>;

class FakeNode {
  children: FakeNode[] = [];
  parent?: FakeNode;
  listeners: Record<string, Handler> = {};
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  textContent = "";
  href = "";
  className = "";
  focused = false;
  id = "";
  classList = {toggle: (name: string, on: boolean) => {
    const classes = new Set(this.className.split(" ").filter(Boolean));
    if (on) classes.add(name); else classes.delete(name);
    this.className = [...classes].join(" ");
  }};
  constructor(public tagName = "div") {}
  append(...nodes: FakeNode[]) { for (const node of nodes) node.parent = this; this.children.push(...nodes); }
  replaceChildren(...nodes: FakeNode[]) { this.children = []; this.append(...nodes); }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  getAttribute(key: string) { return this.attributes[key]; }
  removeAttribute(key: string) { delete this.attributes[key]; }
  addEventListener(name: string, fn: Handler) { this.listeners[name] = fn; }
  focus() { this.focused = true; }
  reportValidity() { return true; }
  get firstChild() { return this.children[0]; }
  async fire(name: string) { await this.listeners[name]?.({preventDefault() {}}); }
}

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function song(id: number, match: "exact" | "review" = "exact"): DraftTrack {
  return {id: String(id), catalogId: id, artistId: id, title: id === 1 ? "<script>alert(1)</script>" : `Song ${id}`, artist: `Artist ${id}`, album: "Album", durationMs: 120000, releaseDate: "2026-01-01", url: "javascript:alert(1)", source: "Every Noise", sourceUrl: "https://everynoise.com/", match, provenance: {kind: "unknown", evidence: []}, selected: true};
}

async function setup(activeJob?: MusicJob, web = false, unavailableCatalogIds: string[] = []) {
  const ids: Record<string, FakeNode> = {};
  for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const node = new FakeNode(match[1]!);
    node.id = match[3]!;
    node.value = /\bvalue="([^"]*)"/.exec(match[2]!)?.[1] || "";
    node.hidden = /\bhidden\b/.test(match[2]!);
    node.disabled = /\bdisabled\b/.test(match[2]!);
    ids[node.id] = node;
  }
  for (const [id, value] of Object.entries({length: "30", selection: "mix", "per-artist": "1", country: "AU"})) ids[id]!.value = value;
  const get = (id: string) => ids[id]!;
  const collect = (node: FakeNode): FakeNode[] => [node, ...node.children.flatMap(collect)];
  const nodes = () => Object.values(ids).flatMap(collect);
  const hasClass = (node: FakeNode, name: string) => node.className.split(" ").includes(name);
  const query = (selector: string) => nodes().filter(node => selector.split(",").some(part => {
    const simple = part.trim();
    if (simple === "#tracks .remove") return hasClass(node, "remove");
    if (simple.startsWith(".classification ")) return node.tagName === simple.split(" ")[1] && !!node.parent && hasClass(node.parent, "classification");
    return hasClass(node, simple.slice(1));
  }));
  const draft: Draft = {id: "draft-1", request: {mode: "genre", seed: "ambient", count: 30, perArtist: 1, selection: "mix", includeAI: false, country: "AU"}, status: "ready", title: "My draft", tracks: [song(1), song(2, "review"), {...song(3), provenance: {kind: "ai", evidence: []}}], warnings: [], progress: {done: 3, total: 3, message: "Ready"}, createdAt: "2026-01-01"};
  const job: MusicJob = {id: "job-1", state: "partial", name: "My draft", message: "One song failed.", playlistId: "playlist-1", tracks: [{track: draft.tracks[0]!, state: "failed", error: "Permission denied."}], createdAt: "2026-01-01", updatedAt: "2026-01-01"};
  const calls: Array<{path: string; options: RequestInit}> = [];
  const errors = new Map<string, string>();
  const responses = new Map<string, unknown>();
  const timers = new Map<number, {callback: () => unknown; ms: number}>();
  let timerID = 0;
  runInNewContext(script, {
    document: {getElementById: get, createElement: (tag: string) => new FakeNode(tag), querySelectorAll: query},
    URL, JSON, Set, Map,
    setTimeout: (callback: () => unknown, ms: number) => {timers.set(++timerID, {callback, ms}); return timerID;},
    clearTimeout: (id: number) => timers.delete(id),
    localStorage: {getItem: () => null, setItem() {}},
    fetch: async (path: string, options: RequestInit) => {
      calls.push({path, options});
      const error = errors.get(path);
      let body: unknown;
      if (error) body = {error};
      else if (responses.has(path)) body = await responses.get(path);
      else if (path === "/api/session") body = {token: "test-token"};
      else if (path === "/api/ready") body = {ready: true, instance: "fixture", activeJob};
      else if (path === "/api/status") body = {music: {platform: "darwin", running: false, accessibility: false, automation: "unknown", message: "Music helper could not start.", ...(web ? {backend: "web-session", connection: "saved", generation: "g1"} : {})}, activeJob};
      else if (path === "/api/genres") body = {genres: [{name: "ambient", slug: "ambient"}]};
      else if (path === "/api/drafts") body = structuredClone(draft);
      else if (path === "/api/preflight") {
        const request = JSON.parse(String(options.body));
        const unavailable = unavailableCatalogIds.filter(id => request.trackIds.includes(id));
        body = {id: "check-1", total: request.trackIds.length, newLibraryAdditions: request.trackIds.length - 1, existingLibrarySongs: 1, ...(web ? {generation: "g1", availableCatalogTracks: request.trackIds.length - unavailable.length, unavailableCatalogTracks: unavailable.length, unavailableCatalogIds: unavailable, storefront: "au"} : {})};
      }
      else if (path === "/api/jobs") body = structuredClone(job);
      else if (path === "/api/jobs/job-1/retry") body = {...job, state: "running"};
      else if (path === "/api/jobs/job-1") body = activeJob || job;
      else if (path === "/api/provenance") body = {ok: true};
      else throw new Error(`Unexpected route ${path}`);
      return {ok: !error, status: error ? 400 : 200, text: async () => JSON.stringify(body)};
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  const preview = async () => { get("seed").value = "ambient"; await get("seed").fire("input"); await get("settings").fire("submit"); };
  const request = (path: string) => JSON.parse(String(calls.findLast(call => call.path === path)!.options.body));
  const runTimer = async (ms: number) => {
    const entry = [...timers].find(([, timer]) => timer.ms === ms);
    if (!entry) throw new Error(`No ${ms}ms timer scheduled`);
    timers.delete(entry[0]);
    await entry[1].callback();
  };
  return {get, query, nodes, calls, errors, responses, runTimer, preview, request, job};
}

test("starts empty with AI off and shows actual Music status without checking the library", async () => {
  const app = await setup();
  expect(app.get("ai").checked).toBe(false);
  expect(app.get("create").disabled).toBe(true);
  expect(app.get("check-library").hidden).toBe(true);
  expect(app.calls.some(call => call.path === "/api/preflight")).toBe(false);
  expect(app.get("permission").children[0]!.textContent).toBe("Music helper could not start.");
  expect(html).toContain('maxlength="120"');
  expect(html).toContain('maxlength="150"');
});

test("complete songs with applying covers stay locked and poll without a Cancel creation control", async () => {
  const job: MusicJob = {id: "job-1", name: "Covered", writer: "web-session", creationState: "known", coverEligible: true, state: "complete", tracks: [{track: song(1), state: "added"}], message: "All songs added.", createdAt: "today", updatedAt: "today", cover: {state: "applying", helperAttempted: true}};
  const app = await setup(job, true);
  app.get("seed").value = "ambient";
  await app.get("seed").fire("input");
  expect(app.get("build").disabled).toBe(true);
  expect(app.get("cancel-job").hidden).toBe(true);
  expect(app.get("retry-job").hidden).toBe(true);
  expect(app.get("job-message").textContent).toContain("All songs added.");
  expect(app.get("job-message").textContent).toContain("cover");
  expect(app.calls.some(call => call.path === "/api/jobs/job-1")).toBe(true);
});

test("cover failure preserves song totals and displays only locally mapped status", async () => {
  const job: MusicJob = {id: "job-1", name: "Covered", state: "complete", tracks: [{track: song(1), state: "added"}], message: "All songs added.", createdAt: "today", updatedAt: "today", cover: {state: "blocked", helperAttempted: true, code: "automation-permission", writeAttempted: false}};
  const app = await setup(job, true);
  expect(app.get("job-count").textContent).toBe("1 of 1 added");
  expect(app.get("job-message").textContent).toContain("Automation");
  expect(app.get("job-message").textContent).toContain("All songs added.");
  expect(app.get("cancel-job").hidden).toBe(true);
});

test("all-confirmed web recovery offers Finish playlist through the normal retry route", async () => {
  for (const state of ["interrupted", "cancelled", "failed", "partial"] as const) {
    const job: MusicJob = {id: "job-1", name: "Saved", writer: "web-session", creationState: "known", playlistId: "p.saved", state, tracks: [{track: song(1), state: "added", outcome: "confirmed"}], message: "Stopped", createdAt: "today", updatedAt: "today"};
    const app = await setup(job, true);
    expect(app.get("retry-job").hidden).toBe(false);
    expect(app.get("retry-job").textContent).toBe("Finish playlist");
    await app.get("retry-job").fire("click");
    expect(app.calls.filter(call => call.options.method === "POST").map(call => call.path)).toEqual(["/api/jobs/job-1/retry"]);
  }
  for (const changes of [{playlistId: undefined}, {creationState: "unknown" as const}, {tracks: [{track: song(1), state: "added" as const}]}]) {
    const job: MusicJob = {id: "job-1", name: "Saved", writer: "web-session", creationState: "known", playlistId: "p.saved", state: "interrupted", tracks: [{track: song(1), state: "added", outcome: "confirmed"}], message: "Stopped", createdAt: "today", updatedAt: "today", ...changes};
    expect((await setup(job, true)).get("retry-job").hidden).toBe(true);
  }
});

function coverStatus(job: MusicJob) {
  return {music: {platform: "darwin", running: false, accessibility: false, automation: "unknown", backend: "web-session", connection: "saved", generation: "g1"}, activeJob: job};
}

function blockedCoverJob(): MusicJob {
  return {id: "job-1", name: "Native cover", writer: "web-session", creationState: "known", playlistId: "p.saved", state: "complete", tracks: [{track: song(1), state: "added", outcome: "confirmed"}], message: "Songs complete.", createdAt: "today", updatedAt: "today", cover: {state: "blocked", helperAttempted: true, code: "automation-permission", writeAttempted: false}};
}

test("same-job status refresh adopts native cover progress and completion", async () => {
  const job = blockedCoverJob(), app = await setup(job, true);
  app.get("seed").value = "ambient";
  await app.get("seed").fire("input");
  expect(app.get("build").disabled).toBe(false);
  const applying: MusicJob = {...job, cover: {state: "applying", helperAttempted: true}};
  app.responses.set("/api/status", coverStatus(applying));
  app.responses.set("/api/jobs/job-1", applying);
  await app.runTimer(15000);
  await new Promise(resolve => setImmediate(resolve));
  expect(app.get("job-message").textContent).toContain("Preparing and checking");
  expect(app.get("build").disabled).toBe(true);
  expect(app.calls.some(call => call.path === "/api/jobs/job-1")).toBe(true);
  const verified: MusicJob = {...job, cover: {state: "verified", helperAttempted: true, writeAttempted: true}};
  app.responses.set("/api/status", coverStatus(verified));
  await app.runTimer(15000);
  expect(app.get("job-message").textContent).toContain("Cover verified");
  expect(app.get("build").disabled).toBe(false);
});

test("busy native status uses the credential-free snapshot for same-job cover progress", async () => {
  const job = blockedCoverJob(), app = await setup(job, true);
  app.errors.set("/api/status", "Apple Music operation is busy");
  const applying: MusicJob = {...job, cover: {state: "applying", helperAttempted: true}};
  app.responses.set("/api/ready", {ready: true, instance: "fixture", activeJob: applying});
  app.responses.set("/api/jobs/job-1", applying);
  await app.runTimer(15000);
  await new Promise(resolve => setImmediate(resolve));
  expect(app.get("job-message").textContent).toContain("Preparing and checking");
  expect(app.get("seed").disabled).toBe(true);
  expect(app.calls.some(call => call.path === "/api/ready" && !call.options.method)).toBe(true);
});

test("an older delayed status response cannot overwrite a newer cover poll", async () => {
  const job: MusicJob = {...blockedCoverJob(), cover: {state: "applying", helperAttempted: true}};
  const app = await setup(job, true);
  let release!: (value: unknown) => void;
  app.responses.set("/api/status", new Promise(resolve => release = resolve));
  const status = app.runTimer(15000);
  const verified: MusicJob = {...job, cover: {state: "verified", helperAttempted: true, writeAttempted: true}};
  app.responses.set("/api/jobs/job-1", verified);
  await app.runTimer(1200);
  expect(app.get("job-message").textContent).toContain("Cover verified");
  release(coverStatus(job));
  await status;
  expect(app.get("job-message").textContent).toContain("Cover verified");
  expect(app.get("seed").disabled).toBe(false);
});

test("web status and counts never require Accessibility or promise library additions", async () => {
  const app = await setup(undefined, true);
  expect(app.get("connection").textContent).toContain("Apple Music");
  expect(app.get("permission").children.map(node => node.textContent).join(" ")).not.toContain("Accessibility");
  await app.preview();
  await app.get("check-library").fire("click");
  expect(app.get("create-note").textContent).toContain("1 available");
  expect(app.get("create-note").textContent).not.toContain("will be added to your library");
});

test("unavailable rows stay visible after explicit deselection and require a new check before Create", async () => {
  const app = await setup(undefined, true, ["2"]);
  await app.preview();
  const review = app.query(".track-select")[1]!;
  review.checked = true;
  await review.fire("change");
  await app.get("check-library").fire("click");
  expect(app.get("create").disabled).toBe(true);
  expect(app.query(".track-select").map(node => node.checked)).toEqual([true, true, false]);
  expect(app.query(".unavailable").map(node => node.textContent)).toEqual(["Unavailable in AU"]);
  expect(app.get("deselect-unavailable").hidden).toBe(false);
  await app.get("deselect-unavailable").fire("click");
  expect(app.query(".track-select").map(node => node.checked)).toEqual([true, false, false]);
  expect(app.query(".unavailable").map(node => node.textContent)).toEqual(["Unavailable in AU"]);
  expect(app.get("tracks").children).toHaveLength(3);
  expect(app.get("create").disabled).toBe(true);
  expect(app.calls.filter(call => call.path === "/api/preflight")).toHaveLength(1);
  expect(app.calls.some(call => call.path === "/api/jobs")).toBe(false);
  await app.get("check-library").fire("click");
  expect(app.request("/api/preflight").trackIds).toEqual(["1"]);
  expect(app.query(".unavailable")).toHaveLength(0);
  expect(app.get("create").disabled).toBe(false);
  expect(app.calls.some(call => call.path === "/api/jobs")).toBe(false);
});

test("requires explicit library counts and invalidates them on selection or removal, but keeps name edits", async () => {
  const app = await setup();
  await app.preview();
  const checks = app.query(".track-select");
  expect(checks.map(node => node.checked)).toEqual([true, false, false]);
  expect(checks[2]!.disabled).toBe(true);
  expect(app.get("tracks").children[0]!.children[2]!.children[0]!.textContent).toBe("<script>alert(1)</script>");
  const links = app.nodes().filter(node => node.tagName === "a");
  expect(links.length).toBeGreaterThan(0);
  expect(links.every(node => node.href.startsWith("https://"))).toBe(true);
  checks[1]!.checked = true;
  await checks[1]!.fire("change");
  expect(app.get("create").disabled).toBe(true);
  await app.get("check-library").fire("click");
  expect(app.request("/api/preflight")).toEqual({draftId: "draft-1", trackIds: ["1", "2"], includeAI: false});
  expect(app.get("create-note").textContent).toBe("2 selected songs. 1 will be added to your library; 1 already there.");
  expect(app.get("create").disabled).toBe(false);
  app.get("title").value = "Renamed";
  await app.get("title").fire("input");
  expect(app.get("create").disabled).toBe(false);
  checks[1]!.checked = false;
  await checks[1]!.fire("change");
  expect(app.get("create").disabled).toBe(true);
  await app.get("check-library").fire("click");
  await app.query("#tracks .remove")[0]!.fire("click");
  expect(app.get("create").disabled).toBe(true);
});

test("current AI choice and checked receipt reach creation, and provenance saves require a new check", async () => {
  const app = await setup();
  await app.preview();
  await app.get("check-library").fire("click");
  const classification = app.query(".classification")[0]!;
  classification.children[0]!.value = "ai";
  await classification.fire("submit");
  expect(app.get("create").disabled).toBe(true);
  expect(app.query(".track-select")[0]!.checked).toBe(false);
  app.get("ai").checked = true;
  await app.get("ai").fire("change");
  expect(app.get("ai-note").textContent).toContain("Preview again to discover excluded artists.");
  const first = app.query(".track-select")[0]!;
  first.checked = true;
  await first.fire("change");
  await app.get("check-library").fire("click");
  expect(app.request("/api/preflight").includeAI).toBe(true);
  await app.get("create").fire("click");
  expect(app.request("/api/jobs")).toEqual({draftId: "draft-1", name: "My draft", trackIds: ["1"], includeAI: true, preflightId: "check-1"});
  expect(app.calls.find(call => call.path === "/api/jobs")!.options.headers).toEqual({"Content-Type": "application/json", "x-wavelength-token": "test-token"});
  expect(app.get("job-tracks").children[0]!.children[1]!.textContent).toBe("Permission denied.");
  expect(app.get("create").disabled).toBe(true);
  await app.get("retry-job").fire("click");
  expect(app.calls.at(-1)!.path).toBe("/api/jobs/job-1/retry");
  expect(app.get("build").disabled).toBe(true);
});

test("failed checks never enable Create and restored active jobs lock controls", async () => {
  const app = await setup();
  await app.preview();
  app.errors.set("/api/preflight", "Music read permission denied.");
  await app.get("check-library").fire("click");
  expect(app.get("create").disabled).toBe(true);
  expect(app.get("status").textContent).toBe("Music read permission denied.");
  const restored = await setup({...app.job, state: "running"});
  expect(restored.get("ai").disabled).toBe(true);
  expect(restored.get("create").disabled).toBe(true);
  expect(restored.get("cancel-job").hidden).toBe(false);
});

test("changing AI preference or starting a new preview discards the previous library check", async () => {
  const app = await setup();
  await app.preview();
  await app.get("check-library").fire("click");
  expect(app.get("create").disabled).toBe(false);
  app.get("ai").checked = true;
  await app.get("ai").fire("change");
  expect(app.get("create").disabled).toBe(true);
  await app.get("check-library").fire("click");
  expect(app.get("create").disabled).toBe(false);
  await app.preview();
  expect(app.get("create").disabled).toBe(true);
  expect(app.get("create-note").textContent).toContain("Check your library");
});

test("changing an assessment keeps its evidence unless the user clears it", async () => {
  const app = await setup();
  await app.preview();
  let classification = app.query(".classification")[0]!;
  classification.children[1]!.value = "https://example.com/artist-statement";
  await classification.fire("submit");
  classification = app.query(".classification")[0]!;
  expect(classification.children[1]!.value).toBe("https://example.com/artist-statement");
  classification.children[0]!.value = "human";
  await classification.fire("submit");
  expect(app.request("/api/provenance").evidence).toBe("https://example.com/artist-statement");
  classification = app.query(".classification")[0]!;
  classification.children[1]!.value = "";
  await classification.fire("submit");
  expect(app.request("/api/provenance").evidence).toBeUndefined();
});
