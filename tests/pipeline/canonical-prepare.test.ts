import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptivePortfolioPolicySchema } from "../../src/contract/candidate-selection-policy.js";

import { describe, expect, it } from "vitest";

import {
  buildCitationInstanceRecordId,
  prepareArtifactPayloadSchema,
  prepareClassificationSchema,
  type ArtifactReference,
  type DiscoverArtifact,
  type DiscoverCitationOccurrence,
  type PrepareClassification,
  type ScopeArtifact,
} from "../../src/contract/lean-artifacts.js";
import {
  buildCanonicalDiscoverArtifact,
  runCanonicalDiscover,
  type CanonicalDiscoverAdapters,
  type CanonicalDiscoverOptions,
} from "../../src/pipeline/canonical-discover.js";
import {
  buildCanonicalPrepareArtifact,
  canonicalPrepareClassificationResultSchema,
  canonicalPrepareOptionsSchema,
  CanonicalPrepareBoundaryError,
  CanonicalPrepareFatalError,
  classifyPrepareOccurrenceDeterministically,
  runCanonicalPrepare,
  type CanonicalPrepareAdapters,
  type CanonicalPrepareClassifierInput,
  type CanonicalPrepareResult,
} from "../../src/pipeline/canonical-prepare.js";
import {
  buildCanonicalScopeArtifact,
  runCanonicalScope,
  type CanonicalScopeAdapters,
} from "../../src/pipeline/canonical-scope.js";
import {
  buildStableId,
  canonicalSerialize,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";
import {
  loadCanonicalArtifact,
  writeCanonicalArtifact,
} from "../../src/contract/selectors.js";

type GroundingVariant =
  | "grounded"
  | "ambiguous"
  | "not_found"
  | "seed_text_unavailable"
  | "acquisition_failed"
  | "grounding_failed";

type ClassifierVariant =
  | "deterministic"
  | "mixed"
  | "ambiguous_and_failed"
  | "fatal"
  | "malformed";

function artifactReference(role: string, key: string): ArtifactReference {
  return {
    artifactId: buildStableId("fixture", { role, key }),
    contentHash: canonicalSha256({ role, key }),
    role,
    uri: `fixture://${role}/${key}`,
  };
}

function externalExecution(provider: string, key: string) {
  return {
    provider,
    requestHash: canonicalSha256({ provider, key, direction: "request" }),
    requestArtifact: artifactReference("external-request", key),
    responseArtifact: artifactReference("external-response", key),
  };
}

function modelExecution(
  key: string,
  purpose: "discover" | "scope" | "prepare",
) {
  return {
    kind: "model" as const,
    provider: "fixture-model-provider",
    model: `fixture-${purpose}-model`,
    promptId: `canonical-${purpose}-prompt`,
    promptVersion: "v1",
    promptContentHash: canonicalSha256({ purpose, prompt: "fixture" }),
    requestHash: canonicalSha256({ purpose, key, direction: "request" }),
    requestArtifact: artifactReference("model-request", `${purpose}-${key}`),
    responseArtifact: artifactReference("model-response", `${purpose}-${key}`),
  };
}

function discoverOptions(): CanonicalDiscoverOptions {
  return {
    seeds: [
      {
        doi: "10.1000/prepare-seed",
        provenanceArtifacts: [
          artifactReference("doi-input", "10.1000/prepare-seed"),
        ],
      },
    ],
    neighborhood: {
      provider: "fixture-citation-index",
      query: "works-citing-seed",
      limit: 10,
    },
    probeBudget: 10,
    candidateSelection: adaptivePortfolioPolicySchema.parse({
      mode: "adaptive_portfolio",
      minFamilies: 1,
      maxFamilies: 2,
      maxPreparedRecords: 1000,
      minMarginalNovelty: 0,
    }),
    recordedAt: "2026-07-16T10:00:00.000Z",
  };
}

function discoverAdapters(
  parser = "fixture-parser-v1",
): CanonicalDiscoverAdapters {
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
        execution: externalExecution("fixture-resolver", "resolve-seed"),
      }),
    retrieveCitingNeighborhood: () =>
      Promise.resolve({
        status: "completed",
        providerReportedTotal: 1,
        coverage: "complete",
        papers: [
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
        execution: externalExecution(
          "fixture-citation-index",
          "citing-neighborhood",
        ),
      }),
    harvestMentions: () =>
      Promise.resolve({
        materialization: {
          status: "succeeded",
          reason: "Fixture citing paper materialized",
          provenanceArtifacts: [artifactReference("raw-citing-paper", parser)],
        },
        harvest: {
          status: "succeeded",
          reason: "All three fixture occurrences harvested",
          provenanceArtifacts: [artifactReference("mention-harvest", parser)],
        },
        mentions: [
          {
            mentionIndex: 0,
            refId: "seed-ref",
            charOffsetStart: 100,
            charOffsetEnd: 158,
            sourceLocator: {
              kind: "xml_path",
              value: "/article/body/sec[2]/p[1]/xref[2]",
            },
            citationMarker: "[2–4]",
            rawContext: "The seed showed alpha and also reported beta [2–4].",
            sectionTitle: "Discussion",
            seedRefLabel: "Seed Author, 2020",
            isBundledCitation: true,
            bundleSize: 3,
            bundleRefIds: ["other-ref-2", "seed-ref", "other-ref-4"],
            bundlePattern: "numeric_range",
            sourceType: "jats_xml",
            parser,
            parserVersion: "1.0.0",
            provenanceArtifacts: [
              artifactReference("occurrence-source", `occurrence-0-${parser}`),
            ],
          },
          {
            mentionIndex: 1,
            refId: "seed-ref",
            charOffsetStart: 300,
            charOffsetEnd: 338,
            sourceLocator: {
              kind: "xml_path",
              value: "/article/body/sec[2]/p[3]/xref[1]",
            },
            citationMarker: "[3]",
            rawContext: "The seed showed alpha again [3].",
            sectionTitle: "Results",
            seedRefLabel: "Seed Author, 2020",
            isBundledCitation: false,
            bundleSize: 1,
            bundleRefIds: ["seed-ref"],
            bundlePattern: "single",
            sourceType: "jats_xml",
            parser,
            parserVersion: "1.0.0",
            provenanceArtifacts: [
              artifactReference("occurrence-source", `occurrence-1-${parser}`),
            ],
          },
          {
            mentionIndex: 2,
            refId: "seed-ref",
            charOffsetStart: 500,
            charOffsetEnd: 538,
            sourceLocator: {
              kind: "xml_path",
              value: "/article/body/sec[3]/p[1]/xref[1]",
            },
            citationMarker: "[3]",
            rawContext: "The seed was cited without a claim [3].",
            sectionTitle: "References",
            seedRefLabel: "Seed Author, 2020",
            isBundledCitation: false,
            bundleSize: 1,
            bundleRefIds: ["seed-ref"],
            bundlePattern: "single",
            sourceType: "jats_xml",
            parser,
            parserVersion: "1.0.0",
            provenanceArtifacts: [
              artifactReference("occurrence-source", `occurrence-2-${parser}`),
            ],
          },
        ],
      }),
    extractAttributedClaims: ({ mention }) => {
      const claims =
        mention.mentionIndex === 0
          ? [
              {
                text: "The seed showed alpha.",
                supportSpanText: "showed alpha",
                confidence: "high" as const,
              },
              {
                text: "The seed showed alpha.",
                supportSpanText: "showed alpha",
                confidence: "high" as const,
              },
              {
                text: "The seed reported beta.",
                supportSpanText: "reported beta",
                confidence: "medium" as const,
              },
            ]
          : mention.mentionIndex === 1
            ? [
                {
                  text: " THE SEED SHOWED ALPHA. ",
                  supportSpanText: "showed alpha again",
                  confidence: "high" as const,
                },
              ]
            : [];
      return Promise.resolve({
        status: "completed",
        reason:
          claims.length > 0
            ? "Fixture claims extracted"
            : "No attributed claim in this occurrence",
        claims,
        execution: modelExecution(
          `discover-${String(mention.mentionIndex)}`,
          "discover",
        ),
      });
    },
  };
}

async function buildDiscoverArtifact(
  runId = "run-canonical-prepare-fixture",
  parser = "fixture-parser-v1",
): Promise<DiscoverArtifact> {
  const result = await runCanonicalDiscover(
    discoverOptions(),
    discoverAdapters(parser),
  );
  return buildCanonicalDiscoverArtifact({
    result,
    runId,
    createdAt: "2026-07-16T10:05:00.000Z",
    configuration: {
      contentHash: canonicalSha256(discoverOptions()),
    },
    code: {
      revision: "2d1b9f2",
      dirty: false,
    },
  });
}

function scopeAdapters(variant: GroundingVariant): CanonicalScopeAdapters {
  return {
    materializeSeed: ({ seed }) => {
      const execution = {
        kind: "external" as const,
        ...externalExecution("fixture-full-text", `seed-${seed.seedId}`),
      };
      if (
        variant === "seed_text_unavailable" ||
        variant === "acquisition_failed"
      ) {
        return Promise.resolve({
          seedId: seed.seedId,
          status: variant,
          reasonCode:
            variant === "seed_text_unavailable" ? "unavailable" : "transport",
          reason:
            variant === "seed_text_unavailable"
              ? "No inspectable seed manuscript was available."
              : "Seed acquisition failed in transit.",
          provenanceArtifacts: [
            artifactReference("seed-acquisition-trace", variant),
          ],
          execution,
        });
      }
      const text =
        "The seed reports alpha in the primary result and beta in a secondary analysis.";
      return Promise.resolve({
        seedId: seed.seedId,
        status: "materialized",
        reason: "Fixture seed text materialized",
        seedTextArtifact: artifactReference("parsed-seed-text", seed.seedId),
        sourceArtifacts: [artifactReference("raw-seed-text", seed.seedId)],
        parser: {
          kind: "fixture-structured-parser",
          version: "v1",
        },
        blocks: [
          {
            blockId: "body-1",
            text,
            sectionTitle: "Results",
            blockKind: "body_paragraph",
            charOffsetStart: 0,
            charOffsetEnd: text.length,
          },
        ],
        execution,
      });
    },
    groundFamily: ({ family }) => {
      const execution = {
        ...modelExecution(family.familyId, "scope"),
      };
      if (variant === "grounding_failed") {
        return Promise.resolve({
          status: "failed",
          reasonCode: "timeout",
          reason: "Fixture grounding timed out.",
          execution,
        });
      }
      if (variant === "not_found") {
        return Promise.resolve({
          status: "completed",
          rawOutput: {
            status: "not_found",
            detailReason: "The tracked claim was not found.",
            supportSpans: [],
          },
          execution,
        });
      }
      const isBeta = family.normalizedClaim.includes("beta");
      return Promise.resolve({
        status: "completed",
        rawOutput: {
          status: variant === "ambiguous" ? "ambiguous" : "grounded",
          detailReason:
            variant === "ambiguous"
              ? "Several passages could support this family."
              : "The seed directly supports this family.",
          supportSpans: [
            {
              verbatimQuote: isBeta ? "beta" : "reports alpha",
              blockId: "body-1",
            },
          ],
        },
        execution,
      });
    },
  };
}

async function buildScopeArtifact(
  discover: DiscoverArtifact,
  variant: GroundingVariant = "grounded",
): Promise<ScopeArtifact> {
  const result = await runCanonicalScope(discover, scopeAdapters(variant), {
    recordedAt: "2026-07-16T10:10:00.000Z",
    discoverArtifactUri: "fixture://canonical-discover/discover.json",
  });
  return buildCanonicalScopeArtifact({
    result,
    runId: discover.runId,
    createdAt: "2026-07-16T10:15:00.000Z",
    configuration: {
      contentHash: canonicalSha256({ stage: "scope", variant }),
    },
    code: {
      revision: "2d1b9f2",
      dirty: false,
    },
  });
}

function classificationExecution(key: string, kind: "model" | "external") {
  if (kind === "model") {
    return modelExecution(key, "prepare");
  }
  return {
    kind,
    ...externalExecution("fixture-classifier", key),
  };
}

function successfulClassification(
  bundled: boolean,
  bundleSize: number,
  execution: ReturnType<typeof classificationExecution>,
): PrepareClassification {
  return {
    status: "classified",
    citationRole: "substantive_attribution",
    evaluationMode: bundled
      ? "fidelity_bundled_use"
      : "fidelity_specific_claim",
    modifiers: {
      isBundled: bundled,
      isReviewMediated: false,
      bundleSize,
    },
    signals: ["fixture:substantive-attribution"],
    rationale: "The fixture context attributes a result to the seed.",
    confidence: "high",
    execution,
  };
}

function prepareAdapters(
  variant: ClassifierVariant,
  calls?: string[],
  inputs?: CanonicalPrepareClassifierInput[],
): CanonicalPrepareAdapters {
  return {
    classifyCitation: (input) => {
      inputs?.push(input);
      const { family, citationOccurrence } = input;
      calls?.push(
        canonicalSerialize({
          familyId: family.familyId,
          citationOccurrenceId: citationOccurrence.mentionId,
        }),
      );
      const key = `${family.familyId}-${citationOccurrence.mentionId}`;
      if (variant === "deterministic") {
        return Promise.resolve(
          classifyPrepareOccurrenceDeterministically(citationOccurrence),
        );
      }
      if (variant === "fatal") {
        return Promise.resolve({
          status: "failed",
          reasonCode: "quota",
          reason: "Fixture classifier quota was exhausted.",
          execution: classificationExecution(key, "external"),
        });
      }
      if (variant === "malformed") {
        return Promise.resolve({
          status: "classified",
          citationRole: "invented_role",
          evaluationMode: "fidelity_specific_claim",
        });
      }
      if (variant === "ambiguous_and_failed") {
        if (citationOccurrence.mentionIndex === 0) {
          return Promise.resolve({
            status: "ambiguous",
            citationRole: "unclear",
            evaluationMode: "manual_review_role_ambiguous",
            modifiers: {
              isBundled: true,
              isReviewMediated: false,
              bundleSize: citationOccurrence.bundleSize,
            },
            signals: ["fixture:conflicting-signals"],
            rationale: "The citation role is genuinely ambiguous.",
            confidence: "low",
            execution: classificationExecution(key, "model"),
          });
        }
        return Promise.resolve({
          status: "failed",
          reasonCode: "timeout",
          reason: "The classifier timed out for this scoped pair.",
          execution: classificationExecution(key, "external"),
        });
      }
      return Promise.resolve(
        successfulClassification(
          citationOccurrence.isBundledCitation,
          citationOccurrence.bundleSize,
          classificationExecution(
            key,
            citationOccurrence.mentionIndex === 0 ? "model" : "external",
          ),
        ),
      );
    },
  };
}

async function runPrepareFixture(
  options: {
    grounding?: GroundingVariant;
    classifier?: ClassifierVariant;
    parser?: string;
    recordedAt?: string;
  } = {},
): Promise<{
  discover: DiscoverArtifact;
  scope: ScopeArtifact;
  result: CanonicalPrepareResult;
}> {
  const discover = await buildDiscoverArtifact(
    "run-canonical-prepare-fixture",
    options.parser,
  );
  const scope = await buildScopeArtifact(
    discover,
    options.grounding ?? "grounded",
  );
  const result = await runCanonicalPrepare(
    scope,
    discover,
    prepareAdapters(options.classifier ?? "deterministic"),
    {
      recordedAt: options.recordedAt ?? "2026-07-16T10:20:00.000Z",
      scopeArtifactUri: "fixture://canonical-scope/scope.json",
    },
  );
  return { discover, scope, result };
}

function recordsForAlpha(result: CanonicalPrepareResult) {
  return result.payload.records.filter((record) =>
    record.family.normalizedClaim.includes("alpha"),
  );
}

describe("canonical Prepare", () => {
  it("materializes one record per family × occurrence without paper collapse", async () => {
    const { result } = await runPrepareFixture();
    const alphaRecords = recordsForAlpha(result);
    expect(alphaRecords).toHaveLength(2);
    expect(
      new Set(alphaRecords.map((record) => record.citingPaper.paper.paperId)),
    ).toEqual(new Set(["citing-paper"]));
    expect(
      new Set(alphaRecords.map((record) => record.citationOccurrenceId)).size,
    ).toBe(2);

    const bundledRecords = result.payload.records.filter(
      (record) => record.citationOccurrence.mentionIndex === 0,
    );
    expect(bundledRecords).toHaveLength(2);
    expect(new Set(bundledRecords.map((record) => record.familyId)).size).toBe(
      2,
    );
    expect(new Set(bundledRecords.map((record) => record.recordId)).size).toBe(
      2,
    );
  });

  it("separates occurrence-local source claims by family and occurrence", async () => {
    const discover = await buildDiscoverArtifact();
    const scope = await buildScopeArtifact(discover);
    const classifierInputs: CanonicalPrepareClassifierInput[] = [];
    const result = await runCanonicalPrepare(
      scope,
      discover,
      prepareAdapters("deterministic", undefined, classifierInputs),
      { recordedAt: "2026-07-16T10:20:00.000Z" },
    );
    const firstOccurrenceId = discover.payload.citationMentions.find(
      (mention) => mention.mentionIndex === 0,
    )!.mentionId;
    const alphaAtFirst = result.payload.records.find(
      (record) =>
        record.citationOccurrenceId === firstOccurrenceId &&
        record.family.normalizedClaim.includes("alpha"),
    )!;
    const betaAtFirst = result.payload.records.find(
      (record) =>
        record.citationOccurrenceId === firstOccurrenceId &&
        record.family.normalizedClaim.includes("beta"),
    )!;
    expect(
      alphaAtFirst.occurrenceSourceClaimRecords.map(
        (sourceClaim) => sourceClaim.extractedClaimText,
      ),
    ).toEqual(["The seed showed alpha.", "The seed showed alpha."]);
    expect(
      betaAtFirst.occurrenceSourceClaimRecords.map(
        (sourceClaim) => sourceClaim.extractedClaimText,
      ),
    ).toEqual(["The seed reported beta."]);
    expect(
      alphaAtFirst.occurrenceSourceCandidates.map(
        (candidate) => candidate.normalizedClaim,
      ),
    ).toEqual(["the seed showed alpha."]);
    expect(
      betaAtFirst.occurrenceSourceCandidates.map(
        (candidate) => candidate.normalizedClaim,
      ),
    ).toEqual(["the seed reported beta."]);

    const alphaRecords = recordsForAlpha(result);
    expect(alphaRecords).toHaveLength(2);
    expect(
      alphaRecords.every((record) => record.sourceClaimRecords.length === 3),
    ).toBe(true);
    for (const record of alphaRecords) {
      expect(
        record.occurrenceSourceClaimRecords.every(
          (sourceClaim) =>
            sourceClaim.mentionId === record.citationOccurrenceId,
        ),
      ).toBe(true);
    }
    expect(
      new Set(
        alphaRecords.flatMap((record) =>
          record.occurrenceSourceClaimRecords.map(
            (sourceClaim) => sourceClaim.claimRecordId,
          ),
        ),
      ).size,
    ).toBe(3);

    for (const input of classifierInputs) {
      const prepared = result.payload.records.find(
        (record) =>
          record.familyId === input.family.familyId &&
          record.citationOccurrenceId === input.citationOccurrence.mentionId,
      )!;
      expect(input.occurrenceSourceCandidates).toEqual(
        prepared.occurrenceSourceCandidates,
      );
      expect(input.occurrenceSourceClaimRecords).toEqual(
        prepared.occurrenceSourceClaimRecords,
      );
    }
  });

  it("uses exactly family × occurrence identity across implementation changes", async () => {
    const first = await runPrepareFixture({
      classifier: "deterministic",
      parser: "fixture-parser-a",
      recordedAt: "2026-07-16T10:20:00.000Z",
    });
    const second = await runPrepareFixture({
      classifier: "mixed",
      parser: "fixture-parser-b",
      recordedAt: "2026-07-17T10:20:00.000Z",
    });
    expect(
      first.result.payload.records.map((record) => record.recordId),
    ).toEqual(second.result.payload.records.map((record) => record.recordId));
    expect(
      first.result.payload.records.map((record) => record.recordId),
    ).toEqual(
      first.result.payload.records.map((record) =>
        buildCitationInstanceRecordId({
          familyId: record.familyId,
          citationOccurrenceId: record.citationOccurrenceId,
        }),
      ),
    );
    const record = first.result.payload.records[0]!;
    expect(
      buildCitationInstanceRecordId({
        familyId: buildStableId("family", { different: true }),
        citationOccurrenceId: record.citationOccurrenceId,
      }),
    ).not.toBe(record.recordId);
    expect(
      buildCitationInstanceRecordId({
        familyId: record.familyId,
        citationOccurrenceId: buildStableId("mention", { different: true }),
      }),
    ).not.toBe(record.recordId);
  });

  it("changes artifact content without changing record identity when classification changes", async () => {
    const discover = await buildDiscoverArtifact();
    const scope = await buildScopeArtifact(discover);
    const options = { recordedAt: "2026-07-16T10:20:00.000Z" };
    const deterministic = await runCanonicalPrepare(
      scope,
      discover,
      prepareAdapters("deterministic"),
      options,
    );
    const mixed = await runCanonicalPrepare(
      scope,
      discover,
      prepareAdapters("mixed"),
      options,
    );
    expect(
      deterministic.payload.records.map((record) => record.recordId),
    ).toEqual(mixed.payload.records.map((record) => record.recordId));
    const deterministicArtifact = buildCanonicalPrepareArtifact({
      result: deterministic,
      runId: scope.runId,
      createdAt: "2026-07-16T10:25:00.000Z",
    });
    const mixedArtifact = buildCanonicalPrepareArtifact({
      result: mixed,
      runId: scope.runId,
      createdAt: "2026-07-16T10:25:00.000Z",
    });
    expect(mixedArtifact.contentHash).not.toBe(
      deterministicArtifact.contentHash,
    );
    expect(mixedArtifact.artifactId).not.toBe(deterministicArtifact.artifactId);
  });

  it("matches frozen Scope membership and never expands to other mentions", async () => {
    const { discover, scope, result } = await runPrepareFixture();
    const expectedPairs = scope.payload.families
      .flatMap((family) =>
        family.includedCitationOccurrenceIds.map((citationOccurrenceId) =>
          canonicalSerialize({
            familyId: family.familyId,
            citationOccurrenceId,
          }),
        ),
      )
      .sort();
    const actualPairs = result.payload.records
      .map((record) =>
        canonicalSerialize({
          familyId: record.familyId,
          citationOccurrenceId: record.citationOccurrenceId,
        }),
      )
      .sort();
    expect(actualPairs).toEqual(expectedPairs);
    const unscopedOccurrence = discover.payload.citationMentions.find(
      (mention) => mention.mentionIndex === 2,
    )!;
    expect(
      result.payload.records.some(
        (record) =>
          record.citationOccurrenceId === unscopedOccurrence.mentionId,
      ),
    ).toBe(false);
    expect(result.payload.records).toHaveLength(3);
  });

  it("preserves bundled citation and source-locator data exactly", async () => {
    const { discover, result } = await runPrepareFixture();
    const source = discover.payload.citationMentions.find(
      (mention) => mention.mentionIndex === 0,
    )!;
    const records = result.payload.records.filter(
      (record) => record.citationOccurrenceId === source.mentionId,
    );
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.citationOccurrence).toEqual(source);
      expect(record.citationOccurrence).toMatchObject({
        citationMarker: "[2–4]",
        refId: "seed-ref",
        seedRefLabel: "Seed Author, 2020",
        bundleRefIds: ["other-ref-2", "seed-ref", "other-ref-4"],
        bundlePattern: "numeric_range",
        sourceLocator: {
          kind: "xml_path",
          value: "/article/body/sec[2]/p[1]/xref[2]",
        },
      });
    }
  });

  it.each([
    "grounded",
    "ambiguous",
    "not_found",
    "seed_text_unavailable",
    "acquisition_failed",
    "grounding_failed",
  ] as const)(
    "prepares every pair with preserved %s Scope annotation",
    async (grounding) => {
      const { scope, result } = await runPrepareFixture({ grounding });
      expect(result.payload.records).toHaveLength(3);
      for (const record of result.payload.records) {
        const sourceFamily = scope.payload.families.find(
          (family) => family.familyId === record.familyId,
        )!;
        expect(record.family).toEqual(sourceFamily);
        expect(record.family.grounding.status).toBe(grounding);
      }
    },
  );

  it("validates deterministic, model, and external classification provenance", async () => {
    const deterministic = await runPrepareFixture({
      classifier: "deterministic",
    });
    expect(
      deterministic.result.payload.records.every(
        (record) => record.classification.execution.kind === "deterministic",
      ),
    ).toBe(true);
    const deterministicArtifact = buildCanonicalPrepareArtifact({
      result: deterministic.result,
      runId: deterministic.scope.runId,
      createdAt: "2026-07-16T10:25:00.000Z",
    });
    expect(deterministicArtifact.execution.kind).toBe("deterministic");
    expect(deterministicArtifact.execution.replayableFromInputs).toBe(true);

    const mixed = await runPrepareFixture({ classifier: "mixed" });
    const mixedArtifact = buildCanonicalPrepareArtifact({
      result: mixed.result,
      runId: mixed.scope.runId,
      createdAt: "2026-07-16T10:25:00.000Z",
    });
    expect(
      new Set(
        mixed.result.payload.records.map(
          (record) => record.classification.execution.kind,
        ),
      ),
    ).toEqual(new Set(["model", "external"]));
    expect(mixedArtifact.execution.kind).toBe("hybrid");
    expect(mixedArtifact.execution.replayableFromInputs).toBe(false);
    expect(mixedArtifact.provenance.prompts.length).toBeGreaterThan(0);
    expect(mixedArtifact.provenance.models.length).toBeGreaterThan(0);
    expect(
      mixedArtifact.execution.kind !== "deterministic" &&
        mixedArtifact.execution.responseArtifacts.length,
    ).toBe(3);
  });

  it("restricts failed classifications to external or model execution", () => {
    const deterministicExecution = {
      kind: "deterministic" as const,
      implementation: "fixture-deterministic-classifier",
    };
    expect(
      prepareClassificationSchema.safeParse({
        status: "failed",
        reasonCode: "timeout",
        reason: "A deterministic timeout is semantically impossible.",
        execution: deterministicExecution,
      }).success,
    ).toBe(false);
    expect(
      canonicalPrepareClassificationResultSchema.safeParse({
        status: "failed",
        reasonCode: "quota",
        reason: "A deterministic quota failure is semantically impossible.",
        execution: deterministicExecution,
      }).success,
    ).toBe(false);

    const external = classificationExecution(
      "external-failure-boundary",
      "external",
    );
    const model = classificationExecution("model-failure-boundary", "model");
    for (const execution of [external, model]) {
      expect(
        prepareClassificationSchema.safeParse({
          status: "failed",
          reasonCode: "timeout",
          reason: "Fixture nonfatal provider failure.",
          execution,
        }).success,
      ).toBe(true);
      expect(
        canonicalPrepareClassificationResultSchema.safeParse({
          status: "failed",
          reasonCode: "quota",
          reason: "Fixture fatal provider failure.",
          execution,
        }).success,
      ).toBe(true);
    }
  });

  it("retains ambiguous and nonfatal failed classification as records", async () => {
    const { result } = await runPrepareFixture({
      classifier: "ambiguous_and_failed",
    });
    expect(result.payload.records).toHaveLength(3);
    expect(
      result.payload.records.filter(
        (record) => record.classification.status === "ambiguous",
      ),
    ).toHaveLength(2);
    expect(
      result.payload.records.filter(
        (record) => record.classification.status === "failed",
      ),
    ).toHaveLength(1);
    expect(
      result.payload.records.find(
        (record) => record.classification.status === "failed",
      )?.classification,
    ).toMatchObject({
      status: "failed",
      reasonCode: "timeout",
      reason: "The classifier timed out for this scoped pair.",
    });
  });

  it("queues unclear roles for manual review and keeps clear bundled roles classified", () => {
    const occurrence = (
      overrides: Partial<DiscoverCitationOccurrence>,
    ): DiscoverCitationOccurrence =>
      ({
        mentionId: "mention-fixture",
        seedId: "seed-1",
        citingPaperRecordId: "citing-1",
        citingPaperId: "paper-1",
        citedPaperId: "seed-paper",
        mentionIndex: 0,
        targetRefIds: ["ref-seed"],
        identityStrength: "weak_context_fallback",
        citationMarker: "Belicova et al., 2021",
        rawContext: "",
        isBundledCitation: false,
        bundleSize: 1,
        bundleRefIds: ["ref-seed"],
        bundlePattern: "single",
        observationProvenance: {
          sourceType: "fixture",
          parser: "fixture",
          artifacts: [artifactReference("parsed-paper", "fixture")],
        },
        ...overrides,
      }) as DiscoverCitationOccurrence;

    const unclear = classifyPrepareOccurrenceDeterministically(
      occurrence({
        // Author–year without Results/Discussion or narrative frames stays unclear.
        rawContext:
          "Additional related observations appear near Belicova et al., 2021 without a decisive claim verb.",
        sectionTitle: "Supplementary Note",
      }),
    );
    expect(unclear).toMatchObject({
      status: "ambiguous",
      citationRole: "unclear",
      evaluationMode: "manual_review_role_ambiguous",
    });

    const bundledClear = classifyPrepareOccurrenceDeterministically(
      occurrence({
        mentionIndex: 1,
        rawContext:
          "Earlier work showed and demonstrated that VRN shapes Pvalb expression (Smith 2019; Belicova et al., 2021; Jones 2020).",
        sectionTitle: "Results",
        isBundledCitation: true,
        bundleSize: 3,
        bundleRefIds: ["ref-a", "ref-seed", "ref-b"],
        bundlePattern: "semicolon_list",
      }),
    );
    expect(bundledClear).toMatchObject({
      status: "classified",
      citationRole: "substantive_attribution",
      evaluationMode: "fidelity_bundled_use",
    });
  });

  it("keeps review-mediated occurrences with missing spans in manual review instead of throwing", () => {
    const occurrence = {
      mentionId: "mention-review",
      seedId: "seed-1",
      citingPaperRecordId: "citing-review",
      citingPaperId: "paper-review",
      citedPaperId: "seed-paper",
      mentionIndex: 0,
      targetRefIds: ["ref-seed"],
      identityStrength: "weak_context_fallback",
      citationMarker: "Belicova et al., 2021",
      rawContext:
        "Reviews summarize that VRN neurons express Pvalb (Belicova et al., 2021).",
      isBundledCitation: false,
      bundleSize: 1,
      bundleRefIds: ["ref-seed"],
      bundlePattern: "single",
      observationProvenance: {
        sourceType: "fixture",
        parser: "fixture",
        artifacts: [artifactReference("parsed-paper", "fixture")],
      },
    } as DiscoverCitationOccurrence;
    const missingSpanClaim = {
      claimRecordId: "claim-review",
      extractedClaimText: "VRN neurons express Pvalb.",
      confidence: "high",
    } as never;

    const classification = classifyPrepareOccurrenceDeterministically(
      occurrence,
      {
        isReviewMediated: true,
        occurrenceSourceClaimRecords: [missingSpanClaim],
      },
    );
    expect(classification).toMatchObject({
      status: "ambiguous",
      citationRole: "unclear",
      evaluationMode: "manual_review_extraction_limited",
      modifiers: { isReviewMediated: true },
    });
  });

  it("uses the weakest extraction confidence so low-information citations are gated, not queued", () => {
    const occurrence = {
      mentionId: "mention-low",
      seedId: "seed-1",
      citingPaperRecordId: "citing-low",
      citingPaperId: "paper-low",
      citedPaperId: "seed-paper",
      mentionIndex: 0,
      targetRefIds: ["ref-seed"],
      identityStrength: "weak_context_fallback",
      citationMarker: "[12]",
      rawContext: "See also related work [12].",
      isBundledCitation: false,
      bundleSize: 1,
      bundleRefIds: ["ref-seed"],
      bundlePattern: "single",
      observationProvenance: {
        sourceType: "fixture",
        parser: "fixture",
        artifacts: [artifactReference("parsed-paper", "fixture")],
      },
    } as DiscoverCitationOccurrence;
    const rawContext = occurrence.rawContext;
    const claims = [
      {
        claimRecordId: "claim-a",
        extractedClaimText: "Related work exists.",
        confidence: "high",
        supportSpan: {
          text: "See also related work",
          charOffsetStart: 0,
          charOffsetEnd: rawContext.indexOf(" [12]"),
          verificationStatus: "verified_exact",
        },
      },
      {
        claimRecordId: "claim-b",
        extractedClaimText: "Related work exists.",
        confidence: "low",
        supportSpan: {
          text: "See also related work",
          charOffsetStart: 0,
          charOffsetEnd: rawContext.indexOf(" [12]"),
          verificationStatus: "verified_exact",
        },
      },
    ] as never[];

    const classification = classifyPrepareOccurrenceDeterministically(
      occurrence,
      { occurrenceSourceClaimRecords: claims },
    );
    expect(classification).toMatchObject({
      status: "classified",
      confidence: "low",
      evaluationMode: "skip_low_information",
    });
  });

  it("fails the stage on fatal classifier failures", async () => {
    const discover = await buildDiscoverArtifact();
    const scope = await buildScopeArtifact(discover);
    await expect(
      runCanonicalPrepare(scope, discover, prepareAdapters("fatal"), {
        recordedAt: "2026-07-16T10:20:00.000Z",
      }),
    ).rejects.toBeInstanceOf(CanonicalPrepareFatalError);
  });

  it("has no sampling or cap boundary and loses no outcomes", async () => {
    expect(
      canonicalPrepareOptionsSchema.safeParse({
        recordedAt: "2026-07-16T10:20:00.000Z",
        targetSize: 1,
      }).success,
    ).toBe(false);
    const { scope, result } = await runPrepareFixture();
    const expectedTotal = scope.payload.families.reduce(
      (total, family) => total + family.includedCitationOccurrenceIds.length,
      0,
    );
    expect(result.payload.records).toHaveLength(expectedTotal);
    expect(result.decisions).toHaveLength(expectedTotal);
  });

  it("rejects malformed classifier output at the adapter boundary", async () => {
    const discover = await buildDiscoverArtifact();
    const scope = await buildScopeArtifact(discover);
    await expect(
      runCanonicalPrepare(scope, discover, prepareAdapters("malformed"), {
        recordedAt: "2026-07-16T10:20:00.000Z",
      }),
    ).rejects.toBeInstanceOf(CanonicalPrepareBoundaryError);
  });

  it("rejects dangling, duplicate, inconsistent, and missing payload records", async () => {
    const { result } = await runPrepareFixture();

    const danglingFamily = structuredClone(result.payload);
    danglingFamily.records[0]!.familyId = buildStableId("family", {
      missing: true,
    });
    expect(prepareArtifactPayloadSchema.safeParse(danglingFamily).success).toBe(
      false,
    );

    const danglingOccurrence = structuredClone(result.payload);
    danglingOccurrence.records[0]!.citationOccurrenceId = buildStableId(
      "mention",
      { missing: true },
    );
    expect(
      prepareArtifactPayloadSchema.safeParse(danglingOccurrence).success,
    ).toBe(false);

    const danglingPaper = structuredClone(result.payload);
    danglingPaper.records[0]!.citingPaper.paper.paperId = "different-paper";
    expect(prepareArtifactPayloadSchema.safeParse(danglingPaper).success).toBe(
      false,
    );

    const duplicate = structuredClone(result.payload);
    duplicate.records.push(structuredClone(duplicate.records[0]!));
    expect(prepareArtifactPayloadSchema.safeParse(duplicate).success).toBe(
      false,
    );

    const duplicateId = structuredClone(result.payload);
    duplicateId.records[1]!.recordId = duplicateId.records[0]!.recordId;
    expect(prepareArtifactPayloadSchema.safeParse(duplicateId).success).toBe(
      false,
    );

    const inconsistentLineage = structuredClone(result.payload);
    inconsistentLineage.records[0]!.lineage.runId = "different-run";
    expect(
      prepareArtifactPayloadSchema.safeParse(inconsistentLineage).success,
    ).toBe(false);

    const missing = structuredClone(result.payload);
    missing.records.pop();
    expect(prepareArtifactPayloadSchema.safeParse(missing).success).toBe(false);
  });

  it("rejects invalid occurrence-local source subsets", async () => {
    const { result } = await runPrepareFixture();
    const isInvalid = (payload: typeof result.payload) =>
      !prepareArtifactPayloadSchema.safeParse(payload).success;
    const findRecord = (
      payload: typeof result.payload,
      claim: "alpha" | "beta",
      mentionIndex: number,
    ) =>
      payload.records.find(
        (record) =>
          record.family.normalizedClaim.includes(claim) &&
          record.citationOccurrence.mentionIndex === mentionIndex,
      )!;

    const emptyCandidates = structuredClone(result.payload);
    findRecord(emptyCandidates, "alpha", 0).occurrenceSourceCandidates = [];
    expect(isInvalid(emptyCandidates)).toBe(true);

    const emptyClaims = structuredClone(result.payload);
    findRecord(emptyClaims, "alpha", 0).occurrenceSourceClaimRecords = [];
    expect(isInvalid(emptyClaims)).toBe(true);

    const danglingCandidate = structuredClone(result.payload);
    findRecord(
      danglingCandidate,
      "alpha",
      0,
    ).occurrenceSourceCandidates[0]!.canonicalClaim =
      "Tampered candidate content";
    expect(isInvalid(danglingCandidate)).toBe(true);

    const crossOccurrence = structuredClone(result.payload);
    const crossOccurrenceSource = findRecord(crossOccurrence, "alpha", 0)
      .occurrenceSourceClaimRecords[0]!;
    findRecord(crossOccurrence, "alpha", 1).occurrenceSourceClaimRecords = [
      crossOccurrenceSource,
    ];
    expect(isInvalid(crossOccurrence)).toBe(true);

    const crossFamily = structuredClone(result.payload);
    findRecord(crossFamily, "alpha", 0).occurrenceSourceCandidates = findRecord(
      crossFamily,
      "beta",
      0,
    ).occurrenceSourceCandidates;
    expect(isInvalid(crossFamily)).toBe(true);

    const extraClaim = structuredClone(result.payload);
    findRecord(extraClaim, "alpha", 1).occurrenceSourceClaimRecords.push(
      findRecord(extraClaim, "alpha", 0).occurrenceSourceClaimRecords[0]!,
    );
    expect(isInvalid(extraClaim)).toBe(true);

    const omittedClaim = structuredClone(result.payload);
    findRecord(omittedClaim, "alpha", 0).occurrenceSourceClaimRecords.pop();
    expect(isInvalid(omittedClaim)).toBe(true);

    const reorderedClaims = structuredClone(result.payload);
    findRecord(
      reorderedClaims,
      "alpha",
      0,
    ).occurrenceSourceClaimRecords.reverse();
    expect(isInvalid(reorderedClaims)).toBe(true);
  });

  it("verifies exact Scope/Discover lineage before classifier execution", async () => {
    const discover = await buildDiscoverArtifact();
    const scope = await buildScopeArtifact(discover);
    const otherDiscover = await buildDiscoverArtifact("different-run");
    const calls: string[] = [];
    await expect(
      runCanonicalPrepare(
        scope,
        otherDiscover,
        prepareAdapters("deterministic", calls),
        { recordedAt: "2026-07-16T10:20:00.000Z" },
      ),
    ).rejects.toBeInstanceOf(CanonicalPrepareBoundaryError);
    expect(calls).toEqual([]);

    const tamperedScope = structuredClone(scope);
    tamperedScope.payload.families[0]!.trackedClaim = "Tampered claim";
    await expect(
      runCanonicalPrepare(
        tamperedScope,
        discover,
        prepareAdapters("deterministic", calls),
        { recordedAt: "2026-07-16T10:20:00.000Z" },
      ),
    ).rejects.toBeInstanceOf(CanonicalPrepareBoundaryError);
    expect(calls).toEqual([]);
  });

  it("round-trips only current Prepare and detects tampering", async () => {
    const { scope, result } = await runPrepareFixture({ classifier: "mixed" });
    const artifact = buildCanonicalPrepareArtifact({
      result,
      runId: scope.runId,
      createdAt: "2026-07-16T10:25:00.000Z",
      configuration: {
        contentHash: canonicalSha256({ stage: "prepare", version: 1 }),
      },
      code: {
        revision: "2d1b9f2",
        dirty: false,
      },
    });
    const directory = mkdtempSync(join(tmpdir(), "palimpsest-prepare-"));
    const artifactPath = join(directory, "prepare.json");
    try {
      writeCanonicalArtifact("prepare", artifactPath, artifact);
      expect(loadCanonicalArtifact("prepare", artifactPath)).toEqual(artifact);

      const tampered = structuredClone(artifact);
      const classification = tampered.payload.records[0]!.classification;
      if (classification.status !== "failed") {
        classification.rationale = "Tampered rationale";
      }
      writeFileSync(artifactPath, JSON.stringify(tampered), "utf8");
      expect(() => loadCanonicalArtifact("prepare", artifactPath)).toThrow(
        /contentHash|artifactId/,
      );

      expect(() =>
        writeCanonicalArtifact("prepare", artifactPath, {
          ...artifact,
          artifactVersion: 2,
        } as unknown as typeof artifact),
      ).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("proves Discover → Scope → Prepare exact accounting without information loss", async () => {
    const { discover, scope, result } = await runPrepareFixture({
      classifier: "mixed",
    });
    expect(result.payload.lineage).toMatchObject({
      runId: discover.runId,
      scopeArtifact: {
        artifactId: scope.artifactId,
        contentHash: scope.contentHash,
        canonicalStage: "scope",
      },
      discoverArtifact: {
        artifactId: discover.artifactId,
        contentHash: discover.contentHash,
        canonicalStage: "discover",
      },
    });
    for (const record of result.payload.records) {
      expect(
        scope.payload.families.find(
          (family) => family.familyId === record.familyId,
        ),
      ).toEqual(record.family);
      expect(record.sourceCandidates).toEqual(
        record.family.candidateIds.map(
          (candidateId) =>
            discover.payload.claimCandidates.find(
              (candidate) => candidate.candidateId === candidateId,
            )!,
        ),
      );
      expect(record.sourceClaimRecords).toEqual(
        record.family.sourceClaimRecordIds.map(
          (sourceClaimRecordId) =>
            discover.payload.attributedClaimRecords.find(
              (sourceClaim) =>
                sourceClaim.claimRecordId === sourceClaimRecordId,
            )!,
        ),
      );
      expect(
        discover.payload.seeds.find(
          (seed) => seed.seedId === record.family.seedId,
        ),
      ).toEqual(record.seed);
      expect(
        discover.payload.citingPapers.find(
          (paper) =>
            paper.citingPaperRecordId ===
            record.citationOccurrence.citingPaperRecordId,
        ),
      ).toEqual(record.citingPaper);
      expect(
        discover.payload.citationMentions.find(
          (mention) => mention.mentionId === record.citationOccurrenceId,
        ),
      ).toEqual(record.citationOccurrence);
    }
    expect(result.payload.records.map((record) => record.recordId)).toEqual(
      [...result.payload.records].map((record) => record.recordId).sort(),
    );
  });
});
