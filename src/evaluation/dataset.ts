import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  buildAdjudicatePacket,
  buildAdjudicatePrompt,
  assessAdjudicatePacketQuality,
} from "../stages/adjudicate/packet.js";
import { buildClaimUnitKey } from "../contract/claim-unit.js";
import { humanReviewEventLogSchema } from "../contract/human-review.js";
import { resolvePreparedRecords } from "../contract/artifacts/index.js";
import type { SeedSectionRole } from "../contract/artifacts/seed-section-role.js";
import { inferSectionRoles } from "../domain/section-patterns.js";
import { loadReportChain, type ReportChain } from "../pipeline/report-chain.js";
import { classifyPrepareOccurrenceDeterministically } from "../stages/prepare/run.js";
import { annotateCitingContext } from "../shared/citation-context-window.js";
import {
  resolveHumanReviewEventsPath,
  loadHumanReviewEventLog,
} from "../review/human-review-store.js";
import { buildStableId, canonicalSha256 } from "../shared/stable-identity.js";
import { compareCodeUnits } from "../shared/order.js";
import {
  buildConstructedCases,
  mutationFileSchema,
} from "./constructed-cases.js";
import {
  importedReviewsSchema,
  importedUnitVerdicts,
  type ImportedReviews,
} from "./imported-labels.js";
import { atomicJson, datasetDir, loadDataset } from "./storage.js";
import {
  datasetSchema,
  type EvaluationCase,
  type EvaluationDataset,
  type SeedDocument,
} from "./types.js";
import { buildCitationRolePrompt } from "../stages/prepare/prompts.js";

const BUILDER_VERSION = "evaluation-build-v3";

function withCaseId<T extends Omit<EvaluationCase, "caseId">>(
  input: T,
): T & { caseId: string } {
  return {
    ...input,
    caseId: buildStableId("eval-case", {
      builderVersion: BUILDER_VERSION,
      input,
    }),
  };
}

/**
 * Cases as the current code would build them from one run's artifacts. A
 * record the run adjudicated but today's packet gate would hold back is not a
 * case: no model would be asked about it now.
 */
function casesFromChain(chain: ReportChain): {
  cases: EvaluationCase[];
  heldBackRecordIds: string[];
} {
  const { prepare, evidence, adjudicate, report } = chain;
  const hashes = Object.fromEntries(
    [chain.discover, chain.scope, prepare, evidence, adjudicate, report].map(
      (artifact) => [artifact.stage, artifact.contentHash],
    ),
  );
  const cases: EvaluationCase[] = [];
  const heldBackRecordIds: string[] = [];
  const seenRoles = new Set<string>();
  const seenSpans = new Set<string>();
  const evidenceByRecord = new Map(
    evidence.payload.records.map((record) => [record.recordId, record]),
  );
  const adjudicateByRecord = new Map(
    adjudicate.payload.records.map((record) => [record.recordId, record]),
  );
  const bm25ById = new Map(
    evidence.payload.bm25Runs.map((run) => [run.bm25RunId, run]),
  );
  const selectionById = new Map(
    evidence.payload.selections.map((selection) => [
      selection.selectionId,
      selection,
    ]),
  );
  // Section roles are assigned again with the current rules, as the role and
  // packet replays below are, so a case shows what the pipeline would hand a
  // model today and not what an older run happened to label.
  const roleByBlock = currentSectionRoles(chain);
  const chunkById = new Map(
    evidence.payload.corpora.flatMap((corpus) =>
      corpus.chunks.map((chunk) => {
        const sourceSectionRole =
          roleByBlock.get(`${chunk.seedId}\0${chunk.sourceBlockId}`) ??
          chunk.sourceSectionRole;
        return [
          chunk.chunkId,
          {
            ...chunk,
            ...(sourceSectionRole ? { sourceSectionRole } : {}),
          },
        ] as const;
      }),
    ),
  );
  for (const record of resolvePreparedRecords(prepare.payload)) {
    const base = {
      runId: report.runId,
      seedDoi: record.seed.doi,
      recordId: record.recordId,
      sourceArtifactHashes: hashes,
    };
    const claims = record.occurrenceSourceClaimRecords;
    const context = record.citationOccurrence.rawContext;
    if (
      !seenRoles.has(record.citationOccurrenceId) &&
      claims.every((claim) => claim.supportSpan)
    ) {
      const deterministic = classifyPrepareOccurrenceDeterministically(
        record.citationOccurrence,
        {
          isReviewMediated:
            record.classification.status === "failed"
              ? false
              : record.classification.modifiers.isReviewMediated,
          occurrenceSourceClaimRecords: claims,
        },
      );
      if (deterministic.status === "failed")
        throw new Error(`Deterministic role replay failed: ${record.recordId}`);
      const role = deterministic.citationRole;
      const occurrence = record.citationOccurrence;
      cases.push(
        withCaseId({
          ...base,
          task: "role",
          occurrenceId: record.citationOccurrenceId,
          context,
          claims: claims.map((claim) => claim.extractedClaimText),
          ...(record.citationOccurrence.sectionTitle
            ? { sectionTitle: record.citationOccurrence.sectionTitle }
            : {}),
          ...(record.citationOccurrence.seedRefLabel
            ? { seedRefLabel: record.citationOccurrence.seedRefLabel }
            : {}),
          deterministicRole: role,
          deterministicUnclear: role === "unclear",
          anthropicPrompt: buildCitationRolePrompt(record),
          roleInput: {
            markedContext: annotateCitingContext(
              occurrence,
              claims.map((claim) => claim.supportSpan!),
            ),
            citationMarker: occurrence.citationMarker,
            supportSpans: claims.map((claim) => claim.supportSpan!.text),
            sectionTitle: occurrence.sectionTitle ?? null,
            seedRefLabel: occurrence.seedRefLabel ?? null,
            isBundledCitation: occurrence.isBundledCitation,
            bundleSize: occurrence.bundleSize,
          },
        }),
      );
      seenRoles.add(record.citationOccurrenceId);
    }
    for (const claim of claims) {
      if (seenSpans.has(claim.claimRecordId)) continue;
      cases.push(
        withCaseId({
          ...base,
          task: "span",
          claimRecordId: claim.claimRecordId,
          claim: claim.extractedClaimText,
          context,
        }),
      );
      seenSpans.add(claim.claimRecordId);
    }
    const outcome = evidenceByRecord.get(record.recordId);
    if (!outcome) throw new Error(`Missing Evidence record ${record.recordId}`);
    const bm25 = outcome.bm25RunId
      ? bm25ById.get(outcome.bm25RunId)
      : undefined;
    const selection = outcome.finalSelectionId
      ? selectionById.get(outcome.finalSelectionId)
      : undefined;
    if (bm25?.status === "matched" && bm25.candidates.length && selection) {
      const candidateIds = bm25.candidates.map(
        (candidate) => candidate.chunkId,
      );
      const candidates = candidateIds.map((chunkId) => {
        const chunk = chunkById.get(chunkId);
        if (!chunk) throw new Error(`Missing Evidence chunk ${chunkId}`);
        return {
          chunkId,
          text: chunk.text,
          sourceBlockKind: chunk.sourceBlockKind,
          ...(chunk.sourceSectionTitle
            ? { sectionTitle: chunk.sourceSectionTitle }
            : {}),
          ...(chunk.sourceSectionRole
            ? { sectionRole: chunk.sourceSectionRole }
            : {}),
          ...(chunk.sourceCitesOtherWork != null
            ? { citesOtherWork: chunk.sourceCitesOtherWork }
            : {}),
        };
      });
      const pinnedChunkIds = selection.pinnedChunkIds ?? [];
      const pinnedPassages = pinnedChunkIds
        .filter((id) => !candidateIds.includes(id))
        .map((id) => {
          const chunk = chunkById.get(id);
          if (!chunk) throw new Error(`Missing pinned chunk ${id}`);
          return { chunkId: id, text: chunk.text };
        });
      cases.push(
        withCaseId({
          ...base,
          task: "rerank",
          query: bm25.queryText,
          candidates,
          pinnedPassages,
          bm25Order: candidateIds,
          pinnedChunkIds,
          selectionLimit: selection.selectionLimit,
        }),
      );
    }
    const adjudication = adjudicateByRecord.get(record.recordId);
    if (adjudication?.status === "adjudicated" && selection) {
      const selectedChunks = selection.selectedChunkIds.map((id) =>
        chunkById.get(id),
      );
      if (selectedChunks.some((chunk) => !chunk))
        throw new Error("Missing selected evidence chunk");
      const packet = buildAdjudicatePacket({
        prepareRecord: record,
        selection,
        selectedChunks: selectedChunks.filter((chunk) => chunk != null),
      });
      if (!assessAdjudicatePacketQuality(packet).ok) {
        heldBackRecordIds.push(record.recordId);
        continue;
      }
      const unitKey = buildClaimUnitKey({
        familyId: record.familyId,
        citingPaperId: record.citationOccurrence.citingPaperId,
        claimTexts: claims.map((claim) => claim.extractedClaimText),
      });
      cases.push(
        withCaseId({
          ...base,
          task: "adjudication",
          unitKey,
          packet,
          anthropicPrompt: buildAdjudicatePrompt(packet),
        }),
      );
    }
  }
  return { cases, heldBackRecordIds };
}

/** Current section role of every seed block, keyed by seed and block. */
function currentSectionRoles(chain: ReportChain): Map<string, SeedSectionRole> {
  const roles = new Map<string, SeedSectionRole>();
  for (const seed of chain.scope.payload.seedMaterializations) {
    if (seed.status !== "materialized") continue;
    const inferred = inferSectionRoles(seed.blocks);
    seed.blocks.forEach((block, index) => {
      roles.set(`${seed.seedId}\0${block.blockId}`, inferred[index]!);
    });
  }
  return roles;
}

/** The seed text Scope froze, one document per seed that has any. */
function seedDocumentsFromChain(chain: ReportChain): SeedDocument[] {
  const roles = currentSectionRoles(chain);
  const seedById = new Map(
    chain.discover.payload.seeds.map((seed) => [seed.seedId, seed]),
  );
  return chain.scope.payload.seedMaterializations.flatMap((materialization) => {
    const seed = seedById.get(materialization.seedId);
    if (materialization.status !== "materialized" || !seed) return [];
    return [
      {
        seedDoi: seed.doi,
        title:
          seed.resolution.status === "resolved"
            ? seed.resolution.paper.title
            : seed.doi,
        blocks: materialization.blocks.map((block) => {
          const sectionRole = roles.get(
            `${materialization.seedId}\0${block.blockId}`,
          );
          return {
            blockId: block.blockId,
            text: block.text,
            blockKind: block.blockKind,
            ...(block.sectionTitle ? { sectionTitle: block.sectionTitle } : {}),
            ...(sectionRole ? { sectionRole } : {}),
            citesOtherWork: (block.citationMentionCount ?? 0) > 0,
          };
        }),
      },
    ];
  });
}

function historicalObservations(chains: readonly ReportChain[]) {
  return chains.map((chain) => ({
    runId: chain.report.runId,
    role: chain.prepare.payload.records.map((record) => ({
      recordId: record.recordId,
      classification: record.classification,
    })),
    rerank: chain.evidence.payload.records.flatMap((record) => {
      const run = chain.evidence.payload.rerankRuns.find(
        (entry) => entry.rerankRunId === record.rerankRunId,
      );
      return run
        ? [
            {
              recordId: record.recordId,
              rerankRunId: run.rerankRunId,
              bm25RunId: run.bm25RunId,
              status: run.status,
              results: run.status === "completed" ? run.results : [],
            },
          ]
        : [];
    }),
    spans: chain.discover.payload.attributedClaimRecords.map((claim) => ({
      claimRecordId: claim.claimRecordId,
      supportSpan: claim.supportSpan ?? null,
    })),
    adjudication: chain.adjudicate.payload.records.map((record) => ({
      recordId: record.recordId,
      status: record.status,
      verdict: record.status === "adjudicated" ? record.verdict : null,
    })),
  }));
}

function importedReviews(
  chains: readonly { chain: ReportChain; runRoot: string }[],
): ImportedReviews {
  return chains.flatMap(({ chain, runRoot }) => {
    const path = resolveHumanReviewEventsPath({
      runRoot,
      reportArtifactId: chain.report.artifactId,
    });
    const log = loadHumanReviewEventLog(path);
    if (!log) return [];
    if (
      log.lineage.reportContentHash !== chain.report.contentHash ||
      log.lineage.runId !== chain.report.runId
    )
      throw new Error("Review lineage mismatch");
    const recordUnitKeys = Object.fromEntries(
      resolvePreparedRecords(chain.prepare.payload).map((record) => [
        record.recordId,
        buildClaimUnitKey({
          familyId: record.familyId,
          citingPaperId: record.citationOccurrence.citingPaperId,
          claimTexts: record.occurrenceSourceClaimRecords.map(
            (claim) => claim.extractedClaimText,
          ),
        }),
      ]),
    );
    return [{ lineage: log.lineage, events: log.events, recordUnitKeys }];
  });
}

function datasetIdentity(
  dataset: Pick<
    EvaluationDataset,
    "builderVersion" | "sources" | "cases" | "seedDocuments"
  >,
): string {
  return buildStableId("dataset", {
    builderVersion: dataset.builderVersion,
    sources: dataset.sources,
    cases: dataset.cases,
    ...(dataset.seedDocuments ? { seedDocuments: dataset.seedDocuments } : {}),
  });
}

export function buildEvaluationDataset(input: {
  reportPaths: string[];
  name: string;
  /** JSON file of mutations that add constructed positives to the dataset. */
  mutationsPath?: string | undefined;
}): { dataset: EvaluationDataset; heldBackRecordIds: string[] } {
  if (input.reportPaths.length === 0)
    throw new Error("At least one --report is required");
  const chains = input.reportPaths.map(loadReportChain);
  const sources = chains.map(({ chain }) => ({
    runId: chain.report.runId,
    reportArtifactId: chain.report.artifactId,
    reportContentHash: chain.report.contentHash,
  }));
  if (new Set(sources.map((source) => source.runId)).size !== sources.length)
    throw new Error("A run may be selected once only");
  const seedDois = chains.flatMap(({ chain }) =>
    chain.discover.payload.seeds.map((seed) => seed.doi.toLowerCase()),
  );
  if (new Set(seedDois).size !== seedDois.length)
    throw new Error(
      "Selected runs share a seed DOI; repeated runs are not independent scientific examples",
    );
  const reviews = importedReviews(chains);
  const built = chains.map(({ chain }) => casesFromChain(chain));
  const observed = built.flatMap((entry) => entry.cases);
  const heldBackRecordIds = built.flatMap((entry) => entry.heldBackRecordIds);
  const mutations = input.mutationsPath
    ? mutationFileSchema.parse(
        JSON.parse(readFileSync(input.mutationsPath, "utf8")) as unknown,
      )
    : [];
  const cases = [
    ...observed,
    ...buildConstructedCases(
      observed,
      importedUnitVerdicts(reviews),
      mutations,
    ).map(withCaseId),
  ].sort((a, b) => compareCodeUnits(a.caseId, b.caseId));
  const content = {
    builderVersion: BUILDER_VERSION,
    sources,
    cases,
    seedDocuments: chains.flatMap(({ chain }) => seedDocumentsFromChain(chain)),
  } as const;
  const datasetId = datasetIdentity(content);
  const dataset = datasetSchema.parse({
    schemaVersion: "evaluation-dataset-v3",
    datasetId,
    name: input.name,
    ...content,
  });
  const dir = datasetDir(datasetId);
  if (existsSync(join(dir, "dataset.json"))) {
    const existing = loadDataset(datasetId);
    if (
      canonicalSha256({ ...existing, name: "" }) !==
      canonicalSha256({ ...dataset, name: "" })
    )
      throw new Error("Dataset identity collision");
    validateEvaluationDataset(datasetId);
    return { dataset: existing, heldBackRecordIds };
  }
  atomicJson(join(dir, "dataset.json"), dataset);
  const observations = historicalObservations(chains.map(({ chain }) => chain));
  atomicJson(join(dir, "historical-observations.json"), observations);
  atomicJson(join(dir, "imported-reviews.json"), reviews);
  atomicJson(join(dir, "imports.json"), {
    observationsHash: canonicalSha256(observations),
    reviewsHash: canonicalSha256(reviews),
  });
  return { dataset, heldBackRecordIds };
}

const importsSchema = z.object({
  observationsHash: z.string(),
  reviewsHash: z.string(),
});

export function validateEvaluationDataset(id: string): {
  caseCounts: Record<string, number>;
  importedReviewEvents: number;
} {
  const dataset = loadDataset(id);
  if (datasetIdentity(dataset) !== dataset.datasetId)
    throw new Error("Dataset content or identity changed");
  const ids = dataset.cases.map((item) => item.caseId);
  if (new Set(ids).size !== ids.length)
    throw new Error("Duplicate case identity");
  const byId = new Map(dataset.cases.map((item) => [item.caseId, item]));
  const seedTextDois = new Set(
    dataset.seedDocuments?.map((document) => document.seedDoi),
  );
  for (const item of dataset.cases) {
    if (
      dataset.schemaVersion === "evaluation-dataset-v3" &&
      item.task === "adjudication" &&
      !seedTextDois.has(item.seedDoi)
    )
      throw new Error(`Missing seed text for adjudication case ${item.caseId}`);
    if (item.task === "adjudication" && item.constructed) {
      const source = byId.get(item.constructed.sourceCaseId);
      if (source?.task !== "adjudication" || source.constructed)
        throw new Error(
          `Constructed case has no observed source: ${item.caseId}`,
        );
    }
    const { caseId, ...input } = item;
    if (
      caseId !==
      buildStableId("eval-case", {
        builderVersion: dataset.builderVersion,
        input,
      })
    )
      throw new Error(`Case changed: ${caseId}`);
    if (
      dataset.schemaVersion !== "evaluation-dataset-v1" &&
      item.task === "role" &&
      !item.roleInput
    )
      throw new Error(`Missing frozen Jev role input: ${caseId}`);
    if (item.task === "rerank") {
      const candidateIds = item.candidates.map(
        (candidate) => candidate.chunkId,
      );
      if (
        new Set(candidateIds).size !== candidateIds.length ||
        candidateIds.join() !== item.bm25Order.join()
      )
        throw new Error(`Invalid rerank candidate set ${caseId}`);
      if (
        item.pinnedChunkIds.some(
          (id) =>
            !candidateIds.includes(id) &&
            !item.pinnedPassages.some((passage) => passage.chunkId === id),
        )
      )
        throw new Error(`Invalid grounding pin ${caseId}`);
    }
  }
  const reviewsPath = join(datasetDir(id), "imported-reviews.json");
  const observationsPath = join(datasetDir(id), "historical-observations.json");
  const imports = importsSchema.parse(
    JSON.parse(
      readFileSync(join(datasetDir(id), "imports.json"), "utf8"),
    ) as unknown,
  );
  const reviewsRaw: unknown = JSON.parse(readFileSync(reviewsPath, "utf8"));
  const observationsRaw: unknown = JSON.parse(
    readFileSync(observationsPath, "utf8"),
  );
  if (
    canonicalSha256(reviewsRaw) !== imports.reviewsHash ||
    canonicalSha256(observationsRaw) !== imports.observationsHash
  )
    throw new Error("Imported reviews or historical observations changed");
  const reviews = importedReviewsSchema.parse(reviewsRaw);
  for (const review of reviews) {
    const source = dataset.sources.find(
      (entry) => entry.runId === review.lineage.runId,
    );
    if (
      !source ||
      source.reportArtifactId !== review.lineage.reportArtifactId ||
      source.reportContentHash !== review.lineage.reportContentHash
    )
      throw new Error(
        "Imported review lineage does not match a dataset source",
      );
    humanReviewEventLogSchema.parse({
      schemaVersion: "human-review-events-v2",
      lineage: review.lineage,
      events: review.events,
    });
  }
  const caseCounts: Record<string, number> = {};
  for (const item of dataset.cases)
    caseCounts[item.task] = (caseCounts[item.task] ?? 0) + 1;
  return {
    caseCounts,
    importedReviewEvents: reviews.reduce(
      (sum, item) => sum + item.events.length,
      0,
    ),
  };
}
