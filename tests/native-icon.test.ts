import {test, expect} from "bun:test";
import {mkdtemp, mkdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";

const root = resolve(import.meta.dir, "..");
async function readIcon(contents: string) {
  const plist = Bun.spawn(["/usr/bin/plutil", "-convert", "json", "-o", "-", join(contents, "Info.plist")], {stdout: "pipe", stderr: "pipe"});
  const metadata = JSON.parse(await new Response(plist.stdout).text());
  if (await plist.exited !== 0) throw new Error("Invalid app metadata");
  if (metadata.CFBundleIconFile !== "Wavelength.icns") throw new Error("App icon is not declared");
  const icon = Bun.file(join(contents, "Resources", metadata.CFBundleIconFile));
  if (!await icon.exists()) throw new Error("Declared app icon is missing");
  const bytes = Buffer.from(await icon.arrayBuffer());
  if (bytes.length < 8 || bytes.toString("ascii", 0, 4) !== "icns" || bytes.readUInt32BE(4) !== bytes.length) throw new Error("Invalid app icon");
  return {metadata, bytes};
}

test.skipIf(process.platform !== "darwin")("icon packaging rejects an undeclared or missing icon", async () => {
  const contents = await mkdtemp(join(tmpdir(), "wavelength-icon-"));
  try {
    await mkdir(join(contents, "Resources"));
    await Bun.write(join(contents, "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>');
    await expect(readIcon(contents)).rejects.toThrow("App icon is not declared");
    await Bun.write(join(contents, "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIconFile</key><string>Wavelength.icns</string></dict></plist>');
    await expect(readIcon(contents)).rejects.toThrow("Declared app icon is missing");
    await Bun.write(join(contents, "Resources/Wavelength.icns"), Buffer.from("icns0000"));
    await expect(readIcon(contents)).rejects.toThrow("Invalid app icon");
  } finally {await rm(contents, {recursive: true, force: true});}
});

test.skipIf(process.platform !== "darwin" || !process.env.WAVELENGTH_PACKAGING_APP)("signed app bundles the declared approved icon", async () => {
  const app = process.env.WAVELENGTH_PACKAGING_APP!;
  const {metadata, bytes} = await readIcon(join(app, "Contents"));
  expect(bytes).toEqual(Buffer.from(await Bun.file(join(root, "native/Assets/Wavelength.icns")).arrayBuffer()));
  expect(metadata.CFBundleShortVersionString).toBe("0.1.0");
  expect(metadata.CFBundleVersion).toBe("5");
  expect(metadata.NSAppleEventsUsageDescription).toBe("Wavelength reads your Music library metadata and listening statistics when you request a history scan, and updates artwork for playlists it creates.");
  expect(metadata.CFBundleIdentifier).toBe("local.wavelength.app");
  expect(metadata.LSMinimumSystemVersion).toBe("14.0");
  const signature = Bun.spawn(["/usr/bin/codesign", "--verify", "--deep", "--strict", app], {stdout: "pipe", stderr: "pipe"});
  expect(await signature.exited).toBe(0);
});
