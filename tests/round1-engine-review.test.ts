import {expect, test} from "bun:test";
import {execFile} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runInNewContext} from "node:vm";
import {Jobs} from "../src/jobs";
import {Store} from "../src/store";
import {createWebMusicAdapter, runBridgeRequest, stopOwnedHelpers} from "../src/web-music";
import type {DraftTrack} from "../src/types";

// Independent synthetic challenge. Run serially under heavy.lock with disk-backed TMPDIR.
const track = (id: number): DraftTrack => ({id: String(id), catalogId: id, artistId: id, title: `Song ${id}`, artist: "Synthetic", album: "Fixture", durationMs: 1000, releaseDate: "2026-01-01", url: "https://example.invalid", source: "fixture", match: "exact", selected: true, provenance: {kind: "unknown", evidence: []}});
type Invoke = NonNullable<Parameters<typeof createWebMusicAdapter>[0]>;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) {if (predicate()) return; await Bun.sleep(5);}
  throw new Error(`Bounded wait expired: ${label}`);
}
async function finished(jobs: Jobs, id: string) {
  await until(() => !jobs.isActive(), "job completion");
  return jobs.get(id)!;
}
const alive = (pid: number) => {try {process.kill(pid, 0); return true;} catch {return false;}};
const scratch = () => mkdtempSync(join(tmpdir(), "round1-engine-review-"));
const reply = (input: Parameters<Invoke>[0], envelope: unknown, exit = 0) => runBridgeRequest(input, {
  command: [process.execPath, "-e", `await Bun.stdin.text(); console.log(${JSON.stringify(JSON.stringify(envelope))}); process.exit(${exit});`], timeoutMs: 1500,
});
const good: Invoke = async input => {
  if (input.action === "status" || input.action === "rebindPlaylist") return {generation: "g1"};
  if (input.action === "ensurePlaylist") return {id: "p.synthetic"};
  if (input.action === "addTrackToPlaylist") return {kind: "confirmed", catalogId: input.catalogIds![input.position!], alreadyPresent: true};
  if (input.action === "playlistCover") return {state: "blocked", code: "automation-permission", writeAttempted: false};
  throw new Error(`Unexpected synthetic action: ${input.action}`);
};

test("review delayed web exit notification retains ownership after reap deadline and isolates a later launch", async () => {
  const source = readFileSync(new URL("../src/web-music.ts", import.meta.url), "utf8");
  const bridge = source.slice(source.indexOf("const errorMessages"), source.indexOf("\nfunction record")).replaceAll("export ", "");
  const release = deferred<void>();
  const actual: Bun.Subprocess[] = [], signals: Array<[number, string]> = [];
  let released = false;
  const api = runInNewContext(`${new Bun.Transpiler({loader: "ts"}).transformSync(bridge)}\n({runBridgeRequest, stopOwnedHelpers, children})`, {
    Buffer, TextDecoder, setTimeout, clearTimeout,
    Bun: {spawn(command: string[], options: Parameters<typeof Bun.spawn>[1]) {
      const child = Bun.spawn(command, options); actual.push(child);
      const delayed = actual.length === 1;
      return {stdin: child.stdin, stdout: child.stdout,
        get exitCode() {return delayed && !released ? null : child.exitCode;},
        exited: child.exited.then(async code => {if (delayed) await release.promise; return code;}),
        kill(signal: string) {signals.push([child.pid, signal]); if (child.exitCode === null) child.kill(signal as "SIGKILL");},
      };
    }},
  });
  const sentinel = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {stdout: "ignore", stderr: "ignore"});
  let second: Promise<unknown> | undefined;
  try {
    const command = [process.execPath, "-e", 'process.on("SIGTERM", () => {}); await Bun.stdin.text(); setInterval(() => {}, 1000);'];
    const first = api.runBridgeRequest({action: "ensurePlaylist"}, {command, timeoutMs: 50}).catch((error: unknown) => error);
    expect(await first).toMatchObject({code: "transport", uncertain: true});
    expect(api.children.size).toBe(1);
    await actual[0]!.exited;
    expect(alive(actual[0]!.pid)).toBe(false);
    api.stopOwnedHelpers();
    expect(signals.filter(([pid]) => pid === actual[0]!.pid)).toHaveLength(2);
    second = api.runBridgeRequest({action: "ensurePlaylist"}, {command, timeoutMs: 1500}).catch((error: unknown) => error);
    expect(api.children.size).toBe(2);
    released = true; release.resolve();
    await until(() => api.children.size === 1, "old notification removes only old ownership");
    expect(alive(actual[1]!.pid)).toBe(true);
    api.stopOwnedHelpers();
    expect(await second).toMatchObject({code: "transport", uncertain: true});
    expect(api.children.size).toBe(0);
    expect(alive(sentinel.pid)).toBe(true);
    expect(signals.every(([, signal]) => signal === "SIGKILL")).toBe(true);
  } finally {
    released = true; release.resolve();
    for (const child of actual) {if (child.exitCode === null) child.kill("SIGKILL"); await child.exited;}
    await second;
    sentinel.kill("SIGKILL"); await sentinel.exited;
  }
});

test("review legacy delayed completion keeps both generations owned until their individual callbacks", async () => {
  const source = readFileSync(new URL("../src/music.ts", import.meta.url), "utf8");
  const start = source.indexOf("function execute(");
  const code = source.slice(start, source.indexOf("\n}\n", start) + 3) + "\n" + source.match(/^export function stopOwnedHelpers.*$/m)![0].replace("export ", "");
  const ownedHelpers = new Set(), children: ReturnType<typeof execFile>[] = [], callbacks: Array<() => void> = [];
  const api = runInNewContext(`${new Bun.Transpiler({loader: "ts"}).transformSync(code)}\n({execute, stopOwnedHelpers})`, {
    ownedHelpers, execFile(file: string, args: string[], options: object, callback: (error: unknown, stdout: string, stderr: string) => void) {
      const child = execFile(file, args, options, (error, stdout, stderr) => callbacks.push(() => callback(error, String(stdout), String(stderr))));
      children.push(child); return child;
    },
  });
  const results: Promise<unknown>[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      results.push(api.execute(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], 1500).catch((error: unknown) => error));
      api.stopOwnedHelpers();
      await until(() => callbacks.length === i + 1, "real execFile completion");
      expect(ownedHelpers.size).toBe(i + 1);
    }
    callbacks[0]!(); await results[0];
    expect(ownedHelpers.size).toBe(1);
    api.stopOwnedHelpers();
    callbacks[1]!(); await results[1];
    expect(ownedHelpers.size).toBe(0);
    expect(children.every(child => !alive(child.pid!))).toBe(true);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await until(() => callbacks.length === children.length, "legacy cleanup callbacks");
    for (const callback of callbacks) callback();
    await Promise.all(results);
  }
});

for (const stage of ["launch", "ready", "stdout-closed"] as const) {
  test(`review repeated stop during ${stage} reaps only owned children`, async () => {
    const root = scratch(), marker = join(root, "ready"), sentinelFile = join(root, "sentinel");
    writeFileSync(sentinelFile, "synthetic unrelated data");
    const sentinel = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {stdout: "ignore", stderr: "ignore"});
    let pid: number | undefined, request: Promise<unknown> | undefined;
    try {
      const command = [process.execPath, "-e", `process.on("SIGTERM", () => {}); await Bun.stdin.text(); ${stage === "stdout-closed" ? 'process.stdout.write(JSON.stringify({ok:false,error:{code:"rejected",uncertain:false}})); process.stdout.end();' : ""} await Bun.write(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`];
      request = runBridgeRequest({action: "ensurePlaylist"}, {command, timeoutMs: 1500}).catch(error => error);
      if (stage !== "launch") {await until(() => existsSync(marker), "helper ready"); pid = Number(readFileSync(marker, "utf8"));}
      stopOwnedHelpers(); stopOwnedHelpers();
      expect(await request).toMatchObject({code: "transport", uncertain: true});
      if (pid) expect(alive(pid)).toBe(false);
      expect(alive(sentinel.pid)).toBe(true);
      expect(readFileSync(sentinelFile, "utf8")).toBe("synthetic unrelated data");
      expect(await reply({action: "status"}, {ok: true, result: {generation: "next"}})).toEqual({generation: "next"});
      stopOwnedHelpers();
      expect(alive(sentinel.pid)).toBe(true);
    } finally {
      stopOwnedHelpers(); await request;
      if (pid && alive(pid)) {process.kill(pid, "SIGKILL"); await until(() => !alive(pid!), "helper cleanup");}
      sentinel.kill("SIGKILL"); await sentinel.exited;
      rmSync(root, {recursive: true, force: true});
    }
  });
}

test("review malformed known and unknown replies retain creation intent across cancellation, account change and reopen", async () => {
  const errors = [
    {code: "__proto__", uncertain: false}, {code: "toString", uncertain: false}, {code: "future-native-error", uncertain: false},
    {code: "rejected", uncertain: "false"}, {code: "transport", uncertain: null}, {code: "missing"},
    {code: ["rejected"], uncertain: false},
  ];
  for (const error of errors) {
    const root = scratch(), path = join(root, "jobs.sqlite"), gate = deferred<void>();
    let store = new Store(path), creates = 0, generation = "g1";
    store.put("sentinel", "unrelated", {value: "keep"});
    const invoke: Invoke = async input => {
      if (input.action === "status") return {generation};
      if (input.action === "ensurePlaylist") {creates++; await gate.promise; return reply(input, {ok: false, error});}
      throw new Error("No follow-up action expected after ambiguous creation");
    };
    let jobs = new Jobs(store, createWebMusicAdapter(invoke));
    const job = jobs.create("Synthetic", [track(1)], false, generation);
    try {
      expect(creates).toBe(1);
      jobs.cancel(job.id); jobs.cancel(job.id);
      expect(() => jobs.retry(job.id)).toThrow("already running");
      gate.resolve();
      expect(await finished(jobs, job.id)).toMatchObject({state: "cancelled", creationState: "unknown", tracks: [{state: "adding", outcome: "uncertain"}]});
      generation = "g2";
      store.close(); store = new Store(path); jobs = new Jobs(store, createWebMusicAdapter(invoke));
      for (let i = 0; i < 3; i++) {jobs.cancel(job.id); expect(() => jobs.retry(job.id)).toThrow("unknown");}
      expect(creates).toBe(1);
      expect(store.get<{value: string}>("sentinel", "unrelated")).toEqual({value: "keep"});
    } finally {gate.resolve(); await until(() => !jobs.isActive(), "creation cleanup"); store.close(); rmSync(root, {recursive: true, force: true});}
  }
});

test("review a valid pre-write rejection allows one retry but a nonzero helper exit makes its reply uncertain", async () => {
  const store = new Store(":memory:");
  let creates = 0;
  const jobs = new Jobs(store, createWebMusicAdapter(async input => {
    if (input.action === "ensurePlaylist") {creates++; return reply(input, {ok: false, error: {code: "rejected", uncertain: false}}, creates === 1 ? 0 : 7);}
    return good(input);
  }));
  try {
    const first = await finished(jobs, jobs.create("Synthetic", [track(1)], false, "g1").id);
    expect(first.creationState).toBe("not-started");
    jobs.retry(first.id);
    expect(await finished(jobs, first.id)).toMatchObject({creationState: "unknown", tracks: [{outcome: "uncertain"}]});
    expect(() => jobs.retry(first.id)).toThrow("unknown");
    expect(creates).toBe(2);
  } finally {await until(() => !jobs.isActive(), "job cleanup"); store.close();}
});

test("review repeated cancel and account rebind never turn an ambiguous append into another write", async () => {
  const root = scratch(), path = join(root, "jobs.sqlite");
  let store = new Store(path), generation = "g1", stage = "initial", creates = 0;
  let gate = deferred<unknown>(), entered = false;
  const contents = ["1"], calls: Array<{generation?: string; position?: number; reconcileOnly?: boolean}> = [];
  const invoke: Invoke = async input => {
    if (input.action === "status") {if (stage === "status") {entered = true; return gate.promise;} return {generation};}
    if (input.action === "rebindPlaylist") {if (stage === "rebind") {entered = true; return gate.promise;} return {generation};}
    if (input.action === "ensurePlaylist") {creates++; return {id: "p.synthetic"};}
    if (input.action === "addTrackToPlaylist") {
      calls.push({generation: input.generation, position: input.position, reconcileOnly: input.reconcileOnly});
      if (input.position === 1) {
        if (stage === "initial") {contents.push("2"); entered = true; await gate.promise; return reply(input, {ok: false, error: {code: "future-write-error", uncertain: false}});}
        if (stage === "known-rejection") return reply(input, {ok: false, error: {code: "rejected", uncertain: false}});
        if (stage === "malformed-confirmation") return {kind: "confirmed", catalogId: "999", alreadyPresent: true};
      }
      if (!input.reconcileOnly) contents.push(input.catalogIds![input.position!]!);
      return {kind: "confirmed", catalogId: input.catalogIds![input.position!], alreadyPresent: input.reconcileOnly};
    }
    return good(input);
  };
  let jobs = new Jobs(store, createWebMusicAdapter(invoke));
  const job = jobs.create("Synthetic", [track(1), track(2), track(3)], false, generation);
  try {
    await until(() => entered, "ambiguous append");
    jobs.cancel(job.id); jobs.cancel(job.id); gate.resolve({});
    expect(await finished(jobs, job.id)).toMatchObject({state: "cancelled", tracks: [{state: "added"}, {outcome: "uncertain"}, {state: "pending"}]});
    for (const nextStage of ["status", "rebind"]) {
      stage = nextStage; generation = nextStage === "status" ? "g2" : "g3"; entered = false; gate = deferred<unknown>();
      jobs.retry(job.id); await until(() => entered, stage); jobs.cancel(job.id); jobs.cancel(job.id);
      gate.reject(new Error("Synthetic account read rejected"));
      expect(await finished(jobs, job.id)).toMatchObject({state: "cancelled", connectionGeneration: "g1", tracks: [{state: "added"}, {outcome: "uncertain"}, {state: "pending"}]});
      expect(calls).toHaveLength(2);
    }
    store.close(); store = new Store(path); jobs = new Jobs(store, createWebMusicAdapter(invoke));
    for (const nextStage of ["known-rejection", "malformed-confirmation"]) {
      stage = nextStage; jobs.retry(job.id);
      expect(await finished(jobs, job.id)).toMatchObject({state: "partial", connectionGeneration: "g3", tracks: [{state: "added"}, {outcome: "uncertain"}, {state: "pending"}]});
      expect(contents).toEqual(["1", "2"]);
    }
    stage = "confirmed"; generation = "g4"; jobs.retry(job.id);
    expect(await finished(jobs, job.id)).toMatchObject({state: "complete", connectionGeneration: "g4"});
    expect(contents).toEqual(["1", "2", "3"]);
    expect(creates).toBe(1);
    expect(calls.filter(call => call.position === 1).map(call => call.reconcileOnly)).toEqual([false, true, true, true]);
    expect(calls.filter(call => call.position === 2)).toEqual([{generation: "g4", position: 2, reconcileOnly: false}]);
  } finally {gate.resolve({}); await until(() => !jobs.isActive(), "append cleanup"); store.close(); rmSync(root, {recursive: true, force: true});}
});

test("review unknown cover helper error survives later known rejection and account changes without another apply", async () => {
  const store = new Store(":memory:");
  let generation = "g1";
  const modes: string[] = [];
  const jobs = new Jobs(store, createWebMusicAdapter(async input => {
    if (input.action === "status") return {generation};
    if (input.action === "playlistCover") {
      modes.push(input.coverMode!);
      return reply(input, {ok: false, error: {code: modes.length === 1 ? "future-artwork-error" : "rejected", uncertain: false}});
    }
    return good(input);
  }));
  try {
    const job = await finished(jobs, jobs.create("Synthetic", [track(1)], false, generation).id);
    expect(job.cover?.state).toBe("uncertain");
    for (const action of ["permission", "retry", "check", "retry"] as const) {
      generation = "g2"; jobs.cancel(job.id); jobs.coverAction(job.id, action);
      expect((await finished(jobs, job.id)).cover?.state).toBe("uncertain");
    }
    expect(modes).toEqual(["apply", "authorize", "check", "check", "check"]);
  } finally {await until(() => !jobs.isActive(), "cover cleanup"); store.close();}
});
