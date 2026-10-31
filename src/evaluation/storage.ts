import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { z } from "zod";
import {
  datasetSchema,
  annotationLogSchema,
  type EvaluationDataset,
  type AnnotationLog,
} from "./types.js";

export function evaluationRoot(): string {
  return resolve(
    process.env.PALIMPSEST_ROOT ?? process.cwd(),
    "data",
    "evaluations",
  );
}

export function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id))
    throw new Error(`Invalid evaluation identifier: ${id}`);
  return id;
}

export function datasetDir(id: string): string {
  return join(evaluationRoot(), "datasets", safeId(id));
}
export function experimentDir(id: string): string {
  return join(evaluationRoot(), "experiments", safeId(id));
}

export function atomicJson(path: string, value: unknown): void {
  atomicText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function atomicText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, value, "utf8");
  renameSync(temp, path);
}

export function readJson<T extends z.ZodType>(
  path: string,
  schema: T,
): z.infer<T> {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return schema.parse(raw) as z.infer<T>;
}

export function loadDataset(id: string): EvaluationDataset {
  return readJson(join(datasetDir(id), "dataset.json"), datasetSchema);
}

export function loadAnnotationLog(id: string): AnnotationLog {
  const path = join(datasetDir(id), "annotations.json");
  return existsSync(path)
    ? readJson(path, annotationLogSchema)
    : { schemaVersion: "evaluation-annotations-v1", datasetId: id, events: [] };
}

export function listDatasets(): EvaluationDataset[] {
  const root = join(evaluationRoot(), "datasets");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadDataset(entry.name));
}
