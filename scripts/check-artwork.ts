import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const fixture = await mkdtemp(join(tmpdir(), "wavelength-artwork-checks-"));
const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`;
try {
  const sources = ["Types", "ArtworkTypes", "ArtworkRenderer", "ArtworkStore", "ArtworkMusic"].map(name => `native/WebMusic/${name}.swift`);
  for (const command of [
    ["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-warnings-as-errors", "-target", target, ...sources, "native/Tests/ArtworkChecks.swift", "-o", join(fixture, "ArtworkChecks")],
    [join(fixture, "ArtworkChecks"), ...process.argv.slice(2)],
  ]) {
    const child = Bun.spawn(command, {stdout: "inherit", stderr: "inherit"});
    if (await child.exited !== 0) throw new Error(`Artwork checks failed (${child.exitCode})`);
  }
} finally { await rm(fixture, {recursive: true, force: true}); }
