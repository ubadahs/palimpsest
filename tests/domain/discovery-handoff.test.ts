import { describe, expect, it } from "vitest";

import {
  deserializeHandoffMap,
  discoveryHandoffFileSchema,
  serializeHandoffMap,
  validateDiscoveryHandoffBoundary,
  type DiscoveryHandoffMap,
} from "../../src/domain/discovery-handoff.js";
import type {
  FamilyGroundingTrace,
  HarvestedSeedMention,
  ResolvedPaper,
} from "../../src/domain/types.js";

const seedPaper: ResolvedPaper = {
  id: "seed-paper",
  doi: "10.1234/seed",
  title: "Seed paper",
  authors: ["Seed Author"],
  source: "openalex",
  fullTextHints: {
    providerAvailability: "available",
    repositoryUrl: "https://example.test/seed.xml",
  },
  paperType: "article",
  referencedWorksCount: 20,
  publicationYear: 2020,
};

const citingPaper: ResolvedPaper = {
  id: "citing-paper",
  doi: "10.1234/citing",
  title: "Citing paper",
  authors: ["Citing Author"],
  source: "openalex",
  fullTextHints: {
    providerAvailability: "available",
    repositoryUrl: "https://example.test/citing.xml",
  },
  paperType: "article",
  referencedWorksCount: 30,
  publicationYear: 2024,
};

const mention: HarvestedSeedMention = {
  mentionId: "mention-1",
  citingPaperId: citingPaper.id,
  citedPaperId: seedPaper.id,
  citationMarker: "(Seed Author, 2020)",
  rawContext: "Seed Author (2020) reported the measured effect.",
  sectionTitle: "Discussion",
  sourceType: "jats_xml",
  provenance: {
    citingPaperTitle: citingPaper.title,
    parserKind: "jats",
    acquisitionMethod: "pmc_xml",
  },
  harvestOutcome: "success",
  seedRefLabel: "Seed Author, 2020",
};

const groundingTrace: FamilyGroundingTrace = {
  familyId: "family-1",
  canonicalTrackedClaim: "The measured effect changed.",
  grounding: {
    status: "grounded",
    analystClaim: "The measured effect changed.",
    normalizedClaim: "The measured effect changed.",
    supportSpans: [
      {
        text: "The intervention changed the measured effect.",
        sectionTitle: "Results",
        blockKind: "body_paragraph",
      },
    ],
    blocksDownstream: false,
    detailReason: "A verbatim support span was found.",
  },
  llmUsage: {
    inputTokens: 100,
    cacheReadTokens: 20,
  },
};

function makeHandoffMap(): DiscoveryHandoffMap {
  return new Map([
    [
      "10.1234/seed",
      {
        doi: "10.1234/seed",
        resolvedPaper: seedPaper,
        citingPapersRaw: [citingPaper],
        mentionsByPaperId: new Map([[citingPaper.id, [mention]]]),
        groundingByFamilyId: new Map([
          [groundingTrace.familyId, groundingTrace],
        ]),
      },
    ],
  ]);
}

describe("discovery handoff boundary", () => {
  it("round-trips the versioned representation", () => {
    const serialized = serializeHandoffMap(makeHandoffMap());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;

    const file = discoveryHandoffFileSchema.parse(
      JSON.parse(serialized.data) as unknown,
    );
    expect(file.schemaVersion).toBe(1);
    expect(file.artifactVersion).toBe(1);
    expect(file.artifactType).toBe("palimpsest-discovery-handoffs");

    const restored = deserializeHandoffMap(serialized.data);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.data).toEqual(makeHandoffMap());
  });

  it("rejects an unversioned handoff record", () => {
    const serialized = serializeHandoffMap(makeHandoffMap());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const file = discoveryHandoffFileSchema.parse(
      JSON.parse(serialized.data) as unknown,
    );

    const restored = deserializeHandoffMap(JSON.stringify(file.handoffs));
    expect(restored.ok).toBe(false);
    if (!restored.ok) {
      expect(restored.error).toMatch(/Invalid versioned discovery handoff/);
    }
  });

  it("gives fresh and restored runs the same validated map", () => {
    const freshBoundary = validateDiscoveryHandoffBoundary(makeHandoffMap());
    expect(freshBoundary.ok).toBe(true);
    if (!freshBoundary.ok) return;

    const restored = deserializeHandoffMap(freshBoundary.data.serialized);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    expect(freshBoundary.data.handoffs).toEqual(restored.data);
    const reserialized = serializeHandoffMap(restored.data);
    expect(reserialized).toEqual({
      ok: true,
      data: freshBoundary.data.serialized,
    });
  });

  it("rejects malformed and content-tampered versioned input", () => {
    const malformed = deserializeHandoffMap(
      JSON.stringify({
        schemaVersion: 1,
        artifactVersion: 1,
        artifactType: "palimpsest-discovery-handoffs",
        contentHash: "0".repeat(64),
        handoffs: {
          "10.1234/seed": {
            doi: "10.1234/seed",
          },
        },
      }),
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.error).toMatch(
        /Invalid versioned discovery handoff.*resolvedPaper/,
      );
    }

    const serialized = serializeHandoffMap(makeHandoffMap());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const file = discoveryHandoffFileSchema.parse(
      JSON.parse(serialized.data) as unknown,
    );
    const tampered = deserializeHandoffMap(
      JSON.stringify({
        ...file,
        contentHash: "0".repeat(64),
      }),
    );
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) {
      expect(tampered.error).toMatch(/contentHash/);
    }
  });

  it("returns a diagnostic failure for invalid fresh maps", () => {
    const invalid = makeHandoffMap();
    const handoff = invalid.get("10.1234/seed")!;
    handoff.mentionsByPaperId = new Map([["wrong-paper", [mention]]]);

    const validated = validateDiscoveryHandoffBoundary(invalid);
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.error).toMatch(
        /Invalid fresh discovery handoff.*citingPaperId/,
      );
    }
  });

  it("rejects invalid JSON and unversioned files", () => {
    expect(deserializeHandoffMap("{").ok).toBe(false);
    const legacy = deserializeHandoffMap(
      JSON.stringify({
        "10.1234/seed": {
          doi: "10.1234/seed",
          resolvedPaper: seedPaper,
          citingPapersRaw: [],
          mentionsByPaperId: [],
          groundingByFamilyId: {},
        },
      }),
    );
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) {
      expect(legacy.error).toMatch(/Invalid versioned discovery handoff/);
    }
  });
});
