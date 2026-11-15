/**
 * A whole Discover→Adjudicate chain over the stage fixtures, with a scripted
 * adjudicator. Shared by the tests that read finished runs.
 */
import { hashAdjudicateRequest } from "../../src/contract/artifacts/index.js";
import { canonicalSha256 } from "../../src/shared/stable-identity.js";
import {
  adjudicatePromptText,
  buildAdjudicateArtifact,
  runAdjudicate,
  type AdjudicateAdapterInput,
} from "../../src/stages/adjudicate/run.js";
import {
  buildDiscoverArtifact,
  runDiscover,
} from "../../src/stages/discover/run.js";
import {
  buildEvidenceArtifact,
  runEvidence,
  type EvidenceRerankerInput,
} from "../../src/stages/evidence/run.js";
import {
  buildPrepareArtifact,
  runPrepare,
} from "../../src/stages/prepare/run.js";
import { buildScopeArtifact, runScope } from "../../src/stages/scope/run.js";
import {
  discoverAdapters,
  discoverOptions,
  modelExecution,
  prepareAdapters,
  scopeAdapters,
  type Neighbors,
} from "./chain.fixture.js";

export async function buildChain(
  options: {
    grounding?: "grounded" | "seed_text_unavailable";
    classifier?: "mixed" | "default";
    adjudicateVariant?:
      | "F"
      | "D"
      | "U"
      | "nonfatal_failure"
      | "malformed"
      /** A faithful verdict reached from the whole seed text. */
      | "seed_text";
    reranking?: boolean;
    selectionLimit?: number;
    runId?: string;
    /** An older citing paper and three neighbors; see `neighborhoodPapers`. */
    neighbors?: Neighbors;
  } = {},
) {
  const runId = options.runId ?? "run-report-fixture";
  const discoverResult = await runDiscover(
    discoverOptions({
      probeBudget: options.neighbors === "readable" ? 2 : 10,
      recordedAt: "2026-07-17T10:00:00.000Z",
    }),
    discoverAdapters({ neighbors: options.neighbors }),
  );
  const discover = buildDiscoverArtifact({
    result: discoverResult,
    runId,
    createdAt: "2026-07-17T10:05:00.000Z",
  });
  const scopeResult = await runScope(
    discover,
    scopeAdapters(options.grounding ?? "grounded"),
    {
      recordedAt: "2026-07-17T10:10:00.000Z",
      discoverArtifactUri: "fixture://discover/discover.json",
    },
  );
  const scope = buildScopeArtifact({
    result: scopeResult,
    runId: discover.runId,
    createdAt: "2026-07-17T10:15:00.000Z",
  });
  const prepareResult = await runPrepare(
    scope,
    discover,
    prepareAdapters(options.classifier ?? "mixed"),
    {
      recordedAt: "2026-07-17T10:20:00.000Z",
      scopeArtifactUri: "fixture://scope/scope.json",
    },
  );
  const prepare = buildPrepareArtifact({
    result: prepareResult,
    runId: discover.runId,
    createdAt: "2026-07-17T10:25:00.000Z",
  });
  const evidenceResult = await runEvidence(
    prepare,
    scope,
    options.reranking
      ? {
          rerank: (input: EvidenceRerankerInput) =>
            Promise.resolve({
              status: "completed",
              rawOutput: {
                results: [
                  {
                    chunkId: input.candidates[0]!.chunkId,
                    relevanceScore: 99,
                    rank: 1,
                    rationale:
                      "Fixture reranker selected the most relevant candidate.",
                  },
                ],
              },
              execution: {
                ...modelExecution("rerank", input.bm25RunId),
              },
            }),
        }
      : {},
    {
      recordedAt: "2026-07-17T10:30:00.000Z",
      prepareArtifactUri: "fixture://prepare/prepare.json",
      scopeArtifactUri: "fixture://scope/scope.json",
      reranking: options.reranking
        ? { enabled: true, topN: 3 }
        : { enabled: false },
      ...(options.selectionLimit != null
        ? { selectionLimit: options.selectionLimit }
        : {}),
    },
  );
  const evidence = buildEvidenceArtifact({
    result: evidenceResult,
    runId: discover.runId,
    createdAt: "2026-07-17T10:35:00.000Z",
  });

  const variant = options.adjudicateVariant ?? "F";
  const calls: AdjudicateAdapterInput[] = [];
  const adjudicateResult = await runAdjudicate(
    evidence,
    prepare,
    {
      adjudicate: (input) => {
        calls.push(input);
        const execution = {
          ...modelExecution("adjudicate", input.recordId),
          promptId: String(input.promptId),
          promptVersion: String(input.promptVersion),
          promptContentHash: canonicalSha256(adjudicatePromptText(input)),
          requestHash: hashAdjudicateRequest(input),
        };
        if (variant === "nonfatal_failure") {
          return Promise.resolve({
            status: "failed",
            reasonCode: "timeout",
            reason: "Fixture adjudicator timed out.",
            execution,
          });
        }
        if (variant === "malformed") {
          return Promise.resolve({
            status: "completed",
            rawOutput: { verdict: "supported" },
            execution,
          });
        }
        const verdict =
          options.neighbors != null &&
          input.packet.citingPaperTitle === "Citing paper old"
            ? "D"
            : variant === "seed_text"
              ? "F"
              : variant;
        const cited = input.packet.selectedChunks[0]!;
        return Promise.resolve({
          status: "completed",
          rawOutput: {
            citingAssertion:
              "The citing paper attributes Ril9 silencing to bulkhead loss.",
            sourceStatement:
              "The cited chunks report the same phenotype in lining cells.",
            verdict,
            mutationKinds: verdict === "D" ? ["scope_broadened"] : [],
            direction: verdict === "F" ? "none" : "strengthened",
            rationale: "Fixture adjudication rationale.",
            confidence: "medium",
            ...(input.evidence === "seed_text"
              ? {
                  // Quote the first selected chunk from the block the prompt
                  // numbered it under, plus words the seed does not contain.
                  seedQuotes: [
                    {
                      block: Number(
                        [
                          ...input.promptPrefix
                            .slice(0, input.promptPrefix.indexOf(cited.text))
                            .matchAll(/^#(\d+) \(/gm),
                        ].at(-1)![1],
                      ),
                      quote: cited.text,
                    },
                    { block: 1, quote: "words the seed does not contain" },
                  ],
                }
              : { citedChunkIds: [cited.chunkId] }),
          },
          execution,
        });
      },
    },
    {
      recordedAt: "2026-07-17T10:40:00.000Z",
      evidence: variant === "seed_text" ? "seed_text" : "selected_chunks",
      evidenceArtifactUri: "fixture://evidence/evidence.json",
      prepareArtifactUri: "fixture://prepare/prepare.json",
    },
  );
  const adjudicate = buildAdjudicateArtifact({
    result: adjudicateResult,
    runId: discover.runId,
    createdAt: "2026-07-17T10:45:00.000Z",
  });
  return { discover, scope, prepare, evidence, adjudicate, calls };
}
