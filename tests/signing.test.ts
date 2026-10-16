import {expect, test} from "bun:test";
import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {resolveSigningIdentity as resolveIdentity} from "../scripts/signing";

const fingerprint = "1234567890ABCDEF1234567890ABCDEF12345678";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "wavelength-signing-"));
  try {await run(root);} finally {await rm(root, {recursive: true, force: true});}
}

test("missing local signing config uses ad hoc signing with an explicit permission warning", async () => {
  await fixture(async root => {
    const result = await resolveIdentity(root, {});
    expect(result.identity).toBe("-");
    expect(result.warning).toContain("ad hoc");
    expect(result.warning).toContain("permission");
  });
});

test("local signing fingerprint is used without a fallback warning", async () => {
  await fixture(async root => {
    await Bun.write(join(root, ".wavelength-signing-identity"), fingerprint + "\n");
    expect(await resolveIdentity(root, {})).toEqual({identity: fingerprint});
  });
});

test("explicit signing environment overrides local config without reading a malformed file", async () => {
  await fixture(async root => {
    await mkdir(join(root, ".wavelength-signing-identity"));
    for (const identity of [fingerprint, "Apple Development: Fixture Person (TEAM123)", "-"]) expect(await resolveIdentity(root, {WAVELENGTH_SIGN_IDENTITY: identity})).toEqual({identity});
  });
});

test("invalid explicit identities fail instead of silently falling back", async () => {
  await fixture(async root => {
    await Bun.write(join(root, ".wavelength-signing-identity"), fingerprint + "\n");
    for (const identity of ["", "   ", "--help", "Fixture\nIdentity", "Fixture\tIdentity", "Fixture\u007fIdentity", "x".repeat(513)]) await expect(resolveIdentity(root, {WAVELENGTH_SIGN_IDENTITY: identity})).rejects.toThrow("WAVELENGTH_SIGN_IDENTITY");
  });
});

test("malformed or unreadable local signing files fail instead of changing signing identity", async () => {
  await fixture(async root => {
    const file = join(root, ".wavelength-signing-identity");
    for (const value of ["", "-", "Apple Development: Fixture", "a".repeat(39), "g".repeat(40), fingerprint + "\nother"]) {
      await Bun.write(file, value);
      await expect(resolveIdentity(root, {})).rejects.toThrow(".wavelength-signing-identity");
    }
    await rm(file);
    await mkdir(file);
    await expect(resolveIdentity(root, {})).rejects.toThrow(".wavelength-signing-identity");
  });
});
