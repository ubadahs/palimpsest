import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

import type { z } from "zod";

export function loadJsonArtifact<T>(
  artifactPath: string,
  schema: z.ZodType<T>,
  artifactLabel: string,
): T {
  if (!existsSync(artifactPath)) {
    throw new Error(
      `${artifactLabel} file not found: ${artifactPath}. If resuming a run, the artifact may have been deleted.`,
    );
  }
  const stat = statSync(artifactPath);
  if (stat.size === 0) {
    throw new Error(
      `${artifactLabel} file is empty (0 bytes): ${artifactPath}`,
    );
  }

  const raw = readFileSync(artifactPath, "utf8");
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid ${artifactLabel} JSON at ${artifactPath}: ${message}`,
      { cause: error },
    );
  }

  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.join(".") || "<root>";
    const message = issue?.message ?? parsed.error.message;
    throw new Error(
      `Invalid ${artifactLabel} artifact at ${artifactPath}: ${path} ${message}`,
    );
  }

  return parsed.data;
}

export function writeJsonArtifact(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

export function manifestPathForArtifact(artifactPath: string): string {
  return artifactPath.replace(/\.json$/i, "_manifest.json");
}
