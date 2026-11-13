/** Shared fixtures for the stage production-adapter tests. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppConfig } from "../../src/config/app-config.js";
import type { LLMClient } from "../../src/integrations/llm-client.js";
import { createProvenanceStore } from "../../src/pipeline/provenance-store.js";

const tempRoots: string[] = [];

/** Removes the provenance stores `makeStore` created; call from `afterEach`. */
export function removeStores(): void {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
}

export function makeStore() {
  const root = mkdtempSync(join(tmpdir(), "provenance-"));
  tempRoots.push(root);
  return createProvenanceStore(root);
}

export function appConfig(): AppConfig {
  return {
    nodeEnv: "test",
    databasePath: ":memory:",
    providerBaseUrls: {
      openAlex: "https://example.test/openalex",
      semanticScholar: "https://example.test/s2",
      bioRxiv: "https://example.test/biorxiv",
      grobid: "https://example.test/grobid",
    },
    grobidConcurrency: 2,
    openAlexEmail: undefined,
    semanticScholarApiKey: undefined,
    anthropicApiKey: undefined,
    institutionalProxyUrl: undefined,
  };
}

export const FIXTURE_RECORD = {
  purpose: "attributed-claim-extraction",
  model: "fixture-model",
  attempted: true,
  successful: true,
  failed: false,
  billable: false,
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  latencyMs: 1,
  finishReason: "stop",
  timestamp: "2026-07-17T12:00:00.000Z",
  estimatedCostUsd: 0,
} as const;

/** Answers structured-output calls with a fixed object. */
export function llmClientReturning(object: unknown): LLMClient {
  return {
    generateObject: () => Promise.resolve({ object, record: FIXTURE_RECORD }),
    getLedger: () => ({
      totalCalls: 0,
      totalAttemptedCalls: 0,
      totalSuccessfulCalls: 0,
      totalFailedCalls: 0,
      totalBillableCalls: 0,
      totalExactCacheHits: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalEstimatedCostUsd: 0,
      byPurpose: {},
      calls: [],
    }),
  } as LLMClient;
}

export const seed = {
  status: "resolved" as const,
  paper: {
    paperId: "seed-paper",
    providerRecordId: "https://openalex.org/W123",
    title: "Seed paper",
    doi: "10.1000/seed",
    authors: ["Seed Author"],
  },
  execution: {
    provider: "openalex",
    requestHash: "a".repeat(64),
    requestArtifact: {
      artifactId: `fixture_${"a".repeat(64)}`,
      contentHash: "a".repeat(64),
      role: "request",
    },
    responseArtifact: {
      artifactId: `fixture_${"b".repeat(64)}`,
      contentHash: "b".repeat(64),
      role: "response",
    },
  },
};

export const citingPaper = {
  providerRecordId: "https://openalex.org/W456",
  paperId: "citing-paper",
  title: "Citing paper",
  authors: ["Citing Author"],
  fullTextAvailability: "available" as const,
  provenanceArtifacts: [
    {
      artifactId: `fixture_${"c".repeat(64)}`,
      contentHash: "c".repeat(64),
      role: "paper",
    },
  ],
};

export const mention = {
  mentionId: `mention_${"d".repeat(64)}`,
  seedId: `seed_${"e".repeat(64)}`,
  citingPaperRecordId: `citing-paper_${"f".repeat(64)}`,
  citingPaperId: "citing-paper",
  citedPaperId: "seed-paper",
  mentionIndex: 0,
  targetRefIds: ["seed-ref"],
  locationQuality: "exact_dom" as const,
  citationMarker: "[1]",
  rawContext: "The seed showed claim A and claim B [1].",
  isBundledCitation: false,
  bundleSize: 1,
  bundleRefIds: ["seed-ref"],
  bundlePattern: "single",
  observationProvenance: {
    sourceType: "jats_xml",
    parser: "fixture",
    artifacts: [
      {
        artifactId: `fixture_${"1".repeat(64)}`,
        contentHash: "1".repeat(64),
        role: "mention",
      },
    ],
  },
};
