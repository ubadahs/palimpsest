import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCanonicalAdjudicatePrompt,
  type CanonicalAdjudicatePacket,
} from "../../src/adjudication/canonical-adjudicate-packet.js";
import type { GenerateObjectParams } from "../../src/integrations/llm-client.js";
import {
  buildConstructedCases,
  type Mutation,
} from "../../src/evaluation/constructed-cases.js";
import { generateEvaluationReport } from "../../src/evaluation/report.js";
import {
  createExperiment,
  loadTrials,
  runExperiment,
} from "../../src/evaluation/runner.js";
import { atomicJson, datasetDir } from "../../src/evaluation/storage.js";
import type {
  EvaluationCase,
  SeedDocument,
} from "../../src/evaluation/types.js";
import {
  buildStableId,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";

type Request = GenerateObjectParams;
type Version = "v2" | "v3";
const model = vi.hoisted(() => ({
  requests: [] as unknown[],
  inFlight: 0,
  /** Requests already in flight when each request started, in start order. */
  inFlightAtStart: [] as number[],
  reply: (_request: unknown): unknown => ({}),
}));

vi.mock("../../src/integrations/llm-client.js", async (original) => ({
  ...(await original<object>()),
  createLLMClient: (options: unknown) => ({
    options,
    async generateObject(request: Request) {
      model.requests.push({ options, request });
      model.inFlightAtStart.push(model.inFlight);
      model.inFlight++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      model.inFlight--;
      return {
        object: model.reply(request),
        record: {
          model: request.model,
          latencyMs: 5,
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 900,
        },
      };
    },
    getLedger: () => ({}),
  }),
}));

const seedDocument: SeedDocument = {
  seedDoi: "10.1/seed",
  title: "Seed paper",
  blocks: [
    {
      blockId: "abstract-0",
      text: "We identified three marker classes in the mouse Norel.",
      blockKind: "abstract",
      sectionRole: "abstract",
      citesOtherWork: false,
    },
  ],
};

function adjudicationCase(index: number, version: Version): EvaluationCase {
  const packet: CanonicalAdjudicatePacket = {
    recordId: `record_${String(index)}`,
    familyId: "fam_1",
    citationOccurrenceId: `occ_${String(index)}`,
    citationRole: "substantive_attribution",
    evaluationMode: "fidelity_specific_claim",
    isBundled: false,
    bundleSize: 1,
    citingPaperTitle: `Citing paper ${String(index)}`,
    citedPaperTitle: "Seed paper",
    familyTrackedClaim: "Seed reported three marker classes.",
    markedCitingContext: "▶ Marlowe et al. reported three marker classes. ◀",
    occurrenceClaims: [
      {
        claimRecordId: `claim_${String(index)}`,
        claimText: "The seed reported three marker classes.",
        supportSpanText: "reported three marker classes",
      },
    ],
    selectedChunks: [
      {
        chunkId: "chunk_1",
        text: "We identified three marker classes in the mouse Norel.",
        sourceBlockKind: "abstract",
        charOffsetStart: 0,
        charOffsetEnd: 54,
      },
    ],
  };
  const input = {
    task: "adjudication" as const,
    runId: "run-one",
    seedDoi: "10.1/seed",
    recordId: packet.recordId,
    sourceArtifactHashes: { report: canonicalSha256("fixture") },
    unitKey: `unit_${String(index)}`,
    packet,
    anthropicPrompt: buildCanonicalAdjudicatePrompt(packet),
  };
  return {
    ...input,
    caseId: buildStableId("eval-case", {
      builderVersion: `evaluation-build-${version}`,
      input,
    }),
  };
}

const mutation: Mutation = {
  recordId: "record_1",
  expectedVerdict: "D",
  mutationKind: "scope_broadened",
  direction: "strengthened",
  rationale: "The seed reports three classes, not nine.",
  contextEdits: [{ find: "three marker", replace: "nine marker" }],
  claimEdits: [{ find: "three marker", replace: "nine marker" }],
};

/** A v3 dataset holds the seed text; a v2 dataset predates it. */
function writeDataset(version: Version, mutations: Mutation[] = []): string {
  const observed = [1, 2, 3, 4].map((index) =>
    adjudicationCase(index, version),
  );
  const constructed = buildConstructedCases(
    observed,
    new Map([["unit_1", { verdict: "F" }]]),
    mutations,
  ).map((input) => ({
    ...input,
    caseId: buildStableId("eval-case", {
      builderVersion: `evaluation-build-${version}`,
      input,
    }),
  }));
  const content = {
    builderVersion: `evaluation-build-${version}`,
    sources: [
      {
        runId: "run-one",
        reportArtifactId: "report",
        reportContentHash: canonicalSha256("fixture"),
      },
    ],
    cases: [...observed, ...constructed].sort((a, b) =>
      a.caseId.localeCompare(b.caseId),
    ),
    ...(version === "v3" ? { seedDocuments: [seedDocument] } : {}),
  };
  const datasetId = buildStableId("dataset", content);
  atomicJson(join(datasetDir(datasetId), "dataset.json"), {
    schemaVersion: `evaluation-dataset-${version}`,
    datasetId,
    name: "fixture",
    ...content,
  });
  atomicJson(join(datasetDir(datasetId), "historical-observations.json"), []);
  atomicJson(join(datasetDir(datasetId), "imported-reviews.json"), []);
  atomicJson(join(datasetDir(datasetId), "imports.json"), {
    observationsHash: canonicalSha256([]),
    reviewsHash: canonicalSha256([]),
  });
  return datasetId;
}

function config(provider: Record<string, unknown>) {
  return {
    schemaVersion: "evaluation-experiment-config-v1",
    tasks: ["adjudication"],
    providers: [
      {
        id: "whole-paper",
        kind: "anthropic",
        model: "claude-sonnet-5-5",
        adjudicationEvidence: "seed_text",
        concurrency: 3,
        pricePerMillionInputTokensUsd: 2,
        pricePerMillionOutputTokensUsd: 10,
        ...provider,
      },
    ],
  };
}

const faithfulReply = {
  citingAssertion: "The citer says the seed reported three classes.",
  sourceStatement: "The seed reports three classes.",
  verdict: "F",
  mutationKinds: [],
  direction: "none",
  rationale: "The statements match.",
  confidence: "high",
  seedQuotes: [{ block: 1, quote: "three marker classes" }],
};

describe.sequential("seed-text adjudication provider", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "palimpsest-seed-text-"));
    vi.stubEnv("PALIMPSEST_ROOT", root);
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    model.requests.length = 0;
    model.inFlightAtStart.length = 0;
    model.inFlight = 0;
    model.reply = () => faithfulReply;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("sends the seed text as a prefix shared by every record, which the client caches", async () => {
    const experiment = createExperiment(writeDataset("v3"), config({}));
    expect(await runExperiment(experiment.experimentId)).toMatchObject({
      completed: 4,
      pending: 0,
    });
    const sent = model.requests as { request: Request }[];
    expect(sent).toHaveLength(4);
    expect(new Set(sent.map(({ request }) => request.promptPrefix)).size).toBe(
      1,
    );
    expect(sent[0]!.request.promptPrefix).toContain(
      "We identified three marker classes in the mouse Norel.",
    );
    expect(new Set(sent.map(({ request }) => request.promptSuffix)).size).toBe(
      4,
    );
    const trials = loadTrials(experiment.experimentId);
    expect(trials.map((trial) => trial.prediction)).toEqual(
      Array.from({ length: 4 }, () => ({ verdict: "F" })),
    );
    expect(trials[0]!.diagnostics).toMatchObject({
      request: { seedDoi: "10.1/seed" },
      response: {
        seedQuotes: [{ blockId: "abstract-0", quote: "three marker classes" }],
      },
    });
    expect(JSON.stringify(trials[0]!.diagnostics)).not.toContain(
      "We identified three marker classes in the mouse Norel.",
    );
  });

  it("lets one request write the cache before the rest run side by side", async () => {
    const experiment = createExperiment(writeDataset("v3"), config({}));
    await runExperiment(experiment.experimentId);
    expect(model.inFlightAtStart[0]).toBe(0);
    expect(model.inFlightAtStart[1]).toBe(0);
    expect(Math.max(...model.inFlightAtStart)).toBe(2);
  });

  it("records a reply with no verifiable quote as an invalid response, with its cost", async () => {
    model.reply = () => ({
      ...faithfulReply,
      seedQuotes: [{ block: 1, quote: "four marker classes" }],
    });
    const experiment = createExperiment(
      writeDataset("v3"),
      config({ concurrency: 1 }),
    );
    await runExperiment(experiment.experimentId);
    const [trial] = loadTrials(experiment.experimentId);
    expect(trial).toMatchObject({
      status: "invalid_response",
      error:
        "seedQuotes: A F verdict must rest on at least one verified seed quote",
    });
    expect(trial!.calls).toHaveLength(1);
  });

  it("reports constructed positives apart from behaviour on real records", async () => {
    // Stands in for a model that reads the citing text: it objects to "nine".
    model.reply = (request) => {
      const { prompt, promptSuffix } = request as Request;
      const { seedQuotes, ...judgment } = faithfulReply;
      const edited = (prompt ?? promptSuffix ?? "").includes("nine marker");
      return {
        ...judgment,
        ...(edited
          ? {
              verdict: "D",
              mutationKinds: ["scope_broadened"],
              direction: "strengthened",
            }
          : {}),
        ...(prompt ? { citedChunks: [1] } : { seedQuotes }),
      };
    };
    const whole = config({}).providers[0]!;
    const experiment = createExperiment(writeDataset("v3", [mutation]), {
      ...config({}),
      providers: [
        whole,
        { ...whole, id: "chunks", adjudicationEvidence: undefined },
      ],
    });
    await runExperiment(experiment.experimentId);
    const { report, markdownPath } = generateEvaluationReport(
      experiment.experimentId,
    );
    expect(report.constructedCases).toMatchObject([
      {
        providerId: "whole-paper",
        distortions: {
          cases: 1,
          scored: 1,
          matchedExpectedVerdict: 1,
          falseFaithful: 0,
          namedMutationKind: 1,
          pairs: 1,
          discriminatedPairs: 1,
        },
      },
      {
        providerId: "chunks",
        distortions: { scored: 1, matchedExpectedVerdict: 1 },
      },
    ]);
    expect(report.groups).toMatchObject([
      {
        providerId: "whole-paper",
        outputSummary: { predictedLabels: { F: 4 } },
      },
      { providerId: "chunks", outputSummary: { predictedLabels: { F: 4 } } },
    ]);
    expect(readFileSync(markdownPath, "utf8")).toContain(
      "| whole-paper | 1/1 | 1 | 0 | 1 | 1/1 | 0/0 |",
    );
  });

  it("refuses the arm up front when it cannot run", () => {
    expect(() => createExperiment(writeDataset("v2"), config({}))).toThrow(
      "which this dataset does not hold",
    );
    expect(() =>
      createExperiment(
        writeDataset("v3"),
        config({ kind: "jev", model: "jev" }),
      ),
    ).toThrow("only Anthropic providers can adjudicate from seed text");
  });
});
