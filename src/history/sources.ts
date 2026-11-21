import type { z } from "zod";

import {
  buildCitingPaperRecordId,
  buildClaimExtractionObservationId,
  buildSeedId,
  type DiscoverAttributedClaimRecord,
  type DiscoverCitationOccurrence,
  type DiscoverCitingPaperRecord,
  type DiscoverSeed,
} from "../contract/artifacts/discover.js";
import { RUN_CONFIG_DEFAULTS } from "../contract/run-types.js";
import { normalizeDoi } from "../contract/artifacts/checks.js";
import {
  uniqueSortedArtifactReferences,
  sha256DigestSchema,
  type ArtifactReference,
} from "../contract/artifacts/primitives.js";
import {
  scopeSeedMaterializationSchema,
  type ScopeSeedMaterialization,
} from "../contract/artifacts/scope.js";
import type { ScopeCitationStatement } from "../contract/artifacts/scope-statements.js";
import {
  citationObservationParserMatches,
  type ParsedPaperDocument,
} from "../domain/parsing.js";
import { classifyProviderError } from "../integrations/llm-client.js";
import type { ReportChain } from "../pipeline/report-chain.js";
import type { ProvenanceStore } from "../pipeline/provenance-store.js";
import { resolveClaimCitation } from "../stages/discover/citation-attachment.js";
import { EXTRACTION_PROMPT_VERSION } from "../stages/discover/prompts.js";
import {
  buildAttributedClaimRecords,
  claimExtractionResultSchema,
  createCitationOccurrence,
  mentionHarvestResultSchema,
  neighborhoodResultSchema,
  seedResolutionResultSchema,
  type DiscoverAdapters,
} from "../stages/discover/run.js";
import { buildScopeCitationStatements } from "../stages/scope/statements.js";
import type { ScopeAdapters } from "../stages/scope/run.js";
import { decodeCitingPaperParse } from "./parsed-source.js";
import type {
  CitationHistoryNeighborhood,
  HistoryCiterStatus,
  HistoryDirectCitation,
  HistoryPaper,
} from "./store.js";

export type HistoryCiterExamination = {
  status: HistoryCiterStatus;
  reason: string;
  provenanceArtifacts: ArtifactReference[];
  occurrences: DiscoverCitationOccurrence[];
  statements: ScopeCitationStatement[];
  bibliographyMatch?: NonNullable<
    DiscoverCitingPaperRecord["bibliographyMatch"]
  >;
  claimProvenance?: ReadonlyMap<string, ArtifactReference[]>;
  directCitation: (
    original: HistoryPaper,
    occurrence: DiscoverCitationOccurrence,
  ) => HistoryDirectCitation;
};

type Citer = {
  paper: HistoryPaper;
  examine: () => Promise<HistoryCiterExamination>;
};

export type HistorySource = {
  neighborhood: Omit<
    CitationHistoryNeighborhood,
    "allocatedCiterLimit" | "citers"
  >;
  citers: Citer[];
  middleText: () => Promise<HistoryMiddleText | undefined>;
};

export type HistoryMiddleText = {
  blocks: Extract<
    ScopeSeedMaterialization,
    { status: "materialized" }
  >["blocks"];
  parser: { kind: string; version: string };
  sourceTextHash: string;
  sourceArtifact: ArtifactReference;
};

export type ParsedCitationSource = {
  document: ParsedPaperDocument;
  artifact: ArtifactReference;
};

const unknownDirect: HistoryDirectCitation = {
  status: "unknown",
  referenceIds: [],
  provenanceArtifacts: [],
};

export function isHistorySpendLimit(error: unknown): boolean {
  return classifyProviderError(error).classification === "spend_limit";
}

function isExactOccurrence(occurrence: DiscoverCitationOccurrence): boolean {
  const span = occurrence.markerSpan;
  return (
    occurrence.locationQuality === "exact_dom" &&
    span != null &&
    occurrence.rawContext.slice(span.charOffsetStart, span.charOffsetEnd) ===
      occurrence.citationMarker
  );
}

function parsedDirectCitation(
  source: ParsedCitationSource | undefined,
  original: HistoryPaper,
  occurrence: DiscoverCitationOccurrence,
  store: Pick<ProvenanceStore, "persist">,
): HistoryDirectCitation {
  if (!source || !original.doi || !isExactOccurrence(occurrence)) {
    return unknownDirect;
  }
  const citingMention = source.document.mentions.find(
    (mention) =>
      mention.mentionIndex === occurrence.mentionIndex &&
      mention.locationQuality === "exact_dom" &&
      mention.rawContext === occurrence.rawContext &&
      mention.markerSpan?.charOffsetStart ===
        occurrence.markerSpan?.charOffsetStart &&
      mention.markerSpan?.charOffsetEnd ===
        occurrence.markerSpan?.charOffsetEnd,
  );
  if (!citingMention) return unknownDirect;
  const doi = normalizeDoi(original.doi);
  const matchedReferences = source.document.references.filter(
    (ref) => ref.doi && normalizeDoi(ref.doi) === doi,
  );
  const referenceIds = matchedReferences.map((ref) => ref.refId).sort();
  const references = new Set(referenceIds);
  const sameGroup =
    citingMention.bundleRefIds.some((id) => references.has(id)) ||
    citingMention.targetRefIds.some((id) => references.has(id));
  const matchingMentions = source.document.mentions.filter(
    (mention) =>
      mention.locationQuality === "exact_dom" &&
      mention.targetRefIds.some((id) => references.has(id)),
  );
  const status = sameGroup
    ? "same_group"
    : matchingMentions.length > 0
      ? "elsewhere"
      : references.size > 0
        ? "bibliography_only"
        : source.document.references.length > 0
          ? "no_match_in_parsed_references"
          : "unknown";
  const evidence = store.persist({
    role: "history-direct-citation",
    body: {
      source: source.artifact,
      originalDoi: doi,
      occurrenceId: occurrence.mentionId,
      groupRefIds: citingMention.bundleRefIds,
      parsedReferenceCount: source.document.references.length,
      matchedReferences,
      matchingMentions: matchingMentions.map((mention) => ({
        refIds: mention.targetRefIds,
        sourceLocator: mention.sourceLocator,
        charOffsetStart: mention.charOffsetStart,
        charOffsetEnd: mention.charOffsetEnd,
      })),
      status,
    },
  });
  return {
    status,
    referenceIds,
    provenanceArtifacts: [source.artifact, evidence],
  };
}

export function unavailableHistorySource(
  middle: HistoryPaper,
  status: CitationHistoryNeighborhood["status"],
  reason: string,
  provenanceArtifacts: ArtifactReference[] = [],
): HistorySource {
  return {
    neighborhood: {
      middle,
      status,
      reason,
      coverage: "unknown",
      omittedCount: 0,
      provenanceArtifacts,
    },
    citers: [],
    middleText: () => Promise.resolve(undefined),
  };
}

function selectByPublicationYear<T>(
  papers: readonly T[],
  yearOf: (paper: T) => number | undefined,
  limit: number,
): T[] {
  const byYear = new Map<number, T[]>();
  const undated: T[] = [];
  for (const paper of papers) {
    const year = yearOf(paper);
    if (year == null) {
      undated.push(paper);
      continue;
    }
    const group = byYear.get(year);
    if (group) group.push(paper);
    else byYear.set(year, [paper]);
  }
  let groups = [...byYear.keys()]
    .sort((a, b) => a - b)
    .map((year) => byYear.get(year)!);
  const selected: T[] = [];
  for (let rank = 0; groups.length > 0 && selected.length < limit; rank++) {
    const slots = limit - selected.length;
    if (slots < groups.length) {
      for (let slot = 0; slot < slots; slot++) {
        const index =
          slots === 1
            ? Math.floor((groups.length - 1) / 2)
            : Math.round((slot * (groups.length - 1)) / (slots - 1));
        selected.push(groups[index]![rank]!);
      }
      break;
    }
    for (const group of groups) selected.push(group[rank]!);
    groups = groups.filter((group) => group.length > rank + 1);
  }
  return selected.concat(undated.slice(0, limit - selected.length));
}

function selectionCoverage(
  query: Pick<
    CitationHistoryNeighborhood,
    "coverage" | "providerReportedTotal"
  >,
  enumerated: number,
  selected: number,
) {
  const omittedCount =
    Math.max(enumerated, query.providerReportedTotal ?? 0) - selected;
  return {
    coverage: omittedCount > 0 ? ("truncated" as const) : query.coverage,
    omittedCount,
  };
}

const selectionReason =
  "Selected from enumerated works across publication years, with undated works filling remaining slots.";

export function reuseHistorySource(input: {
  chain: ReportChain;
  middle: HistoryPaper;
  maxCiters: number;
  readProvenance: (reference: ArtifactReference) => unknown;
  provenanceStore: Pick<ProvenanceStore, "persist">;
}): HistorySource | undefined {
  const { chain, middle, maxCiters, readProvenance, provenanceStore } = input;
  if (!middle.doi) return undefined;
  const seedId = buildSeedId({ doi: middle.doi });
  const query = chain.discover.payload.neighborhoodQueries.find(
    (entry) => entry.seedId === seedId && entry.status === "completed",
  );
  if (!query) return undefined;
  const papers = chain.discover.payload.citingPapers
    .filter((entry) => entry.seedId === seedId)
    .sort((a, b) => a.providerPosition - b.providerPosition);
  const selected = selectByPublicationYear(
    papers,
    (entry) => entry.paper.publicationYear,
    maxCiters,
  );
  const occurrencesByPaper = groupByPaper(
    chain.discover.payload.citationMentions,
  );
  const statementsByPaper = groupByPaper(
    chain.scope.payload.citationStatements,
  );
  const claimProvenance = new Map(
    chain.discover.payload.attributedClaimRecords.map((claim) => [
      claim.claimRecordId,
      claim.provenanceArtifacts,
    ]),
  );
  const extractionsByOccurrence = new Map(
    chain.discover.payload.claimExtractionObservations.map((item) => [
      item.mentionId,
      item,
    ]),
  );
  // Older extractors only asked for empirical restatements. A cached empty
  // answer from that question cannot establish that B did not use A's method.
  if (
    chain.discover.payload.claimExtractionObservations.some(
      (entry) =>
        entry.seedId === seedId &&
        entry.execution.kind === "model" &&
        entry.execution.promptVersion !== EXTRACTION_PROMPT_VERSION,
    )
  )
    return undefined;
  return {
    neighborhood: {
      middle,
      status: "examined",
      reason: `${query.statusReason} ${selectionReason}`,
      ...selectionCoverage(query, papers.length, selected.length),
      ...(query.providerReportedTotal == null
        ? {}
        : {
            providerReportedTotal: query.providerReportedTotal,
          }),
      sourceReport: {
        runId: chain.report.runId,
        artifactId: chain.report.artifactId,
        contentHash: chain.report.contentHash,
      },
      provenanceArtifacts: query.provenanceArtifacts,
    },
    citers: selected.map((entry) => ({
      paper: toHistoryPaper(entry.paper),
      examine: () => {
        const occurrences =
          occurrencesByPaper.get(entry.citingPaperRecordId) ?? [];
        const parsedSources = new Map<
          string,
          ReturnType<typeof decodeCitingPaperParse> | undefined
        >();
        const exactReference = isReliableReference(
          entry.bibliographyMatch?.method,
        );
        const statements = (
          statementsByPaper.get(entry.citingPaperRecordId) ?? []
        ).map((statement) =>
          exactReference ? statement : unverifiedReference(statement),
        );
        const failedExtraction = occurrences.some(
          (occurrence) =>
            extractionsByOccurrence.get(occurrence.mentionId)?.status !==
              "claims_extracted" &&
            extractionsByOccurrence.get(occurrence.mentionId)?.status !==
              "no_claims",
        );
        let status: HistoryCiterStatus = "assessed";
        let reason = entry.harvest.reason;
        if (entry.probe.status === "not_selected") {
          status = "not_probed";
          reason = entry.probe.reason;
        } else if (entry.materialization.status === "unavailable") {
          status = "access_unavailable";
          reason = entry.materialization.reason;
        } else if (
          entry.materialization.status === "failed" ||
          entry.harvest.status === "failed" ||
          failedExtraction
        ) {
          status = "examination_failed";
          reason = failedExtraction
            ? "The reused extraction did not finish for every citation occurrence."
            : entry.materialization.status === "failed"
              ? entry.materialization.reason
              : entry.harvest.reason;
        } else if (entry.harvest.status === "no_mentions") {
          status = "no_in_text_citation";
        } else if (statements.length === 0) {
          status = "no_attributed_statement";
          reason = "No substantive attributed statement was extracted.";
        }
        return Promise.resolve({
          status,
          reason,
          ...(entry.bibliographyMatch
            ? { bibliographyMatch: entry.bibliographyMatch }
            : {}),
          provenanceArtifacts: uniqueSortedArtifactReferences([
            ...entry.provenanceArtifacts,
            ...entry.materialization.provenanceArtifacts,
            ...entry.harvest.provenanceArtifacts,
            ...occurrences.flatMap(
              (occurrence) =>
                extractionsByOccurrence.get(occurrence.mentionId)
                  ?.provenanceArtifacts ?? [],
            ),
          ]),
          occurrences,
          statements,
          claimProvenance,
          directCitation: (original, occurrence) => {
            const version = occurrence.observationProvenance;
            const refs = version.artifacts.filter(
              (reference) => reference.role === "citing-paper-parse",
            );
            const artifact = refs[0];
            if (refs.length !== 1 || !artifact) return unknownDirect;
            const key = `${artifact.artifactId}:${artifact.contentHash}`;
            if (!parsedSources.has(key)) {
              const body = readProvenance(artifact);
              if (body === undefined) parsedSources.set(key, undefined);
              else {
                try {
                  parsedSources.set(key, decodeCitingPaperParse(body));
                } catch {
                  parsedSources.set(key, undefined);
                }
              }
            }
            const parsed = parsedSources.get(key);
            if (
              !parsed ||
              parsed.paperId !== occurrence.citingPaperId ||
              parsed.sourceTextHash !== version.sourceTextHash ||
              !citationObservationParserMatches(
                version.parser,
                parsed.document.parserKind,
              ) ||
              parsed.document.parserVersion !== version.parserVersion
            )
              return unknownDirect;
            return parsedDirectCitation(
              { document: parsed.document, artifact },
              original,
              occurrence,
              provenanceStore,
            );
          },
        });
      },
    })),
    middleText: () => {
      const materialization = chain.scope.payload.seedMaterializations.find(
        (item) => item.seedId === seedId,
      );
      return Promise.resolve(
        materialization && versionedMiddleText(materialization, readProvenance),
      );
    },
  };
}

function versionedMiddleText(
  materialization: ScopeSeedMaterialization,
  readProvenance: (reference: ArtifactReference) => unknown,
): HistoryMiddleText | undefined {
  if (materialization.status !== "materialized") return;
  const body = readProvenance(materialization.seedTextArtifact);
  const hash = sha256DigestSchema.safeParse(
    body && typeof body === "object" && "sourceTextHash" in body
      ? body.sourceTextHash
      : undefined,
  );
  if (!hash.success) return;
  return {
    blocks: materialization.blocks,
    parser: materialization.parser,
    sourceArtifact: materialization.seedTextArtifact,
    sourceTextHash: hash.data,
  };
}

function groupByPaper<T extends { citingPaperRecordId: string }>(
  items: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.citingPaperRecordId);
    if (group) group.push(item);
    else groups.set(item.citingPaperRecordId, [item]);
  }
  return groups;
}

export function isReliableReference(method: string | undefined): boolean {
  return (
    method === "doi" ||
    method === "arxiv_id" ||
    method === "author_year_exact_title" ||
    method === "author_year_journal_volume_first_page" ||
    method === "author_adjacent_year_exact_title_volume"
  );
}

function unverifiedReference(
  statement: ScopeCitationStatement,
): ScopeCitationStatement {
  return {
    ...statement,
    credit: "unverified",
    assessment: {
      status: "exact_attribution_unverified",
      relationship: "unassessed",
      findingIds: [],
      retained: [],
      changes: [],
      reason:
        "The bibliography match does not uniquely identify the intermediate paper.",
    },
  };
}

export function toHistoryPaper(input: {
  paperId: string;
  title: string;
  doi?: string | undefined;
  publicationYear?: number | undefined;
}): HistoryPaper {
  return {
    paperId: input.paperId,
    title: input.title,
    ...(input.doi ? { doi: input.doi } : {}),
    ...(input.publicationYear != null
      ? { publicationYear: input.publicationYear }
      : {}),
  };
}

async function examineFreshCiter(input: {
  adapters: DiscoverAdapters;
  seed: Extract<
    z.infer<typeof seedResolutionResultSchema>,
    { status: "resolved" }
  >;
  seedId: string;
  paper: Parameters<DiscoverAdapters["harvestMentions"]>[0]["citingPaper"];
  getParsedSource: (paperId: string) => ParsedCitationSource | undefined;
  shouldStartWork: () => boolean;
  provenanceStore: ProvenanceStore;
}): Promise<HistoryCiterExamination> {
  const {
    adapters,
    seed,
    seedId,
    paper,
    getParsedSource,
    shouldStartWork,
    provenanceStore,
  } = input;
  if (!shouldStartWork()) {
    return {
      status: "budget_exhausted",
      reason:
        "The remaining model budget is exhausted. The paper was not retrieved.",
      provenanceArtifacts: paper.provenanceArtifacts,
      occurrences: [],
      statements: [],
      directCitation: () => unknownDirect,
    };
  }
  const harvest = mentionHarvestResultSchema.parse(
    await adapters.harvestMentions({ seed, citingPaper: paper }),
  );
  const source = getParsedSource(paper.paperId);
  const provenanceArtifacts = uniqueSortedArtifactReferences([
    ...paper.provenanceArtifacts,
    ...harvest.materialization.provenanceArtifacts,
    ...harvest.harvest.provenanceArtifacts,
  ]);
  const citingPaperRecordId = buildCitingPaperRecordId({
    seedId,
    provider: "openalex",
    providerRecordId: paper.providerRecordId,
  });
  const occurrences = harvest.mentions.map((mention) =>
    createCitationOccurrence({
      seedId,
      citedPaperId: seed.paper.paperId,
      citingPaperRecordId,
      citingPaperId: paper.paperId,
      mention,
    }),
  );
  const directCitation = (
    original: HistoryPaper,
    occurrence: DiscoverCitationOccurrence,
  ) => parsedDirectCitation(source, original, occurrence, provenanceStore);
  const base = {
    occurrences,
    provenanceArtifacts,
    directCitation,
    ...(harvest.bibliographyMatch
      ? { bibliographyMatch: harvest.bibliographyMatch }
      : {}),
  };
  if (harvest.materialization.status !== "succeeded") {
    return {
      ...base,
      status:
        harvest.materialization.status === "unavailable"
          ? "access_unavailable"
          : "examination_failed",
      reason: harvest.materialization.reason,
      statements: [],
    };
  }
  if (harvest.harvest.status !== "succeeded") {
    return {
      ...base,
      status:
        harvest.harvest.status === "no_mentions"
          ? "no_in_text_citation"
          : "examination_failed",
      reason: harvest.harvest.reason,
      statements: [],
    };
  }
  let status: HistoryCiterStatus = "assessed";
  let reason = "The exact citation occurrences were examined.";
  const claims: DiscoverAttributedClaimRecord[] = [];
  const extractionArtifacts: ArtifactReference[] = [];
  for (const occurrence of occurrences) {
    const exactReference = isReliableReference(
      harvest.bibliographyMatch?.method,
    );
    if (!isExactOccurrence(occurrence) || !exactReference) {
      status = "examination_failed";
      reason =
        "At least one citation lacks an exact marker or an unambiguous bibliography match.";
      continue;
    }
    let extraction: z.infer<typeof claimExtractionResultSchema>;
    try {
      extraction = claimExtractionResultSchema.parse(
        await adapters.extractAttributedClaims({
          seed,
          citingPaper: paper,
          mention: occurrence,
        }),
      );
    } catch (error) {
      if (!isHistorySpendLimit(error)) throw error;
      status = "budget_exhausted";
      reason = "A model request would exceed the history spend limit.";
      break;
    }
    const artifacts = [
      extraction.execution.requestArtifact,
      extraction.execution.responseArtifact,
    ];
    extractionArtifacts.push(...artifacts);
    if (extraction.status === "failed") {
      status = "examination_failed";
      reason = extraction.reason;
      continue;
    }
    for (const claim of buildAttributedClaimRecords({
      claims: extraction.claims,
      seedId,
      mentionId: occurrence.mentionId,
      extractionId: buildClaimExtractionObservationId({
        seedId,
        mentionId: occurrence.mentionId,
      }),
      rawContext: occurrence.rawContext,
      highlightedCitation: occurrence,
      provenanceArtifacts: uniqueSortedArtifactReferences(artifacts),
    })) {
      const attached = resolveClaimCitation(claim, occurrence, occurrences);
      claims.push({ ...claim, mentionId: attached.mentionId });
    }
  }
  const observations = [
    {
      citingPaperRecordId,
      paper,
      ...(harvest.bibliographyMatch
        ? { bibliographyMatch: harvest.bibliographyMatch }
        : {}),
    },
  ];
  const statements = buildScopeCitationStatements({
    citingPapers: observations,
    citationMentions: occurrences,
    attributedClaimRecords: claims,
  });
  return {
    ...base,
    provenanceArtifacts: uniqueSortedArtifactReferences([
      ...provenanceArtifacts,
      ...extractionArtifacts,
    ]),
    status:
      status === "assessed" && statements.length === 0
        ? "no_attributed_statement"
        : status,
    reason:
      status === "assessed" && statements.length === 0
        ? "No substantive attributed statement was extracted."
        : reason,
    statements,
    claimProvenance: new Map(
      claims.map((claim) => [claim.claimRecordId, claim.provenanceArtifacts]),
    ),
  };
}

export async function freshHistorySource(input: {
  middle: HistoryPaper;
  maxCiters: number;
  neighborhoodLimit?: number;
  discover: DiscoverAdapters;
  scope: ScopeAdapters;
  getParsedSource: (paperId: string) => ParsedCitationSource | undefined;
  shouldStartWork: () => boolean;
  provenanceStore: ProvenanceStore;
}): Promise<HistorySource> {
  const {
    middle,
    maxCiters,
    neighborhoodLimit = RUN_CONFIG_DEFAULTS.discover.neighborhoodLimit,
    discover,
    scope,
    getParsedSource,
    shouldStartWork,
    provenanceStore,
  } = input;
  if (!middle.doi) {
    return unavailableHistorySource(
      middle,
      "missing_doi",
      "The intermediate paper has no resolved DOI.",
    );
  }
  if (!shouldStartWork()) {
    return unavailableHistorySource(
      middle,
      "cost_budget_exhausted",
      "The history spend limit is exhausted before discovery.",
    );
  }
  const doi = normalizeDoi(middle.doi);
  const seedId = buildSeedId({ doi });
  const seed = seedResolutionResultSchema.parse(
    await discover.resolveSeed({ doi }),
  );
  const seedArtifacts = [
    seed.execution.requestArtifact,
    seed.execution.responseArtifact,
  ];
  if (seed.status !== "resolved") {
    return unavailableHistorySource(
      middle,
      "neighborhood_unavailable",
      seed.reason,
      seedArtifacts,
    );
  }
  const query = neighborhoodResultSchema.parse(
    await discover.retrieveCitingNeighborhood({
      seed,
      boundary: {
        provider: "openalex",
        query: "cites",
        limit: neighborhoodLimit,
      },
    }),
  );
  const provenanceArtifacts = uniqueSortedArtifactReferences([
    ...seedArtifacts,
    query.execution.requestArtifact,
    query.execution.responseArtifact,
    ...(query.status === "completed" ? (query.pageArtifacts ?? []) : []),
  ]);
  if (query.status !== "completed") {
    return unavailableHistorySource(
      middle,
      "neighborhood_unavailable",
      query.reason,
      provenanceArtifacts,
    );
  }
  const enumerated = [
    ...new Map(query.papers.map((paper) => [paper.paperId, paper])).values(),
  ];
  const papers = selectByPublicationYear(
    enumerated,
    (paper) => paper.publicationYear,
    maxCiters,
  );
  const resolved: DiscoverSeed = {
    seedId,
    doi,
    resolution: { status: "resolved", ...seed.execution, paper: seed.paper },
    provenanceArtifacts: seedArtifacts,
  };
  return {
    neighborhood: {
      middle,
      status: "examined",
      reason: selectionReason,
      ...selectionCoverage(query, enumerated.length, papers.length),
      ...(query.providerReportedTotal == null
        ? {}
        : {
            providerReportedTotal: query.providerReportedTotal,
          }),
      provenanceArtifacts,
    },
    citers: papers.map((paper) => ({
      paper: toHistoryPaper(paper),
      examine: async () =>
        examineFreshCiter({
          adapters: discover,
          seed,
          seedId,
          paper,
          getParsedSource,
          shouldStartWork,
          provenanceStore,
        }),
    })),
    middleText: async () => {
      const materialization = scopeSeedMaterializationSchema.parse(
        await scope.materializeSeed({ seed: resolved }),
      );
      return versionedMiddleText(
        materialization,
        (reference) => provenanceStore.load(reference).body,
      );
    },
  };
}
