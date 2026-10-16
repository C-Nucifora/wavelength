import {cp, mkdir, mkdtemp, chmod, readdir} from "node:fs/promises";
import {join, resolve, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {resolveSigningIdentity} from "./signing";
import {validateRuntime, verifyAdHoc} from "./release";

if (process.platform !== "darwin") throw new Error("The native app must be built on macOS.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv.includes("--release");
if (release) {
  if (process.arch !== "arm64") throw new Error("The experimental release requires Apple Silicon.");
  await validateRuntime(process.execPath);
}
const signing = await resolveSigningIdentity(root, release ? {...process.env, WAVELENGTH_SIGN_IDENTITY: "-"} : process.env);
if (signing.warning) console.warn(signing.warning);
const output = resolve(root, "../builds.noindex");
await mkdir(output, {recursive: true});
const directory = await mkdtemp(join(output, "native-"));
const app = join(directory, "Wavelength.app");
const contents = join(app, "Contents");
const resources = join(contents, "Resources");
const bin = join(resources, "bin");
await mkdir(join(contents, "MacOS"), {recursive: true});
await mkdir(bin, {recursive: true});
await mkdir(join(resources, "engine/native"), {recursive: true});
await cp(join(root, "src"), join(resources, "engine/src"), {recursive: true});
await cp(join(root, "public"), join(resources, "engine/public"), {recursive: true});
await cp(join(root, "native/history.jxa"), join(resources, "engine/native/history.jxa"));
await cp(join(root, "native/Assets/Wavelength.icns"), join(resources, "Wavelength.icns"));
await cp(process.execPath, join(bin, "bun"));
if (release) {
  await cp(join(root, "LICENSE"), join(resources, "LICENSE"));
  await cp(join(root, "licenses"), join(resources, "licenses"), {recursive: true});
}
await chmod(join(bin, "bun"), 0o755);
const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
const target = `${architecture}-apple-macos14.0`;
async function run(command: string[]) {
  const process = Bun.spawn(command, {cwd: root, stdout: "inherit", stderr: "inherit"});
  if (await process.exited !== 0) throw new Error(`${command[0]} failed`);
}
const sources = (await readdir(join(root, "native/App"))).filter(name => name.endsWith(".swift")).sort().map(name => join(root, "native/App", name));
sources.push(...["Types", "ArtworkTypes", "ArtworkRenderer", "ArtworkStore"].map(name => join(root, "native/WebMusic", name + ".swift")));
sources.push(...["WrapperPolicy", "WrapperCapture", "WrapperWebView"].map(name => join(root, "experimental/web-session-probe/auth-wrapper", name + ".swift")));
await run(["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-warnings-as-errors", "-target", target, ...sources, "-o", join(contents, "MacOS/Wavelength")]);
await run(["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-warnings-as-errors", "-target", target, ...["Types", "ArtworkTypes", "ArtworkRenderer", "ArtworkStore", "ArtworkMusic", "Core", "Catalog", "Storage", "Main"].map(name => join(root, "native/WebMusic", name + ".swift")), "-o", join(bin, "WebMusicBridge")]);
await Bun.write(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.wavelength.app</string>
<key>CFBundleName</key><string>Wavelength</string>
<key>CFBundleDisplayName</key><string>Wavelength</string>
<key>CFBundleExecutable</key><string>Wavelength</string>
<key>CFBundleIconFile</key><string>Wavelength.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>5</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSAppleEventsUsageDescription</key><string>Wavelength reads your Music library metadata and listening statistics when you request a history scan, and updates artwork for playlists it creates.</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>`);
await run(["/usr/bin/plutil", "-lint", join(contents, "Info.plist")]);
for (const [executable, identifier] of [[join(bin, "bun"), "local.wavelength.engine"], [join(bin, "WebMusicBridge"), "local.wavelength.web-music-bridge"], [join(contents, "MacOS/Wavelength"), "local.wavelength.app"]]) {
  await run(["/usr/bin/codesign", "--force", "--sign", signing.identity, "--identifier", identifier!, executable!]);
}
await run(["/usr/bin/codesign", "--force", "--sign", signing.identity, app]);
await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
if (release) {
  for (const path of [join(bin, "bun"), join(bin, "WebMusicBridge"), join(contents, "MacOS/Wavelength"), app]) await verifyAdHoc(path);
}
await run([process.execPath, join(root, "scripts/check-native.ts"), resources]);
console.log(`Built ${app}`);
