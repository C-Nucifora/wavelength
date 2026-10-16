import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "wavelength-auth-check-"));
for (const command of [
  ["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-warnings-as-errors", join(root, "../ProbeCore.swift"), ...["WrapperPolicy", "WrapperModel", "WrapperChecks"].map(n => join(root, n + ".swift")), "-o", join(scratch, "checks")],
  [join(scratch, "checks")],
  ["bun", join(root, "CaptureChecks.ts")],
]) {
  const child = Bun.spawn(command, {stdout: "inherit", stderr: "inherit"});
  if (await child.exited !== 0) throw new Error("Auth wrapper checks failed");
}
