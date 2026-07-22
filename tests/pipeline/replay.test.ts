import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { adaptivePortfolioPolicySchema } from "../../src/contract/candidate-selection-policy.js";
import type { ArtifactReference } from "../../src/contract/lean-artifacts.js";
import {
  mapFullTextAcquisitionFailure,
  selectSeedReferenceMentions,
} from "../../src/pipeline/canonical-production-adapters.js";
import {
  buildCanonicalDiscoverArtifact,
  runCanonicalDiscover,
  type CanonicalDiscoverAdapters,
} from "../../src/pipeline/canonical-discover.js";
import { parseParsedPaperDocument } from "../../src/retrieval/parsed-paper.js";
import {
  buildStableId,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/pipeline/vrn-replay",
);
const SEED_DOI = "10.1000/jin.20210042";
const PVALB_CLAIM =
  "Pvalb+ fast-spiking interneurons increase gamma power after 40 Hz stimulation.";
const GABA_CLAIM =
  "GABAergic interneurons play an important role in the brain.";

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

function modelExecution(key: string) {
  return {
    kind: "model" as const,
    provider: "fixture-model-provider",
    model: "fixture-model",
    promptId: "canonical-attributed-claim-extraction",
    promptVersion: "v1",
    promptContentHash: canonicalSha256({ prompt: "vrn-replay" }),
    requestHash: canonicalSha256({ key, direction: "request" }),
    requestArtifact: artifactReference("model-request", key),
    responseArtifact: artifactReference("model-response", key),
  };
}

function harvestFromFixtureXml(xmlPath: string, paperId: string) {
  const xml = readFileSync(xmlPath, "utf8");
  const parsed = parseParsedPaperDocument(xml, "jats_xml");
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error(`Failed to parse ${xmlPath}: ${parsed.error}`);
  }
  const seedMentions = selectSeedReferenceMentions(
    parsed.data.mentions,
    "seed",
  );
  return {
    materialization: {
      status: "succeeded" as const,
      reason: "Recorded VRN fixture materialized",
      provenanceArtifacts: [
        artifactReference("raw-full-text", paperId),
        artifactReference("parsed-full-text", paperId),
      ],
    },
    harvest: {
      status: "succeeded" as const,
      reason: `Harvested ${String(seedMentions.length)} seed occurrence(s)`,
      provenanceArtifacts: [artifactReference("mention-harvest", paperId)],
    },
    mentions: seedMentions.map((mention) => ({
      mentionIndex: mention.mentionIndex,
      refId: mention.refId,
      targetRefIds: mention.targetRefIds,
      ...(mention.charOffsetStart != null && mention.charOffsetEnd != null
        ? {
            charOffsetStart: mention.charOffsetStart,
            charOffsetEnd: mention.charOffsetEnd,
          }
        : {}),
      ...(mention.sourceLocator
        ? { sourceLocator: mention.sourceLocator }
        : {}),
      locationQuality: mention.locationQuality,
      citationGroupOrdinal: mention.citationGroupOrdinal,
      citationMarker: mention.citationMarker,
      rawContext: mention.rawContext,
      ...(mention.sectionTitle ? { sectionTitle: mention.sectionTitle } : {}),
      seedRefLabel: "Belicova, 2020",
      isBundledCitation: mention.isBundledCitation,
      bundleSize: mention.bundleSize,
      bundleRefIds: mention.bundleRefIds,
      bundlePattern: mention.bundlePattern,
      sourceType: mention.sourceType,
      parser: mention.parser,
      parserVersion: parsed.data.parserVersion,
      provenanceArtifacts: [
        artifactReference(
          "source-citation-occurrence",
          `${paperId}-${String(mention.mentionIndex)}`,
        ),
      ],
    })),
  };
}

function buildReplayAdapters(): CanonicalDiscoverAdapters {
  return {
    resolveSeed: ({ doi }) =>
      Promise.resolve({
        status: "resolved",
        paper: {
          paperId: "vrn-seed",
          providerRecordId: "https://openalex.org/Wseed",
          title: "Visual experience and VRN circuit maturation",
          doi,
          authors: ["Belicova L"],
          publicationYear: 2020,
        },
        execution: externalExecution("openalex", `resolve-${doi}`),
      }),
    retrieveCitingNeighborhood: () =>
      Promise.resolve({
        status: "completed",
        providerReportedTotal: 3,
        coverage: "complete",
        papers: [
          {
            providerRecordId: "provider-paywalled",
            paperId: "citing-paywalled",
            title: "Paywalled citer",
            doi: "10.2000/paywalled",
            authors: ["Pay Wall"],
            publicationYear: 2021,
            paperType: "journal-article",
            fullTextAvailability: "unavailable",
            provenanceArtifacts: [
              artifactReference("provider-paper-record", "paywalled"),
            ],
          },
          {
            providerRecordId: "provider-bundled",
            paperId: "citing-bundled",
            title: "Bundled and repeated citer",
            doi: "10.2000/bundled",
            authors: ["Bundle Author"],
            publicationYear: 2022,
            paperType: "journal-article",
            fullTextAvailability: "available",
            provenanceArtifacts: [
              artifactReference("provider-paper-record", "bundled"),
            ],
          },
          {
            providerRecordId: "provider-gaba",
            paperId: "citing-gaba",
            title: "GABAergic paraphrase citer",
            doi: "10.2000/gaba",
            authors: ["Gaba Author"],
            publicationYear: 2023,
            paperType: "journal-article",
            fullTextAvailability: "available",
            provenanceArtifacts: [
              artifactReference("provider-paper-record", "gaba"),
            ],
          },
        ],
        pageArtifacts: [artifactReference("neighborhood-page", "1")],
        execution: externalExecution("openalex", "neighborhood"),
      }),
    harvestMentions: ({ citingPaper }) => {
      if (citingPaper.paperId === "citing-paywalled") {
        const mapped = mapFullTextAcquisitionFailure({
          failureCode: "paywall",
          error: "HTTP 403 from publisher PDF endpoint",
        });
        return Promise.resolve({
          materialization: {
            status: "unavailable",
            reasonCode: mapped.reasonCode,
            reason: mapped.reason,
            provenanceArtifacts: [
              artifactReference("acquisition-failure", citingPaper.paperId),
            ],
          },
          harvest: {
            status: "not_attempted",
            reason: "Harvest not attempted after materialization failure.",
            provenanceArtifacts: [
              artifactReference("harvest-not-attempted", citingPaper.paperId),
            ],
          },
          mentions: [],
        });
      }
      if (citingPaper.paperId === "citing-bundled") {
        return Promise.resolve(
          harvestFromFixtureXml(
            join(FIXTURE_ROOT, "citing-bundled-repeated.jats.xml"),
            citingPaper.paperId,
          ),
        );
      }
      return Promise.resolve(
        harvestFromFixtureXml(
          join(FIXTURE_ROOT, "citing-gaba-redundant.jats.xml"),
          citingPaper.paperId,
        ),
      );
    },
    extractAttributedClaims: ({ citingPaper, mention }) => {
      const text =
        citingPaper.paperId === "citing-bundled" &&
        mention.rawContext.toLowerCase().includes("pvalb")
          ? PVALB_CLAIM
          : GABA_CLAIM;
      return Promise.resolve({
        status: "completed",
        reason: "Recorded VRN claim extraction",
        claims: [
          {
            text,
            supportSpanText: mention.rawContext.slice(
              0,
              Math.min(48, mention.rawContext.length),
            ),
            confidence: "high",
          },
        ],
        execution: modelExecution(
          `${citingPaper.paperId}-${String(mention.mentionIndex)}`,
        ),
      });
    },
  };
}

describe("VRN recorded Discover replay", () => {
  it("emits one seed occurrence per citation group with Pvalb portfolio coverage", async () => {
    const options = {
      seeds: [
        {
          doi: SEED_DOI,
          provenanceArtifacts: [artifactReference("seed-input", SEED_DOI)],
        },
      ],
      neighborhood: {
        provider: "openalex",
        query: "works-citing-seed",
        limit: 25,
      },
      probeBudget: 3,
      candidateSelection: adaptivePortfolioPolicySchema.parse({
        mode: "adaptive_portfolio",
        minFamilies: 2,
        maxFamilies: 5,
        maxPreparedRecords: 20,
      }),
      recordedAt: "2026-07-19T12:00:00.000Z",
    };
    const result = await runCanonicalDiscover(
      options,
      buildReplayAdapters(),
    );
    const artifact = buildCanonicalDiscoverArtifact({
      result,
      runId: "run-vrn-replay",
      createdAt: "2026-07-19T12:05:00.000Z",
      configuration: {
        contentHash: canonicalSha256(options),
      },
    });
    expect(artifact.canonicalStage).toBe("discover");
    expect(result.payload.citationMentions.length).toBeGreaterThanOrEqual(2);

    const bundledMentions = result.payload.citationMentions.filter(
      (mention) => mention.citingPaperId === "citing-bundled",
    );
    expect(bundledMentions).toHaveLength(2);
    expect(
      bundledMentions.every((mention) => mention.targetRefIds.includes("seed")),
    ).toBe(true);
    expect(
      new Set(bundledMentions.map((mention) => mention.mentionId)).size,
    ).toBe(2);
    expect(
      bundledMentions.some(
        (mention) =>
          mention.isBundledCitation &&
          mention.bundleRefIds.includes("r1") &&
          mention.bundleRefIds.includes("seed"),
      ),
    ).toBe(true);
    expect(bundledMentions.some((mention) => !mention.isBundledCitation)).toBe(
      true,
    );

    const paywalled = result.payload.citingPapers.find(
      (paper) => paper.paper.paperId === "citing-paywalled",
    );
    expect(paywalled?.materialization.status).toBe("unavailable");
    expect(paywalled?.materialization).toMatchObject({
      reasonCode: "unavailable",
    });

    const claimTexts = result.payload.attributedClaimRecords.map(
      (claim) => claim.extractedClaimText,
    );
    expect(claimTexts).toContain(PVALB_CLAIM);
    expect(claimTexts).toContain(GABA_CLAIM);

    const selected = result.payload.candidateDispositions.filter(
      (disposition) => disposition.selectedForScope,
    );
    expect(
      selected.some((disposition) => {
        const candidate = result.payload.claimCandidates.find(
          (entry) => entry.candidateId === disposition.candidateId,
        );
        return candidate?.canonicalClaim === PVALB_CLAIM;
      }),
    ).toBe(true);
    expect(
      selected.every((disposition) => disposition.annotation != null),
    ).toBe(true);
    expect(artifact.payload.seeds[0]?.doi).toBe(SEED_DOI);
  });
});
