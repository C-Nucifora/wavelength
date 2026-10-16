import {readFile} from "node:fs/promises";
import {join} from "node:path";

export async function resolveSigningIdentity(root: string, environment: Record<string, string | undefined> = process.env): Promise<{identity: string; warning?: string}> {
  const override = environment.WAVELENGTH_SIGN_IDENTITY;
  if (override !== undefined) {
    const identity = override.trim();
    if (!identity || override.length > 512 || /[\u0000-\u001F\u007F-\u009F]/.test(override) || identity.startsWith("-") && identity !== "-") throw new Error("WAVELENGTH_SIGN_IDENTITY must be a certificate fingerprint, certificate name, or '-' for ad hoc signing.");
    return {identity};
  }
  const file = join(root, ".wavelength-signing-identity");
  let contents: string;
  try {contents = await readFile(file, "utf8");}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {identity: "-", warning: "Wavelength is using ad hoc signing because no signing identity is configured. Rebuilding may repeat macOS permission prompts. Set WAVELENGTH_SIGN_IDENTITY or .wavelength-signing-identity to use a stable identity."};
    throw new Error("Could not read .wavelength-signing-identity. Fix the local signing configuration before building.", {cause: error});
  }
  const identity = contents.trim();
  if (!/^[a-fA-F0-9]{40}$/.test(identity)) throw new Error(".wavelength-signing-identity must contain one 40-character hexadecimal certificate fingerprint.");
  return {identity};
}
