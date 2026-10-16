import {test, expect} from "bun:test";
import {mkdtemp, cp, chmod, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";

const root = resolve(import.meta.dir, "..");
const alive = (pid: number) => {try {process.kill(pid, 0); return true;} catch {return false;}};
async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 100; i++) {const value = await read(); if (value !== undefined) return value; await Bun.sleep(30);}
  throw new Error("Timed out waiting for the fixture engine");
}
test.skipIf(process.platform !== "darwin")("explicit precompiled helper runs without finding Swift sources or invoking a compiler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wavelength-helper-"));
  const helper = join(directory, "WebMusicBridge");
  try {
    await cp(join(root, "tests/fixtures/native-helper.sh"), helper); await chmod(helper, 0o755);
    const child = Bun.spawn([process.execPath, "-e", 'import {createWebMusicAdapter} from "./src/web-music.ts"; console.log(JSON.stringify(await createWebMusicAdapter().getMusicStatus()));'], {cwd: root, env: {...process.env, WAVELENGTH_WEB_MUSIC_BRIDGE: helper}, stdout: "pipe", stderr: "pipe"});
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toMatchObject({backend: "web-session", connection: "missing", accessibility: false});
    expect(await new Response(child.stderr).text()).toBe("");
  } finally {await rm(directory, {recursive: true, force: true});}
});
test("engine termination cleans a registered owned helper and preserves unrelated processes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wavelength-shutdown-"));
  const helper = join(directory, "WebMusicBridge");
  const pidFile = join(directory, "helper.pid");
  await cp(join(root, "tests/fixtures/native-helper.sh"), helper); await chmod(helper, 0o755);
  const unrelated = Bun.spawn(["/bin/sleep", "30"]);
  const engine = Bun.spawn([process.execPath, "src/index.ts"], {cwd: root, env: {...process.env, PORT: "0", WAVELENGTH_DATA_DIR: directory, WAVELENGTH_WEB_MUSIC_BRIDGE: helper, WAVELENGTH_TEST_HELPER_PID: pidFile}, stdout: "pipe", stderr: "pipe"});
  let helperPID: number | undefined;
  try {
    const reader = engine.stdout.getReader();
    const announced = new TextDecoder().decode((await reader.read()).value);
    const origin = announced.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(origin).toBeDefined();
    const status = fetch(`${origin}/api/status`).catch(() => undefined);
    helperPID = await waitFor(async () => {
      if (!await Bun.file(pidFile).exists()) return undefined;
      const value = await Bun.file(pidFile).text();
      return /^\d+$/.test(value) && Number(value) > 1 ? Number(value) : undefined;
    });
    expect(alive(helperPID)).toBe(true);
    engine.kill("SIGTERM");
    expect(await engine.exited).toBe(0);
    await waitFor(async () => !alive(helperPID!) ? true : undefined);
    expect(alive(helperPID)).toBe(false);
    expect(alive(unrelated.pid)).toBe(true);
    await status;
    reader.releaseLock();
  } finally {
    if (engine.exitCode === null) engine.kill("SIGKILL");
    if (helperPID && alive(helperPID)) process.kill(helperPID, "SIGKILL");
    unrelated.kill(); await unrelated.exited;
    await rm(directory, {recursive: true, force: true});
  }
}, 10000);

test("engine accepts CSV beyond 128 KiB and retains JSON and 20 MiB ceilings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wavelength-history-transport-"));
  const engine = Bun.spawn([process.execPath, "src/index.ts"], {cwd: root, env: {...process.env, PORT: "0", WAVELENGTH_DATA_DIR: directory}, stdout: "pipe", stderr: "pipe"});
  const reader = engine.stdout.getReader();
  try {
    const announced = new TextDecoder().decode((await reader.read()).value);
    const origin = announced.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(origin).toBeDefined();
    const {token} = await (await fetch(`${origin}/api/session`)).json();
    const headers = {origin: origin!, "x-wavelength-token": token, "content-type": "text/csv; charset=utf-8"};
    const csv = "Song Name,Event End Timestamp\n" + "Song,\n".repeat(25000);
    const previewResponse = await fetch(`${origin}/api/history/preview`, {method: "POST", headers, body: csv});
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview.coverage.acceptedRows).toBe(25000);
    expect((await fetch(`${origin}/api/drafts`, {method: "POST", headers: {...headers, "content-type": "application/json"}, body: JSON.stringify({data: "x".repeat(131073)})})).status).toBe(413);
    expect((await fetch(`${origin}/api/history/preview`, {method: "POST", headers, body: new Uint8Array(20 * 1024 * 1024 + 1)})).status).toBe(413);
    engine.kill("SIGTERM");
    expect(await engine.exited).toBe(0);
    expect(await new Response(engine.stderr).text()).toBe("");
  } finally {
    reader.releaseLock();
    if (engine.exitCode === null) {engine.kill("SIGKILL"); await engine.exited;}
    await rm(directory, {recursive: true, force: true});
  }
}, 10000);
