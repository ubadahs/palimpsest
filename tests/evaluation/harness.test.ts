import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendAnnotation,
  blindCaseView,
  revealCase,
  revealExperimentResults,
  EvaluationConflictError,
} from "../../src/evaluation/annotations.js";
import { validateEvaluationDataset } from "../../src/evaluation/dataset.js";
import { generateEvaluationReport } from "../../src/evaluation/report.js";
import {
  historicalAttemptAccounting,
  uniqueHistoricalCalls,
} from "../../src/evaluation/optimization-report.js";
import {
  createExperiment,
  loadTrials,
  runExperiment,
  trialSchema,
} from "../../src/evaluation/runner.js";
import {
  pythonSpanToJs,
  resolveExactQuote,
  validateJsSpan,
} from "../../src/evaluation/span.js";
import {
  atomicJson,
  datasetDir,
  experimentDir,
  loadDataset,
} from "../../src/evaluation/storage.js";
import {
  datasetSchema,
  type EvaluationCase,
} from "../../src/evaluation/types.js";
import {
  buildStableId,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";

function identified<T extends Omit<EvaluationCase, "caseId">>(
  input: T,
): T & { caseId: string } {
  return {
    ...input,
    caseId: buildStableId("eval-case", {
      builderVersion: "evaluation-build-v1",
      input,
    }),
  };
}

function writeImports(datasetId: string, reviews: unknown): void {
  atomicJson(join(datasetDir(datasetId), "historical-observations.json"), []);
  atomicJson(join(datasetDir(datasetId), "imported-reviews.json"), reviews);
  atomicJson(join(datasetDir(datasetId), "imports.json"), {
    observationsHash: canonicalSha256([]),
    reviewsHash: canonicalSha256(reviews),
  });
}

describe.sequential("evaluation harness", () => {
  let root: string;
  let datasetId: string;
  let roleId: string;
  let rerankId: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "palimpsest-evaluation-"));
    vi.stubEnv("PALIMPSEST_ROOT", root);
    const sourceArtifactHashes = { report: canonicalSha256("review-fixture") };
    const role = identified({
      task: "role",
      runId: "run-one",
      seedDoi: "10.1/seed",
      recordId: "record-role",
      sourceArtifactHashes,
      occurrenceId: "mention-one",
      context: "Pell et al. found dorsal contact.",
      claims: ["Retinal input was found"],
      deterministicRole: "substantive_attribution",
      deterministicUnclear: false,
      anthropicPrompt: "Production role prompt",
    });
    const rerank = identified({
      task: "rerank",
      runId: "run-one",
      seedDoi: "10.1/seed",
      recordId: "record-rerank",
      sourceArtifactHashes,
      query: "dorsal contact",
      candidates: [
        {
          chunkId: "a",
          text: "Background only",
          sourceBlockKind: "body_paragraph",
        },
        {
          chunkId: "b",
          text: "No dorsal contact was detected",
          sourceBlockKind: "body_paragraph",
        },
      ],
      pinnedPassages: [
        { chunkId: "pin", text: "Retinal input appears in the results" },
      ],
      bm25Order: ["a", "b"],
      pinnedChunkIds: ["pin"],
      selectionLimit: 2,
    });
    roleId = role.caseId;
    rerankId = rerank.caseId;
    const cases = [role, rerank].sort((a, b) =>
      a.caseId.localeCompare(b.caseId),
    );
    const sources = [
      {
        runId: "run-one",
        reportArtifactId: "artifact-one",
        reportContentHash: "report-hash",
      },
    ];
    datasetId = buildStableId("dataset", {
      builderVersion: "evaluation-build-v1",
      sources,
      cases,
    });
    atomicJson(
      join(datasetDir(datasetId), "dataset.json"),
      datasetSchema.parse({
        schemaVersion: "evaluation-dataset-v1",
        builderVersion: "evaluation-build-v1",
        datasetId,
        name: "fixture",
        sources,
        cases,
      }),
    );
    writeImports(datasetId, []);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("verifies content identity and removes machine roles and ranks from blind views", () => {
    expect(validateEvaluationDataset(datasetId).caseCounts).toEqual({
      role: 1,
      rerank: 1,
    });
    const data = datasetSchema.parse(
      JSON.parse(
        readFileSync(join(datasetDir(datasetId), "dataset.json"), "utf8"),
      ) as unknown,
    );
    const role = data.cases.find((item) => item.task === "role")!;
    const rerank = data.cases.find((item) => item.task === "rerank")!;
    expect(blindCaseView(role)).not.toHaveProperty("deterministicRole");
    expect(blindCaseView(role)).not.toHaveProperty("anthropicPrompt");
    expect(blindCaseView(rerank)).not.toHaveProperty("bm25Order");
    const blindRerank = blindCaseView(rerank);
    expect(blindRerank.task).toBe("rerank");
    if (blindRerank.task !== "rerank") throw new Error("Expected rerank case");
    expect(blindRerank.candidates).toHaveLength(3);
    atomicJson(join(datasetDir(datasetId), "dataset.json"), {
      ...data,
      name: "fixture",
      cases: data.cases.map((item) =>
        item.task === "role" ? { ...item, context: "Tampered" } : item,
      ),
    });
    expect(() => validateEvaluationDataset(datasetId)).toThrow(
      /Dataset content or identity changed/,
    );
  });

  it("records blind revisions, reveal exposure, and expected-head conflicts", () => {
    const base = {
      caseId: roleId,
      reviewer: "reviewer",
      status: "final",
      notes: "",
      value: { task: "role", role: "substantive_attribution" },
    };
    const first = appendAnnotation(datasetId, {
      ...base,
      expectedHeadEventId: null,
    });
    expect(first.exposed).toBe(false);
    expect(() =>
      appendAnnotation(datasetId, { ...base, expectedHeadEventId: null }),
    ).toThrow(EvaluationConflictError);
    revealCase(datasetId, roleId, "reviewer");
    const revised = appendAnnotation(datasetId, {
      ...base,
      expectedHeadEventId: first.eventId,
      supersedesEventId: first.eventId,
    });
    expect(revised.exposed).toBe(true);
    expect(revised.supersedesEventId).toBe(first.eventId);
    const log = JSON.parse(
      readFileSync(join(datasetDir(datasetId), "annotations.json"), "utf8"),
    ) as { events: unknown[] };
    expect(log.events).toHaveLength(3);
  });

  it("records exposure before returning saved variant answers", () => {
    const experiment = createExperiment(datasetId, {
      schemaVersion: "evaluation-experiment-config-v1",
      tasks: ["role"],
      providers: [{ id: "rules", kind: "rules", model: "role-regex-v1" }],
    });
    atomicJson(
      join(
        experimentDir(experiment.experimentId),
        "results",
        "request-one.json",
      ),
      {
        requestId: "request-one",
        requestHash: "input-one",
        variantId: "role-v2",
        caseId: roleId,
        attemptId: "attempt-one",
        role: "substantive_attribution",
      },
    );
    const revealed = revealExperimentResults(
      datasetId,
      experiment.experimentId,
      "reviewer",
    );
    expect(revealed.optimizationResults).toHaveLength(1);
    const log = JSON.parse(
      readFileSync(join(datasetDir(datasetId), "annotations.json"), "utf8"),
    ) as { events: { caseId: string; reviewer: string }[] };
    expect(
      log.events.some(
        (event) => event.caseId === roleId && event.reviewer === "reviewer",
      ),
    ).toBe(true);
    const annotation = appendAnnotation(datasetId, {
      caseId: roleId,
      reviewer: "reviewer",
      status: "final",
      expectedHeadEventId: null,
      notes: "",
      value: { task: "role", role: "substantive_attribution" },
    });
    expect(annotation.exposed).toBe(true);
  });

  it("counts original historical attempts once across reused copies", () => {
    const original = trialSchema.parse({
      trialId: "source-trial",
      experimentId: "source-experiment",
      caseId: roleId,
      task: "role",
      providerId: "jev",
      requestedModel: "jev",
      repetition: 1,
      caseHash: "case",
      providerHash: "provider",
      status: "success",
      prediction: { role: "unclear" },
      calls: [{ latencyMs: 100 }, { latencyMs: 110 }],
    });
    atomicJson(
      join(experimentDir("source-experiment"), "trials", "source-trial.json"),
      original,
    );
    const copy = {
      ...original,
      trialId: "reused-trial",
      experimentId: "destination-experiment",
      reusedFrom: {
        experimentId: "source-experiment",
        trialId: "source-trial",
      },
    };
    const accounting = historicalAttemptAccounting([original, copy]);
    expect(accounting.uniqueAttempts).toBe(2);
    expect(accounting.provenance).toHaveLength(1);
    expect(uniqueHistoricalCalls([original, copy])).toHaveLength(2);
  });

  it("joins a revised role case to an explicit historical baseline without claiming equal input", () => {
    const source = createExperiment(datasetId, {
      schemaVersion: "evaluation-experiment-config-v1",
      tasks: ["role"],
      providers: [
        {
          id: "haiku",
          kind: "anthropic",
          model: "claude-haiku-5-5",
          pricePerMillionInputTokensUsd: 1,
          pricePerMillionOutputTokensUsd: 5,
        },
      ],
    });
    const sourceTrial = loadTrials(source.experimentId).find(
      (item) => item.caseId === roleId,
    )!;
    atomicJson(
      join(
        experimentDir(source.experimentId),
        "trials",
        `${sourceTrial.trialId}.json`,
      ),
      {
        ...sourceTrial,
        status: "success",
        prediction: { role: "background_context" },
        calls: [{ inputTokens: 100, outputTokens: 10, latencyMs: 200 }],
        completedAt: new Date().toISOString(),
      },
    );
    atomicJson(
      join(experimentDir(source.experimentId), "trials", "failed-source.json"),
      {
        ...sourceTrial,
        trialId: "failed-source",
        status: "provider_failure",
        calls: [{ latencyMs: 300, httpStatus: 503 }],
      },
    );
    const original = loadDataset(datasetId);
    const priorRole = original.cases.find((item) => item.task === "role")!;
    const { caseId: _caseId, ...priorInput } = priorRole;
    void _caseId;
    const revisedInput = {
      ...priorInput,
      deterministicRole: "unclear" as const,
      deterministicUnclear: true,
      roleInput: {
        markedContext: `▶ ${priorRole.context} ◀`,
        citationMarker: "Pell et al.",
        supportSpans: ["dorsal contact"],
        sectionTitle: null,
        seedRefLabel: null,
        isBundledCitation: false,
        bundleSize: 1,
      },
    };
    const revisedRole = {
      ...revisedInput,
      caseId: buildStableId("eval-case", {
        builderVersion: "evaluation-build-v2",
        input: revisedInput,
      }),
    };
    const revisedCases = [revisedRole];
    const revisedId = buildStableId("dataset", {
      builderVersion: "evaluation-build-v2",
      sources: original.sources,
      cases: revisedCases,
    });
    atomicJson(join(datasetDir(revisedId), "dataset.json"), {
      schemaVersion: "evaluation-dataset-v2",
      builderVersion: "evaluation-build-v2",
      datasetId: revisedId,
      name: "revised",
      sources: original.sources,
      cases: revisedCases,
    });
    writeImports(revisedId, []);
    const experiment = createExperiment(revisedId, {
      schemaVersion: "evaluation-experiment-config-v1",
      tasks: ["role"],
      providers: [
        {
          id: "jev",
          kind: "jev",
          model: "test-jev",
          endpoint: "https://example.test/v1/systemone",
        },
      ],
      optimization: {
        variants: [
          { id: "role-v2", task: "role", layout: "role-v2", phase: "fallback" },
        ],
        baselineReferences: [
          { experimentId: source.experimentId, providerId: "haiku" },
        ],
        maxAttempts: 2,
        maxActiveSeconds: 30,
        requestTimeoutMs: 30_000,
        concurrency: 1,
        minimumRequestIntervalMs: 0,
      },
    });
    const trial = loadTrials(experiment.experimentId)[0]!;
    atomicJson(
      join(
        experimentDir(experiment.experimentId),
        "trials",
        `${trial.trialId}.json`,
      ),
      {
        ...trial,
        status: "success",
        prediction: { role: "substantive_attribution" },
        completedAt: new Date().toISOString(),
        durationMs: 100,
      },
    );
    const report = generateEvaluationReport(experiment.experimentId);
    const analysis = report.report.optimization as {
      cost: {
        historicalUniqueAttempts: number;
        unknownHistoricalChargeAttempts: number;
      };
      baselines: {
        selectedReferenceAttempts: number;
        selectedReferenceUnknownChargeAttempts: number;
      }[];
      comparisons: {
        caseId: string;
        historicalCaseId: string;
        comparisonType: string;
        scientificInputCompatible: boolean;
      }[];
    };
    expect(analysis.cost.historicalUniqueAttempts).toBe(2);
    expect(analysis.cost.unknownHistoricalChargeAttempts).toBe(1);
    expect(analysis.baselines[0]).toMatchObject({
      selectedReferenceAttempts: 2,
      selectedReferenceUnknownChargeAttempts: 1,
    });
    expect(analysis.comparisons).toContainEqual(
      expect.objectContaining({
        caseId: revisedRole.caseId,
        historicalCaseId: roleId,
        comparisonType: "historical_baseline",
        scientificInputCompatible: false,
      }),
    );
  });

  it("checks Python code points, repeated quotations, whitespace, and no-span boundaries", () => {
    const context = "α😀 claim\nclaim";
    expect(pythonSpanToJs(context, 3, 8)).toEqual({
      start: 4,
      end: 9,
      text: "claim",
    });
    expect(pythonSpanToJs(context, 9, 14)).toEqual({
      start: 10,
      end: 15,
      text: "claim",
    });
    expect(validateJsSpan(context, { start: 4, end: 9, text: "claim" })).toBe(
      true,
    );
    expect(validateJsSpan(context, { start: 3, end: 8, text: "claim" })).toBe(
      false,
    );
    expect(() => pythonSpanToJs(context, 0, 99)).toThrow();
    expect(() => pythonSpanToJs(context, 3, 3)).toThrow();
    expect(() => resolveExactQuote(context, "claim")).toThrow(/ambiguous/);
    expect(resolveExactQuote(context, "claim", "😀 ", "\n")).toEqual({
      start: 4,
      end: 9,
      text: "claim",
    });
    expect(resolveExactQuote(context, " claim")).toEqual({
      start: 3,
      end: 9,
      text: " claim",
    });
  });

  it("resumes completed trials without duplicate calls and reports labeled pin effects", async () => {
    appendAnnotation(datasetId, {
      caseId: rerankId,
      reviewer: "reviewer",
      status: "final",
      expectedHeadEventId: null,
      notes: "",
      value: {
        task: "rerank",
        grades: { a: "irrelevant", b: "direct", pin: "direct" },
      },
    });
    const experiment = createExperiment(datasetId, {
      schemaVersion: "evaluation-experiment-config-v1",
      tasks: ["rerank"],
      providers: [
        {
          id: "bm25",
          kind: "bm25",
          model: "bm25-v1",
          tasks: ["rerank"],
          concurrency: 1,
          minimumRequestIntervalMs: 100,
        },
      ],
    });
    expect((await runExperiment(experiment.experimentId)).completed).toBe(1);
    const first = loadTrials(experiment.experimentId)[0]!;
    expect(first.status).toBe("success");
    expect((await runExperiment(experiment.experimentId)).completed).toBe(1);
    expect(loadTrials(experiment.experimentId)[0]!.completedAt).toBe(
      first.completedAt,
    );
    const expanded = createExperiment(datasetId, {
      schemaVersion: "evaluation-experiment-config-v1",
      tasks: ["rerank", "role"],
      providers: [
        {
          id: "bm25",
          kind: "bm25",
          model: "bm25-v1",
          tasks: ["rerank"],
        },
        {
          id: "rules",
          kind: "rules",
          model: "role-regex-v1",
          tasks: ["role"],
        },
      ],
    });
    const reused = loadTrials(expanded.experimentId).find(
      (trial) => trial.providerId === "bm25",
    )!;
    expect(reused.status).toBe("success");
    expect(reused.reusedFrom).toEqual({
      experimentId: experiment.experimentId,
      trialId: first.trialId,
    });
    expect(reused.completedAt).toBe(first.completedAt);
    expect((await runExperiment(expanded.experimentId)).completed).toBe(2);
    const changed = createExperiment(datasetId, {
      schemaVersion: "evaluation-experiment-config-v1",
      tasks: ["rerank"],
      providers: [
        {
          id: "bm25",
          kind: "bm25",
          model: "different-bm25-revision",
          tasks: ["rerank"],
        },
      ],
    });
    expect(loadTrials(changed.experimentId)[0]!.status).toBe("pending");
    const report = generateEvaluationReport(experiment.experimentId);
    const group = (
      report.report.groups as { metrics: Record<string, number> }[]
    )[0]!;
    expect(group.metrics.pinnedRecall5).toBe(1);
    expect(group.metrics.recall5).toBe(0.5);
    expect(readFileSync(report.markdownPath, "utf8")).toMatch(
      /^# Evaluation comparison:/,
    );
  });

  it("imports blinded final reviews and counts duplicate records as one claim unit", () => {
    const sourceArtifactHashes = { report: "report-hash" };
    const packet = {
      citationRole: "substantive_attribution",
      evaluationMode: "fidelity_specific_claim",
      markedCitingContext: "▶A finding◀",
      familyTrackedClaim: "A finding",
      citingPaperTitle: "Citer",
      citedPaperTitle: "Source",
      occurrenceClaims: [
        { claimRecordId: "claim-one", claimText: "A finding" },
      ],
      selectedChunks: [{ chunkId: "chunk-one", text: "A finding" }],
    };
    const first = identified({
      task: "adjudication",
      runId: "run-two",
      seedDoi: "10.1/other",
      recordId: "record-one",
      sourceArtifactHashes,
      unitKey: "shared-claim-unit",
      packet,
      anthropicPrompt: "Production adjudication prompt",
    });
    const second = identified({
      task: "adjudication",
      runId: "run-two",
      seedDoi: "10.1/other",
      recordId: "record-two",
      sourceArtifactHashes,
      unitKey: "shared-claim-unit",
      packet,
      anthropicPrompt: "Production adjudication prompt",
    });
    const cases = [first, second].sort((a, b) =>
      a.caseId.localeCompare(b.caseId),
    );
    const reportArtifactId = buildStableId("artifact", { fixture: "two" });
    const reportContentHash = canonicalSha256("review-fixture");
    const sources = [{ runId: "run-two", reportArtifactId, reportContentHash }];
    const id = buildStableId("dataset", {
      builderVersion: "evaluation-build-v1",
      sources,
      cases,
    });
    atomicJson(
      join(datasetDir(id), "dataset.json"),
      datasetSchema.parse({
        schemaVersion: "evaluation-dataset-v1",
        builderVersion: "evaluation-build-v1",
        datasetId: id,
        name: "review fixture",
        sources,
        cases,
      }),
    );
    const assessment = {
      eligibleForAdjudication: "yes",
      inScope: "yes",
      citingSpanValid: "yes",
      citedEvidenceValid: "yes",
      evidenceSufficiency: "sufficient",
      humanVerdict: "F",
      blinded: true,
      mutationKinds: [],
      notes: "",
    };
    const events = [first, second].map((item, index) => ({
      eventId: `hrevent_${String(index + 1).padStart(32, "0")}`,
      recordId: item.recordId,
      familyId: "family-one",
      reviewer: "human",
      createdAt: new Date().toISOString(),
      status: "final",
      assessment,
    }));
    const recordUnitKeys = {
      "record-one": "shared-claim-unit",
      "record-two": "shared-claim-unit",
    };
    writeImports(id, [
      {
        lineage: { runId: "run-two", reportArtifactId, reportContentHash },
        events,
        recordUnitKeys,
      },
    ]);
    const experiment = createExperiment(id, {
      schemaVersion: "evaluation-experiment-config-v1",
      tasks: ["adjudication"],
      providers: [
        {
          id: "opus",
          kind: "anthropic",
          model: "claude-opus-5-5",
          tasks: ["adjudication"],
        },
      ],
    });
    for (const trial of loadTrials(experiment.experimentId))
      atomicJson(
        join(
          experimentDir(experiment.experimentId),
          "trials",
          `${trial.trialId}.json`,
        ),
        {
          ...trial,
          status: "success",
          prediction: { verdict: "F" },
          calls: [],
          durationMs: 1,
          completedAt: new Date().toISOString(),
        },
      );
    const report = generateEvaluationReport(experiment.experimentId);
    const group = (
      report.report.groups as {
        scoredBlind: number;
        labeledCases: number;
        confusion: Record<string, Record<string, number>>;
      }[]
    )[0]!;
    expect(group.scoredBlind).toBe(1);
    expect(group.labeledCases).toBe(1);
    expect(group.confusion.F?.F).toBe(1);
    const pairedExperiment = createExperiment(id, {
      schemaVersion: "evaluation-experiment-config-v1",
      tasks: ["adjudication"],
      providers: [
        {
          id: "opus",
          kind: "anthropic",
          model: "claude-opus-5-5",
          tasks: ["adjudication"],
        },
        {
          id: "jev",
          kind: "jev",
          model: "test-jev",
          tasks: ["adjudication"],
        },
      ],
    });
    for (const trial of loadTrials(pairedExperiment.experimentId).filter(
      (row) => row.providerId === "jev",
    ))
      atomicJson(
        join(
          experimentDir(pairedExperiment.experimentId),
          "trials",
          `${trial.trialId}.json`,
        ),
        {
          ...trial,
          status: "success",
          prediction: { verdict: trial.caseId === first.caseId ? "F" : "D" },
          calls: [],
          durationMs: 1,
          completedAt: new Date().toISOString(),
        },
      );
    const paired = generateEvaluationReport(pairedExperiment.experimentId);
    expect(
      (
        paired.report.pairedDifferences as {
          commonSuccessfulCases: number;
        }[]
      )[0]?.commonSuccessfulCases,
    ).toBe(0);
    const conflicted = events.map((event, index) =>
      index === 1
        ? { ...event, assessment: { ...assessment, humanVerdict: "E" } }
        : event,
    );
    writeImports(id, [
      {
        lineage: { runId: "run-two", reportArtifactId, reportContentHash },
        events: conflicted,
        recordUnitKeys,
      },
    ]);
    const revised = generateEvaluationReport(experiment.experimentId);
    expect(
      (revised.report.groups as { scoredBlind: number }[])[0]!.scoredBlind,
    ).toBe(0);
    expect(revised.report.annotationSnapshotHash).not.toBe(
      report.report.annotationSnapshotHash,
    );
  });
});
