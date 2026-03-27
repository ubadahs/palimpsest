import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { execSync } from "node:child_process";

import { z } from "zod";

export const artifactSourceSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().length(64).optional(),
  })
  .passthrough();
export type ArtifactSource = z.infer<typeof artifactSourceSchema>;

export const artifactManifestSchema = z
  .object({
    artifactType: z.string().min(1),
    artifactVersion: z.number().int().positive(),
    generatedAt: z.string().min(1),
    generator: z.string().min(1),
    sourceArtifacts: z.array(artifactSourceSchema),
    gitCommit: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    relatedArtifacts: z.array(z.string()).optional(),
  })
  .passthrough();
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

export type ManifestWriteOptions = {
  artifactType: string;
  artifactVersion?: number;
  generator: string;
  sourceArtifacts?: string[];
  model?: string;
  relatedArtifacts?: string[];
  cwd?: string;
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readSourceArtifact(path: string): ArtifactSource {
  try {
    const content = readFileSync(path, "utf8");
    return {
      path,
      sha256: sha256(content),
    };
  } catch {
    return {
      path,
      sha256: undefined,
    };
  }
}

function getGitCommit(cwd: string): string | undefined {
  try {
    const output = execSync("git rev-parse HEAD", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString("utf8")
      .trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

export function loadJsonArtifact<T>(
  artifactPath: string,
  schema: z.ZodType<T>,
  artifactLabel: string,
): T {
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

export function writeArtifactManifest(
  artifactPath: string,
  options: ManifestWriteOptions,
): string {
  const cwd = resolve(options.cwd ?? process.cwd());
  const manifest: ArtifactManifest = {
    artifactType: options.artifactType,
    artifactVersion: options.artifactVersion ?? 1,
    generatedAt: new Date().toISOString(),
    generator: options.generator,
    sourceArtifacts: (options.sourceArtifacts ?? []).map(readSourceArtifact),
    gitCommit: getGitCommit(cwd),
    model: options.model,
    relatedArtifacts:
      options.relatedArtifacts && options.relatedArtifacts.length > 0
        ? options.relatedArtifacts.map((item) => resolve(cwd, item))
        : undefined,
  };

  const manifestPath = manifestPathForArtifact(artifactPath);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifestPath;
}

export function outputSummaryLabel(artifactPath: string): string {
  return basename(artifactPath);
}
