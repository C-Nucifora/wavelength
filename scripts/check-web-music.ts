import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const fixture = await mkdtemp(join(tmpdir(), "wavelength-web-music-checks-"));
const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`;
const sources = ["Types", "ArtworkTypes", "ArtworkRenderer", "ArtworkStore", "ArtworkMusic", "Core", "Catalog", "Storage"].map(name => `native/WebMusic/${name}.swift`);
try {
  await mkdir(".build", {recursive: true});
  for (const command of [
    ["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-warnings-as-errors", "-target", target, ...sources, "native/Tests/WebMusicChecks.swift", "-o", join(fixture, "WebMusicChecks")],
    [join(fixture, "WebMusicChecks")],
    ["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-warnings-as-errors", "-target", target, ...sources, "native/WebMusic/Main.swift", "-o", join(fixture, "WebMusicBridge")],
    ["/usr/bin/codesign", "--force", "--sign", "-", join(fixture, "WebMusicBridge")],
    ["/usr/bin/codesign", "--verify", "--strict", join(fixture, "WebMusicBridge")],
  ]) {
    const child = Bun.spawn(command, {stdout: "inherit", stderr: "inherit"});
    if (await child.exited !== 0) throw new Error(`Web music checks failed (${child.exitCode})`);
  }
  for (const [payload, args] of [
    ['{"action":"not-an-operation","credentials":{"bearer":"fixture-secret","user":"fixture-user"}}', []],
    ['{"action":"status"}', ["fixture-secret"]],
    ['{"action":"status","unknown":"fixture-secret"}', []],
    ['{"action":"status","jobId":null}', []],
    ['{"action":"status","coverMode":null}', []],
    ['{"action":"playlistCover","position":null}', []],
    ['{"action":"playlistCover","reconcileOnly":null}', []],
    ['{"action":"saveConnection","credentials":{"bearer":"fixture-secret","user":"fixture-user","unknown":true}}', []],
    ["fixture-secret".repeat(11_000), []],
    ['{"action":"saveConnection","credentials":', []],
  ] as [string, string[]][]) {
    const child = Bun.spawn([join(fixture, "WebMusicBridge"), ...args], {stdin: "pipe", stdout: "pipe", stderr: "pipe"});
    child.stdin.write(payload); child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const result = JSON.parse(stdout);
    if (code !== 0 || stderr !== "" || stdout.length > 128 * 1024 || stdout.includes("fixture-secret") || result.ok !== false || result.error.code !== "invalid-input" || result.error.uncertain !== false) {
      throw new Error("CLI rejected-input envelope checks failed");
    }
  }
  console.log("Web music CLI checks passed: signed build, bounded stdin, safe envelopes, no Keychain or account requests");
} finally { await rm(fixture, {recursive: true, force: true}); }
