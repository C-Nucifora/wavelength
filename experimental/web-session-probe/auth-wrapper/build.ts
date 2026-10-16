import {cp, mkdir} from "node:fs/promises";
import {dirname, resolve, join} from "node:path";
import {fileURLToPath} from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(root, "../../../../web-session-probe/auth-wrapper");
await mkdir(output, {recursive: true});
let directory = "";
for (let n = 1; n < 10000; n++) {
  const candidate = join(output, String(n).padStart(3, "0"));
  try { await mkdir(candidate); directory = candidate; break; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}
if (!directory) throw new Error("No free build output directory");
const app = join(directory, "Wavelength Sign-in Spike.app");
const contents = join(app, "Contents");
await mkdir(join(contents, "MacOS"), {recursive: true});
await cp(join(root, "Info.plist"), join(contents, "Info.plist"));
const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`;
for (const command of [
  ["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-warnings-as-errors", "-target", target, join(root, "../ProbeCore.swift"), ...["WrapperPolicy", "WrapperCapture", "WrapperWebView", "WrapperModel", "WrapperStorage", "WrapperApp"].map(n => join(root, n + ".swift")), "-o", join(contents, "MacOS/WavelengthAuthWrapper")],
  ["/usr/bin/plutil", "-lint", join(contents, "Info.plist")],
  ["/usr/bin/codesign", "--force", "--sign", "-", "--identifier", "local.wavelength.auth-wrapper-probe", app],
  ["/usr/bin/codesign", "--verify", "--deep", "--strict", app],
]) {
  const child = Bun.spawn(command, {stdout: "inherit", stderr: "inherit"});
  if (await child.exited !== 0) throw new Error("Auth wrapper build failed");
}
console.log(`Built ${app}. Not launched or installed.`);
