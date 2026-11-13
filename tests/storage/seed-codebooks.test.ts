import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { collectDatabaseGarbage } from "../../src/cli/commands/db-gc.js";
import type { AppConfig } from "../../src/config/app-config.js";
import { LLM_CACHE_VERSIONS } from "../../src/config/llm-versions.js";
import {
  SEED_CODEBOOK_PROCEDURE_VERSION,
  buildSeedTextHash,
  scopeSeedCodebookSchema,
  type ScopeSeedCodebook,
} from "../../src/contract/lean-artifacts.js";
import { analysisRunConfigSchema } from "../../src/contract/run-types.js";
import type {
  GenerateObjectParams,
  LLMClient,
} from "../../src/integrations/llm-client.js";
import { buildCanonicalScopeAdapters } from "../../src/pipeline/canonical-production-adapters.js";
import { createCanonicalProvenanceStore } from "../../src/pipeline/canonical-provenance-store.js";
import {
  resolveSeedCodebook,
  type GeneratedCodebookOutcome,
} from "../../src/pipeline/seed-codebook.js";
import { openDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migration-service.js";
import { createSqliteSeedCodebookStore } from "../../src/storage/seed-codebooks.js";
import { fixtureCodebookContent } from "../pipeline/codebook.fixture.js";

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function migratedDatabase() {
  const database = openDatabase(
    join(tempDir("palimpsest-codebook-"), "db.sqlite"),
  );
  runMigrations(database);
  return database;
}

// An invented seed.
const SEED_ID = `seed_${"a".repeat(64)}`;
const BLOCKS = [
  {
    blockId: "b1",
    text: "Glimmer moths orient to polarized moonlight during migration.",
    blockKind: "body_paragraph" as const,
    charOffsetStart: 0,
    charOffsetEnd: 62,
  },
];

function generator(label: string) {
  return vi.fn(
    (): Promise<GeneratedCodebookOutcome> =>
      Promise.resolve({
        status: "generated",
        model: "fixture-model",
        executions: [],
        output: {
          content: {
            ...fixtureCodebookContent(BLOCKS),
            themes: fixtureCodebookContent(BLOCKS).themes.map((theme) => ({
              ...theme,
              statement: `${label} theme`,
            })),
          },
          verification: {
            proposedThemes: 1,
            proposedEntries: 1,
            quotesProposed: 2,
            quotesVerified: 2,
            entriesDropped: 0,
            entriesOrphaned: 0,
            themesDropped: 0,
          },
        },
      }),
  );
}

function key(
  overrides: Partial<{ seedTextHash: string; procedureVersion: string }> = {},
) {
  return {
    seedId: SEED_ID,
    seedTextHash: buildSeedTextHash(BLOCKS),
    procedureVersion: SEED_CODEBOOK_PROCEDURE_VERSION,
    ...overrides,
  };
}

function themeStatement(codebook: ScopeSeedCodebook): string | undefined {
  return codebook.status === "generated" || codebook.status === "reused"
    ? codebook.themes[0]!.statement
    : undefined;
}

describe("seed codebook store", () => {
  it("reuses a stored codebook for the same key and regenerates for a new seed text or procedure", async () => {
    const database = migratedDatabase();
    const store = createSqliteSeedCodebookStore(database);
    const resolve = (
      label: string,
      overrides: Parameters<typeof key>[0] = {},
      regenerate = false,
    ) => {
      const generate = generator(label);
      return resolveSeedCodebook({
        store,
        key: key(overrides),
        regenerate,
        generatedAt: "2026-11-01T00:00:00.000Z",
        runId: `run-${label}`,
        generate,
      }).then((codebook) => ({ codebook, generate }));
    };

    const first = await resolve("first");
    expect(first.codebook.status).toBe("generated");
    expect(first.generate).toHaveBeenCalledOnce();

    const again = await resolve("second");
    expect(again.generate).not.toHaveBeenCalled();
    expect(again.codebook.status).toBe("reused");
    expect(themeStatement(again.codebook)).toBe("first theme");
    expect(again.codebook).toMatchObject({ generatedInRunId: "run-first" });
    expect(scopeSeedCodebookSchema.safeParse(again.codebook).success).toBe(
      true,
    );

    const newText = await resolve("new-text", {
      seedTextHash: "b".repeat(64),
    });
    expect(newText.generate).toHaveBeenCalledOnce();
    const newProcedure = await resolve("new-procedure", {
      procedureVersion: "seed-codebook-v999",
    });
    expect(newProcedure.generate).toHaveBeenCalledOnce();

    const regenerated = await resolve("regenerated", {}, true);
    expect(regenerated.generate).toHaveBeenCalledOnce();
    const afterRegenerate = await resolve("third");
    expect(themeStatement(afterRegenerate.codebook)).toBe("regenerated theme");
    database.close();
  });

  it("db:gc never deletes a stored codebook", async () => {
    const database = migratedDatabase();
    const store = createSqliteSeedCodebookStore(database);
    await resolveSeedCodebook({
      store,
      key: key(),
      regenerate: false,
      generatedAt: "2000-01-01T00:00:00.000Z",
      generate: generator("old"),
    });
    collectDatabaseGarbage(database, 1);
    expect(store.get(key())).toBeDefined();
    database.close();
  });
});

describe("production codebook adapter", () => {
  function appConfig(): AppConfig {
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

  const REPLIES: Record<string, unknown> = {
    draft_results: {
      headline: [
        {
          statement: "Moths use polarized moonlight.",
          attributedToOtherWork: false,
          quotes: ["orient to polarized moonlight"],
        },
      ],
      results: [],
    },
    draft_background: { background: [], methods: [] },
    organise: {
      themes: [
        {
          id: "T1",
          statement: "Moths navigate by polarized moonlight.",
          isHeadline: true,
          quotes: ["orient to polarized moonlight"],
        },
      ],
      entries: [
        {
          id: "E01",
          parent: "T1",
          statement: "Migrating moths orient to polarized moonlight.",
          type: "result",
          attributedToOtherWork: false,
          quotes: [
            "Glimmer moths orient to polarized moonlight during migration.",
          ],
        },
      ],
    },
  };

  function adapterWith(input: {
    database: ReturnType<typeof migratedDatabase>;
    forceRefresh?: boolean;
    regenerateCodebook?: boolean;
  }) {
    const generateObject = vi.fn((params: GenerateObjectParams) => {
      const step = params.promptSuffix?.startsWith(
        "TASK: List (a) the paper's headline",
      )
        ? "draft_results"
        : params.promptSuffix?.includes("List (a) background")
          ? "draft_background"
          : "organise";
      return Promise.resolve({
        object: {
          headline: [],
          results: [],
          background: [],
          methods: [],
          themes: [],
          entries: [],
          ...(REPLIES[step] as object),
        },
        record: {
          purpose: "seed-codebook" as const,
          model: params.model ?? "claude-sonnet-5-5",
          attempted: true as const,
          successful: true,
          failed: false,
          billable: true,
          thinkingEnabled: true,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          latencyMs: 1,
          finishReason: "stop",
          timestamp: "2026-11-01T00:00:00.000Z",
          estimatedCostUsd: 0.01,
        },
      });
    });
    const adapter = buildCanonicalScopeAdapters({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({}),
      llmClient: {
        generateObject,
        getLedger: () => {
          throw new Error("unused");
        },
      } as unknown as LLMClient,
      provenanceStore: createCanonicalProvenanceStore(
        tempDir("codebook-prov-"),
      ),
      codebookStore: createSqliteSeedCodebookStore(input.database),
      ...(input.forceRefresh ? { forceRefresh: true } : {}),
      ...(input.regenerateCodebook ? { regenerateCodebook: true } : {}),
      runId: "run-fixture",
    });
    return { adapter, generateObject };
  }

  const seed = {
    seedId: SEED_ID,
    doi: "10.0000/invented-moths",
    provenanceArtifacts: [],
    resolution: {
      status: "resolved",
      paper: { title: "Moonlight and moths" },
    },
  };
  const seedText = {
    status: "materialized",
    seedId: SEED_ID,
    blocks: BLOCKS,
  };
  const build = (adapter: ReturnType<typeof adapterWith>["adapter"]) =>
    adapter.buildCodebook({
      seed,
      seedText,
      seedTextHash: buildSeedTextHash(BLOCKS),
    } as unknown as Parameters<
      typeof adapter.buildCodebook
    >[0]) as Promise<ScopeSeedCodebook>;

  it("generates once, reuses under --force-refresh, and regenerates only on request", async () => {
    const database = migratedDatabase();

    const fresh = adapterWith({ database });
    const generated = await build(fresh.adapter);
    expect(generated.status).toBe("generated");
    expect(fresh.generateObject).toHaveBeenCalledTimes(3);
    const calls = fresh.generateObject.mock.calls.map((call) => call[0]);
    expect(new Set(calls.map((call) => call.promptPrefix)).size).toBe(1);
    expect(calls.every((call) => call.purpose === "seed-codebook")).toBe(true);
    expect(calls[0]!.exactCache).toEqual({
      keyVersion: LLM_CACHE_VERSIONS.seedCodebook,
    });
    expect(scopeSeedCodebookSchema.safeParse(generated).success).toBe(true);

    const forced = adapterWith({ database, forceRefresh: true });
    const reused = await build(forced.adapter);
    expect(reused.status).toBe("reused");
    expect(forced.generateObject).not.toHaveBeenCalled();
    expect(reused).toMatchObject({ generatedInRunId: "run-fixture" });

    const regenerate = adapterWith({ database, regenerateCodebook: true });
    const again = await build(regenerate.adapter);
    expect(again.status).toBe("generated");
    expect(regenerate.generateObject).toHaveBeenCalledTimes(3);
    // A regeneration asks the model again instead of replaying the cache.
    expect(
      regenerate.generateObject.mock.calls[0]![0].exactCache,
    ).toMatchObject({
      refresh: true,
    });
    database.close();
  });

  it("tags one claim per request, with the codebook as the shared prefix", async () => {
    const database = migratedDatabase();
    const { adapter } = adapterWith({ database });
    const codebook = await build(adapter);
    if (codebook.status !== "generated") throw new Error("expected a codebook");
    const generateObject = vi.fn((params: GenerateObjectParams) =>
      Promise.resolve({
        object: {
          kind: "specific",
          entries: ["E01"],
          theme: null,
          reason: "x",
        },
        record: {
          purpose: "codebook-tagging" as const,
          model: params.model ?? "claude-haiku-5-5",
          attempted: true as const,
          successful: true,
          failed: false,
          billable: true,
          thinkingEnabled: true,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          latencyMs: 1,
          finishReason: "stop",
          timestamp: "2026-11-01T00:00:00.000Z",
          estimatedCostUsd: 0.001,
        },
      }),
    );
    const tagger = buildCanonicalScopeAdapters({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({}),
      llmClient: { generateObject } as unknown as LLMClient,
      provenanceStore: createCanonicalProvenanceStore(
        tempDir("codebook-prov-"),
      ),
    });
    for (const claimText of ["Moths see moonlight.", "Moths migrate."]) {
      await tagger.tagClaim({
        seed,
        codebook,
        claimText,
      } as unknown as Parameters<typeof tagger.tagClaim>[0]);
    }
    const [first, second] = generateObject.mock.calls.map((call) => call[0]);
    expect(first!.purpose).toBe("codebook-tagging");
    expect(first!.model).toBe("claude-haiku-5-5");
    expect(first!.promptPrefix).toBe(second!.promptPrefix);
    expect(first!.promptPrefix).toContain("E01 [result]");
    expect(first!.promptPrefix).not.toContain("Moths see moonlight.");
    expect(first!.promptSuffix).toBe('Citing claim: "Moths see moonlight."');
    expect(second!.promptSuffix).toBe('Citing claim: "Moths migrate."');
    expect(first!.exactCache).toEqual({
      keyVersion: LLM_CACHE_VERSIONS.codebookTagging,
    });
    database.close();
  });
});
