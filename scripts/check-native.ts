import {mkdir, mkdtemp, cp, symlink, chmod, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
await mkdir(".build", {recursive: true});
const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`;
const sources = ["APITypes", "PlaylistCover", "HistoryTypes", "HistoryFileReader", "APIClient", "EngineController", "MusicConnection", "AppModel"].map(name => `native/App/${name}.swift`);
sources.push(...["Types", "ArtworkTypes", "ArtworkRenderer", "ArtworkStore"].map(name => `native/WebMusic/${name}.swift`));
const fixture = await mkdtemp(join(tmpdir(), "wavelength-pending-fixture-"));
try {
  await mkdir(join(fixture, "bin"));
  await mkdir(join(fixture, "engine/src"), {recursive: true});
  await symlink(process.execPath, join(fixture, "bin/bun"));
  await cp("tests/fixtures/native-helper.sh", join(fixture, "bin/WebMusicBridge"));
  await chmod(join(fixture, "bin/WebMusicBridge"), 0o755);
  await cp("tests/fixtures/pending-engine.ts", join(fixture, "engine/src/index.ts"));
  for (const command of [
    ["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-warnings-as-errors", "-target", target, ...sources, "native/Tests/DiscographyChecks.swift", "native/Tests/PendingChecks.swift", "native/Tests/HistoryChecks.swift", "native/Tests/ConnectionChecks.swift", "native/Tests/NativeChecks.swift", "-o", ".build/NativeChecks"],
    [".build/NativeChecks", ...process.argv.slice(2)],
  ]) {
    const child = Bun.spawn(command, {stdout: "inherit", stderr: "inherit", env: {...process.env, WAVELENGTH_PENDING_FIXTURE: fixture}});
    if (await child.exited !== 0) throw new Error(`Native checks failed (${child.exitCode}, ${child.signalCode})`);
  }
} finally { await rm(fixture, {recursive: true, force: true}); }
