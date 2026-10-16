import {cp, mkdir} from "node:fs/promises";
import {resolve, dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
if (process.platform !== "darwin") throw new Error("Build this probe on macOS.");
const root = dirname(fileURLToPath(import.meta.url));
// Reserve a fresh version directory rather than overwriting an older deliverable.
const output = resolve(root, "../../../web-session-probe");
await mkdir(output, {recursive: true});
let directory = "";
for (let version = 1; version < 10_000; version++) {
  const candidate = join(output, String(version).padStart(3, "0"));
  try { await mkdir(candidate); directory = candidate; break; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}
if (!directory) throw new Error("No free probe output directory.");
const app = join(directory, "Wavelength Web Session Probe.app");
const contents = join(app, "Contents");
await mkdir(join(contents, "MacOS"), {recursive: true});
await cp(join(root, "Info.plist"), join(contents, "Info.plist"));
const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`;
for (const command of [
  ["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-warnings-as-errors", "-target", target, ...["ProbeCore", "ProbeModel", "ProbeStorage", "ProbeApp"].map(name => join(root, `${name}.swift`)), "-o", join(contents, "MacOS/WebSessionProbe")],
  ["/usr/bin/plutil", "-lint", join(contents, "Info.plist")],
  ["/usr/bin/codesign", "--force", "--sign", "-", "--identifier", "local.wavelength.web-session-probe", app],
  ["/usr/bin/codesign", "--verify", "--deep", "--strict", app],
]) {
  const child = Bun.spawn(command, {stdout: "inherit", stderr: "inherit"});
  if (await child.exited !== 0) throw new Error("Probe build failed");
}
console.log(`Built ${app}. Not launched or installed.`);
