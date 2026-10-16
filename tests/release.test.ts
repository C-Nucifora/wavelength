import {afterEach, expect, test} from "bun:test";
import {mkdtemp, mkdir, readFile, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {validateSnapshot, validateRuntime, validateMaterials, reserveOutput, archiveSource, verifyFiles, verifyAdHoc, captureSnapshot} from "../scripts/release";

const temporary: string[] = [];
afterEach(async () => {for (const path of temporary.splice(0)) await rm(path, {recursive: true, force: true});});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wavelength-release-test-"));
  temporary.push(root);
  const git = Bun.spawnSync(["git", "init", "-q", root]);
  expect(git.exitCode).toBe(0);
  await writeFile(join(root, "feature.ts"), "export const feature = 1;\n");
  return root;
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const reviewed = {files: [{path: "feature.ts", sha256: sha("export const feature = 1;\n"), mode: 0o644}]};

// Removing inventory comparison would silently omit a new feature.
test("snapshot rejects unaccounted untracked source", async () => {
  const root = await fixture();
  await writeFile(join(root, "new-feature.ts"), "new source");
  await expect(validateSnapshot(root, reviewed)).rejects.toThrow(/unaccounted/i);
});
// Removing hash validation would package edits made after review.
test("snapshot rejects changes after review", async () => {
  const root = await fixture();
  await writeFile(join(root, "feature.ts"), "changed source");
  await expect(validateSnapshot(root, reviewed)).rejects.toThrow(/hash/i);
});
test("snapshot rejects personal signing configuration even when allowlisted", async () => {
  const root = await fixture();
  await writeFile(join(root, ".wavelength-signing-identity"), "personal");
  await expect(validateSnapshot(root, {files: [...reviewed.files, {path: ".wavelength-signing-identity", sha256: sha("personal"), mode: 0o644}]})).rejects.toThrow(/forbidden/i);
});
test("runtime rejects missing provenance input", async () => {
  const root = await fixture();
  await expect(validateRuntime(join(root, "absent-bun"))).rejects.toThrow();
});
test("runtime rejects a mismatched executable before executing it", async () => {
  const root = await fixture();
  await expect(validateRuntime(join(root, "feature.ts"))).rejects.toThrow(/runtime.*hash/i);
});
test("materials rejects missing source archives", async () => {
  const root = await fixture();
  await expect(validateMaterials(root, [{path: "Bun-source.tar.gz", sha256: sha("source")}])).rejects.toThrow();
});
test("materials rejects changed licensing content", async () => {
  const root = await fixture();
  await expect(validateMaterials(root, [{path: "feature.ts", sha256: sha("license")}])).rejects.toThrow(/hash/i);
});
test("release refuses an existing output directory without changing it", async () => {
  const root = await fixture();
  await expect(reserveOutput(root)).rejects.toThrow(/exist/i);
  expect(await readFile(join(root, "feature.ts"), "utf8")).toBe("export const feature = 1;\n");
});
test("manifest verification rejects archive tampering", async () => {
  const root = await fixture();
  await expect(verifyFiles(root, [{path: "feature.ts", sha256: sha("other")}])).rejects.toThrow(/hash/i);
});
test("source archive includes reviewed untracked features and excludes ignored secrets", async () => {
  const root = await fixture();
  await writeFile(join(root, ".gitignore"), "secret.txt\n");
  await writeFile(join(root, "secret.txt"), "private");
  const snapshot = {files: [...reviewed.files, {path: ".gitignore", sha256: sha("secret.txt\n"), mode: 0o644}]};
  const output = await mkdtemp(join(tmpdir(), "wavelength-archive-test-"));
  temporary.push(output);
  const archive = join(output, "source.zip");
  await archiveSource(root, snapshot, archive);
  await mkdir(join(output, "extracted"));
  const unzip = Bun.spawnSync(["/usr/bin/ditto", "-x", "-k", archive, join(output, "extracted")]);
  expect(unzip.exitCode).toBe(0);
  expect(await readFile(join(output, "extracted/Wavelength-source/feature.ts"), "utf8")).toBe("export const feature = 1;\n");
  expect(await Bun.file(join(output, "extracted/Wavelength-source/secret.txt")).exists()).toBe(false);
});

test("snapshot capture requires every current source file in the explicit review list", async () => {
  const root = await fixture();
  await expect(captureSnapshot(root, [])).rejects.toThrow(/unaccounted/i);
  expect(await captureSnapshot(root, ["feature.ts"])).toEqual(reviewed);
});
test("signature check rejects an unsigned executable", async () => {
  const root = await fixture();
  await expect(verifyAdHoc(join(root, "feature.ts"))).rejects.toThrow();
});
test("signature check accepts a real ad hoc signed executable", async () => {
  const root = await fixture();
  const executable = join(root, "hello");
  await writeFile(join(root, "hello.c"), "int main(void) { return 0; }\n");
  expect(Bun.spawnSync(["/usr/bin/xcrun", "clang", join(root, "hello.c"), "-o", executable]).exitCode).toBe(0);
  expect(Bun.spawnSync(["/usr/bin/codesign", "--force", "--sign", "-", executable]).exitCode).toBe(0);
  await expect(verifyAdHoc(executable)).resolves.toBeUndefined();
});

test("snapshot command records explicit reviewed file hashes", async () => {
  const root = await fixture();
  const control = await mkdtemp(join(tmpdir(), "wavelength-control-test-"));
  temporary.push(control);
  await writeFile(join(control, "files.json"), JSON.stringify(["feature.ts"]));
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/release.ts"), "snapshot", root, join(control, "files.json"), join(control, "snapshot.json")]);
  expect(child.exitCode).toBe(0);
  expect(await Bun.file(join(control, "snapshot.json")).exists()).toBe(true);
  expect(await Bun.file(join(control, "snapshot.json")).json()).toEqual(reviewed);
});
test("verify command fails when a recorded artifact was changed", async () => {
  const root = await fixture();
  await writeFile(join(root, "manifest.json"), JSON.stringify({artifacts: [{path: "feature.ts", sha256: sha("original")}]}));
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/release.ts"), "verify", root]);
  expect(child.exitCode).not.toBe(0);
});
