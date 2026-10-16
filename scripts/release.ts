import {chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";

export type Entry = {path: string; sha256: string; mode?: number};
export type Snapshot = {files: Entry[]};
export async function captureSnapshot(root: string, paths: string[]): Promise<Snapshot> {
  const files: Entry[] = [];
  for (const path of paths) {
    safePath(path);
    files.push({path, sha256: await hash(join(root, path)), mode: (await lstat(join(root, path))).mode & 0o777});
  }
  const snapshot = {files};
  await validateSnapshot(root, snapshot);
  return snapshot;
}

export async function verifyAdHoc(path: string): Promise<void> {
  await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", path]);
  const details = await run(["/usr/bin/codesign", "--display", "--verbose=4", path]);
  if (!/^Signature=adhoc$/m.test(details) || /^Authority=/m.test(details) || !/^TeamIdentifier=not set$/m.test(details)) throw new Error(`Expected ad hoc signature: ${path}`);
}
export const runtime = {
  revision: "1.3.14+0d9b296af",
  commit: "0d9b296af33f2b851fcbf4df3e9ec89751734ba4",
  sha256: "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233",
  archiveSHA256: "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620",
  url: "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-aarch64.zip",
};

export async function hash(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

function safePath(path: string): void {
  if (!path || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..") || /[\\\x00-\x1f\x7f]/.test(path)) throw new Error(`Unsafe path: ${path}`);
}

async function run(command: string[], cwd?: string, env?: Record<string, string | undefined>): Promise<string> {
  const child = Bun.spawn(command, {cwd, env, stdout: "pipe", stderr: "pipe"});
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(`${command[0]} failed: ${stderr}`);
  return stdout + stderr;
}

export async function verifyFiles(root: string, entries: Entry[]): Promise<void> {
  if (!entries.length) throw new Error("Empty file inventory");
  const seen = new Set<string>();
  for (const entry of entries) {
    safePath(entry.path);
    if (seen.has(entry.path)) throw new Error(`Duplicate path: ${entry.path}`);
    seen.add(entry.path);
    // Check every parent too, so a directory symlink cannot escape the root.
    const parts = entry.path.split("/");
    for (let count = 1; count <= parts.length; count++) {
      const stat = await lstat(join(root, ...parts.slice(0, count)));
      if (stat.isSymbolicLink() || count === parts.length && !stat.isFile()) throw new Error(`Not a regular file: ${entry.path}`);
      if (count === parts.length && entry.mode !== undefined && (stat.mode & 0o777) !== entry.mode) throw new Error(`Mode changed: ${entry.path}`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || await hash(join(root, entry.path)) !== entry.sha256) throw new Error(`Hash mismatch: ${entry.path}`);
  }
}

export async function validateSnapshot(root: string, snapshot: Snapshot): Promise<void> {
  for (const {path} of snapshot.files) {
    safePath(path);
    if (/(^|\/)(?:\.git|\.superpowers|node_modules|\.data|\.build|cache|\.env[^/]*|\.wavelength-signing[^/]*)(\/|$)|\.(?:app|sqlite[^/]*|db[^/]*|har|p12|pfx|pem|key|keychain[^/]*|mobileprovision|provisionprofile)(\/|$)/i.test(path)) throw new Error(`Forbidden source path: ${path}`);
  }
  const inventory = (await run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], root)).split("\0").filter(Boolean);
  const reviewed = new Set(snapshot.files.map(file => file.path));
  const unaccounted = inventory.filter(path => !reviewed.has(path));
  const unknown = snapshot.files.filter(file => !inventory.includes(file.path));
  if (unaccounted.length || unknown.length) throw new Error(`Unaccounted source files: ${[...unaccounted, ...unknown.map(file => file.path)].join(", ")}`);
  await verifyFiles(root, snapshot.files);
}

export async function validateRuntime(binary: string): Promise<void> {
  if (await hash(binary) !== runtime.sha256) throw new Error("Runtime hash does not match the pinned official Bun binary");
  if ((await run([binary, "--revision"])).trim() !== runtime.revision) throw new Error("Runtime revision mismatch");
}

export async function validateMaterials(root: string, entries: Entry[]): Promise<void> {
  await verifyFiles(root, entries);
}

export async function reserveOutput(directory: string): Promise<void> {
  await mkdir(directory); // Atomic: an existing output is never reused.
}

export async function archiveSource(root: string, snapshot: Snapshot, archive: string): Promise<void> {
  await validateSnapshot(root, snapshot);
  const temporary = await mkdtemp(join(dirname(archive), ".source-"));
  try {
    const source = join(temporary, "Wavelength-source");
    for (const entry of snapshot.files) {
      const destination = join(source, entry.path);
      await mkdir(dirname(destination), {recursive: true});
      await cp(join(root, entry.path), destination, {errorOnExist: true, force: false});
      if (entry.mode !== undefined) await chmod(destination, entry.mode);
    }
    await verifyFiles(source, snapshot.files);
    await run(["/usr/bin/ditto", "-c", "-k", "--norsrc", "--noextattr", "--keepParent", source, archive]);
    const extracted = join(temporary, "verify");
    await run(["/usr/bin/ditto", "-x", "-k", archive, extracted]);
    await verifyFiles(join(extracted, "Wavelength-source"), snapshot.files);
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "snapshot" && args.length === 3) {
    const [root, list, destination] = args as [string, string, string];
    const snapshot = await captureSnapshot(resolve(root), JSON.parse(await readFile(list, "utf8")));
    await writeFile(destination, JSON.stringify(snapshot, null, 2) + "\n", {flag: "wx"});
  } else if (command === "verify" && args.length === 1) {
    const root = resolve(args[0]!);
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    await verifyFiles(root, manifest.artifacts);
    console.log("Release artifact hashes verified.");
  } else if (command === "package" && args.length === 3) {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Release packaging requires Apple Silicon macOS.");
    const root = resolve(import.meta.dir, "..");
    const [snapshotPath, materialsRoot, output] = args.map(path => resolve(path)) as [string, string, string];
    const snapshot: Snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    const materials: {files: Entry[]; unresolved: string[]} = JSON.parse(await readFile(join(root, "licenses/runtime-sources.json"), "utf8"));
    if (materials.unresolved.length) throw new Error(`Runtime redistribution audit unresolved: ${materials.unresolved.join("; ")}`);
    await validateSnapshot(root, snapshot);
    await validateRuntime(process.execPath);
    await validateMaterials(materialsRoot, materials.files);
    await reserveOutput(output);
    const working = await mkdtemp(join(output, ".work-"));
    try {
      const sourceZIP = "Wavelength-0.1.0-experimental-source.zip";
      await archiveSource(root, snapshot, join(output, sourceZIP));
      await run(["/usr/bin/ditto", "-x", "-k", join(output, sourceZIP), working]);
      const source = join(working, "Wavelength-source");
      const buildLog = await run([process.execPath, join(source, "scripts/build-app.ts"), "--release"], source, {...process.env, WAVELENGTH_SIGN_IDENTITY: "-"});
      const app = /^Built (.+\.app)$/m.exec(buildLog)?.[1];
      if (!app || !app.startsWith(working + "/")) throw new Error("Build did not return an isolated app path");
      const executables = ["Contents/MacOS/Wavelength", "Contents/Resources/bin/bun", "Contents/Resources/bin/WebMusicBridge"];
      await verifyAdHoc(app);
      for (const executable of executables) {
        await verifyAdHoc(join(app, executable));
        if ((await run(["/usr/bin/lipo", "-archs", join(app, executable)])).trim() !== "arm64") throw new Error(`Unexpected architecture: ${executable}`);
      }
      const appZIP = "Wavelength-0.1.0-experimental-macos-arm64.zip";
      await run(["/usr/bin/ditto", "-c", "-k", "--norsrc", "--noextattr", "--keepParent", app, join(output, appZIP)]);
      const extracted = join(working, "packaged");
      await run(["/usr/bin/ditto", "-x", "-k", join(output, appZIP), extracted]);
      await verifyAdHoc(join(extracted, "Wavelength.app"));
      for (const executable of executables) await verifyAdHoc(join(extracted, "Wavelength.app", executable));
      const files = [sourceZIP, appZIP, "source-snapshot.json", "LICENSE", "RELEASE-NOTES.md"];
      await cp(snapshotPath, join(output, "source-snapshot.json"));
      await cp(join(source, "LICENSE"), join(output, "LICENSE"));
      await cp(join(source, "docs/RELEASE-NOTES.md"), join(output, "RELEASE-NOTES.md"));
      for (const entry of materials.files) {
        const destination = join(output, "runtime-sources", entry.path);
        await mkdir(dirname(destination), {recursive: true});
        await cp(join(materialsRoot, entry.path), destination, {force: false, errorOnExist: true});
        files.push(`runtime-sources/${entry.path}`);
      }
      await verifyFiles(join(output, "runtime-sources"), materials.files);
      const artifacts: Entry[] = [];
      for (const path of files) {
        if ((await lstat(join(output, path))).size >= 2 ** 31) throw new Error(`Artifact exceeds GitHub's 2 GiB asset limit: ${path}`);
        artifacts.push({path, sha256: await hash(join(output, path))});
      }
      const manifest = {version: "0.1.0-experimental", platform: "macos-arm64", minimumMacOS: "14.0", signing: "ad hoc", notarized: false, runtime, bundledRuntimeSHA256: await hash(join(app, "Contents/Resources/bin/bun")), toolchain: (await run(["/usr/bin/xcrun", "swiftc", "--version"])).trim(), artifacts};
      await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      artifacts.push({path: "manifest.json", sha256: await hash(join(output, "manifest.json"))});
      await writeFile(join(output, "SHA256SUMS"), artifacts.map(entry => `${entry.sha256}  ${entry.path}\n`).join(""));
      await verifyFiles(output, artifacts);
      console.log(`Prepared experimental release: ${output}`);
    } finally {
      await rm(working, {recursive: true, force: true});
    }
  } else {
    throw new Error("Usage: release.ts snapshot ROOT FILE-LIST.json NEW-SNAPSHOT.json | package SNAPSHOT.json MATERIALS NEW-OUTPUT | verify OUTPUT");
  }
}
