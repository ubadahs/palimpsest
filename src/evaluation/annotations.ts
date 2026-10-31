import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { buildStableId } from "../shared/stable-identity.js";
import {
  atomicJson,
  datasetDir,
  evaluationRoot,
  loadAnnotationLog,
  loadDataset,
} from "./storage.js";
import { loadExperiment, loadTrials } from "./runner.js";
import { loadOptimizationResults } from "./optimization-report.js";
import { validateJsSpan } from "./span.js";
import {
  annotationValueSchema,
  type AnnotationEvent,
  type BlindEvaluationCase,
  type EvaluationCase,
} from "./types.js";

export class EvaluationConflictError extends Error {}

function withAnnotationLock<T>(datasetId: string, action: () => T): T {
  const path = join(datasetDir(datasetId), "annotations.lock");
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx");
  } catch {
    throw new EvaluationConflictError(
      "Another annotation write is in progress; reload and retry",
    );
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    unlinkSync(path);
  }
}

export const appendAnnotationRequestSchema = z.object({
  caseId: z.string().min(1),
  reviewer: z.string().min(1),
  status: z.enum(["draft", "final"]),
  expectedHeadEventId: z.string().nullable(),
  supersedesEventId: z.string().optional(),
  notes: z.string(),
  value: annotationValueSchema,
  resolvesConflict: z.boolean().optional(),
});
export type AppendAnnotationRequest = z.infer<
  typeof appendAnnotationRequestSchema
>;

function requireCase(datasetId: string, caseId: string): EvaluationCase {
  const item = loadDataset(datasetId).cases.find(
    (entry) => entry.caseId === caseId,
  );
  if (!item) throw new Error(`Unknown evaluation case ${caseId}`);
  return item;
}

export function appendAnnotation(
  datasetId: string,
  requestInput: unknown,
): AnnotationEvent {
  const request = appendAnnotationRequestSchema.parse(requestInput);
  const item = requireCase(datasetId, request.caseId);
  if (item.task !== request.value.task)
    throw new Error("Annotation task mismatch");
  return withAnnotationLock(datasetId, () => {
    const log = loadAnnotationLog(datasetId);
    const latest = log.events
      .filter(
        (event): event is AnnotationEvent =>
          "value" in event &&
          event.caseId === item.caseId &&
          event.reviewer === request.reviewer,
      )
      .at(-1);
    if (
      (latest?.eventId ?? null) !== request.expectedHeadEventId ||
      (request.supersedesEventId != null &&
        request.supersedesEventId !== latest?.eventId)
    )
      throw new EvaluationConflictError(
        "Annotation head changed; reload before revising",
      );
    if (
      request.value.task === "rerank" &&
      item.task === "rerank" &&
      request.status === "final"
    ) {
      const expected = [...item.candidates, ...item.pinnedPassages]
        .map((candidate) => candidate.chunkId)
        .sort();
      const received = Object.keys(request.value.grades).sort();
      if (expected.join("\0") !== received.join("\0"))
        throw new Error(
          "Final relevance annotation must grade every candidate",
        );
    }
    if (request.value.task === "span" && item.task === "span") {
      if (
        request.status === "final" &&
        request.value.noValidSpan === request.value.spans.length > 0
      )
        throw new Error("Select spans or mark no valid span");
      if (
        request.value.spans.some((span) => !validateJsSpan(item.context, span))
      )
        throw new Error("Span does not exactly bound original context");
    }
    const exposed = log.events.some(
      (event) =>
        !("value" in event) &&
        event.caseId === item.caseId &&
        event.reviewer === request.reviewer,
    );
    const event: AnnotationEvent = {
      eventId: `ae_${randomBytes(16).toString("hex")}`,
      caseId: item.caseId,
      reviewer: request.reviewer,
      createdAt: new Date().toISOString(),
      status: request.status,
      expectedHeadEventId: request.expectedHeadEventId,
      ...(request.supersedesEventId
        ? { supersedesEventId: request.supersedesEventId }
        : {}),
      exposed,
      notes: request.notes,
      value: request.value,
      ...(request.resolvesConflict ? { resolvesConflict: true } : {}),
    };
    atomicJson(join(datasetDir(datasetId), "annotations.json"), {
      ...log,
      events: [...log.events, event],
    });
    return event;
  });
}

export function revealCase(
  datasetId: string,
  caseId: string,
  reviewer: string,
): {
  historical: unknown;
  predictions: unknown[];
  optimizationResults: ReturnType<typeof loadOptimizationResults>;
} {
  const item = requireCase(datasetId, caseId);
  if (!reviewer.trim()) throw new Error("Reviewer is required");
  withAnnotationLock(datasetId, () => {
    const log = loadAnnotationLog(datasetId);
    if (
      !log.events.some(
        (event) =>
          !("value" in event) &&
          event.caseId === caseId &&
          event.reviewer === reviewer,
      )
    ) {
      atomicJson(join(datasetDir(datasetId), "annotations.json"), {
        ...log,
        events: [
          ...log.events,
          {
            eventId: `re_${randomBytes(16).toString("hex")}`,
            caseId,
            reviewer,
            createdAt: new Date().toISOString(),
          },
        ],
      });
    }
  });
  // This endpoint is the sole machine-observation boundary for the annotation UI.
  const observationsPath = join(
    datasetDir(datasetId),
    "historical-observations.json",
  );
  const observations: unknown = existsSync(observationsPath)
    ? JSON.parse(readFileSync(observationsPath, "utf8"))
    : [];
  const key = item.task === "span" ? item.claimRecordId : item.recordId;
  const groups = z
    .array(
      z.object({
        runId: z.string(),
        role: z.array(z.record(z.string(), z.unknown())),
        rerank: z.array(z.record(z.string(), z.unknown())),
        spans: z.array(z.record(z.string(), z.unknown())),
        adjudication: z.array(z.record(z.string(), z.unknown())),
      }),
    )
    .parse(observations);
  const historical = groups
    .filter((entry) => entry.runId === item.runId)
    .flatMap((entry) => {
      const values = item.task === "span" ? entry.spans : entry[item.task];
      return values.filter(
        (value) => value.recordId === key || value.claimRecordId === key,
      );
    });
  const experimentsRoot = join(evaluationRoot(), "experiments");
  const predictions = existsSync(experimentsRoot)
    ? readdirSync(experimentsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
          const experiment = loadExperiment(entry.name);
          return experiment.datasetId === datasetId
            ? loadTrials(entry.name).filter((trial) => trial.caseId === caseId)
            : [];
        })
    : [];
  const optimizationResults = existsSync(experimentsRoot)
    ? readdirSync(experimentsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
          const experiment = loadExperiment(entry.name);
          return experiment.datasetId === datasetId
            ? loadOptimizationResults(entry.name).filter(
                (result) => result.caseId === caseId,
              )
            : [];
        })
    : [];
  return { historical, predictions, optimizationResults };
}

export function revealExperimentResults(
  datasetId: string,
  experimentId: string,
  reviewer: string,
): {
  trials: ReturnType<typeof loadTrials>;
  optimizationResults: ReturnType<typeof loadOptimizationResults>;
  report: unknown;
} {
  if (!reviewer.trim()) throw new Error("Reviewer is required");
  const experiment = loadExperiment(experimentId);
  if (experiment.datasetId !== datasetId)
    throw new Error("Experiment belongs to another dataset");
  const trials = loadTrials(experimentId);
  const optimizationResults = loadOptimizationResults(experimentId);
  withAnnotationLock(datasetId, () => {
    const log = loadAnnotationLog(datasetId);
    const exposed = new Set(
      log.events
        .filter((event) => !("value" in event) && event.reviewer === reviewer)
        .map((event) => event.caseId),
    );
    const revealEvents = [
      ...new Set([
        ...trials.map((trial) => trial.caseId),
        ...optimizationResults.map((result) => result.caseId),
      ]),
    ]
      .filter((caseId) => !exposed.has(caseId))
      .map((caseId) => ({
        eventId: `re_${randomBytes(16).toString("hex")}`,
        caseId,
        reviewer,
        createdAt: new Date().toISOString(),
      }));
    if (revealEvents.length)
      atomicJson(join(datasetDir(datasetId), "annotations.json"), {
        ...log,
        events: [...log.events, ...revealEvents],
      });
  });
  const reportsDir = join(
    evaluationRoot(),
    "experiments",
    experimentId,
    "reports",
  );
  const reports = existsSync(reportsDir)
    ? readdirSync(reportsDir).filter((name) => name.endsWith(".json"))
    : [];
  const latest = reports
    .sort(
      (left, right) =>
        statSync(join(reportsDir, left)).mtimeMs -
        statSync(join(reportsDir, right)).mtimeMs,
    )
    .at(-1);
  const report: unknown = latest
    ? JSON.parse(readFileSync(join(reportsDir, latest), "utf8"))
    : null;
  return { trials, optimizationResults, report };
}

export function blindCaseView(item: EvaluationCase): BlindEvaluationCase {
  const base = {
    caseId: item.caseId,
    runId: item.runId,
    seedDoi: item.seedDoi,
    recordId: item.recordId,
  };
  if (item.task === "role") {
    return {
      ...base,
      task: "role",
      context: item.context,
      claims: item.claims,
      ...(item.sectionTitle ? { sectionTitle: item.sectionTitle } : {}),
      ...(item.seedRefLabel ? { seedRefLabel: item.seedRefLabel } : {}),
    };
  }
  if (item.task === "rerank") {
    return {
      ...base,
      task: "rerank",
      query: item.query,
      candidates: [...item.candidates, ...item.pinnedPassages]
        .sort((a, b) =>
          buildStableId("display-order", {
            caseId: item.caseId,
            chunkId: a.chunkId,
          }).localeCompare(
            buildStableId("display-order", {
              caseId: item.caseId,
              chunkId: b.chunkId,
            }),
          ),
        )
        .map((candidate) => ({
          chunkId: candidate.chunkId,
          text: candidate.text,
        })),
    };
  }
  if (item.task === "adjudication") {
    return {
      ...base,
      task: "adjudication",
      packet: {
        markedCitingContext: item.packet.markedCitingContext,
        familyTrackedClaim: item.packet.familyTrackedClaim,
        citingPaperTitle: item.packet.citingPaperTitle,
        citedPaperTitle: item.packet.citedPaperTitle,
        occurrenceClaims: item.packet.occurrenceClaims.map((claim) => ({
          claimRecordId: claim.claimRecordId,
          claimText: claim.claimText,
        })),
        selectedChunks: item.packet.selectedChunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          text: chunk.text,
        })),
      },
    };
  }
  return { ...base, task: "span", claim: item.claim, context: item.context };
}

export function blindDatasetView(datasetId: string): {
  datasetId: string;
  name: string;
  cases: BlindEvaluationCase[];
  annotations: AnnotationEvent[];
} {
  const dataset = loadDataset(datasetId);
  return {
    datasetId,
    name: dataset.name,
    cases: dataset.cases.map(blindCaseView),
    annotations: loadAnnotationLog(datasetId).events.filter(
      (event): event is AnnotationEvent => "value" in event,
    ),
  };
}
