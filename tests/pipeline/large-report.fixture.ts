/**
 * A synthetic full canonical chain at census scale: many citing papers, each
 * with two occurrences, spread over a fixed number of claim families, every
 * family selected. No network or model calls; verdicts cycle so every family
 * has D, E, U, and F records. Used to bound Report Markdown and the Report
 * inspector payload by families rather than records.
 */
import {
  buildStableId,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";
import type { ArtifactReference } from "../../src/contract/lean-artifacts.js";
import {
  buildCanonicalDiscoverArtifact,
  runCanonicalDiscover,
} from "../../src/pipeline/canonical-discover.js";
import {
  buildCanonicalScopeArtifact,
  runCanonicalScope,
} from "../../src/pipeline/canonical-scope.js";
import {
  buildCanonicalPrepareArtifact,
  runCanonicalPrepare,
} from "../../src/pipeline/canonical-prepare.js";
import {
  buildCanonicalEvidenceArtifact,
  runCanonicalEvidence,
} from "../../src/pipeline/canonical-evidence.js";
import {
  adjudicatePromptText,
  buildCanonicalAdjudicateArtifact,
  runCanonicalAdjudicate,
} from "../../src/pipeline/canonical-adjudicate.js";
import {
  buildCanonicalReportArtifact,
  runCanonicalReport,
} from "../../src/pipeline/canonical-report.js";
import { hashCanonicalAdjudicateRequest } from "../../src/contract/lean-artifacts.js";

function reference(role: string, key: string): ArtifactReference {
  return {
    artifactId: buildStableId("fixture", { role, key }),
    contentHash: canonicalSha256({ role, key }),
    role,
    uri: `fixture://${role}/${key}`,
  };
}

function external(provider: string, key: string) {
  return {
    provider,
    requestHash: canonicalSha256({ provider, key, direction: "request" }),
    requestArtifact: reference("external-request", key),
    responseArtifact: reference("external-response", key),
  };
}

function model(purpose: string, key: string) {
  return {
    kind: "model" as const,
    provider: "fixture-model-provider",
    model: `fixture-${purpose}-model`,
    promptId: `canonical-${purpose}-prompt`,
    promptVersion: "v1",
    promptContentHash: canonicalSha256({ purpose, prompt: "fixture" }),
    requestHash: canonicalSha256({ purpose, key, direction: "request" }),
    requestArtifact: reference("model-request", `${purpose}-${key}`),
    responseArtifact: reference("model-response", `${purpose}-${key}`),
  };
}

const SEED_BLOCKS = [
  {
    blockId: "block-abstract",
    text: "The abstract describes how gene loss alters markers in lining cells.",
    sectionTitle: "Abstract",
    blockKind: "abstract" as const,
  },
  {
    blockId: "block-results",
    text: "Gene loss altered every marker measured in lining cells, with large effects.",
    sectionTitle: "Results",
    blockKind: "body_paragraph" as const,
  },
  {
    blockId: "block-methods",
    text: "Genes were silenced with a validated protocol before imaging lining cells.",
    sectionTitle: "Methods",
    blockKind: "body_paragraph" as const,
  },
];

const VERDICTS = ["F", "F", "D", "E", "U", "F"] as const;

type LargeChainOptions = {
  citingPapers: number;
  families: number;
  /**
   * Word each citer's claim differently and cluster claims with a fake
   * model that groups them by the gene they name, so Discover's blocked
   * clustering runs; called with each request's claim count. Without it
   * claims share their family's exact text and group by it.
   */
  concurrency?: number;
  onClusteringCall?: (claims: number) => void;
};

const runId = "run-large-report-fixture";

export async function runLargeDiscover(options: LargeChainOptions) {
  const papers = Array.from({ length: options.citingPapers }, (_, index) => ({
    providerRecordId: `provider-citing-${String(index)}`,
    paperId: `citing-${String(index)}`,
    title: `Citing paper ${String(index)} on lining cell markers`,
    doi: `10.2000/citing-${String(index)}`,
    authors: ["Citing Author"],
    publicationYear: 2010 + (index % 15),
    fullTextAvailability: "available" as const,
    provenanceArtifacts: [reference("provider-paper", String(index))],
  }));
  const familyOf = (paperIndex: number, mentionIndex: number) =>
    (paperIndex * 2 + mentionIndex) % options.families;

  const discoverResult = await runCanonicalDiscover(
    {
      seeds: [
        {
          doi: "10.1000/large-seed",
          provenanceArtifacts: [reference("doi-input", "large-seed")],
        },
      ],
      neighborhood: {
        provider: "fixture-citation-index",
        query: "works-citing-large-seed",
        limit: 10_000,
      },
      probeBudget: "all",
      candidateSelection: { mode: "all", policyVersion: "all-candidates-v1" },
      recordedAt: "2026-07-17T10:00:00.000Z",
      concurrency: options.concurrency ?? 16,
      fetchConcurrency: 16,
    },
    {
      resolveSeed: ({ doi }) =>
        Promise.resolve({
          status: "resolved",
          paper: {
            paperId: "seed-paper",
            providerRecordId: "provider-seed-paper",
            title: "Synthetic seed paper",
            doi,
            authors: ["Seed Author"],
            publicationYear: 2008,
          },
          execution: external("fixture-resolver", "seed"),
        }),
      retrieveCitingNeighborhood: () =>
        Promise.resolve({
          status: "completed",
          providerReportedTotal: papers.length,
          coverage: "complete",
          papers,
          execution: external("fixture-citation-index", "neighborhood"),
        }),
      harvestMentions: ({ citingPaper }) => {
        const paperIndex = Number(citingPaper.paperId.split("-")[1]);
        return Promise.resolve({
          materialization: {
            status: "succeeded",
            reason: "Fixture citing text materialized.",
            provenanceArtifacts: [
              reference("raw-citing-paper", citingPaper.paperId),
            ],
          },
          harvest: {
            status: "succeeded",
            reason: "Two occurrences were harvested.",
            provenanceArtifacts: [
              reference("mention-harvest", citingPaper.paperId),
            ],
          },
          mentions: [0, 1].map((mentionIndex) => {
            const family = familyOf(paperIndex, mentionIndex);
            return {
              mentionIndex,
              refId: "seed-ref",
              charOffsetStart: 100 + mentionIndex * 200,
              charOffsetEnd: 160 + mentionIndex * 200,
              sourceLocator: {
                kind: "xml_path" as const,
                value: `/article/body/sec[${String(mentionIndex + 1)}]/p[1]/xref[1]`,
              },
              citationMarker: "[3]",
              rawContext: `Gene${String(family)} loss alters marker${String(family)} in lining cells [3].`,
              sectionTitle: "Results",
              seedRefLabel: "Seed Author, 2008",
              isBundledCitation: false,
              bundleSize: 1,
              bundleRefIds: ["seed-ref"],
              bundlePattern: "single" as const,
              sourceType: "jats_xml" as const,
              parser: "fixture-parser",
              parserVersion: "1.0.0",
              provenanceArtifacts: [
                reference(
                  "occurrence-source",
                  `${citingPaper.paperId}-${String(mentionIndex)}`,
                ),
              ],
            };
          }),
        });
      },
      ...(options.onClusteringCall
        ? {
            canonicalizeClaims: async ({
              claims,
            }: {
              claims: Array<{
                claimRecordId: string;
                extractedClaimText: string;
              }>;
            }) => {
              options.onClusteringCall?.(claims.length);
              await new Promise((resolve) =>
                setTimeout(resolve, Math.floor(Math.random() * 3)),
              );
              const byGene = new Map<string, string[]>();
              for (const claim of claims) {
                const gene = /Gene(\d+)/.exec(claim.extractedClaimText)![1]!;
                byGene.set(gene, [
                  ...(byGene.get(gene) ?? []),
                  claim.claimRecordId,
                ]);
              }
              return {
                status: "completed",
                clusters: [...byGene].map(([gene, claimRecordIds]) => ({
                  canonicalClaim: `Gene${gene} loss alters marker${gene}.`,
                  claimRecordIds,
                })),
                execution: model(
                  "canonicalize",
                  claims.map((claim) => claim.claimRecordId).join(","),
                ),
              };
            },
          }
        : {}),
      extractAttributedClaims: ({ mention, citingPaper }) => {
        const family = /Gene(\d+)/.exec(mention.rawContext)![1]!;
        return Promise.resolve({
          status: "completed",
          reason: "Fixture attributed claim extracted.",
          claims: [
            {
              text: options.onClusteringCall
                ? `Gene${family} loss alters marker${family} in lining cells (${citingPaper.paperId}).`
                : `Gene${family} loss alters marker${family} in lining cells.`,
              supportSpanText: `Gene${family} loss alters marker${family}`,
              confidence: "high",
            },
          ],
          execution: model(
            "discover",
            `${citingPaper.paperId}-${String(mention.mentionIndex)}`,
          ),
        });
      },
    },
  );
  return buildCanonicalDiscoverArtifact({
    result: discoverResult,
    runId,
    createdAt: "2026-07-17T10:05:00.000Z",
  });
}

export async function buildLargeReportChain(options: LargeChainOptions) {
  const discover = await runLargeDiscover(options);

  let offset = 0;
  const blocks = SEED_BLOCKS.map((block) => {
    const charOffsetStart = offset;
    offset = charOffsetStart + block.text.length + 2;
    return {
      ...block,
      charOffsetStart,
      charOffsetEnd: charOffsetStart + block.text.length,
    };
  });
  const scopeResult = await runCanonicalScope(
    discover,
    {
      materializeSeed: ({ seed }) =>
        Promise.resolve({
          seedId: seed.seedId,
          status: "materialized",
          reason: "Fixture seed manuscript materialized.",
          seedTextArtifact: reference("parsed-seed-text", seed.seedId),
          sourceArtifacts: [reference("raw-seed-manuscript", seed.seedId)],
          parser: { kind: "fixture-structured-parser", version: "v1" },
          blocks,
          execution: {
            kind: "external" as const,
            ...external("fixture-full-text", seed.seedId),
          },
        }),
      groundFamily: ({ family }) =>
        Promise.resolve({
          status: "completed",
          rawOutput: {
            status: "grounded",
            detailReason: "The Results block reports the finding.",
            supportSpans: [
              {
                verbatimQuote: SEED_BLOCKS[1]!.text,
                blockId: "block-results",
              },
            ],
          },
          execution: model("scope", family.familyId),
        }),
    },
    { recordedAt: "2026-07-17T10:10:00.000Z", concurrency: 16 },
  );
  const scope = buildCanonicalScopeArtifact({
    result: scopeResult,
    runId,
    createdAt: "2026-07-17T10:15:00.000Z",
  });

  const prepareResult = await runCanonicalPrepare(
    scope,
    discover,
    {
      classifyCitation: () =>
        Promise.resolve({
          status: "classified",
          citationRole: "substantive_attribution",
          evaluationMode: "fidelity_specific_claim",
          modifiers: {
            isBundled: false,
            isReviewMediated: false,
            bundleSize: 1,
          },
          signals: ["fixture:direct-attribution"],
          rationale: "Fixture substantive attribution.",
          confidence: "high",
          execution: {
            kind: "deterministic",
            implementation: "fixture-classifier-v1",
          },
        }),
    },
    { recordedAt: "2026-07-17T10:20:00.000Z", concurrency: 16 },
  );
  const prepare = buildCanonicalPrepareArtifact({
    result: prepareResult,
    runId,
    createdAt: "2026-07-17T10:25:00.000Z",
  });

  const evidenceResult = await runCanonicalEvidence(
    prepare,
    scope,
    {},
    {
      recordedAt: "2026-07-17T10:30:00.000Z",
      reranking: { enabled: false },
    },
  );
  const evidence = buildCanonicalEvidenceArtifact({
    result: evidenceResult,
    runId,
    createdAt: "2026-07-17T10:35:00.000Z",
  });

  let adjudicated = 0;
  const adjudicateResult = await runCanonicalAdjudicate(
    evidence,
    prepare,
    {
      adjudicate: (input) => {
        const verdict = VERDICTS[adjudicated++ % VERDICTS.length]!;
        const cited = input.packet.selectedChunks[0]!;
        return Promise.resolve({
          status: "completed",
          rawOutput: {
            citingAssertion:
              "The citing paper says the gene's loss alters its marker.",
            sourceStatement:
              "The seed reports that gene loss altered every marker measured.",
            verdict,
            mutationKinds: verdict === "D" ? ["scope_broadened"] : [],
            direction: verdict === "F" ? "none" : "strengthened",
            rationale: "Fixture adjudication rationale.",
            confidence: "medium",
            citedChunkIds: [cited.chunkId],
          },
          execution: {
            ...model("adjudicate", input.recordId),
            promptId: String(input.promptId),
            promptVersion: String(input.promptVersion),
            promptContentHash: canonicalSha256(adjudicatePromptText(input)),
            requestHash: hashCanonicalAdjudicateRequest(input),
          },
        });
      },
    },
    {
      recordedAt: "2026-07-17T10:40:00.000Z",
      evidence: "selected_chunks",
      concurrency: 1,
    },
  );
  const adjudicate = buildCanonicalAdjudicateArtifact({
    result: adjudicateResult,
    runId,
    createdAt: "2026-07-17T10:45:00.000Z",
  });

  const reportResult = runCanonicalReport(
    discover,
    scope,
    prepare,
    evidence,
    adjudicate,
    { recordedAt: "2026-07-17T10:50:00.000Z" },
  );
  const report = buildCanonicalReportArtifact({
    result: reportResult,
    runId,
    createdAt: "2026-07-17T10:55:00.000Z",
  });
  return { discover, scope, prepare, evidence, adjudicate, report };
}
