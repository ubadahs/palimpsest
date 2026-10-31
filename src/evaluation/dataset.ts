import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  buildCanonicalAdjudicatePacket,
  buildCanonicalAdjudicatePrompt,
  assessAdjudicatePacketQuality,
} from "../adjudication/canonical-adjudicate-packet.js";
import { buildClaimUnitKey } from "../contract/claim-unit.js";
import { humanReviewEventLogSchema } from "../contract/human-review.js";
import {
  buildReportInspectorRecords,
  loadCanonicalArtifact,
} from "../contract/selectors.js";
import type { StageArtifactMap } from "../contract/inspector-payloads.js";
import type { StageKey } from "../contract/lean-stages.js";
import { verifyReportAncestors } from "../pipeline/canonical-report.js";
import { buildCitationRolePrompt } from "../pipeline/canonical-production-adapters.js";
import { classifyPrepareOccurrenceDeterministically } from "../pipeline/canonical-prepare.js";
import { annotateCitingContext } from "../shared/citation-context-window.js";
import {
  resolveHumanReviewEventsPath,
  loadHumanReviewEventLog,
} from "../review/human-review-store.js";
import { buildStableId, canonicalSha256 } from "../shared/stable-identity.js";
import { compareCodeUnits } from "../shared/order.js";
import { atomicJson, datasetDir, loadDataset } from "./storage.js";
import {
  datasetSchema,
  type EvaluationCase,
  type EvaluationDataset,
} from "./types.js";

type AncestorStage =
  | "discover"
  | "scope"
  | "prepare"
  | "evidence"
  | "adjudicate";
type Chain = { [K in StageKey]: StageArtifactMap[K] };

function loadAncestor<K extends AncestorStage>(
  runRoot: string,
  stage: K,
  reference: { artifactId: string; contentHash: string },
): StageArtifactMap[K] {
  const folder = readdirSync(runRoot, { withFileTypes: true }).find(
    (entry) => entry.isDirectory() && entry.name.endsWith(`-${stage}`),
  );
  if (!folder)
    throw new Error(`Missing ${stage} stage directory in ${runRoot}`);
  const matches = readdirSync(join(runRoot, folder.name)).filter(
    (name) =>
      name.endsWith(`_canonical-${stage}.json`) &&
      name.includes(reference.artifactId),
  );
  if (matches.length !== 1)
    throw new Error(
      `Expected one ${stage} artifact matching ${reference.artifactId}`,
    );
  const artifact = loadCanonicalArtifact(
    stage,
    join(runRoot, folder.name, matches[0]!),
  );
  if (
    artifact.artifactId !== reference.artifactId ||
    artifact.contentHash !== reference.contentHash
  )
    throw new Error(`${stage} lineage mismatch`);
  return artifact;
}

function loadChain(reportPath: string): { chain: Chain; runRoot: string } {
  const full = resolve(reportPath);
  const report = loadCanonicalArtifact("report", full);
  const runRoot = dirname(dirname(full));
  const lineage = report.payload.lineage;
  if (report.runId !== lineage.runId)
    throw new Error("Report run identity mismatch");
  const discover = loadAncestor(runRoot, "discover", lineage.discoverArtifact);
  const scope = loadAncestor(runRoot, "scope", lineage.scopeArtifact);
  const prepare = loadAncestor(runRoot, "prepare", lineage.prepareArtifact);
  const evidence = loadAncestor(runRoot, "evidence", lineage.evidenceArtifact);
  const adjudicate = loadAncestor(
    runRoot,
    "adjudicate",
    lineage.adjudicateArtifact,
  );
  verifyReportAncestors({
    discoverArtifact: discover,
    scopeArtifact: scope,
    prepareArtifact: prepare,
    evidenceArtifact: evidence,
    adjudicateArtifact: adjudicate,
  });
  buildReportInspectorRecords({ report, prepare, evidence, adjudicate });
  if (report.payload.recordTraces.length !== prepare.payload.records.length)
    throw new Error("Report record spine is incomplete");
  return {
    chain: { discover, scope, prepare, evidence, adjudicate, report },
    runRoot,
  };
}

function casesFromChain(chain: Chain): EvaluationCase[] {
  const { prepare, evidence, adjudicate, report } = chain;
  const hashes = Object.fromEntries(
    [chain.discover, chain.scope, prepare, evidence, adjudicate, report].map(
      (artifact) => [artifact.canonicalStage, artifact.contentHash],
    ),
  );
  const withId = <T extends Omit<EvaluationCase, "caseId">>(
    input: T,
  ): T & { caseId: string } => ({
    ...input,
    caseId: buildStableId("eval-case", {
      builderVersion: "evaluation-build-v2",
      input,
    }),
  });
  const cases: EvaluationCase[] = [];
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
  const chunkById = new Map(
    evidence.payload.corpora.flatMap((corpus) =>
      corpus.chunks.map((chunk) => [chunk.chunkId, chunk] as const),
    ),
  );
  for (const record of prepare.payload.records) {
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
        withId({
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
              context,
              occurrence.citationMarker,
              occurrence.seedRefLabel,
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
        withId({
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
        withId({
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
      const packet = buildCanonicalAdjudicatePacket({
        prepareRecord: record,
        selection,
        selectedChunks: selectedChunks.filter((chunk) => chunk != null),
      });
      if (!assessAdjudicatePacketQuality(packet).ok)
        throw new Error(
          `Adjudicated record fails current packet gate: ${record.recordId}`,
        );
      const unitKey = buildClaimUnitKey({
        familyId: record.familyId,
        citingPaperId: record.citationOccurrence.citingPaperId,
        claimTexts: claims.map((claim) => claim.extractedClaimText),
      });
      cases.push(
        withId({
          ...base,
          task: "adjudication",
          unitKey,
          packet,
          anthropicPrompt: buildCanonicalAdjudicatePrompt(packet),
        }),
      );
    }
  }
  return cases.sort((a, b) => compareCodeUnits(a.caseId, b.caseId));
}

export function buildEvaluationDataset(input: {
  reportPaths: string[];
  name: string;
}): EvaluationDataset {
  if (input.reportPaths.length === 0)
    throw new Error("At least one --report is required");
  const chains = input.reportPaths.map(loadChain);
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
  const cases = chains
    .flatMap(({ chain }) => casesFromChain(chain))
    .sort((a, b) => compareCodeUnits(a.caseId, b.caseId));
  const datasetId = buildStableId("dataset", {
    builderVersion: "evaluation-build-v2",
    sources,
    cases,
  });
  const dataset = datasetSchema.parse({
    schemaVersion: "evaluation-dataset-v2",
    builderVersion: "evaluation-build-v2",
    datasetId,
    name: input.name,
    sources,
    cases,
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
    return existing;
  }
  atomicJson(join(dir, "dataset.json"), dataset);
  const observations = chains.flatMap(({ chain }) => ({
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
  atomicJson(join(dir, "historical-observations.json"), observations);
  const reviews = chains.flatMap(({ chain, runRoot }) => {
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
      chain.prepare.payload.records.map((record) => [
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
  atomicJson(join(dir, "imported-reviews.json"), reviews);
  atomicJson(join(dir, "imports.json"), {
    observationsHash: canonicalSha256(observations),
    reviewsHash: canonicalSha256(reviews),
  });
  return dataset;
}

export const importedReviewsSchema = z.array(
  z.object({
    lineage: z.object({
      runId: z.string(),
      reportArtifactId: z.string(),
      reportContentHash: z.string(),
    }),
    events: z.array(z.unknown()),
    recordUnitKeys: z.record(z.string(), z.string()),
  }),
);
const importsSchema = z.object({
  observationsHash: z.string(),
  reviewsHash: z.string(),
});

export function validateEvaluationDataset(id: string): {
  caseCounts: Record<string, number>;
  importedReviewEvents: number;
} {
  const dataset = loadDataset(id);
  const expected = buildStableId("dataset", {
    builderVersion: dataset.builderVersion,
    sources: dataset.sources,
    cases: dataset.cases,
  });
  if (expected !== dataset.datasetId)
    throw new Error("Dataset content or identity changed");
  const ids = dataset.cases.map((item) => item.caseId);
  if (new Set(ids).size !== ids.length)
    throw new Error("Duplicate case identity");
  for (const item of dataset.cases) {
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
      dataset.schemaVersion === "evaluation-dataset-v2" &&
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
