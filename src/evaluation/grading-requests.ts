/** Stores and lists the grading requests of a dataset. */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildStableId } from "../shared/stable-identity.js";
import {
  atomicJson,
  datasetDir,
  loadAnnotationLog,
  loadDataset,
  readJson,
} from "./storage.js";
import { gradingRequestSchema, type GradingRequest } from "./types.js";

function requestsDir(datasetId: string): string {
  return join(datasetDir(datasetId), "requests");
}

/**
 * Saves a request for labels on `caseIds`, in that order. Asking again for
 * the same cases under the same title returns the request already saved.
 */
export function createGradingRequest(
  datasetId: string,
  input: { title: string; purpose: string; caseIds: readonly string[] },
): GradingRequest {
  const taskByCase = new Map(
    loadDataset(datasetId).cases.map((item) => [item.caseId, item.task]),
  );
  const unknown = input.caseIds.filter((caseId) => !taskByCase.has(caseId));
  if (unknown.length)
    throw new Error(`Not cases of this dataset: ${unknown.join(", ")}`);
  if (new Set(input.caseIds).size !== input.caseIds.length)
    throw new Error("A request lists each case once");
  if (new Set(input.caseIds.map((caseId) => taskByCase.get(caseId))).size > 1)
    throw new Error("A request asks one kind of question: cases of one task");
  const requestId = buildStableId("grading-request", {
    datasetId,
    title: input.title,
    caseIds: input.caseIds,
  });
  const path = join(requestsDir(datasetId), `${requestId}.json`);
  if (existsSync(path)) return readJson(path, gradingRequestSchema);
  const request = gradingRequestSchema.parse({
    schemaVersion: "evaluation-grading-request-v1",
    requestId,
    datasetId,
    title: input.title,
    purpose: input.purpose,
    caseIds: input.caseIds,
    createdAt: new Date().toISOString(),
  });
  atomicJson(path, request);
  return request;
}

/** A dataset's requests, oldest first. */
export function listGradingRequests(datasetId: string): GradingRequest[] {
  const dir = requestsDir(datasetId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(join(dir, name), gradingRequestSchema))
    .sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1));
}

/** The requests still waiting: those with a case nobody has finally answered. */
export function openGradingRequests(datasetId: string): GradingRequest[] {
  const answered = new Set(
    loadAnnotationLog(datasetId).events.flatMap((event) =>
      "value" in event && event.status === "final" ? [event.caseId] : [],
    ),
  );
  return listGradingRequests(datasetId).filter((request) =>
    request.caseIds.some((caseId) => !answered.has(caseId)),
  );
}
