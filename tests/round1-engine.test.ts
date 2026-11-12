import {expect, test} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, statSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {execFile} from "node:child_process";
import {runInNewContext} from "node:vm";
import {Store} from "../src/store";
import {Jobs} from "../src/jobs";
import {createApp} from "../src/server";
import {createWebMusicAdapter, runBridgeRequest, stopOwnedHelpers} from "../src/web-music";
import type {DraftTrack, MusicJob} from "../src/types";

// Round 1 synthetic breaker. Run only this file, serially under heavy.lock.
const track = (n: number): DraftTrack => ({id: String(n), catalogId: n, artistId: n, title: `Song ${n}`, artist: "Synthetic", album: "Fixture", durationMs: 1000, releaseDate: "2026-01-01", url: "https://example.invalid", source: "fixture", match: "exact", selected: true, provenance: {kind: "unknown", evidence: []}});
const discovery = {getGenres: async () => [], buildDraft: async () => ({tracks: [], warnings: []})};
const selection = {draftId: "draft", trackIds: ["1", "2"], includeAI: false};
const scratch = () => mkdtempSync(join(tmpdir(), "round1-engine-"));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
async function until(predicate: () => boolean, label = "fixture") {
  for (let i = 0; i < 300; i++) {if (predicate()) return; await Bun.sleep(5);}
  throw new Error(`Bounded wait expired: ${label}`);
}
async function finished(jobs: Jobs, id: string) {
  await until(() => !jobs.isActive(), "job completion");
  return jobs.get(id)!;
}
type Invoke = NonNullable<Parameters<typeof createWebMusicAdapter>[0]>;
const good: Invoke = async input => {
  if (input.action === "status" || input.action === "rebindPlaylist") return {generation: "g1"};
  if (input.action === "inspectTracks") return {generation: "g1", storefront: "au", total: input.catalogIds!.length, availableCatalogTracks: input.catalogIds!.length, unavailableCatalogTracks: 0, unavailableCatalogIds: []};
  if (input.action === "ensurePlaylist") return {id: "p.synthetic"};
  if (input.action === "addTrackToPlaylist") return {kind: "confirmed", catalogId: input.catalogIds![input.position!], alreadyPresent: true};
  if (input.action === "playlistCover") return {state: "blocked", code: "automation-permission", writeAttempted: false};
  throw new Error(`Unexpected synthetic action: ${input.action}`);
};
function fixture(invoke: Invoke = good, native = true) {
  const store = new Store(":memory:");
  store.put("draft", "draft", {id: "draft", status: "ready", tracks: [track(1), track(2)], request: {mode: "genre", includeAI: false}});
  const app = createApp({store, port: 8769, engineToken: native ? "round1-synthetic-token" : undefined, discovery, music: createWebMusicAdapter(invoke)});
  const request = (path: string, value?: unknown, changes: Record<string, string> = {}) => new Request(`http://127.0.0.1:8769${path}`, {method: value === undefined ? "GET" : "POST", headers: {host: "127.0.0.1:8769", origin: "http://127.0.0.1:8769", "content-type": "application/json", "x-wavelength-token": app.token, ...changes}, ...(value === undefined ? {} : {body: JSON.stringify(value)})});
  return {store, app, request, close: () => {app.dispose(); store.close();}};
}

test("round1 HTTP authentication matrix blocks all native requests before integrations", async () => {
  let calls = 0;
  const f = fixture(async input => {calls++; return good(input);});
  try {
    const paths = ["/api/session", "/api/ready", "/api/status", "/api/history", "/api/jobs/missing", "/"];
    for (const path of paths) for (const token of ["", "wrong", "round1-synthetic-token,wrong"]) {
      expect((await f.app.fetch(f.request(path, undefined, {"x-wavelength-token": token}))).status).toBe(403);
    }
    for (const host of ["evil.invalid:8769", "127.0.0.1:8768", "127.0.0.1", "127.0.0.1:8769.evil.invalid", "[::1]:8769"]) {
      expect((await f.app.fetch(f.request("/api/ready", undefined, {host}))).status).toBe(403);
    }
    for (const origin of ["null", "https://127.0.0.1:8769", "http://evil.invalid:8769", "http://127.0.0.1:8769.evil.invalid", ""]) {
      expect((await f.app.fetch(f.request("/api/preflight", selection, {origin}))).status).toBe(403);
    }
    expect(calls).toBe(0);
    for (const value of [null, [], 1, "x", {trackIds: []}, {...selection, trackIds: ["1", "1"]}, {...selection, trackIds: [1]}, {...selection, includeAI: "false"}]) {
      expect((await f.app.fetch(f.request("/api/preflight", value))).status).toBe(400);
    }
    expect(calls).toBe(0);
    expect((await f.app.fetch(f.request("/api/drafts", {junk: "x".repeat(131073)}))).status).toBe(413);
  } finally {f.close();}
});

test("round1 concurrent creation consumes one receipt once, including later replay", async () => {
  const gate = deferred<unknown>();
  let creates = 0;
  const f = fixture(async input => {if (input.action === "ensurePlaylist") {creates++; return gate.promise;} return good(input);});
  try {
    const receipt = await (await f.app.fetch(f.request("/api/preflight", selection))).json();
    const body = {...selection, name: "Synthetic", preflightId: receipt.id};
    const responses = await Promise.all(Array.from({length: 12}, () => f.app.fetch(f.request("/api/jobs", body))));
    expect(responses.filter(r => r.status === 200)).toHaveLength(1);
    expect(creates).toBe(1);
    const id = (await responses.find(r => r.status === 200)!.json()).id;
    gate.resolve({id: "p.synthetic"});
    expect((await finished(f.app.jobs, id)).state).toBe("complete");
    expect((await f.app.fetch(f.request("/api/jobs", body))).status).toBe(400);
    expect(creates).toBe(1);
  } finally {gate.resolve({id: "p.synthetic"}); await until(() => !f.app.jobs.isActive()); f.close();}
});

test("round1 real loopback HTTP rejects duplicate tokens and serializes a receipt burst", async () => {
  const store = new Store(":memory:");
  store.put("draft", "draft", {id: "draft", status: "ready", tracks: [track(1), track(2)], request: {mode: "genre", includeAI: false}});
  let app!: ReturnType<typeof createApp>, creates = 0;
  const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: request => app.fetch(request)});
  const origin = `http://127.0.0.1:${server.port}`;
  app = createApp({store, port: server.port!, engineToken: "round1-http-token", discovery, music: createWebMusicAdapter(async input => {if (input.action === "ensurePlaylist") creates++; return good(input);})});
  const headers = {origin, "content-type": "application/json", "x-wavelength-token": app.token};
  const post = (path: string, value: unknown) => fetch(origin + path, {method: "POST", headers, body: JSON.stringify(value), signal: AbortSignal.timeout(2000)});
  try {
    expect(server.hostname).toBe("127.0.0.1");
    const duplicate = new Headers(headers); duplicate.append("x-wavelength-token", "wrong");
    expect((await fetch(origin + "/api/session", {headers: duplicate})).status).toBe(403);
    expect((await fetch(origin + "/api/session")).status).toBe(403);
    expect((await fetch(origin + "/api/ready", {headers})).status).toBe(200);
    const receipt = await (await post("/api/preflight", selection)).json();
    const results = await Promise.all(Array.from({length: 8}, () => post("/api/jobs", {...selection, name: "Synthetic HTTP", preflightId: receipt.id})));
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    const id = (await results.find(r => r.status === 200)!.json()).id;
    expect((await finished(app.jobs, id)).state).toBe("complete");
    expect(creates).toBe(1);
  } finally {await until(() => !app.jobs.isActive()); server.stop(true); app.dispose(); store.close();}
});

test("round1 concurrent preflight excludes writes and does not consume receipt on busy rejection", async () => {
  let held = false, entered = false, creates = 0;
  const gate = deferred<unknown>();
  const f = fixture(async input => {
    if (input.action === "inspectTracks" && held) {entered = true; return gate.promise;}
    if (input.action === "ensurePlaylist") creates++;
    return good(input);
  });
  try {
    const receipt = await (await f.app.fetch(f.request("/api/preflight", selection))).json();
    held = true;
    const pending = f.app.fetch(f.request("/api/preflight", selection));
    await until(() => entered);
    expect((await f.app.fetch(f.request("/api/preflight", selection))).status).toBe(409);
    const body = {...selection, name: "Synthetic", preflightId: receipt.id};
    expect((await f.app.fetch(f.request("/api/jobs", body))).status).toBe(409);
    expect(creates).toBe(0);
    gate.resolve(await good({action: "inspectTracks", catalogIds: ["1", "2"]}));
    expect((await pending).status).toBe(200);
    const response = await f.app.fetch(f.request("/api/jobs", body));
    expect(response.status).toBe(200);
    await finished(f.app.jobs, (await response.json()).id);
  } finally {gate.resolve({}); await until(() => !f.app.jobs.isActive()); f.close();}
});

test("round1 malformed inspection replies never mint usable receipts", async () => {
  const valid = await good({action: "inspectTracks", catalogIds: ["1", "2"]}) as Record<string, unknown>;
  const mutations = [null, [], {}, {...valid, generation: "g2"}, {...valid, total: 1}, {...valid, availableCatalogTracks: -1}, {...valid, unavailableCatalogTracks: "0"}, {...valid, unavailableCatalogIds: ["3"]}, {...valid, unavailableCatalogIds: ["1", "1"]}, {...valid, unavailableCatalogIds: ["1"]}, {...valid, storefront: ""}];
  for (const result of mutations) {
    let writes = 0;
    const f = fixture(async input => {if (input.action === "inspectTracks") return result; if (input.action === "ensurePlaylist") writes++; return good(input);});
    try {
      const response = await f.app.fetch(f.request("/api/preflight", selection));
      expect(response.status).toBe(400);
      expect((await response.json()).id).toBeUndefined();
      expect(writes).toBe(0);
    } finally {f.close();}
  }
});

for (const stage of ["status", "rebindPlaylist"] as const) for (const rejects of [false, true]) {
  test(`round1 cancellation survives ${stage} ${rejects ? "rejection" : "success"}`, async () => {
    const store = new Store(":memory:");
    const gate = deferred<unknown>();
    let entered = false, writes = 0;
    const job = {id: crypto.randomUUID(), name: "Synthetic", writer: "web-session", connectionGeneration: "g1", creationState: stage === "status" ? "not-started" : "known", ...(stage === "status" ? {} : {playlistId: "p.synthetic"}), state: "failed", tracks: [{track: track(1), state: "pending"}], message: "Fixture", createdAt: "now", updatedAt: "now"} as MusicJob;
    store.put("job", job.id, job);
    const jobs = new Jobs(store, createWebMusicAdapter(async input => {
      if (input.action === stage) {entered = true; return gate.promise;}
      if (["ensurePlaylist", "addTrackToPlaylist", "playlistCover"].includes(input.action)) writes++;
      return good(input);
    }));
    try {
      jobs.retry(job.id);
      await until(() => entered);
      jobs.cancel(job.id);
      if (rejects) gate.reject(new Error("Synthetic read rejection")); else gate.resolve({generation: "g1"});
      const result = await finished(jobs, job.id);
      expect(writes).toBe(0);
      expect(result.connectionGeneration).toBe("g1");
      expect(result.state).toBe("cancelled");
    } finally {gate.resolve({generation: "g1"}); await until(() => !jobs.isActive()); store.close();}
  });
}

test("round1 malformed create replies preserve unknown intent and forbid a second create", async () => {
  for (const raw of [null, [], {}, {id: ""}, {id: 1}, {id: "wrong"}, {id: "p."}, {id: "p.a/b"}]) {
    const store = new Store(":memory:");
    let creates = 0, appends = 0;
    const jobs = new Jobs(store, createWebMusicAdapter(async input => {
      if (input.action === "ensurePlaylist") {creates++; return raw;}
      if (input.action === "addTrackToPlaylist") appends++;
      return good(input);
    }));
    try {
      const result = await finished(jobs, jobs.create("Synthetic", [track(1)], false, "g1").id);
      expect(result.creationState).toBe("unknown");
      expect(() => jobs.retry(result.id)).toThrow("unknown");
      expect([creates, appends]).toEqual([1, 0]);
    } finally {store.close();}
  }
});

test("round1 seeded append fault sequences preserve the confirmed prefix and reconcile uncertainty", async () => {
  // Fixed LCG seed, 32 cases, 2..6 tracks, one injected fault per case.
  let seed = 0x51a7c0de;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const faults: unknown[] = [null, [], {}, {kind: "confirmed", catalogId: "999", alreadyPresent: false}, {kind: "confirmed", catalogId: "1", alreadyPresent: "yes"}, {kind: "uncertain"}, {kind: "conflict"}, {kind: "not-added"}];
  for (let iteration = 0; iteration < 32; iteration++) {
    const count = 2 + next() % 5, position = next() % count, fault = faults[next() % faults.length];
    const store = new Store(":memory:");
    let retried = false, creates = 0;
    const calls: Array<{position: number; reconcileOnly: boolean}> = [];
    const jobs = new Jobs(store, createWebMusicAdapter(async input => {
      if (input.action === "ensurePlaylist") creates++;
      if (input.action === "addTrackToPlaylist") {
        calls.push({position: input.position!, reconcileOnly: input.reconcileOnly!});
        if (!retried && input.position === position) return fault;
      }
      return good(input);
    }));
    try {
      const first = await finished(jobs, jobs.create("Synthetic", Array.from({length: count}, (_, n) => track(n + 1)), false, "g1").id);
      expect(first.tracks.map(t => t.state)).toEqual(Array.from({length: count}, (_, n) => n < position ? "added" : n === position ? "failed" : "pending"));
      expect(calls.map(c => c.position)).toEqual(Array.from({length: position + 1}, (_, n) => n));
      retried = true;
      jobs.retry(first.id);
      const last = await finished(jobs, first.id);
      expect(last.state).toBe("complete");
      expect(creates).toBe(1);
      const uncertain = ["uncertain", "conflict"].includes(first.tracks[position]!.outcome!);
      expect(calls[position + 1]).toEqual({position, reconcileOnly: uncertain});
    } finally {store.close();}
  }
});

test("round1 malformed cover results and later blocks never permit another apply", async () => {
  const faults = [null, [], {}, {state: "verified", code: "image-verified", writeAttempted: true}, {state: "blocked", code: "automation-permission", writeAttempted: true}, {state: "uncertain", code: "image-unconfirmed", writeAttempted: false}, {state: "verified", code: "wrong", imageHash: "a".repeat(64), writeAttempted: true}];
  for (const raw of faults) {
    const store = new Store(":memory:");
    const modes: string[] = [];
    let songs = 0;
    const jobs = new Jobs(store, createWebMusicAdapter(async input => {
      if (input.action === "playlistCover") {modes.push(input.coverMode!); return modes.length === 1 ? raw : {state: "blocked", code: "identity-mismatch", writeAttempted: false};}
      if (["ensurePlaylist", "addTrackToPlaylist"].includes(input.action)) songs++;
      return good(input);
    }));
    try {
      const first = await finished(jobs, jobs.create("Synthetic", [track(1)], false, "g1").id);
      expect(first.cover?.state).toBe("uncertain");
      for (const action of ["retry", "permission", "check", "retry"] as const) {jobs.coverAction(first.id, action); expect((await finished(jobs, first.id)).cover?.state).toBe("uncertain");}
      expect(modes).toEqual(["apply", "check", "authorize", "check", "check"]);
      expect(songs).toBe(2);
    } finally {store.close();}
  }
});

test("round1 constructor failures release the acquired lease for repair and reopen", () => {
  for (const broken of ["invalid-database", "truncated-database"]) {
    const root = scratch(), path = join(root, "round1-engine.sqlite");
    try {
      if (broken === "invalid-database") writeFileSync(path, "not a database");
      else {const db = new Database(path); db.exec("CREATE TABLE fixture (value)"); db.close(); writeFileSync(path, readFileSync(path).subarray(0, 100));}
      expect(() => new Store(path)).toThrow();
      rmSync(path, {force: true});
      for (const suffix of ["-wal", "-shm"]) rmSync(path + suffix, {force: true});
      const repaired = new Store(path);
      try {repaired.put("fixture", "ok", {ok: true}); expect(repaired.get<{ok: boolean}>("fixture", "ok")).toEqual({ok: true});}
      finally {repaired.close();}
    } finally {rmSync(root, {recursive: true, force: true});}
  }
});

for (const suffix of ["-wal", "-shm"]) {
  test(`round1 lease ${suffix} symlink must be rejected without touching its target`, () => {
    const root = scratch(), path = join(root, "round1-engine.sqlite"), leasePath = path + ".lock", target = join(root, "round1-engine-target");
    let store: Store | undefined;
    try {
      const lease = new Database(leasePath); lease.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture (value)"); lease.close();
      // SQLite can leave its closed fixture's WAL sidecars on macOS.
      for (const sidecar of ["-wal", "-shm"]) rmSync(leasePath + sidecar, {force: true});
      const bytes = Buffer.alloc(32768, 0x41);
      writeFileSync(target, bytes, {mode: 0o640});
      symlinkSync(target, leasePath + suffix);
      let rejected = false;
      try {store = new Store(path);} catch {rejected = true;}
      const actual = {rejected, unchanged: readFileSync(target).equals(bytes), mode: statSync(target).mode & 0o777};
      expect(actual).toEqual({rejected: true, unchanged: true, mode: 0o640});
    } finally {store?.close(); rmSync(root, {recursive: true, force: true});}
  });
}

test("round1 bridge malformed envelopes and oversized output retain write uncertainty", async () => {
  const samples = ["null", "[]", "{}", '{"ok":true,"result":[]}', '{"ok":false,"error":{"code":"rejected"}}', "x".repeat(131073)];
  for (const action of ["status", "ensurePlaylist"] as const) for (const output of samples) {
    const expression = output.length > 131072 ? '"x".repeat(131073)' : JSON.stringify(output);
    const command = [process.execPath, "-e", `await Bun.stdin.text(); process.stdout.write(${expression});`];
    let caught: unknown;
    try {await runBridgeRequest({action}, {command, timeoutMs: 1500});} catch (error) {caught = error;}
    expect(caught).toMatchObject({uncertain: action === "ensurePlaylist", code: "malformed"});
  }
});

test("round1 timed-out helper remains owned until it exits despite ignored SIGTERM", async () => {
  const root = scratch(), pidPath = join(root, "round1-engine-helper.pid");
  let pid: number | undefined;
  const alive = (value: number) => {try {process.kill(value, 0); return true;} catch {return false;}};
  try {
    const command = [process.execPath, "-e", `process.on("SIGTERM", () => {}); await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000); await Bun.stdin.text();`];
    const result = runBridgeRequest({action: "ensurePlaylist"}, {command, timeoutMs: 500}).catch(error => error);
    await until(() => existsSync(pidPath));
    pid = Number(readFileSync(pidPath, "utf8"));
    expect(await result).toMatchObject({uncertain: true, code: "transport"});
    stopOwnedHelpers();
    // Allow a bounded grace period for any implementation that escalates termination.
    for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(5);
    expect(alive(pid)).toBe(false);
  } finally {
    if (pid && alive(pid)) {process.kill(pid, "SIGKILL"); await until(() => !alive(pid!), "synthetic helper cleanup");}
    rmSync(root, {recursive: true, force: true});
  }
});

for (const mode of ["overflow", "shutdown"] as const) {
  test(`round1 ${mode} reaps only the owned bridge despite ignored SIGTERM`, async () => {
    const root = scratch(), pidPath = join(root, "helper.pid");
    const sentinel = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {stdout: "ignore", stderr: "ignore"});
    const alive = (pid: number) => {try {process.kill(pid, 0); return true;} catch {return false;}};
    let pid: number | undefined;
    try {
      const command = [process.execPath, "-e", `process.on("SIGTERM", () => {}); await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); ${mode === "overflow" ? 'process.stdout.write("x".repeat(131073));' : ""} setInterval(() => {}, 1000); await Bun.stdin.text();`];
      const result = runBridgeRequest({action: "ensurePlaylist"}, {command, timeoutMs: 1500}).catch(error => error);
      await until(() => existsSync(pidPath));
      pid = Number(readFileSync(pidPath, "utf8"));
      if (mode === "shutdown") stopOwnedHelpers();
      expect(await result).toMatchObject({uncertain: true, code: mode === "overflow" ? "malformed" : "transport"});
      await until(() => !alive(pid!), "owned bridge exit");
      expect(alive(sentinel.pid)).toBe(true);
    } finally {
      if (pid && alive(pid)) {process.kill(pid, "SIGKILL"); await until(() => !alive(pid!), "owned bridge cleanup");}
      sentinel.kill("SIGKILL"); await sentinel.exited;
      rmSync(root, {recursive: true, force: true});
    }
  });
}

for (const mode of ["timeout", "overflow", "shutdown"] as const) {
  test(`round1 legacy ${mode} reaps its synthetic helper despite ignored SIGTERM`, async () => {
    const source = readFileSync(new URL("../src/music.ts", import.meta.url), "utf8");
    const start = source.indexOf("function execute(");
    const executeSource = source.slice(start, source.indexOf("\n}\n", start) + 3);
    const stopSource = source.match(/^export function stopOwnedHelpers.*$/m)![0].replace(/^export /, "");
    const ownedHelpers = new Set();
    const {execute, stopOwnedHelpers: stop} = runInNewContext(`${new Bun.Transpiler({loader: "ts"}).transformSync(`${executeSource}\n${stopSource}`)}\n({execute, stopOwnedHelpers})`, {ownedHelpers, execFile});
    const root = scratch(), pidPath = join(root, "legacy.pid");
    const sentinel = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {stdout: "ignore", stderr: "ignore"});
    const alive = (pid: number) => {try {process.kill(pid, 0); return true;} catch {return false;}};
    let pid: number | undefined, result: Promise<unknown> | undefined;
    try {
      result = execute(process.execPath, ["-e", `process.on("SIGTERM", () => {}); await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); ${mode === "overflow" ? 'process.stdout.write("x".repeat(8192));' : ""} setInterval(() => {}, 1000);`], mode === "timeout" ? 500 : 5000, mode === "overflow" ? 128 : 2097152).catch((error: unknown) => error);
      await until(() => existsSync(pidPath));
      pid = Number(readFileSync(pidPath, "utf8"));
      if (mode === "shutdown") {stop(); expect(ownedHelpers.size).toBe(1);}
      const error = await Promise.race([result, Bun.sleep(1500).then(() => null)]);
      expect(error).not.toBeNull();
      await until(() => !alive(pid!), "legacy helper exit");
      expect(ownedHelpers.size).toBe(0);
      expect(alive(sentinel.pid)).toBe(true);
    } finally {
      if (pid && alive(pid)) {process.kill(pid, "SIGKILL"); await until(() => !alive(pid!), "legacy helper cleanup");}
      await result;
      sentinel.kill("SIGKILL"); await sentinel.exited;
      rmSync(root, {recursive: true, force: true});
    }
  });
}

test("round1 cancellation preserves an uncertain in-flight creation and blocks retry", async () => {
  const store = new Store(":memory:"), gate = deferred<unknown>();
  let entered = false, creates = 0;
  const jobs = new Jobs(store, createWebMusicAdapter(async input => {
    if (input.action === "ensurePlaylist") {creates++; entered = true; return gate.promise;}
    return good(input);
  }));
  try {
    const job = jobs.create("Synthetic", [track(1)], false, "g1");
    await until(() => entered);
    jobs.cancel(job.id);
    gate.reject(Object.assign(new Error("Synthetic lost reply"), {uncertain: true}));
    const result = await finished(jobs, job.id);
    expect(result).toMatchObject({state: "cancelled", creationState: "unknown", tracks: [{state: "adding", outcome: "uncertain"}]});
    expect(() => jobs.retry(job.id)).toThrow("unknown");
    expect(creates).toBe(1);
  } finally {gate.resolve({id: "p.synthetic"}); await until(() => !jobs.isActive()); store.close();}
});
