import {test, expect} from "bun:test";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {createApp} from "../src/server";
import {Store} from "../src/store";

const root = resolve(import.meta.dir, "..");
const swift = await readFile(join(root, "native/Tests/HistoryChecks.swift"), "utf8");
const packaged = swift.slice(swift.indexOf("@MainActor private static func runPackaged(resources:"), swift.indexOf("    private static func packagedDatabaseCheck("));
const scripts = [...packaged.matchAll(/script: """\n([\s\S]*?)\n\s*"""/g)].map(match => match[1]!);

test("packaged history fixture releases its lease and refreshes its client around direct Store access", () => {
  let running = false;
  let starts = 0;
  let databaseChecks = 0;
  const steps = packaged.matchAll(/\bapi = try await engine\.start\(\)|await engine\.stop\(\)|try packagedDatabaseCheck\(|\bapi\.(?:call|uploadCSV)\(/g);
  for (const [step] of steps) {
    if (step.includes("engine.start")) {running = true; starts++;}
    else if (step.includes("engine.stop")) running = false;
    else if (step.includes("packagedDatabaseCheck")) {expect(running).toBe(false); databaseChecks++;}
    else expect(running).toBe(true);
  }
  expect(starts).toBe(3);
  expect(databaseChecks).toBe(3);
  expect(scripts).toHaveLength(3);
});

test("packaged history scripts survive readiness restart and Forget without touching integrations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wavelength-packaged-history-fixture-"));
  const path = join(directory, "state.sqlite");
  let owned: {store: Store; app: ReturnType<typeof createApp>} | undefined;
  const unused = async (): Promise<never> => {throw new Error("Packaged history must not invoke integrations");};
  function start() {
    const store = new Store(path);
    const app = createApp({store, port: 8769, engineToken: crypto.randomUUID(),
      discovery: {getGenres: unused, buildDraft: unused},
      music: {getMusicStatus: unused, ensurePlaylist: unused, addTrackToPlaylist: unused, openPlaylist: unused}});
    owned = {store, app};
    expect(() => new Store(path)).toThrow("already using this data directory");
    return (route: string, body?: unknown) => app.fetch(new Request(`http://127.0.0.1:8769${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {host: "127.0.0.1:8769", origin: "http://127.0.0.1:8769", "x-wavelength-token": app.token, "content-type": "application/json"},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    }));
  }
  function stop() {owned?.app.dispose(); owned?.store.close(); owned = undefined;}
  async function runScript(index: number) {
    expect(owned).toBeUndefined();
    const child = Bun.spawn([process.execPath, "-e", scripts[index]!], {
      cwd: root, env: {...process.env, WAVELENGTH_DATA_DIR: directory}, stdout: "pipe", stderr: "pipe",
    });
    expect({exit: await child.exited, stderr: await new Response(child.stderr).text()}).toEqual({exit: 0, stderr: ""});
  }
  try {
    let call = start();
    expect(await (await call("/api/history?timeZone=UTC")).json()).toMatchObject({sources: [], page: null});
    stop();
    await runScript(0);
    call = start();
    const ready = await call("/api/ready");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ready: true, activeJob: {
      id: "sentinel", name: "Fixture sentinel", state: "complete", tracks: [], message: "Synthetic preserved job", createdAt: "2026-01-01", updatedAt: "2026-01-01",
    }});
    const library = await call("/api/history?source=library&kind=tracks&timeZone=UTC");
    expect(library.status).toBe(200);
    expect(await library.json()).toMatchObject({page: {rows: [{libraryPlayCount: 0}]}});
    expect((await call("/api/history/forget", {})).status).toBe(200);
    stop();
    await runScript(1);
    call = start();
    expect((await call("/api/ready")).status).toBe(200);
    const unsupported = await call("/api/history?timeZone=UTC");
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()).error).toContain("schema");
    expect((await call("/api/history/forget", {})).status).toBe(200);
    stop();
    await runScript(2);
  } finally {stop(); await rm(directory, {recursive: true, force: true});}
});
