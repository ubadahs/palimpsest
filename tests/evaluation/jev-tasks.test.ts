import { describe, expect, it } from "vitest";
import { providerConfigSchema } from "../../src/evaluation/config.js";
import {
  buildJevFixtureRequestSpecs,
  buildJevRequestSpecs,
  parseJevResult,
  validateJevFixtureResult,
} from "../../src/evaluation/jev-tasks.js";
import type { EvaluationCase } from "../../src/evaluation/types.js";
import type { JevVariant } from "../../src/evaluation/optimization-contract.js";

const provider = providerConfigSchema.parse({
  id: "jev",
  kind: "jev",
  model: "jev-1.13.0",
});
const base = {
  caseId: "example",
  runId: "run",
  seedDoi: "10.1/seed",
  recordId: "record",
  sourceArtifactHashes: { report: "hash" },
};
const rerank: Extract<EvaluationCase, { task: "rerank" }> = {
  ...base,
  task: "rerank",
  query: "The treatment increased survival",
  candidates: [
    {
      chunkId: "b",
      text: "It increased survival only at the high dose.",
      sourceBlockKind: "table",
      sectionRole: "results",
      citesOtherWork: false,
    },
    {
      chunkId: "a",
      text: "Earlier studies discussed survival.",
      sourceBlockKind: "body_paragraph",
      sectionRole: "introduction",
      citesOtherWork: true,
    },
  ],
  pinnedPassages: [],
  bm25Order: ["b", "a"],
  pinnedChunkIds: ["b"],
  selectionLimit: 2,
};
const variant = (
  layout: "shared-passages" | "passage-per-question",
): JevVariant => ({
  id: layout,
  task: "rerank",
  layout,
  batchSize: 2,
  questionOrder: "stable",
  repetition: 1,
  phase: "main",
});

describe("Jev scientific requests", () => {
  it("gives both layouts identical passage content, metadata, and rubric", () => {
    const shared = buildJevRequestSpecs(
      rerank,
      variant("shared-passages"),
      provider,
    )[0]!;
    const direct = buildJevRequestSpecs(
      rerank,
      variant("passage-per-question"),
      provider,
    )[0]!;
    type Question = {
      criteria: unknown;
      instructions: { task: string; passage: unknown };
    };
    const sharedBody = shared.body as {
      state: { passages: unknown[] };
      questions: Record<string, Question>;
    };
    const directBody = direct.body as { questions: Record<string, Question> };
    expect(shared.answerMap).toEqual(direct.answerMap);
    for (let index = 0; index < 2; index++) {
      const key = `passage_${index + 1}`;
      expect(sharedBody.state.passages[index]).toEqual(
        directBody.questions[key]!.instructions.passage,
      );
      expect(sharedBody.questions[key]!.criteria).toEqual(
        directBody.questions[key]!.criteria,
      );
      expect(sharedBody.questions[key]!.instructions.task).toEqual(
        directBody.questions[key]!.instructions.task,
      );
    }
    expect(sharedBody.questions.passage_1!.instructions.task).toMatch(
      /Contradictory findings and qualifying conditions/,
    );
    expect(JSON.stringify([shared.body, direct.body])).not.toMatch(
      /bm25|pinned|human|historical|relevanceScore/i,
    );
    expect(shared.requestHash).not.toBe(direct.requestHash);
  });

  it("validates exact answers and preserves fractional scores and uncertainty", () => {
    const request = buildJevRequestSpecs(
      rerank,
      variant("shared-passages"),
      provider,
    )[0]!;
    const response = {
      answers: {
        passage_1: {
          type: "score",
          score: 0.25,
          probabilities: { "0": 0.8, "1": 0.15, "2": 0.05 },
          confidence: 0.8,
        },
        passage_2: {
          type: "score",
          score: 1.6,
          probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
          confidence: 0.7,
        },
      },
    };
    const result = parseJevResult(request, response, "attempt-1");
    expect(result.attemptId).toBe("attempt-1");
    expect(result.scores?.a?.score).toBe(0.25);
    expect(result.scores?.b?.probabilities).toEqual({
      "0": 0.1,
      "1": 0.2,
      "2": 0.7,
    });
    expect(() =>
      parseJevResult(request, {
        answers: { passage_1: response.answers.passage_1 },
      }),
    ).toThrow(/keys/);
    expect(() =>
      parseJevResult(request, {
        answers: { ...response.answers, extra: response.answers.passage_1 },
      }),
    ).toThrow(/keys/);
  });

  it("freezes six invented endpoint checks outside the scientific dataset", () => {
    const specs = buildJevFixtureRequestSpecs(provider);
    expect(specs).toHaveLength(6);
    expect(new Set(specs.map((item) => item.requestId)).size).toBe(6);
    expect(
      specs.filter((item) => item.answerMap.decision === "role"),
    ).toHaveLength(2);
    expect(specs.every((item) => item.caseId.startsWith("fixture-"))).toBe(
      true,
    );
    const bundled = specs.find(
      (item) => item.caseId === "fixture-role-bundled",
    )!;
    expect(
      validateJevFixtureResult(bundled, {
        requestId: bundled.requestId,
        requestHash: bundled.requestHash,
        variantId: bundled.variantId,
        caseId: bundled.caseId,
        attemptId: "attempt",
        role: "substantive_attribution",
      }),
    ).toBe(true);
    expect(
      validateJevFixtureResult(bundled, {
        requestId: bundled.requestId,
        requestHash: bundled.requestHash,
        variantId: bundled.variantId,
        caseId: bundled.caseId,
        attemptId: "attempt",
        role: "background_context",
      }),
    ).toBe(false);
  });
});
