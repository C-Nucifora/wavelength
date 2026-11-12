import {afterEach, expect, test} from "bun:test";
import {mkdtemp, mkdir, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {captureSnapshot, verifyFiles} from "../scripts/release";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, {recursive: true, force: true});
});

async function fixture() {
  const control = await mkdtemp(join(tmpdir(), "wavelength-data-review-"));
  temporary.push(control);
  const root = join(control, "source"), alias = join(control, "alias");
  await mkdir(root);
  expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
  await writeFile(join(root, "source.ts"), "synthetic source\n");
  await symlink(root, alias);
  const entry = {path: "source.ts", sha256: createHash("sha256").update("synthetic source\n").digest("hex")};
  return {control, root, alias, entry};
}

// A trailing separator must not turn a rejected root symlink into a directory.
for (const operation of ["capture", "verify"] as const) {
  test.each(["/", "//"])(`${operation} rejects a root symlink ending in %s`, async suffix => {
    const {root, alias, entry} = await fixture();
    const run = (directory: string) => operation === "capture"
      ? captureSnapshot(directory, [entry.path])
      : verifyFiles(directory, [entry]);
    await run(root + suffix);
    await expect(run(alias)).rejects.toThrow(/regular file/);
    await expect(run(alias + suffix)).rejects.toThrow(/regular file/);
  });
}

test.each(["snapshot", "verify"])("%s CLI rejects a root symlink with a trailing slash", async command => {
  const {control, root, alias, entry} = await fixture();
  await writeFile(join(root, "manifest.json"), JSON.stringify({artifacts: [entry]}));
  await writeFile(join(control, "files.json"), JSON.stringify([entry.path, "manifest.json"]));
  const args = command === "snapshot"
    ? [alias + "/", join(control, "files.json"), join(control, "snapshot.json")]
    : [alias + "/"];
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/release.ts"), command, ...args]);
  expect(child.exitCode).not.toBe(0);
  expect(child.stderr.toString()).toContain("Not a regular file");
});
