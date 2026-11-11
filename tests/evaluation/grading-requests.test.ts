import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendAnnotation,
  blindDatasetView,
} from "../../src/evaluation/annotations.js";
import {
  createGradingRequest,
  listGradingRequests,
  openGradingRequests,
} from "../../src/evaluation/grading-requests.js";
import { atomicJson, datasetDir } from "../../src/evaluation/storage.js";
import type { EvaluationCase } from "../../src/evaluation/types.js";

const base = {
  runId: "run-one",
  seedDoi: "10.1/seed",
  sourceArtifactHashes: { report: "hash" },
};

function adjudicationCase(caseId: string): EvaluationCase {
  return {
    ...base,
    caseId,
    task: "adjudication",
    recordId: `record_${caseId}`,
    unitKey: `unit_${caseId}`,
    anthropicPrompt: "prompt",
    packet: {
      citationRole: "substantive_attribution",
      evaluationMode: "fidelity_specific_claim",
      markedCitingContext: "▶ Marlowe et al. reported three marker classes. ◀",
      familyTrackedClaim: "Seed reported three marker classes.",
      citingPaperTitle: "Citing paper",
      citedPaperTitle: "Seed paper",
      occurrenceClaims: [],
      selectedChunks: [],
    },
  };
}

const roleCase: EvaluationCase = {
  ...base,
  caseId: "role",
  task: "role",
  recordId: "record_role",
  occurrenceId: "mention",
  context: "Marlowe et al. reported three marker classes.",
  claims: ["Three marker classes were reported"],
  deterministicRole: "unclear",
  deterministicUnclear: true,
  anthropicPrompt: "prompt",
};

const ask = {
  title: "A second look",
  purpose: "Your labels decide which adjudicator becomes the default.",
};

describe.sequential("grading requests", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "palimpsest-requests-"));
    vi.stubEnv("PALIMPSEST_ROOT", root);
    atomicJson(join(datasetDir("dataset_one"), "dataset.json"), {
      schemaVersion: "evaluation-dataset-v3",
      builderVersion: "evaluation-build-v3",
      datasetId: "dataset_one",
      name: "fixture",
      sources: [
        { runId: "run-one", reportArtifactId: "r", reportContentHash: "h" },
      ],
      cases: [adjudicationCase("a"), adjudicationCase("b"), roleCase],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the cases in the order they were asked for and shows them to the reviewer", () => {
    const request = createGradingRequest("dataset_one", {
      ...ask,
      caseIds: ["b", "a"],
    });
    expect(request).toMatchObject({ ...ask, caseIds: ["b", "a"] });
    expect(listGradingRequests("dataset_one")).toEqual([request]);
    expect(blindDatasetView("dataset_one").requests).toEqual([request]);
  });

  it("returns the saved request when asked for the same cases again", () => {
    const first = createGradingRequest("dataset_one", {
      ...ask,
      caseIds: ["a", "b"],
    });
    const again = createGradingRequest("dataset_one", {
      ...ask,
      purpose: "Reworded.",
      caseIds: ["a", "b"],
    });
    expect(again).toEqual(first);
    expect(listGradingRequests("dataset_one")).toHaveLength(1);
  });

  it("stays open until every case has a final answer", () => {
    const request = createGradingRequest("dataset_one", {
      ...ask,
      caseIds: ["a", "b"],
    });
    const answer = (
      caseId: string,
      reviewer: string,
      status: "draft" | "final",
    ) =>
      appendAnnotation("dataset_one", {
        caseId,
        reviewer,
        status,
        expectedHeadEventId: null,
        notes: "",
        value: {
          task: "adjudication",
          verdict: "F",
          packetQuality: "valid",
          evidenceSufficiency: "sufficient",
        },
      });
    answer("a", "ada", "final");
    answer("b", "ada", "draft");
    expect(openGradingRequests("dataset_one")).toEqual([request]);
    answer("b", "bo", "final");
    expect(openGradingRequests("dataset_one")).toEqual([]);
  });

  it("refuses cases it cannot ask about as one question", () => {
    const request = (caseIds: string[]) =>
      createGradingRequest("dataset_one", { ...ask, caseIds });
    expect(() => request(["a", "missing"])).toThrow(
      "Not cases of this dataset: missing",
    );
    expect(() => request(["a", "a"])).toThrow("lists each case once");
    expect(() => request(["a", "role"])).toThrow("cases of one task");
    expect(listGradingRequests("dataset_one")).toEqual([]);
  });
});
