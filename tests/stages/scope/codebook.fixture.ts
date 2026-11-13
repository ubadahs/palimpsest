/**
 * Stub Scope codebook adapters for stage fixtures that are not about the
 * codebook: a one-theme, one-entry codebook quoting the seed's first block,
 * and a tagger that tags every claim with that entry.
 */
import {
  SEED_CODEBOOK_PROCEDURE_VERSION,
  buildSeedCodebookId,
  type SeedCodebookContent,
} from "../../../src/contract/artifacts/index.js";
import type { ModelExecution } from "../../../src/contract/model-execution.js";
import type { ScopeAdapters } from "../../../src/stages/scope/run.js";
import { canonicalSha256 } from "../../../src/shared/stable-identity.js";

export function fixtureModelExecution(label: string): ModelExecution {
  const reference = (role: string) => ({
    artifactId: `artifact_${canonicalSha256({ label, role })}`,
    contentHash: canonicalSha256({ label, role, content: true }),
    role,
  });
  return {
    kind: "model",
    provider: "fixture",
    model: "fixture-model",
    promptId: "fixture-prompt",
    promptVersion: "v1",
    promptContentHash: canonicalSha256({ label, prompt: true }),
    requestHash: canonicalSha256({ label, request: true }),
    requestArtifact: reference("fixture-request"),
    responseArtifact: reference("fixture-response"),
  };
}

export function fixtureCodebookContent(
  blocks: ReadonlyArray<{
    blockId: string;
    text: string;
    charOffsetStart: number;
  }>,
): SeedCodebookContent {
  const block = blocks[0]!;
  const text = block.text.slice(0, Math.min(20, block.text.length));
  const quote = {
    blockId: block.blockId,
    text,
    charOffsetStart: block.charOffsetStart,
    charOffsetEnd: block.charOffsetStart + text.length,
  };
  return {
    themes: [
      {
        themeId: "T1",
        statement: "The fixture seed's main claim.",
        isHeadline: true,
        quotes: [quote],
      },
    ],
    entries: [
      {
        entryId: "E01",
        themeId: "T1",
        statement: "The fixture seed's one result.",
        type: "result",
        attributedToOtherWork: false,
        quotes: [quote],
      },
    ],
  };
}

export function stubCodebookAdapters(): Pick<
  ScopeAdapters,
  "buildCodebook" | "tagClaim"
> {
  return {
    buildCodebook: ({ seed, seedText, seedTextHash }) => {
      const content = fixtureCodebookContent(seedText.blocks);
      return Promise.resolve({
        status: "reused",
        seedId: seed.seedId,
        codebookId: buildSeedCodebookId({
          seedId: seed.seedId,
          seedTextHash,
          procedureVersion: SEED_CODEBOOK_PROCEDURE_VERSION,
          content,
        }),
        procedureVersion: SEED_CODEBOOK_PROCEDURE_VERSION,
        seedTextHash,
        model: "fixture-model",
        generatedAt: "2026-01-01T00:00:00.000Z",
        verification: {
          proposedThemes: 1,
          proposedEntries: 1,
          quotesProposed: 2,
          quotesVerified: 2,
          entriesDropped: 0,
          entriesOrphaned: 0,
          themesDropped: 0,
        },
        ...content,
      });
    },
    tagClaim: ({ claimText }) =>
      Promise.resolve({
        status: "completed",
        rawOutput: {
          kind: "specific",
          entries: ["E01"],
          theme: null,
          reason: "Fixture tag.",
        },
        execution: fixtureModelExecution(`tag:${claimText}`),
      }),
  };
}
