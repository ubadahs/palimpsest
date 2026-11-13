/**
 * Shared fixtures for the stage chain tests: a two-occurrence seed paper
 * walked through Discover, Scope, and Prepare with scripted adapters.
 */
import { adaptivePortfolioPolicySchema } from "../../src/stages/discover/candidate-selection.js";
import type { ArtifactReference } from "../../src/contract/artifacts/index.js";
import {
  buildStableId,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";
import type {
  DiscoverAdapters,
  DiscoverOptions,
} from "../../src/stages/discover/run.js";
import type { PrepareAdapters } from "../../src/stages/prepare/run.js";
import type { ScopeAdapters } from "../../src/stages/scope/run.js";
import { stubCodebookAdapters } from "./scope/codebook.fixture.js";

export const FAMILY_CLAIM =
  "Ril9 silencing causes loss of surface ridges and pocket formation.";

export const SOURCE_BLOCKS = [
  {
    blockId: "scope-block-abstract",
    text: "The abstract describes epithelial lumen organization and general polarity controls.",
    sectionTitle: "Abstract",
    blockKind: "abstract" as const,
  },
  {
    blockId: "scope-block-results",
    text: "Silencing Ril9 caused loss of surface ridges and pocket formation in lining cells. The resulting lumens lost their normal anisotropy.",
    sectionTitle: "Results",
    blockKind: "body_paragraph" as const,
  },
  {
    blockId: "scope-block-methods",
    text: "Ril9 was silenced with a validated small interfering RNA protocol before confocal imaging.",
    sectionTitle: "Methods",
    blockKind: "body_paragraph" as const,
  },
];

export type SourceBlock = {
  blockId: string;
  text: string;
  sectionTitle: string;
  blockKind: "abstract" | "body_paragraph";
};

export type GroundingVariant =
  | "grounded"
  | "not_found"
  | "grounding_failed"
  | "seed_text_unavailable"
  | "acquisition_failed";

export type ClassifierVariant =
  | "default"
  | "mixed"
  | "classification_failed"
  | "second_occurrence_failed"
  | "skip_low_information"
  | "ambiguous"
  | "manual_review_role_ambiguous"
  | "manual_review_extraction_limited";

export function artifactReference(
  role: string,
  key: string,
): ArtifactReference {
  return {
    artifactId: buildStableId("fixture", { role, key }),
    contentHash: canonicalSha256({ role, key }),
    role,
    uri: `fixture://${role}/${key}`,
  };
}

export function externalExecution(provider: string, key: string) {
  return {
    provider,
    requestHash: canonicalSha256({ provider, key, direction: "request" }),
    requestArtifact: artifactReference("external-request", key),
    responseArtifact: artifactReference("external-response", key),
  };
}

export function modelExecution(
  purpose: string,
  key: string,
  model = `fixture-${purpose}-model`,
  prompt: { id: string; version: string } = {
    id: `${purpose}-prompt`,
    version: "v1",
  },
) {
  return {
    kind: "model" as const,
    provider: "fixture-model-provider",
    model,
    promptId: prompt.id,
    promptVersion: prompt.version,
    promptContentHash: canonicalSha256({ purpose, prompt: "fixture" }),
    requestHash: canonicalSha256({
      purpose,
      key,
      model,
      direction: "request",
    }),
    requestArtifact: artifactReference(
      "model-request",
      `${purpose}-${key}-${model}`,
    ),
    responseArtifact: artifactReference(
      "model-response",
      `${purpose}-${key}-${model}`,
    ),
  };
}

export function extractionModelExecution(key: string, model: string) {
  return {
    kind: "model" as const,
    provider: "fixture-model-provider",
    model,
    promptId: "attributed-claim-extraction",
    promptVersion: "v1",
    promptContentHash: canonicalSha256({
      prompt: "extract all citing-side attributed claims",
    }),
    requestHash: canonicalSha256({ key, model, direction: "request" }),
    requestArtifact: artifactReference("model-request", `${key}-${model}`),
    responseArtifact: artifactReference("model-response", `${key}-${model}`),
  };
}

export function materializedBlocks(
  blocks: ReadonlyArray<SourceBlock> = SOURCE_BLOCKS,
) {
  let offset = 0;
  return blocks.map((block) => {
    const charOffsetStart = offset;
    const charOffsetEnd = charOffsetStart + block.text.length;
    offset = charOffsetEnd + 2;
    return { ...block, charOffsetStart, charOffsetEnd };
  });
}

export function discoverOptions(
  overrides: {
    dois?: string[];
    query?: string;
    probeBudget?: number;
    maxFamilies?: number;
    recordedAt?: string;
  } = {},
): DiscoverOptions {
  const {
    dois = ["10.1000/fixture-seed"],
    query = "works-citing-seed",
    probeBudget = 10,
    maxFamilies = 5,
    recordedAt = "2026-07-17T08:00:00.000Z",
  } = overrides;
  return {
    seeds: dois.map((doi) => ({
      doi,
      provenanceArtifacts: [artifactReference("doi-input", doi)],
    })),
    neighborhood: {
      provider: "fixture-citation-index",
      query,
      limit: 10,
    },
    probeBudget,
    candidateSelection: adaptivePortfolioPolicySchema.parse({
      mode: "adaptive_portfolio",
      minFamilies: 1,
      maxFamilies,
      maxPreparedRecords: 1000,
      minMarginalNovelty: 0,
    }),
    recordedAt,
  };
}

/**
 * Readable neighbors are frame papers: with a probe budget of 2 the two
 * strata carry inclusion probabilities 1 and 1/4. Closed neighbors sit
 * outside the frame: probed only with budget left over, they add records the
 * weighted rates must leave out.
 */
export type Neighbors = "readable" | "closed";

/**
 * A second citing paper in its own stratum, plus three neighbors beside the
 * first.
 */
const neighborhoodPapers = (neighbors: Neighbors) => [
  {
    providerRecordId: "provider-citing-paper-old",
    paperId: "citing-paper-old",
    title: "Citing paper old",
    doi: "10.2000/citing-paper-old",
    authors: ["Old Author"],
    publicationYear: 2011,
    fullTextAvailability: "available" as const,
    provenanceArtifacts: [
      artifactReference("provider-paper", "citing-paper-old"),
    ],
  },
  ...[1, 2, 3].map((index) => ({
    providerRecordId: `provider-neighbor-${String(index)}`,
    paperId: `neighbor-${String(index)}`,
    title: `Neighbor paper ${String(index)}`,
    authors: ["Neighbor Author"],
    publicationYear: 2026,
    fullTextAvailability:
      neighbors === "readable"
        ? ("available" as const)
        : ("unavailable" as const),
    provenanceArtifacts: [
      artifactReference("provider-paper", `neighbor-${String(index)}`),
    ],
  })),
];

export function discoverAdapters(
  options: {
    claim?: string | undefined;
    secondClaim?: string | undefined;
    multipleClaims?: boolean | undefined;
    contextText?: string | undefined;
    neighbors?: Neighbors | undefined;
  } = {},
): DiscoverAdapters {
  const {
    claim = FAMILY_CLAIM,
    secondClaim = `  ${claim.toUpperCase()}  `,
    multipleClaims = false,
    contextText,
    neighbors,
  } = options;
  return {
    resolveSeed: ({ doi }) =>
      Promise.resolve({
        status: "resolved",
        paper: {
          paperId: "seed-paper",
          providerRecordId: "provider-seed-paper",
          title: "Seed paper",
          doi,
          authors: ["Seed Author"],
          publicationYear: 2020,
        },
        execution: externalExecution("fixture-resolver", "seed"),
      }),
    retrieveCitingNeighborhood: () =>
      Promise.resolve({
        status: "completed",
        providerReportedTotal: neighbors ? 5 : 1,
        coverage: "complete",
        papers: [
          ...(neighbors ? neighborhoodPapers(neighbors) : []),
          {
            providerRecordId: "provider-citing-paper",
            paperId: "citing-paper",
            title: "Citing paper",
            doi: "10.2000/citing-paper",
            authors: ["Citing Author"],
            publicationYear: 2025,
            fullTextAvailability: "available",
            provenanceArtifacts: [
              artifactReference("provider-paper", "citing-paper"),
            ],
          },
        ],
        execution: externalExecution("fixture-citation-index", "neighborhood"),
      }),
    harvestMentions: () =>
      Promise.resolve({
        materialization: {
          status: "succeeded",
          reason: "Fixture citing text materialized.",
          provenanceArtifacts: [
            artifactReference("raw-citing-paper", "citing-paper"),
          ],
        },
        harvest: {
          status: "succeeded",
          reason: "Two distinct occurrences were harvested.",
          provenanceArtifacts: [
            artifactReference("mention-harvest", "citing-paper"),
          ],
        },
        mentions: [
          {
            mentionIndex: 0,
            refId: "seed-ref",
            charOffsetStart: 100,
            charOffsetEnd: 158,
            sourceLocator: {
              kind: "xml_path" as const,
              value: "/article/body/sec[1]/p[1]/xref[1]",
            },
            citationMarker: "[3]",
            rawContext:
              contextText ??
              "The reported phenotype followed Ril9 depletion [3].",
            sectionTitle: "Results",
            seedRefLabel: "Seed Author, 2020",
            isBundledCitation: false,
            bundleSize: 1,
            bundleRefIds: ["seed-ref"],
            bundlePattern: "single" as const,
            sourceType: "jats_xml" as const,
            parser: "fixture-parser-a",
            parserVersion: "1.0.0",
            provenanceArtifacts: [
              artifactReference("occurrence-source", "occurrence-0"),
            ],
          },
          {
            mentionIndex: 1,
            refId: "seed-ref",
            charOffsetStart: 300,
            charOffsetEnd: 354,
            sourceLocator: {
              kind: "xml_path" as const,
              value: "/article/body/sec[2]/p[2]/xref[2]",
            },
            citationMarker: "[3–5]",
            rawContext:
              contextText ??
              "Bulkhead defects are discussed with several references [3–5].",
            sectionTitle: "Discussion",
            seedRefLabel: "Seed Author, 2020",
            isBundledCitation: true,
            bundleSize: 3,
            bundleRefIds: ["seed-ref", "other-4", "other-5"],
            bundlePattern: "numeric_range" as const,
            sourceType: "jats_xml" as const,
            parser: "fixture-parser-b",
            parserVersion: "2.0.0",
            provenanceArtifacts: [
              artifactReference("occurrence-source", "occurrence-1"),
            ],
          },
        ],
      }),
    extractAttributedClaims: ({ mention }) => {
      const mentionClaim = mention.mentionIndex === 0 ? claim : secondClaim;
      return Promise.resolve({
        status: "completed",
        reason: "Fixture attributed claim extracted.",
        claims: [
          {
            text: mentionClaim,
            supportSpanText:
              mention.mentionIndex === 0
                ? "reported phenotype"
                : "Bulkhead defects",
            confidence: mention.mentionIndex === 0 ? "high" : "medium",
          },
          ...(multipleClaims
            ? [
                {
                  text: ` ${mentionClaim} `,
                  supportSpanText:
                    mention.mentionIndex === 0
                      ? "Ril9 depletion"
                      : "several references",
                  confidence: "medium" as const,
                },
              ]
            : []),
        ],
        execution: modelExecution(
          "discover",
          `occurrence-${String(mention.mentionIndex)}`,
        ),
      });
    },
  };
}

export function scopeAdapters(
  grounding: GroundingVariant = "grounded",
  blocks: ReadonlyArray<SourceBlock> = SOURCE_BLOCKS,
): ScopeAdapters {
  return {
    materializeSeed: ({ seed }) => {
      const execution = {
        kind: "external" as const,
        ...externalExecution("fixture-full-text", seed.seedId),
      };
      if (
        grounding === "seed_text_unavailable" ||
        grounding === "acquisition_failed"
      ) {
        return Promise.resolve({
          seedId: seed.seedId,
          status: grounding,
          reasonCode:
            grounding === "seed_text_unavailable"
              ? ("unavailable" as const)
              : ("transport" as const),
          reason:
            grounding === "seed_text_unavailable"
              ? "No inspectable seed manuscript was available."
              : "Seed manuscript acquisition failed in transit.",
          provenanceArtifacts: [
            artifactReference("seed-acquisition-trace", grounding),
          ],
          execution,
        });
      }
      return Promise.resolve({
        seedId: seed.seedId,
        status: "materialized",
        reason: "Fixture seed manuscript materialized.",
        seedTextArtifact: artifactReference("parsed-seed-text", seed.seedId),
        sourceArtifacts: [
          artifactReference("raw-seed-manuscript", seed.seedId),
        ],
        parser: {
          kind: "fixture-structured-parser",
          version: "v1",
        },
        blocks: materializedBlocks(blocks),
        execution,
      });
    },
    ...stubCodebookAdapters(),
    groundFamily: ({ family }) => {
      const execution = {
        ...modelExecution("scope", family.familyId),
      };
      if (grounding === "grounding_failed") {
        return Promise.resolve({
          status: "failed",
          reasonCode: "timeout",
          reason: "Fixture Scope grounding timed out.",
          execution,
        });
      }
      return Promise.resolve({
        status: "completed",
        rawOutput:
          grounding === "not_found"
            ? {
                status: "not_found",
                detailReason: "No direct seed support was found.",
                supportSpans: [],
              }
            : {
                status: "grounded",
                detailReason: "The Results block directly reports the claim.",
                supportSpans: [
                  {
                    verbatimQuote:
                      "Silencing Ril9 caused loss of surface ridges and pocket formation in lining cells.",
                    blockId: "scope-block-results",
                  },
                ],
              },
        execution,
      });
    },
  };
}

export function prepareAdapters(
  classifier: ClassifierVariant = "default",
): PrepareAdapters {
  return {
    classifyCitation: ({ citationOccurrence }) => {
      if (classifier === "classification_failed") {
        return Promise.resolve({
          status: "failed",
          reasonCode: "timeout",
          reason: "Fixture classification timed out.",
          execution: {
            kind: "external",
            ...externalExecution(
              "fixture-classifier",
              citationOccurrence.mentionId,
            ),
          },
        });
      }
      if (
        classifier === "second_occurrence_failed" &&
        citationOccurrence.mentionIndex !== 0
      ) {
        return Promise.resolve({
          status: "failed",
          reasonCode: "timeout",
          reason: "Fixture classification timed out.",
          execution: {
            kind: "external",
            ...externalExecution("fixture-classifier", "occurrence-1"),
          },
        });
      }
      if (classifier === "mixed" && citationOccurrence.mentionIndex === 1) {
        return Promise.resolve({
          status: "classified",
          citationRole: "acknowledgment_or_low_information",
          evaluationMode: "skip_low_information",
          modifiers: {
            isBundled: citationOccurrence.isBundledCitation,
            isReviewMediated: false,
            bundleSize: citationOccurrence.bundleSize,
          },
          signals: ["fixture:low-info"],
          rationale: "Fixture low-information gate.",
          confidence: "high",
          execution: {
            kind: "deterministic",
            implementation: "fixture-classifier-low-info-v1",
          },
        });
      }
      if (classifier === "skip_low_information") {
        return Promise.resolve({
          status: "classified",
          citationRole: "acknowledgment_or_low_information",
          evaluationMode: "skip_low_information",
          modifiers: {
            isBundled: citationOccurrence.isBundledCitation,
            isReviewMediated: false,
            bundleSize: citationOccurrence.bundleSize,
          },
          signals: ["fixture:low-info"],
          rationale: "Acknowledgment-only citation.",
          confidence: "high",
          execution: {
            kind: "deterministic",
            implementation: "fixture-classifier-v1",
          },
        });
      }
      if (
        classifier === "ambiguous" ||
        classifier === "manual_review_role_ambiguous"
      ) {
        return Promise.resolve({
          status: "ambiguous",
          citationRole: "unclear",
          evaluationMode: "manual_review_role_ambiguous",
          modifiers: {
            isBundled: citationOccurrence.isBundledCitation,
            isReviewMediated: false,
            bundleSize: citationOccurrence.bundleSize,
          },
          signals: ["fixture:ambiguous"],
          rationale: "The citation role is genuinely ambiguous.",
          confidence: "medium",
          execution: {
            kind: "deterministic",
            implementation: "fixture-classifier-v1",
          },
        });
      }
      if (classifier === "manual_review_extraction_limited") {
        return Promise.resolve({
          status: "ambiguous",
          citationRole: "unclear",
          evaluationMode: "manual_review_extraction_limited",
          modifiers: {
            isBundled: citationOccurrence.isBundledCitation,
            isReviewMediated: false,
            bundleSize: citationOccurrence.bundleSize,
          },
          signals: ["fixture:extraction-limited"],
          rationale: "Extraction confidence is too low for model adjudication.",
          confidence: "low",
          execution: {
            kind: "deterministic",
            implementation: "fixture-classifier-v1",
          },
        });
      }
      return Promise.resolve(
        citationOccurrence.mentionIndex === 0
          ? {
              status: "classified",
              citationRole: "substantive_attribution",
              evaluationMode: "fidelity_specific_claim",
              modifiers: {
                isBundled: false,
                isReviewMediated: false,
                bundleSize: 1,
              },
              signals: ["fixture:direct-attribution"],
              rationale: "The first occurrence makes a direct attribution.",
              confidence: "high",
              execution: {
                kind: "deterministic",
                implementation: "fixture-classifier-v1",
              },
            }
          : {
              status: "classified",
              citationRole: "background_context",
              evaluationMode: "fidelity_bundled_use",
              modifiers: {
                isBundled: true,
                isReviewMediated: false,
                bundleSize: 3,
              },
              signals: ["fixture:bundled-background"],
              rationale: "The second occurrence is bundled background.",
              confidence: "medium",
              execution: {
                kind: "deterministic",
                implementation: "fixture-classifier-v1",
              },
            },
      );
    },
  };
}
