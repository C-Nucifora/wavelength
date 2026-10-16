import {mkdir} from "node:fs/promises";
import {resolve, dirname} from "node:path";
import {fileURLToPath} from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(root, "../../.build/web-session-probe-checks");
await mkdir(dirname(output), {recursive: true});
const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`;
for (const command of [
  ["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-warnings-as-errors", "-target", target, `${root}/ProbeCore.swift`, `${root}/ProbeModel.swift`, `${root}/ProbeChecks.swift`, "-o", output],
  [output],
]) {
  const child = Bun.spawn(command, {stdout: "inherit", stderr: "inherit"});
  if (await child.exited !== 0) throw new Error("Probe checks failed");
}
