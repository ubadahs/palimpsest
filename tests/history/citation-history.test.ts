import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROMPT_VERSIONS } from "../../src/config/prompt-versions.js";
import type {
  AssessHistoryCases,
  HistoryAssessmentInput,
} from "../../src/history/assessment.js";
import { runCitationHistory } from "../../src/history/run.js";
import {
  freshHistorySource,
  reuseHistorySource,
  type HistoryMiddleText,
} from "../../src/history/sources.js";
import { LLMProviderError } from "../../src/integrations/llm-client.js";
import { createProvenanceStore } from "../../src/pipeline/provenance-store.js";
import { sha256Text } from "../../src/shared/stable-identity.js";
import { parseParsedPaperDocument } from "../../src/retrieval/parsed-paper.js";
import {
  mentionHarvestResultSchema,
  neighborhoodResultSchema,
} from "../../src/stages/discover/run.js";
import { buildReportArtifact, runReport } from "../../src/stages/report/run.js";
import type { ScopeAdapters } from "../../src/stages/scope/run.js";
import {
  SOURCE_BLOCKS,
  artifactReference,
  discoverAdapters,
  externalExecution,
  modelExecution,
  scopeAdapters,
} from "../stages/chain.fixture.js";
import { buildChain } from "../stages/full-chain.fixture.js";

const origDoi = "10.1000/fixture-seed";
const middleDoi = "10.2000/citing-paper";
const middleHash = sha256Text("Exact middle article");
const carried = "ridges were lost after Ril9 depletion";
const supportSentence =
  "They found ridges were lost after Ril9 depletion, and a red stain appeared [3].";
const limits = {
  maxParents: 1,
  maxCiters: 1,
  maxCostUsd: 2,
  maxHops: 2 as const,
};

function fixtureDiscover(
  child = false,
  context = supportSentence,
  multiple = false,
  additionalStatements = 0,
) {
  const base = discoverAdapters({
    contextText: context,
    ...(multiple ? { neighbors: "readable" as const } : {}),
  });
  return {
    ...base,
    retrieveCitingNeighborhood: async (
      input: Parameters<typeof base.retrieveCitingNeighborhood>[0],
    ) => {
      if (!child) return base.retrieveCitingNeighborhood(input);
      return {
        status: "completed",
        providerReportedTotal: 3,
        coverage: "truncated",
        papers: [
          {
            providerRecordId: "provider-later-paper",
            paperId: "later-paper",
            title: "Later paper",
            doi: "10.3000/later-paper",
            authors: [],
            fullTextAvailability: "available",
            provenanceArtifacts: [
              artifactReference("provider-paper", "later-paper"),
            ],
          },
        ],
        execution: externalExecution("openalex", "later-neighborhood"),
      };
    },
    harvestMentions: async (
      input: Parameters<typeof base.harvestMentions>[0],
    ) => {
      const observed = mentionHarvestResultSchema.parse(
        await base.harvestMentions(input),
      );
      return {
        ...observed,
        bibliographyMatch: { method: "doi", refId: "seed-ref" },
        mentions: [
          {
            ...observed.mentions[0]!,
            locationQuality: "exact_dom",
            parser: "jats-normalized",
            sourceLocator: { kind: "block_id", value: "excerpt#cg-0" },
            citationGroupOrdinal: 0,
            markerSpan: {
              charOffsetStart: context.indexOf("[3]"),
              charOffsetEnd: context.indexOf("[3]") + 3,
            },
            sourceTextHash: child ? sha256Text("Later paper XML") : middleHash,
            isBundledCitation: child,
            bundleSize: child ? 2 : 1,
            bundlePattern: child ? "parenthetical_group" : "single",
            bundleRefIds: child ? ["seed-ref", "original-ref"] : ["seed-ref"],
          },
        ],
      };
    },
    extractAttributedClaims: (
      _input: Parameters<typeof base.extractAttributedClaims>[0],
    ) =>
      Promise.resolve({
        status: "completed",
        reason: "The exact citing sentence credits the earlier work.",
        claims: [
          {
            text: "The cited paper found Ril9 depletion induced ridge loss.",
            supportSpanText: context,
          },
          ...Array.from({ length: additionalStatements }, (_, index) => ({
            text: `The additional depletion condition ${index + 1} induced ridge loss.`,
            supportSpanText: context,
          })),
        ],
        execution: {
          ...modelExecution("history-extraction", child ? "later" : "middle"),
          promptVersion: PROMPT_VERSIONS.extraction,
        },
      }),
  };
}

function fixtureScope(relationship: "partial" | "full"): ScopeAdapters {
  return {
    ...scopeAdapters(),
    inventorySeed: () =>
      Promise.resolve({
        status: "completed",
        rawOutput: {
          takeaways: [],
          inventoryReason: "Grounded a result in the Results section.",
          results: [
            {
              id: "result",
              qualifiers: [],
              supports: [],
              statement: "Depletion leads to ridge loss and pocket formation.",
              ownershipReason:
                "The paper reports this effect from its experiment.",
              supportSpans: [
                {
                  blockId: SOURCE_BLOCKS[1]!.blockId,
                  verbatimQuote: SOURCE_BLOCKS[1]!.text,
                },
              ],
            },
          ],
        },
        execution: modelExecution("inventory", "original"),
      }),
    matchStatements: ({ findings, statements }) =>
      Promise.resolve({
        status: "completed",
        rawOutput: {
          assessments: statements.map((statement) => ({
            statementId: statement.statementId,
            relationship,
            findingIds: [findings[0]!.findingId],
            retained: [carried],
            changes:
              relationship === "partial" ? ["Pocket formation omitted"] : [],
            reason: "The attributed sentence carries the ridge loss only.",
          })),
        },
        execution: modelExecution("match", "original-middle"),
      }),
  };
}

async function generateReport(
  child = false,
  context = supportSentence,
  multiple = false,
  relationship: "partial" | "full" = "partial",
  discover = fixtureDiscover(child, context, multiple),
) {
  const chain = await buildChain({
    runId: child ? "history-middle-fixture" : "history-original-fixture",
    seedDoi: child ? middleDoi : origDoi,
    discover,
    scope: fixtureScope(relationship),
  });
  const report = buildReportArtifact({
    result: runReport(
      chain.discover,
      chain.scope,
      chain.prepare,
      chain.evidence,
      chain.adjudicate,
      { recordedAt: "2026-11-18T20:00:00Z" },
    ),
    runId: chain.discover.runId,
    createdAt: "2026-11-18T20:00:01Z",
  });
  return { ...chain, report };
}

const atlasResult =
  "Our atlas identified a completely independent expression pattern.";
const uptakeResult =
  "From this ridge-loss mechanism, we derive a testable threshold.";
const sourceArtifact = artifactReference("seed-text", "fixture-middle");
const middleText: HistoryMiddleText = {
  parser: { kind: "jats", version: "1.0.0" },
  sourceTextHash: middleHash,
  sourceArtifact,
  blocks: [
    { blockId: "excerpt", text: supportSentence },
    { blockId: "atlas", text: atlasResult },
    { blockId: "uptake", text: uptakeResult },
  ].map((block) => ({
    ...block,
    blockKind: "body_paragraph" as const,
    charOffsetStart: 0,
    charOffsetEnd: block.text.length,
  })),
};

function scriptedAssessment(
  route: (input: HistoryAssessmentInput) => unknown = () => ({
    kind: "direct_restatement",
    connection: [{ blockId: "excerpt", text: carried }],
  }),
  relation: "partial" | "full" | "distinct" | "scope_changed" = "partial",
  immediateFidelity: unknown = {
    status: "unassessed",
    reason: "No verdict in this route fixture.",
  },
): AssessHistoryCases {
  return (cases) =>
    Promise.resolve({
      status: "completed",
      rawOutput: {
        assessments: cases.map((input, index) => ({
          caseNumber: index + 1,
          downstreamQuote: input.downstreamText,
          immediateFidelity,
          comparison: {
            status: relation,
            retained: relation === "distinct" ? [] : [input.downstreamText],
            changes:
              relation === "partial" || relation === "scope_changed"
                ? ["The downstream wording has different scope."]
                : [],
            reason: "Test comparison with the original finding.",
          },
          route: route(input),
          reason: "Test route based on the supplied intermediate text.",
        })),
      },
      execution: modelExecution("history-assessment", relation),
    });
}

function useReusedReport(
  child: Awaited<ReturnType<typeof generateReport>>,
  sourceText: HistoryMiddleText = middleText,
): Parameters<typeof runCitationHistory>[0]["getSource"] {
  return (middle, maxCiters) =>
    Promise.resolve({
      ...reuseHistorySource({
        chain: child,
        provenanceStore: {
          persist: () => {
            throw new Error("No parse provenance was provided");
          },
        },
        middle,
        maxCiters,
        readProvenance: () => undefined,
      })!,
      middleText: () => Promise.resolve(sourceText),
    });
}

describe("citation history", () => {
  it("assesses an exact partial relay on both axes using reused evidence", async () => {
    const report = await generateReport();
    const child = await generateReport(true);
    const getSource = vi.fn(useReusedReport(child));
    const request = {
      report,
      limits,
      getSource,
      assessHistoryCases: scriptedAssessment((input) => {
        expect(input.original?.doi).toBe(origDoi);
        expect(input.middle?.doi).toBe(middleDoi);
        expect(input.citing?.doi).toBe("10.3000/later-paper");
        expect(input.downstreamCitationCredit).toBe("shared_reference_group");
        expect(input.downstreamBibliographyMatch).toEqual({
          method: "doi",
          refId: "seed-ref",
        });
        expect(input.downstreamTargetRefIds).toContain("seed-ref");
        expect(input.downstreamBundleRefIds).toEqual([
          "seed-ref",
          "original-ref",
        ]);
        expect(input.parentCitation).toMatchObject({
          context: supportSentence,
          marker: "[3]",
          originalReferenceId: "seed-ref",
          targetRefIds: ["seed-ref"],
          markerSpan: { charOffsetStart: supportSentence.indexOf("[3]") },
          sourceLocator: { kind: "block_id", value: "excerpt#cg-0" },
          blockId: "excerpt",
        });
        return {
          kind: "direct_restatement",
          connection: [{ blockId: "excerpt", text: carried }],
        };
      }),
    };
    const result = await runCitationHistory(request);
    expect(result).toEqual(await runCitationHistory(request));
    const path = result.payload.paths[0]!;
    const findingId = path.firstHop.findingIds[0];
    expect(path.statementId).toBe(
      report.scope.payload.citationStatements[0]?.statementId,
    );
    expect(path.firstHop.relationship).toBe("partial");
    expect(path.firstHop.changes).toEqual(["Pocket formation omitted"]);
    expect(result.payload.citationUses).toHaveLength(1);
    expect(result.payload.citationUses[0]).toMatchObject({
      useId: path.laterHops[0]?.useId,
      statementText: "The cited paper found Ril9 depletion induced ridge loss.",
      supportSpan: { text: supportSentence },
    });
    expect(path.laterHops[0]).toMatchObject({
      status: "assessed",
      directCitation: { status: "unknown" },
      assessments: [
        {
          findingId,
          parentTextVersionId: sourceArtifact.artifactId,
          comparison: { status: "partial" },
          route: { kind: "direct_restatement" },
        },
      ],
    });
    expect(result.payload.neighborhoods[0]).toMatchObject({
      coverage: "truncated",
      omittedCount: 2,
      middleSource: { status: "available", sourceArtifact },
    });
    expect(getSource).toHaveBeenCalledWith(path.middle, 1);
  });

  it.each([
    {
      name: "documented uptake through the intermediate's own result",
      route: {
        kind: "uptake",
        connection: [{ blockId: "excerpt", text: carried }],
        contribution: [{ blockId: "uptake", text: uptakeResult }],
      },
      context:
        "The prior paper derived an observable ridge-loss threshold [3].",
      comparison: "scope_changed" as const,
    },
    {
      name: "an independent atlas result",
      route: {
        kind: "independent_contribution",
        contribution: [{ blockId: "atlas", text: atlasResult }],
      },
      context: "The atlas mapped where the protein was expressed [3].",
      comparison: "distinct" as const,
    },
    {
      name: "resemblance without evidence that the intermediate transmitted the result",
      route: { kind: "unresolved" },
      context:
        "The earlier work suggests that Ril9 depletion removes ridges [3].",
      comparison: "partial" as const,
    },
    {
      name: "broader downstream language despite a faithful first hop",
      route: {
        kind: "direct_restatement",
        connection: [{ blockId: "excerpt", text: carried }],
      },
      context:
        "Ril9 depletion removes ridges from all cells across species [3].",
      comparison: "scope_changed" as const,
    },
  ])("records $name", async ({ route, context, comparison }) => {
    const report = await generateReport(false, supportSentence, false, "full");
    const child = await generateReport(true, context);
    const result = await runCitationHistory({
      report,
      limits,
      getSource: useReusedReport(child),
      assessHistoryCases: scriptedAssessment(() => route, comparison),
    });
    const path = result.payload.paths[0]!;
    expect(path.firstHop.relationship).toBe("full");
    expect(path.laterHops[0]).toMatchObject({
      status: "assessed",
      assessments: [
        {
          route: { kind: route.kind },
          comparison: { status: comparison },
        },
      ],
    });
  });

  it.each(["corrected", "different quote", "spend limit"] as const)(
    "preserves the original fidelity and comparison after route reconsideration with %s",
    async (outcome) => {
      const report = await generateReport();
      const downstream =
        "The prior paper derived an observable ridge-loss threshold [3].";
      const child = await generateReport(true, downstream);
      const initial = scriptedAssessment(
        () => ({
          kind: "direct_restatement",
          connection: [
            { blockId: "excerpt", text: carried },
            { blockId: "uptake", text: uptakeResult },
          ],
        }),
        "partial",
        {
          status: "assessed",
          verdict: "F",
          reason: "The later work credits the derived threshold.",
          evidence: [{ blockId: "uptake", text: uptakeResult }],
        },
      );
      const retry = scriptedAssessment(
        () => ({
          kind: "uptake",
          connection: [{ blockId: "excerpt", text: carried }],
          contribution: [{ blockId: "uptake", text: uptakeResult }],
        }),
        "scope_changed",
      );
      const primary = modelExecution("history-assessment", "partial");
      const revision = modelExecution("history-assessment", "scope_changed");
      const assess = vi
        .fn<AssessHistoryCases>()
        .mockImplementationOnce(initial)
        .mockImplementationOnce((cases) => {
          expect(cases).toHaveLength(1);
          expect(cases[0]?.reconsiderRouteForQuote).toBe(downstream);
          if (outcome === "spend limit")
            throw new LLMProviderError("limit", "spend_limit", true);
          return retry(
            outcome === "different quote"
              ? [{ ...cases[0]!, downstreamText: downstream.slice(0, -5) }]
              : cases,
          );
        });

      const result = await runCitationHistory({
        report,
        limits,
        getSource: useReusedReport(child),
        assessHistoryCases: assess,
      });
      expect(assess).toHaveBeenCalledTimes(2);
      const item = result.payload.paths[0]?.laterHops[0]?.assessments[0];
      expect(item).toMatchObject({
        status: "assessed",
        downstreamQuote: downstream,
        immediateFidelity: { verdict: "F" },
        comparison: { status: "partial" },
        route: { kind: outcome === "corrected" ? "uptake" : "unresolved" },
      });
      expect(item?.provenanceArtifacts).toContainEqual(primary.requestArtifact);
      if (outcome === "spend limit")
        expect(item?.provenanceArtifacts).toHaveLength(2);
      else
        expect(item?.provenanceArtifacts).toContainEqual(
          revision.responseArtifact,
        );
    },
  );

  it.each([
    {
      parser: middleText.parser,
      sourceTextHash: sha256Text("Different edition"),
    },
    {
      parser: { ...middleText.parser, version: "9.0.0" },
      sourceTextHash: middleHash,
    },
  ])(
    "compares content without routing through an unverified source version",
    async (version) => {
      const report = await generateReport();
      const child = await generateReport(true);
      const assessor = vi.fn(
        scriptedAssessment((input) => {
          expect(input.parentTextVersionId).toBeUndefined();
          expect(input.parentBlocks).toEqual([]);
          return { kind: "unresolved" };
        }),
      );
      const result = await runCitationHistory({
        report,
        limits,
        getSource: useReusedReport(child, {
          ...middleText,
          ...version,
        }),
        assessHistoryCases: assessor,
      });
      expect(assessor).toHaveBeenCalledOnce();
      expect(result.payload.paths[0]?.laterHops[0]).toMatchObject({
        status: "assessed",
        assessments: [
          {
            route: { kind: "unresolved" },
            comparison: { status: "partial" },
          },
        ],
      });
      expect(result.payload.neighborhoods[0]?.middleSource?.status).toBe(
        "source_version_unverified",
      );
    },
  );

  it("does not locate the credited occurrence using an ambiguous repeated paragraph", async () => {
    const report = await generateReport();
    const child = await generateReport(true);
    const duplicate = { ...middleText.blocks[0]!, blockId: "another-excerpt" };
    const result = await runCitationHistory({
      report,
      limits,
      getSource: useReusedReport(child, {
        ...middleText,
        blocks: [...middleText.blocks, duplicate],
      }),
      assessHistoryCases: scriptedAssessment((input) => {
        expect(input.parentCitation?.blockId).toBeUndefined();
        return { kind: "unresolved" };
      }),
    });
    expect(result.payload.paths[0]?.laterHops[0]).toMatchObject({
      status: "assessed",
      assessments: [
        {
          comparison: { status: "partial" },
          route: { kind: "unresolved" },
        },
      ],
    });
  });

  it("bounds fresh Discover work and preserves exact co-citation and model deferral", async () => {
    const report = await generateReport();
    const root = mkdtempSync(resolve(tmpdir(), "history-fresh-"));
    try {
      const parsed = parseParsedPaperDocument(
        `<article><body><sec><p>${supportSentence.split("[3]")[0]}<xref ref-type="bibr" rid="seed-ref original-ref">[3]</xref>.</p></sec></body>
        <back><ref-list><ref id="original-ref"><element-citation><pub-id pub-id-type="doi">${origDoi}</pub-id></element-citation></ref>
        <ref id="seed-ref"><element-citation><pub-id pub-id-type="doi">${middleDoi}</pub-id></element-citation></ref></ref-list></back></article>`,
        "jats_xml",
      );
      if (!parsed.ok) throw new Error(parsed.error);
      const discover = fixtureDiscover(true);
      const retrieve = vi.spyOn(discover, "retrieveCitingNeighborhood");
      const match = vi.fn(scriptedAssessment(() => ({ kind: "unresolved" })));
      const request = {
        report,
        limits,
        assessHistoryCases: match,
        getSource: (
          middle: Parameters<typeof freshHistorySource>[0]["middle"],
          maxCiters: number,
        ) =>
          freshHistorySource({
            middle,
            maxCiters,
            neighborhoodLimit: 50,
            discover,
            scope: scopeAdapters("seed_text_unavailable"),
            getParsedSource: () => ({
              document: parsed.data,
              artifact: artifactReference("citing-paper-parse", "later"),
            }),
            shouldStartWork: () => true,
            provenanceStore: createProvenanceStore(root),
          }),
      };
      const run = await runCitationHistory(request);
      expect(retrieve.mock.calls[0]?.[0].boundary.limit).toBe(50);
      expect(run.payload.paths[0]?.laterHops[0]).toMatchObject({
        status: "assessed",
        assessments: [{ route: { kind: "unresolved" } }],
        directCitation: {
          status: "same_group",
          referenceIds: ["original-ref"],
        },
      });
      expect(run.payload.neighborhoods[0]?.middleSource?.status).toBe(
        "unavailable",
      );
      expect(match).toHaveBeenCalledTimes(1);
      vi.spyOn(discover, "extractAttributedClaims").mockRejectedValue(
        new LLMProviderError("limit", "spend_limit", true),
      );
      const deferred = await runCitationHistory(request);
      expect(deferred.payload.neighborhoods[0]?.citers[0]?.status).toBe(
        "budget_exhausted",
      );
      expect(deferred.payload.paths[0]?.laterHops[0]?.status).toBe(
        "unassessed",
      );
      expect(match).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("spreads examinations across observed years for fresh and reused metadata", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "history-year-spread-"));
    try {
      const discover = fixtureDiscover(true);
      const retrieve = discover.retrieveCitingNeighborhood;
      vi.spyOn(discover, "retrieveCitingNeighborhood").mockImplementation(
        async (input) => {
          const baseline = neighborhoodResultSchema.parse(
            await retrieve(input),
          );
          if (baseline.status !== "completed")
            throw new Error("Missing fixture metadata");
          return {
            ...baseline,
            coverage: "complete",
            providerReportedTotal: 6,
            papers: [2019, 2019, 2020, 2022, 2026, undefined].map(
              (year, index) => ({
                ...baseline.papers[0]!,
                providerRecordId: `provider-dated-${index}`,
                paperId: `dated-${index}`,
                doi: `10.3000/dated-${index}`,
                ...(year == null ? {} : { publicationYear: year }),
              }),
            ),
          };
        },
      );
      const reused = await generateReport(
        true,
        supportSentence,
        false,
        "partial",
        discover,
      );
      const middle = {
        doi: middleDoi,
        paperId: "citing-paper",
        title: "Middle",
      };
      const harvest = vi.spyOn(discover, "harvestMentions");
      const fresh = await freshHistorySource({
        middle,
        maxCiters: 3,
        discover,
        scope: scopeAdapters("seed_text_unavailable"),
        getParsedSource: () => undefined,
        shouldStartWork: () => true,
        provenanceStore: createProvenanceStore(root),
      });
      const saved = reuseHistorySource({
        chain: reused,
        provenanceStore: createProvenanceStore(root),
        middle,
        maxCiters: 3,
        readProvenance: () => undefined,
      });
      expect(harvest).not.toHaveBeenCalled();
      for (const source of [fresh, saved]) {
        expect(source?.citers.map(({ paper }) => paper.paperId)).toEqual([
          "dated-0",
          "dated-3",
          "dated-4",
        ]);
        expect(source?.neighborhood).toMatchObject({
          coverage: "truncated",
          omittedCount: 3,
          providerReportedTotal: 6,
        });
      }
      await Promise.all(fresh.citers.map((citer) => citer.examine()));
      expect(
        harvest.mock.calls.map(([input]) => input.citingPaper.paperId),
      ).toEqual(["dated-0", "dated-3", "dated-4"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the exact retained material distinct from unrelated words in the first-hop sentence", async () => {
    const report = await generateReport();
    const child = await generateReport(true, "The red stain appeared [3].");
    const result = await runCitationHistory({
      report,
      limits,
      getSource: useReusedReport(child),
      assessHistoryCases: scriptedAssessment((input) => {
        expect(input.parentStatementText).toContain("red stain");
        expect(input.parentRetained).toEqual([carried]);
        expect(input.downstreamText).toBe("The red stain appeared [3].");
        return { kind: "unrelated" };
      }, "distinct"),
    });
    expect(result.payload.paths[0]?.laterHops[0]).toMatchObject({
      status: "assessed",
      assessments: [
        {
          route: { kind: "unrelated" },
          comparison: { status: "distinct" },
        },
      ],
    });
  });

  it("extracts a downstream use once and shares it across first-hop targets", async () => {
    const report = await generateReport(
      false,
      supportSentence,
      false,
      "partial",
      fixtureDiscover(false, supportSentence, false, 1),
    );
    const root = mkdtempSync(resolve(tmpdir(), "history-shared-use-"));
    try {
      const discover = fixtureDiscover(true);
      const extract = vi.spyOn(discover, "extractAttributedClaims");
      const assess = vi.fn(scriptedAssessment());
      const result = await runCitationHistory({
        report,
        limits: { ...limits, maxParents: 2 },
        assessHistoryCases: assess,
        getSource: async (middle, maxCiters) => ({
          ...(await freshHistorySource({
            middle,
            maxCiters,
            discover,
            scope: scopeAdapters("seed_text_unavailable"),
            getParsedSource: () => undefined,
            shouldStartWork: () => true,
            provenanceStore: createProvenanceStore(root),
          })),
          middleText: () => Promise.resolve(middleText),
        }),
      });
      expect(extract).toHaveBeenCalledOnce();
      expect(extract.mock.calls[0]?.[0].seed.paper.doi).toBe(middleDoi);
      expect(result.payload.paths).toHaveLength(2);
      expect(result.payload.citationUses).toHaveLength(1);
      expect(assess).toHaveBeenCalledOnce();
      const [left, right] = result.payload.paths;
      expect(left?.laterHops[0]?.useId).toBe(right?.laterHops[0]?.useId);
      expect(left?.laterHops[0]?.assessments[0]?.caseId).not.toBe(
        right?.laterHops[0]?.assessments[0]?.caseId,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an ambiguous bibliography match as a non-outcome", async () => {
    const report = await generateReport();
    const discover = fixtureDiscover(true);
    const harvestMentions = discover.harvestMentions;
    vi.spyOn(discover, "harvestMentions").mockImplementation(async (input) => ({
      ...(await harvestMentions(input)),
      bibliographyMatch: {
        method: "author_year_title_overlap",
        refId: "seed-ref",
      },
    }));
    const child = await generateReport(
      true,
      supportSentence,
      false,
      "partial",
      discover,
    );
    const assess = vi.fn(scriptedAssessment());
    const result = await runCitationHistory({
      report,
      limits,
      getSource: useReusedReport(child),
      assessHistoryCases: assess,
    });
    expect(assess).not.toHaveBeenCalled();
    expect(result.payload.citationUses[0]).toMatchObject({
      credit: "unverified",
    });
    expect(result.payload.paths[0]?.laterHops[0]).toMatchObject({
      status: "unassessed",
      assessments: [],
    });
    expect(result.payload.neighborhoods[0]?.citers[0]?.status).toBe(
      "examination_failed",
    );
  });

  it("preserves completed comparisons and labels each deferred finding after spend rejection", async () => {
    const report = await generateReport(
      false,
      supportSentence,
      false,
      "partial",
      fixtureDiscover(false, supportSentence, false, 8),
    );
    const child = await generateReport(true);
    const assess = vi
      .fn<AssessHistoryCases>()
      .mockImplementationOnce(scriptedAssessment())
      .mockRejectedValue(new LLMProviderError("limit", "spend_limit", true));
    const result = await runCitationHistory({
      report,
      limits: { ...limits, maxParents: 9 },
      getSource: useReusedReport(child),
      assessHistoryCases: assess,
    });
    expect(assess).toHaveBeenCalledTimes(2);
    expect(result.payload.citationUses[0]?.supportSpan?.text).toBe(
      supportSentence,
    );
    const hops = result.payload.paths.map((path) => path.laterHops[0]);
    expect(hops.filter((hop) => hop?.status === "assessed")).toHaveLength(8);
    expect(hops.at(-1)).toMatchObject({
      status: "budget_exhausted",
      assessments: [{ status: "budget_exhausted", provenanceArtifacts: [] }],
    });
    expect(result.payload.neighborhoods[0]?.citers[0]?.status).toBe(
      "budget_exhausted",
    );
  });

  it("records the provider failure and skips later comparisons after terminal authentication rejection", async () => {
    const report = await generateReport(
      false,
      supportSentence,
      false,
      "partial",
      fixtureDiscover(false, supportSentence, false, 8),
    );
    const child = await generateReport(true);
    const execution = modelExecution("history-assessment", "authentication");
    const assess = vi.fn<AssessHistoryCases>().mockResolvedValue({
      status: "failed",
      reasonCode: "authentication",
      reason: "The provider rejected authentication credentials.",
      execution,
    });
    const result = await runCitationHistory({
      report,
      limits: { ...limits, maxParents: 9 },
      getSource: useReusedReport(child),
      assessHistoryCases: assess,
    });
    expect(assess).toHaveBeenCalledOnce();
    const hops = result.payload.paths.map((path) => path.laterHops[0]);
    expect(hops).toHaveLength(9);
    expect(hops.every((hop) => hop?.status === "provider_failure")).toBe(true);
    expect(hops[0]?.assessments[0]?.provenanceArtifacts).toContainEqual(
      execution.requestArtifact,
    );
    expect(hops.at(-1)?.assessments[0]).toMatchObject({
      status: "provider_failure",
      provenanceArtifacts: [],
    });
    expect(result.payload.neighborhoods[0]?.citers[0]?.status).toBe(
      "examination_failed",
    );
  });

  it("applies one global citer allowance across distinct intermediate papers", async () => {
    const report = await generateReport(false, supportSentence, true);
    const getSource = vi.fn(
      (
        middle: Parameters<typeof freshHistorySource>[0]["middle"],
        _allocated: number,
      ) =>
        Promise.resolve({
          neighborhood: {
            middle,
            status: "examined" as const,
            reason: "One returned work",
            coverage: "complete" as const,
            omittedCount: 0,
            provenanceArtifacts: [],
          },
          citers: [
            {
              paper: {
                paperId: "inaccessible",
                title: "Inaccessible later paper",
              },
              examine: () =>
                Promise.resolve({
                  status: "access_unavailable" as const,
                  reason: "Publisher access unavailable.",
                  provenanceArtifacts: [],
                  occurrences: [],
                  statements: [],
                  directCitation: () => ({
                    status: "unknown" as const,
                    referenceIds: [],
                    provenanceArtifacts: [],
                  }),
                }),
            },
          ],
          middleText: () => Promise.resolve(undefined),
        }),
    );
    const result = await runCitationHistory({
      report,
      limits: { ...limits, maxParents: 2 },
      getSource,
      assessHistoryCases: vi.fn(),
    });
    expect(getSource).toHaveBeenCalledTimes(1);
    expect(result.payload.paths).toHaveLength(2);
    expect(result.payload.neighborhoods.map((item) => item.status)).toEqual([
      "examined",
      "citer_budget_exhausted",
    ]);
    expect(result.payload.neighborhoods[0]?.citers[0]?.status).toBe(
      "access_unavailable",
    );
    getSource.mockClear();
    const shared = await runCitationHistory({
      report,
      limits: { ...limits, maxParents: 2, maxCiters: 5 },
      getSource,
      assessHistoryCases: vi.fn(),
    });
    expect(getSource.mock.calls.map(([, allocation]) => allocation)).toEqual([
      3, 4,
    ]);
    expect(
      new Set(shared.payload.paths.map((path) => path.middle.paperId)).size,
    ).toBe(2);
    expect(
      shared.payload.neighborhoods.map((item) => item.allocatedCiterLimit),
    ).toEqual([3, 4]);
  });
});
