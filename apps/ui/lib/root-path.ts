import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function getRepoRoot(): string {
  const fromEnv = process.env["CITATION_FIDELITY_ROOT"];
  const root = fromEnv ? resolve(fromEnv) : resolve(process.cwd(), "..", "..");

  if (!existsSync(root)) {
    throw new Error(`Repository root not found: ${root}`);
  }

  return root;
}
