import { z } from "zod";

import { compareCodeUnits } from "../shared/order.js";
import { createBoundaryParser } from "../shared/boundary.js";

import { buildClaimUnitKey } from "../contract/claim-unit.js";
import { summarizeStatuses } from "../contract/canonical-report.js";

import {
  adjudicateArtifactSchema,
  buildCitationGroupKey,
  buildReportDecisionRecordId,
  buildReportCount,
  buildReportRate,
  canonicalReportMethod,
  createAppendOnlyDecision,
  createLeanStageArtifact,
  discoverArtifactSchema,
  evidenceArtifactSchema,
  leanArtifactSchemaVersion,
  leanArtifactVersion,
  prepareArtifactSchema,
  canonicalReportMethodId,
  REPORT_INTERPRETATION_WARNING,
  REPORT_PUBLICATION_REASON,
  reportArtifactPayloadSchema,
  reportArtifactSchema,
  scopeArtifactSchema,
  type AdjudicateArtifact,
  type AppendOnlyDecision,
  type ArtifactReference,
  type DiscoverArtifact,
  type EvidenceArtifact,
  type LeanArtifactProvenance,
  type PrepareArtifact,
  type ReportArtifact,
  type ReportArtifactPayload,
  type ReportCount,
  type ReportDecisionSummary,
  type ReportFamilyMutation,
  type ReportFamilyMutationRecord,
  type ReportFunnelCounts,
  type ReportLineage,
  type ReportRate,
  type ReportRecordTrace,
  type ReportSelectionAuditRow,
  type ScopeArtifact,
} from "../contract/lean-artifacts.js";
import { canonicalSerialize } from "../shared/stable-identity.js";

const canonicalReportOptionsSchema = z
  .object({
    recordedAt: z.string().datetime({ offset: true }),
    discoverArtifactUri: z.string().min(1).optional(),
    scopeArtifactUri: z.string().min(1).optional(),
    prepareArtifactUri: z.string().min(1).optional(),
    evidenceArtifactUri: z.string().min(1).optional(),
    adjudicateArtifactUri: z.string().min(1).optional(),
  })
  .strict();
export type CanonicalReportOptions = z.input<
  typeof canonicalReportOptionsSchema
>;

export type CanonicalReportResult = {
  payload: ReportArtifactPayload;
  decisions: AppendOnlyDecision[];
};

export class CanonicalReportBoundaryError extends Error {
  override readonly name = "CanonicalReportBoundaryError";
}

/**
 * Pure deterministic Report stage. No adapters, no model calls, no sampling.
 * Consumes and tamper-verifies the complete current canonical artifact chain.
 */
export function runCanonicalReport(
  discoverArtifactInput: unknown,
  scopeArtifactInput: unknown,
  prepareArtifactInput: unknown,
  evidenceArtifactInput: unknown,
  adjudicateArtifactInput: unknown,
  optionsInput: CanonicalReportOptions,
): CanonicalReportResult {
  const discoverArtifact = parseBoundary(
    discoverArtifactSchema,
    discoverArtifactInput,
    "canonical Discover ancestor",
  );
  const scopeArtifact = parseBoundary(
    scopeArtifactSchema,
    scopeArtifactInput,
    "canonical Scope ancestor",
  );
  const prepareArtifact = parseBoundary(
    prepareArtifactSchema,
    prepareArtifactInput,
    "canonical Prepare ancestor",
  );
  const evidenceArtifact = parseBoundary(
    evidenceArtifactSchema,
    evidenceArtifactInput,
    "canonical Evidence ancestor",
  );
  const adjudicateArtifact = parseBoundary(
    adjudicateArtifactSchema,
    adjudicateArtifactInput,
    "canonical Adjudicate input",
  );
  const options = parseBoundary(
    canonicalReportOptionsSchema,
    optionsInput,
    "canonical Report options",
  );

  verifyReportAncestors({
    discoverArtifact,
    scopeArtifact,
    prepareArtifact,
    evidenceArtifact,
    adjudicateArtifact,
  });

  const lineage = buildReportLineage({
    discoverArtifact,
    scopeArtifact,
    prepareArtifact,
    evidenceArtifact,
    adjudicateArtifact,
    options,
  });

  const funnel = buildFunnelCounts({
    discoverArtifact,
    scopeArtifact,
    prepareArtifact,
    evidenceArtifact,
    adjudicateArtifact,
  });
  const rates = buildRates(funnel);
  const recordTraces = buildRecordTraces({
    prepareArtifact,
    evidenceArtifact,
    adjudicateArtifact,
    lineage,
  });
  const selectionAudit = buildSelectionAudit(discoverArtifact);
  const decisionSummaries = buildDecisionSummaries([
    discoverArtifact,
    scopeArtifact,
    prepareArtifact,
    evidenceArtifact,
    adjudicateArtifact,
  ]);

  const familyMutations = buildFamilyMutations({
    discoverArtifact,
    prepareArtifact,
    evidenceArtifact,
    adjudicateArtifact,
  });

  const payload = reportArtifactPayloadSchema.parse({
    lineage,
    method: canonicalReportMethod,
    interpretationStatus: "uncalibrated_research_output",
    interpretationWarning: REPORT_INTERPRETATION_WARNING,
    deterministic: true,
    replayableFromInputs: true,
    funnel,
    rates,
    familyMutations,
    recordTraces,
    decisionSummaries,
    selectionAudit,
  });

  const decisions = [
    createAppendOnlyDecision({
      recordId: buildReportDecisionRecordId(lineage.runId),
      decisionType: "report_interpretation_status",
      outcome: "uncalibrated_research_output",
      reason: REPORT_INTERPRETATION_WARNING,
      recordedAt: options.recordedAt,
      actor: {
        kind: "deterministic",
        identifier: canonicalReportMethodId,
      },
      evidenceArtifacts: [
        lineage.discoverArtifact,
        lineage.scopeArtifact,
        lineage.prepareArtifact,
        lineage.evidenceArtifact,
        lineage.adjudicateArtifact,
      ],
    }),
    createAppendOnlyDecision({
      recordId: buildReportDecisionRecordId(lineage.runId),
      decisionType: "report_publication_status",
      outcome: "research_artifact_only",
      reason: REPORT_PUBLICATION_REASON,
      recordedAt: options.recordedAt,
      actor: {
        kind: "deterministic",
        identifier: canonicalReportMethodId,
      },
      evidenceArtifacts: [
        lineage.discoverArtifact,
        lineage.scopeArtifact,
        lineage.prepareArtifact,
        lineage.evidenceArtifact,
        lineage.adjudicateArtifact,
      ],
    }),
  ];

  return {
    payload,
    decisions,
  };
}

export function buildCanonicalReportArtifact(input: {
  result: CanonicalReportResult;
  runId: string;
  createdAt: string;
  configuration?: LeanArtifactProvenance["configuration"];
  code?: LeanArtifactProvenance["code"];
  implementation?: string;
}): ReportArtifact {
  const provenance: LeanArtifactProvenance = {
    ...(input.configuration ? { configuration: input.configuration } : {}),
    ...(input.code ? { code: input.code } : {}),
    prompts: [],
    models: [],
  };
  const artifact = createLeanStageArtifact({
    schemaVersion: leanArtifactSchemaVersion,
    artifactVersion: leanArtifactVersion,
    runId: input.runId,
    createdAt: input.createdAt,
    canonicalStage: "report",
    inputArtifacts: [
      input.result.payload.lineage.discoverArtifact,
      input.result.payload.lineage.scopeArtifact,
      input.result.payload.lineage.prepareArtifact,
      input.result.payload.lineage.evidenceArtifact,
      input.result.payload.lineage.adjudicateArtifact,
    ],
    provenance,
    execution: {
      kind: "deterministic",
      implementation: input.implementation ?? "canonical-report-v1",
      replayableFromInputs: true,
    },
    decisions: input.result.decisions,
    payload: input.result.payload,
  });
  return parseBoundary(
    reportArtifactSchema,
    artifact,
    "canonical Report artifact",
  );
}

function verifyReportAncestors(input: {
  discoverArtifact: DiscoverArtifact;
  scopeArtifact: ScopeArtifact;
  prepareArtifact: PrepareArtifact;
  evidenceArtifact: EvidenceArtifact;
  adjudicateArtifact: AdjudicateArtifact;
}): void {
  const {
    discoverArtifact,
    scopeArtifact,
    prepareArtifact,
    evidenceArtifact,
    adjudicateArtifact,
  } = input;

  const runIds = [
    discoverArtifact.runId,
    scopeArtifact.runId,
    prepareArtifact.runId,
    evidenceArtifact.runId,
    adjudicateArtifact.runId,
    prepareArtifact.payload.lineage.runId,
    evidenceArtifact.payload.lineage.runId,
    adjudicateArtifact.payload.lineage.runId,
  ];
  if (new Set(runIds).size !== 1) {
    throw new CanonicalReportBoundaryError(
      "Canonical Report ancestors belong to different runs",
    );
  }

  assertExactReference(
    scopeArtifact.payload.discoverArtifact,
    discoverArtifact,
    "Scope Discover lineage",
  );
  assertExactReference(
    prepareArtifact.payload.lineage.discoverArtifact,
    discoverArtifact,
    "Prepare Discover lineage",
  );
  assertExactReference(
    prepareArtifact.payload.lineage.scopeArtifact,
    scopeArtifact,
    "Prepare Scope lineage",
  );
  assertExactReference(
    evidenceArtifact.payload.lineage.prepareArtifact,
    prepareArtifact,
    "Evidence Prepare lineage",
  );
  assertExactReference(
    evidenceArtifact.payload.lineage.scopeArtifact,
    scopeArtifact,
    "Evidence Scope lineage",
  );
  assertExactReference(
    adjudicateArtifact.payload.lineage.evidenceArtifact,
    evidenceArtifact,
    "Adjudicate Evidence lineage",
  );
  assertExactReference(
    adjudicateArtifact.payload.lineage.prepareArtifact,
    prepareArtifact,
    "Adjudicate Prepare lineage",
  );

  const prepareIds = prepareArtifact.payload.records.map(
    (record) => record.recordId,
  );
  const evidenceIds = evidenceArtifact.payload.records.map(
    (record) => record.recordId,
  );
  const adjudicateIds = adjudicateArtifact.payload.records.map(
    (record) => record.recordId,
  );
  if (
    canonicalSerialize([...prepareIds].sort(compareCodeUnits)) !==
      canonicalSerialize([...evidenceIds].sort(compareCodeUnits)) ||
    canonicalSerialize([...prepareIds].sort(compareCodeUnits)) !==
      canonicalSerialize([...adjudicateIds].sort(compareCodeUnits))
  ) {
    throw new CanonicalReportBoundaryError(
      "Prepare, Evidence, and Adjudicate record ID sets do not match exactly",
    );
  }
  if (
    prepareIds.length !== evidenceIds.length ||
    prepareIds.length !== adjudicateIds.length
  ) {
    throw new CanonicalReportBoundaryError(
      "Prepare, Evidence, and Adjudicate record counts do not match",
    );
  }
}

function buildReportLineage(input: {
  discoverArtifact: DiscoverArtifact;
  scopeArtifact: ScopeArtifact;
  prepareArtifact: PrepareArtifact;
  evidenceArtifact: EvidenceArtifact;
  adjudicateArtifact: AdjudicateArtifact;
  options: CanonicalReportOptions;
}): ReportLineage {
  return {
    runId: input.discoverArtifact.runId,
    discoverArtifact: toStageReference(
      input.discoverArtifact,
      "canonical-discover-input",
      "discover",
      input.options.discoverArtifactUri,
    ),
    scopeArtifact: toStageReference(
      input.scopeArtifact,
      "canonical-scope-input",
      "scope",
      input.options.scopeArtifactUri,
    ),
    prepareArtifact: toStageReference(
      input.prepareArtifact,
      "canonical-prepare-input",
      "prepare",
      input.options.prepareArtifactUri,
    ),
    evidenceArtifact: toStageReference(
      input.evidenceArtifact,
      "canonical-evidence-input",
      "evidence",
      input.options.evidenceArtifactUri,
    ),
    adjudicateArtifact: toStageReference(
      input.adjudicateArtifact,
      "canonical-adjudicate-input",
      "adjudicate",
      input.options.adjudicateArtifactUri,
    ),
  };
}

function buildFunnelCounts(input: {
  discoverArtifact: DiscoverArtifact;
  scopeArtifact: ScopeArtifact;
  prepareArtifact: PrepareArtifact;
  evidenceArtifact: EvidenceArtifact;
  adjudicateArtifact: AdjudicateArtifact;
}): ReportFunnelCounts {
  const {
    discoverArtifact,
    scopeArtifact,
    prepareArtifact,
    evidenceArtifact,
    adjudicateArtifact,
  } = input;
  const discover = discoverArtifact.payload;
  const citingPapers = discover.citingPapers;
  const returnedCitingPaperObservations = citingPapers.length;
  const strata = new Map<string, { returned: number; probed: number }>();
  for (const paper of citingPapers) {
    const key = paper.probe.stratum
      ? `${paper.probe.stratum.yearBand}::${paper.probe.stratum.paperType}`
      : "unknown::unknown";
    const bucket = strata.get(key) ?? { returned: 0, probed: 0 };
    bucket.returned += 1;
    if (paper.probe.status === "selected") bucket.probed += 1;
    strata.set(key, bucket);
  }
  const probeStratumCounts = [...strata.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([stratum, counts]) => ({ stratum, ...counts }));
  // The sampling denominator the provider reported, and whether pagination
  // reached all of it. Both are on the Discover queries and neither reached
  // the report before.
  const providerReportedNeighborhoodTotal = discover.neighborhoodQueries.reduce(
    (total, query) => total + (query.providerReportedTotal ?? 0),
    0,
  );
  const neighborhoodCoverage = summarizeStatuses(
    discover.neighborhoodQueries.map((query) => query.coverage),
  );
  const materializationChannelCounts = summarizeStatuses(
    citingPapers.flatMap((paper) =>
      paper.acquisition ? [paper.acquisition.accessChannel] : [],
    ),
  );
  const materializationLossReasonCounts = summarizeStatuses(
    citingPapers.flatMap((paper) =>
      paper.materialization.status === "succeeded"
        ? []
        : [paper.materialization.reasonCode ?? paper.materialization.status],
    ),
  );
  const harvestLossReasonCounts = summarizeStatuses(
    citingPapers.flatMap((paper) =>
      paper.harvest.status === "succeeded"
        ? []
        : [paper.harvest.reasonCode ?? paper.harvest.status],
    ),
  );
  const bibliographyMatchMethodCounts = summarizeStatuses(
    citingPapers.flatMap((paper) =>
      paper.bibliographyMatch ? [paper.bibliographyMatch.method] : [],
    ),
  );
  const probed = citingPapers.filter(
    (paper) => paper.probe.status === "selected",
  ).length;
  const notProbed = citingPapers.filter(
    (paper) => paper.probe.status === "not_selected",
  ).length;
  const materializationSucceeded = countBy(
    citingPapers,
    (paper) => paper.materialization.status === "succeeded",
  );
  const materializationFailed = countBy(
    citingPapers,
    (paper) => paper.materialization.status === "failed",
  );
  const materializationUnavailable = countBy(
    citingPapers,
    (paper) => paper.materialization.status === "unavailable",
  );
  const materializationNotAttempted = countBy(
    citingPapers,
    (paper) => paper.materialization.status === "not_attempted",
  );
  const harvestSucceeded = countBy(
    citingPapers,
    (paper) => paper.harvest.status === "succeeded",
  );
  const harvestNoMentions = countBy(
    citingPapers,
    (paper) => paper.harvest.status === "no_mentions",
  );
  const harvestFailed = countBy(
    citingPapers,
    (paper) => paper.harvest.status === "failed",
  );
  const harvestNotAttempted = countBy(
    citingPapers,
    (paper) => paper.harvest.status === "not_attempted",
  );
  const extraction = discover.claimExtractionObservations;
  const selectedCandidates = discover.candidateDispositions.filter(
    (disposition) => disposition.selectedForScope,
  ).length;
  const deferredCandidates = discover.candidateDispositions.filter(
    (disposition) => !disposition.selectedForScope,
  ).length;
  const uniqueCitingPapersWithOccurrences = new Set(
    discover.citationMentions.map((mention) => mention.citingPaperId),
  ).size;
  const uniqueCitationGroups = new Set(
    discover.citationMentions.map(buildCitationGroupKey),
  ).size;
  const deferredByFamilyCap = countBy(
    discover.candidateDispositions,
    (disposition) => disposition.bindingConstraint === "max_families",
  );
  const deferredByRecordBudget = countBy(
    discover.candidateDispositions,
    (disposition) => disposition.bindingConstraint === "max_prepared_records",
  );
  const deferredByNovelty = countBy(
    discover.candidateDispositions,
    (disposition) => disposition.bindingConstraint === "min_marginal_novelty",
  );
  const attributedClaimsWithVerifiedSupportSpan = countBy(
    discover.attributedClaimRecords,
    (record) => record.supportSpan != null,
  );
  const attributedClaimsMissingSupportSpan = countBy(
    discover.attributedClaimRecords,
    (record) => record.supportSpan == null,
  );

  const scopedCandidates = scopeArtifact.payload.candidateDecisions.filter(
    (decision) => decision.disposition === "scoped",
  ).length;
  const deferredScopeCandidates =
    scopeArtifact.payload.candidateDecisions.filter(
      (decision) => decision.disposition === "deferred_upstream",
    ).length;
  const groundingStatusCounts = countStatuses(
    scopeArtifact.payload.families.map((family) => family.grounding.status),
  );

  const preparedRecords = prepareArtifact.payload.records;
  const expectedPairs = prepareArtifact.payload.scopedFamilies.reduce(
    (sum, family) => sum + family.includedCitationOccurrenceIds.length,
    0,
  );
  const classified = countBy(
    preparedRecords,
    (record) => record.classification.status === "classified",
  );
  const ambiguous = countBy(
    preparedRecords,
    (record) => record.classification.status === "ambiguous",
  );
  const failed = countBy(
    preparedRecords,
    (record) => record.classification.status === "failed",
  );
  const lowInformation = countBy(preparedRecords, (record) => {
    if (record.classification.status === "failed") return false;
    return (
      record.classification.citationRole ===
        "acknowledgment_or_low_information" ||
      record.classification.evaluationMode === "skip_low_information"
    );
  });
  const manualReviewRoleAmbiguous = countBy(preparedRecords, (record) => {
    if (record.classification.status === "failed") return false;
    return (
      record.classification.evaluationMode === "manual_review_role_ambiguous"
    );
  });
  const manualReviewExtractionLimited = countBy(preparedRecords, (record) => {
    if (record.classification.status === "failed") return false;
    return (
      record.classification.evaluationMode ===
      "manual_review_extraction_limited"
    );
  });
  const manualReview = countBy(preparedRecords, (record) => {
    if (record.classification.status === "failed") return false;
    return (
      record.classification.evaluationMode === "manual_review_role_ambiguous" ||
      record.classification.evaluationMode ===
        "manual_review_extraction_limited" ||
      record.classification.status === "ambiguous"
    );
  });

  const evidenceRecords = evidenceArtifact.payload.records;
  const retrievalStatusCounts = countStatuses(
    evidenceRecords.map((record) => record.retrievalStatus),
  );
  const bm25MatchedRuns = countBy(
    evidenceArtifact.payload.bm25Runs,
    (run) => run.status === "matched",
  );
  const bm25NoMatchRuns = countBy(
    evidenceArtifact.payload.bm25Runs,
    (run) => run.status === "no_lexical_matches",
  );
  const rerankDisabled = countBy(
    evidenceRecords,
    (record) => record.rerankStatus === "disabled",
  );
  const rerankCompleted = countBy(
    evidenceRecords,
    (record) => record.rerankStatus === "completed",
  );
  const rerankFailed = countBy(
    evidenceRecords,
    (record) => record.rerankStatus === "failed",
  );
  const rerankNotAttempted = countBy(
    evidenceRecords,
    (record) =>
      record.rerankStatus === "not_attempted_no_candidates" ||
      record.rerankStatus === "not_attempted_unavailable" ||
      record.rerankStatus === "not_attempted_retrieval_failure",
  );
  const uniqueFinalSelectionsBm25 = countBy(
    evidenceArtifact.payload.selections,
    (selection) =>
      selection.rankingSource === "bm25" ||
      selection.rankingSource === "bm25_with_scope_pins",
  );
  const uniqueFinalSelectionsReranked = countBy(
    evidenceArtifact.payload.selections,
    (selection) =>
      selection.rankingSource === "reranked" ||
      selection.rankingSource === "reranked_with_scope_pins",
  );
  const selectionById = new Map(
    evidenceArtifact.payload.selections.map((selection) => [
      selection.selectionId,
      selection,
    ]),
  );
  let recordSelectionBm25 = 0;
  let recordSelectionReranked = 0;
  for (const record of evidenceRecords) {
    if (record.finalSelectionId == null) continue;
    const selection = selectionById.get(record.finalSelectionId);
    if (selection == null) {
      throw new CanonicalReportBoundaryError(
        `Evidence record references missing selection: ${record.recordId}`,
      );
    }
    if (
      selection.rankingSource === "bm25" ||
      selection.rankingSource === "bm25_with_scope_pins"
    ) {
      recordSelectionBm25 += 1;
    } else if (
      selection.rankingSource === "reranked" ||
      selection.rankingSource === "reranked_with_scope_pins"
    ) {
      recordSelectionReranked += 1;
    }
  }

  const adjudicateRecords = adjudicateArtifact.payload.records;
  const adjudicated = adjudicateRecords.filter(
    (record) => record.status === "adjudicated",
  );
  const notAdjudicated = adjudicateRecords.filter(
    (record) => record.status === "not_adjudicated",
  );
  const adjudicationFailed = adjudicateRecords.filter(
    (record) => record.status === "adjudication_failed",
  );
  const invalidOutput = adjudicateRecords.filter(
    (record) => record.status === "invalid_output",
  );
  const gateCodeCounts = countStatuses(
    notAdjudicated.map((record) => record.gateCode),
  );
  const failureCodeCounts = countStatuses(
    adjudicationFailed.map((record) => record.failureCode),
  );
  const mutationKindCounts = countStatuses(
    adjudicated.flatMap((record) =>
      record.status === "adjudicated" ? record.mutationKinds : [],
    ),
  );
  const mutationDirectionCounts = countStatuses(
    adjudicated.flatMap((record) =>
      record.status === "adjudicated" && record.verdict === "D"
        ? [record.direction]
        : [],
    ),
  );
  const verdictCount = (label: "F" | "D" | "E" | "U") =>
    adjudicated.filter(
      (record) => record.status === "adjudicated" && record.verdict === label,
    ).length;
  const selectionSourceById = new Map(
    evidenceArtifact.payload.selections.map((selection) => [
      selection.selectionId,
      selection.rankingSource,
    ]),
  );
  const rankingSourceByRecordId = new Map(
    evidenceArtifact.payload.records.flatMap((record) =>
      record.finalSelectionId != null
        ? [
            [
              record.recordId,
              selectionSourceById.get(record.finalSelectionId),
            ] as const,
          ]
        : [],
    ),
  );
  const verdictsBySource = new Map<
    EvidenceArtifact["payload"]["selections"][number]["rankingSource"],
    { F: number; D: number; E: number; U: number }
  >();
  for (const record of adjudicated) {
    if (record.status !== "adjudicated") continue;
    const source = rankingSourceByRecordId.get(record.recordId);
    if (!source) continue;
    const bucket = verdictsBySource.get(source) ?? { F: 0, D: 0, E: 0, U: 0 };
    bucket[record.verdict] += 1;
    verdictsBySource.set(source, bucket);
  }
  const verdictCountsByRankingSource = [...verdictsBySource.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([rankingSource, counts]) => ({ rankingSource, ...counts }));

  const prepareById = new Map(
    preparedRecords.map((record) => [record.recordId, record]),
  );
  const uniqueClaimUnitKeys = new Set<string>();
  const uniqueAdjudicatedClaimUnitKeys = new Set<string>();
  const uniqueUnitsByVerdict = {
    F: new Set<string>(),
    D: new Set<string>(),
    E: new Set<string>(),
    U: new Set<string>(),
  };
  let packetsWithVerifiedSupportSpans = 0;
  let packetsMissingSupportSpans = 0;
  for (const outcome of adjudicateRecords) {
    const prepareRecord = prepareById.get(outcome.recordId);
    if (!prepareRecord) continue;
    const unitKey = buildClaimUnitKey({
      familyId: prepareRecord.familyId,
      citingPaperId: prepareRecord.citingPaper.paper.paperId,
      claimTexts: prepareRecord.occurrenceSourceClaimRecords.map(
        (claim) => claim.extractedClaimText,
      ),
    });
    uniqueClaimUnitKeys.add(unitKey);
    if (outcome.status === "adjudicated") {
      uniqueAdjudicatedClaimUnitKeys.add(unitKey);
      uniqueUnitsByVerdict[outcome.verdict].add(unitKey);
    }
    const allVerified =
      prepareRecord.occurrenceSourceClaimRecords.length > 0 &&
      prepareRecord.occurrenceSourceClaimRecords.every(
        (claim) => claim.supportSpan != null,
      );
    if (allVerified) {
      packetsWithVerifiedSupportSpans += 1;
    } else {
      packetsMissingSupportSpans += 1;
    }
  }
  const evidenceSufficient = countBy(
    adjudicated,
    (record) =>
      record.status === "adjudicated" &&
      record.evidenceSufficiency === "sufficient",
  );
  const evidenceLimited = countBy(
    adjudicated,
    (record) =>
      record.status === "adjudicated" &&
      record.evidenceSufficiency === "limited",
  );
  const figureOnlyLimitation = countBy(
    adjudicated,
    (record) =>
      record.status === "adjudicated" &&
      record.evidenceLimitation === "figure_only_support",
  );

  return {
    discover: {
      probeStratumCounts,
      neighborhoodCoverage,
      materializationChannelCounts,
      materializationLossReasonCounts,
      harvestLossReasonCounts,
      bibliographyMatchMethodCounts,
      providerReportedNeighborhoodTotal: count(
        "discover.provider_reported_neighborhood_total",
        providerReportedNeighborhoodTotal,
        "citing_paper_observations",
        "Citing works the provider reported for the seed, across all neighborhood queries",
      ),
      seeds: count(
        "discover.seeds",
        discover.seeds.length,
        "seeds",
        "Discover seed papers declared for the run",
      ),
      returnedCitingPaperObservations: count(
        "discover.returned_citing_paper_observations",
        returnedCitingPaperObservations,
        "citing_paper_observations",
        "Citing-paper observations returned by Discover neighborhood queries",
      ),
      probed: count(
        "discover.probed",
        probed,
        "citing_paper_observations",
        "Seed-specific citing-paper observations selected into the Discover probe budget",
      ),
      notProbed: count(
        "discover.not_probed",
        notProbed,
        "citing_paper_observations",
        "Seed-specific citing-paper observations not selected into the Discover probe budget",
      ),
      materializationSucceeded: count(
        "discover.materialization_succeeded",
        materializationSucceeded,
        "citing_paper_observations",
        "Seed-specific citing-paper observations whose full-text materialization succeeded",
      ),
      materializationFailed: count(
        "discover.materialization_failed",
        materializationFailed,
        "citing_paper_observations",
        "Seed-specific citing-paper observations whose full-text materialization failed",
      ),
      materializationUnavailable: count(
        "discover.materialization_unavailable",
        materializationUnavailable,
        "citing_paper_observations",
        "Seed-specific citing-paper observations whose full text was unavailable",
      ),
      materializationNotAttempted: count(
        "discover.materialization_not_attempted",
        materializationNotAttempted,
        "citing_paper_observations",
        "Seed-specific citing-paper observations for which materialization was not attempted",
      ),
      harvestSucceeded: count(
        "discover.harvest_succeeded",
        harvestSucceeded,
        "citing_paper_observations",
        "Seed-specific citing-paper observations with successful citation-mention harvest",
      ),
      harvestNoMentions: count(
        "discover.harvest_no_mentions",
        harvestNoMentions,
        "citing_paper_observations",
        "Seed-specific citing-paper observations harvested with zero seed citation mentions",
      ),
      harvestFailed: count(
        "discover.harvest_failed",
        harvestFailed,
        "citing_paper_observations",
        "Seed-specific citing-paper observations whose citation-mention harvest failed",
      ),
      harvestNotAttempted: count(
        "discover.harvest_not_attempted",
        harvestNotAttempted,
        "citing_paper_observations",
        "Seed-specific citing-paper observations for which harvest was not attempted",
      ),
      citationOccurrences: count(
        "discover.citation_occurrences",
        discover.citationMentions.length,
        "citation_occurrences",
        "Citation occurrences materialized in Discover",
      ),
      extractionClaimsExtracted: count(
        "discover.extraction_claims_extracted",
        countBy(extraction, (row) => row.status === "claims_extracted"),
        "citation_occurrences",
        "Citation occurrences with one or more attributed claims extracted",
      ),
      extractionNoClaims: count(
        "discover.extraction_no_claims",
        countBy(extraction, (row) => row.status === "no_claims"),
        "citation_occurrences",
        "Citation occurrences with successful extraction and zero attributed claims",
      ),
      extractionFailed: count(
        "discover.extraction_failed",
        countBy(extraction, (row) => row.status === "failed"),
        "citation_occurrences",
        "Citation occurrences whose claim extraction failed",
      ),
      attributedClaimRecords: count(
        "discover.attributed_claim_records",
        discover.attributedClaimRecords.length,
        "attributed_claim_records",
        "Attributed claim records extracted in Discover",
      ),
      candidateClaims: count(
        "discover.candidate_claims",
        discover.claimCandidates.length,
        "candidates",
        "Seed-isolated candidate claims assembled in Discover",
      ),
      selectedCandidates: count(
        "discover.selected_candidates",
        selectedCandidates,
        "candidates",
        "Discover candidates selected for Scope by the adaptive portfolio",
      ),
      deferredCandidates: count(
        "discover.deferred_candidates",
        deferredCandidates,
        "candidates",
        "Discover candidates deferred by the adaptive portfolio",
      ),
      uniqueCitingPapersWithOccurrences: count(
        "discover.unique_citing_papers_with_occurrences",
        uniqueCitingPapersWithOccurrences,
        "citing_papers",
        "Distinct citing papers that contributed at least one seed citation occurrence",
      ),
      uniqueCitationGroups: count(
        "discover.unique_citation_groups",
        uniqueCitationGroups,
        "citation_groups",
        "Distinct seed citation groups after exact targetRefIds occurrence selection",
      ),
      attributedClaimsWithVerifiedSupportSpan: count(
        "discover.attributed_claims_with_verified_support_span",
        attributedClaimsWithVerifiedSupportSpan,
        "attributed_claim_records",
        "Attributed claim records with an exact-verified citing-side support span",
      ),
      attributedClaimsMissingSupportSpan: count(
        "discover.attributed_claims_missing_support_span",
        attributedClaimsMissingSupportSpan,
        "attributed_claim_records",
        "Attributed claim records missing an exact-verified citing-side support span",
      ),
      deferredByFamilyCap: count(
        "discover.deferred_by_family_cap",
        deferredByFamilyCap,
        "candidates",
        "Candidates deferred because the adaptive portfolio reached maxFamilies",
      ),
      deferredByRecordBudget: count(
        "discover.deferred_by_record_budget",
        deferredByRecordBudget,
        "candidates",
        "Candidates deferred because the adaptive portfolio reached maxPreparedRecords",
      ),
      deferredByNovelty: count(
        "discover.deferred_by_novelty",
        deferredByNovelty,
        "candidates",
        "Candidates deferred for insufficient lexical novelty relative to the selected portfolio",
      ),
    },
    scope: {
      scopedCandidates: count(
        "scope.scoped_candidates",
        scopedCandidates,
        "candidates",
        "Discover candidates frozen into Scope families",
      ),
      deferredCandidates: count(
        "scope.deferred_candidates",
        deferredScopeCandidates,
        "candidates",
        "Discover candidates accounted as deferred_upstream by Scope",
      ),
      families: count(
        "scope.families",
        scopeArtifact.payload.families.length,
        "families",
        "Scoped claim families frozen by Scope",
      ),
      groundingStatusCounts,
    },
    prepare: {
      expectedFamilyOccurrencePairs: count(
        "prepare.expected_family_occurrence_pairs",
        expectedPairs,
        "family_occurrence_records",
        "Cartesian family × occurrence pairs required by Scope membership",
      ),
      preparedRecords: count(
        "prepare.prepared_records",
        preparedRecords.length,
        "family_occurrence_records",
        "Prepared citation-instance records emitted by Prepare",
      ),
      classified: count(
        "prepare.classified",
        classified,
        "family_occurrence_records",
        "Prepare records with status classified",
      ),
      ambiguous: count(
        "prepare.ambiguous",
        ambiguous,
        "family_occurrence_records",
        "Prepare records with status ambiguous",
      ),
      failed: count(
        "prepare.failed",
        failed,
        "family_occurrence_records",
        "Prepare records with status failed",
      ),
      lowInformation: count(
        "prepare.low_information",
        lowInformation,
        "family_occurrence_records",
        "Prepare records with low-information citation role or skip_low_information evaluation mode",
      ),
      manualReview: count(
        "prepare.manual_review",
        manualReview,
        "family_occurrence_records",
        "Prepare records needing manual review (ambiguous status or manual-review evaluation modes)",
      ),
      manualReviewRoleAmbiguous: count(
        "prepare.manual_review_role_ambiguous",
        manualReviewRoleAmbiguous,
        "family_occurrence_records",
        "Prepare records queued for manual review because citation role is ambiguous; never model-adjudicated",
      ),
      manualReviewExtractionLimited: count(
        "prepare.manual_review_extraction_limited",
        manualReviewExtractionLimited,
        "family_occurrence_records",
        "Prepare records queued for manual review because extraction is limited; never model-adjudicated",
      ),
    },
    evidence: {
      recordOutcomes: count(
        "evidence.record_outcomes",
        evidenceRecords.length,
        "family_occurrence_records",
        "Evidence outcomes accounted for every Prepare record",
      ),
      retrievalStatusCounts,
      bm25MatchedRuns: count(
        "evidence.bm25_matched_runs",
        bm25MatchedRuns,
        "bm25_runs",
        "Family-level BM25 runs with at least one lexical match",
      ),
      bm25NoMatchRuns: count(
        "evidence.bm25_no_match_runs",
        bm25NoMatchRuns,
        "bm25_runs",
        "Family-level BM25 runs with no lexical matches",
      ),
      rerankDisabled: count(
        "evidence.rerank_disabled",
        rerankDisabled,
        "family_occurrence_records",
        "Evidence records whose reranking policy was disabled",
      ),
      rerankCompleted: count(
        "evidence.rerank_completed",
        rerankCompleted,
        "family_occurrence_records",
        "Evidence records whose optional rerank completed",
      ),
      rerankFailed: count(
        "evidence.rerank_failed",
        rerankFailed,
        "family_occurrence_records",
        "Evidence records whose optional rerank failed nonfatally",
      ),
      rerankNotAttempted: count(
        "evidence.rerank_not_attempted",
        rerankNotAttempted,
        "family_occurrence_records",
        "Evidence records where rerank was not attempted due to unavailable/failed/no-candidate retrieval",
      ),
      uniqueFinalSelectionsBm25: count(
        "evidence.unique_final_selections_bm25",
        uniqueFinalSelectionsBm25,
        "selections",
        "Unique final Evidence selection objects whose ranking source is BM25",
      ),
      uniqueFinalSelectionsReranked: count(
        "evidence.unique_final_selections_reranked",
        uniqueFinalSelectionsReranked,
        "selections",
        "Unique final Evidence selection objects whose ranking source is the separate reranked ranking",
      ),
      recordSelectionBm25: count(
        "evidence.record_selection_bm25",
        recordSelectionBm25,
        "family_occurrence_records",
        "Family×occurrence records using a BM25 final selection; shared selection objects may be counted for multiple records",
      ),
      recordSelectionReranked: count(
        "evidence.record_selection_reranked",
        recordSelectionReranked,
        "family_occurrence_records",
        "Family×occurrence records using a reranked final selection; shared selection objects may be counted for multiple records",
      ),
    },
    adjudicate: {
      totalRecordOutcomes: count(
        "adjudicate.total_record_outcomes",
        adjudicateRecords.length,
        "family_occurrence_records",
        "Adjudicate outcomes accounted for every Evidence/Prepare record",
      ),
      adjudicated: count(
        "adjudicate.adjudicated",
        adjudicated.length,
        "family_occurrence_records",
        "Records that received an F/D/E/U scientific verdict",
      ),
      notAdjudicated: count(
        "adjudicate.not_adjudicated",
        notAdjudicated.length,
        "family_occurrence_records",
        "Records gated as not_adjudicated operational non-verdicts",
      ),
      adjudicationFailed: count(
        "adjudicate.adjudication_failed",
        adjudicationFailed.length,
        "family_occurrence_records",
        "Records with typed nonfatal adjudication_failed outcomes",
      ),
      invalidOutput: count(
        "adjudicate.invalid_output",
        invalidOutput.length,
        "family_occurrence_records",
        "Records with invalid_output operational non-verdicts",
      ),
      gateCodeCounts,
      failureCodeCounts,
      mutationKindCounts,
      mutationDirectionCounts,
      verdictCountsByRankingSource,
      verdictCounts: {
        F: count(
          "adjudicate.verdict_F",
          verdictCount("F"),
          "family_occurrence_records",
          "Adjudicated records with verdict F (never includes operational non-verdicts)",
        ),
        D: count(
          "adjudicate.verdict_D",
          verdictCount("D"),
          "family_occurrence_records",
          "Adjudicated records with verdict D (never includes operational non-verdicts)",
        ),
        E: count(
          "adjudicate.verdict_E",
          verdictCount("E"),
          "family_occurrence_records",
          "Adjudicated records with verdict E (never includes operational non-verdicts)",
        ),
        U: count(
          "adjudicate.verdict_U",
          verdictCount("U"),
          "family_occurrence_records",
          "Adjudicated records with scientific uncertainty U (distinct from operational failures)",
        ),
      },
      uniqueClaimUnits: count(
        "adjudicate.unique_claim_units",
        uniqueClaimUnitKeys.size,
        "unique_claim_units",
        "Distinct family × citing-paper × claim-record units across Adjudicate outcomes",
      ),
      uniqueClaimUnitVerdictCounts: {
        F: count(
          "adjudicate.unique_claim_units_verdict_F",
          uniqueUnitsByVerdict.F.size,
          "unique_claim_units",
          "Unique family × citing-paper × claim units with at least one F record",
        ),
        D: count(
          "adjudicate.unique_claim_units_verdict_D",
          uniqueUnitsByVerdict.D.size,
          "unique_claim_units",
          "Unique family × citing-paper × claim units with at least one D record",
        ),
        E: count(
          "adjudicate.unique_claim_units_verdict_E",
          uniqueUnitsByVerdict.E.size,
          "unique_claim_units",
          "Unique family × citing-paper × claim units with at least one E record",
        ),
        U: count(
          "adjudicate.unique_claim_units_verdict_U",
          uniqueUnitsByVerdict.U.size,
          "unique_claim_units",
          "Unique family × citing-paper × claim units with at least one U record",
        ),
      },
      uniqueAdjudicatedClaimUnits: count(
        "adjudicate.unique_adjudicated_claim_units",
        uniqueAdjudicatedClaimUnitKeys.size,
        "unique_claim_units",
        "Distinct family × citing-paper × claim-record units among adjudicated records",
      ),
      repeatedRecordsBeyondUniqueUnits: count(
        "adjudicate.repeated_records_beyond_unique_units",
        Math.max(0, adjudicateRecords.length - uniqueClaimUnitKeys.size),
        "family_occurrence_records",
        "Adjudicate records beyond the unique claim-unit count (repeated occurrence packets)",
      ),
      packetsWithVerifiedSupportSpans: count(
        "adjudicate.packets_with_verified_support_spans",
        packetsWithVerifiedSupportSpans,
        "adjudication_packets",
        "Packets whose occurrence-local claims all carry exact-verified support spans",
      ),
      packetsMissingSupportSpans: count(
        "adjudicate.packets_missing_support_spans",
        packetsMissingSupportSpans,
        "adjudication_packets",
        "Packets with one or more claims missing an exact-verified support span",
      ),
      evidenceSufficient: count(
        "adjudicate.evidence_sufficient",
        evidenceSufficient,
        "family_occurrence_records",
        "Adjudicated records whose selected text evidence was assessed as sufficient",
      ),
      evidenceLimited: count(
        "adjudicate.evidence_limited",
        evidenceLimited,
        "family_occurrence_records",
        "Adjudicated records with an evidence-sufficiency limitation diagnostic",
      ),
      figureOnlyLimitation: count(
        "adjudicate.figure_only_limitation",
        figureOnlyLimitation,
        "family_occurrence_records",
        "Adjudicated records limited because claim support appears figure-only in text packets",
      ),
    },
  };
}

function buildRates(funnel: ReportFunnelCounts): ReportRate[] {
  const discoverCandidates =
    funnel.discover.selectedCandidates.count +
    funnel.discover.deferredCandidates.count;
  const prepareRecords = funnel.prepare.preparedRecords.count;
  const retrieved =
    funnel.evidence.retrievalStatusCounts.find(
      (entry) => entry.status === "retrieved",
    )?.count ?? 0;
  const adjudicated = funnel.adjudicate.adjudicated.count;
  const totalRecords = funnel.adjudicate.totalRecordOutcomes.count;
  const uniqueAdjudicated = funnel.adjudicate.uniqueAdjudicatedClaimUnits.count;
  const uniqueRate = (verdict: "F" | "D" | "E" | "U") =>
    buildReportRate({
      metricId: `verdict_${verdict}_unique_rate`,
      numerator: funnel.adjudicate.uniqueClaimUnitVerdictCounts[verdict].count,
      denominator: uniqueAdjudicated,
      unit: `${verdict}_unique_claim_units / unique_adjudicated_claim_units`,
      populationLabel: `Share of unique adjudicated claim units with at least one ${verdict} record; repeated citations of one claim count once`,
      numeratorDefinition: `Unique family × citing-paper × claim units with an adjudicated ${verdict} record`,
      denominatorDefinition:
        "Unique family × citing-paper × claim units with at least one adjudicated record",
    });

  const rates: ReportRate[] = [
    uniqueRate("F"),
    uniqueRate("D"),
    uniqueRate("E"),
    uniqueRate("U"),
    buildReportRate({
      metricId: "adjudication_coverage",
      numerator: adjudicated,
      denominator: totalRecords,
      unit: "adjudicated_records / family_occurrence_records",
      populationLabel:
        "Share of canonical Prepare/Evidence/Adjudicate records that received an F/D/E/U verdict",
      numeratorDefinition: "Records with adjudication status adjudicated",
      denominatorDefinition:
        "All canonical Prepare/Evidence/Adjudicate family×occurrence records",
    }),
    buildReportRate({
      metricId: "retrieval_coverage",
      numerator: retrieved,
      denominator: prepareRecords,
      unit: "retrieved_records / family_occurrence_records",
      populationLabel:
        "Share of Prepare records with Evidence retrievalStatus retrieved",
      numeratorDefinition: "Evidence records with retrievalStatus retrieved",
      denominatorDefinition: "All Prepare family×occurrence records",
    }),
    buildReportRate({
      metricId: "scope_selection_rate",
      numerator: funnel.discover.selectedCandidates.count,
      denominator: discoverCandidates,
      unit: "selected_candidates / candidates",
      populationLabel:
        "Share of Discover candidates selected for Scope by the adaptive portfolio",
      numeratorDefinition: "Discover candidates with selectedForScope true",
      denominatorDefinition: "All Discover candidates (selected + deferred)",
    }),
    buildReportRate({
      metricId: "verdict_D_rate",
      numerator: funnel.adjudicate.verdictCounts.D.count,
      denominator: adjudicated,
      unit: "D_verdicts / adjudicated_records",
      populationLabel:
        "Share of adjudicated records labeled D; denominator is adjudicated records only",
      numeratorDefinition: "Adjudicated records with verdict D",
      denominatorDefinition:
        "Adjudicated records only (never all discovered papers, mentions, families, or prepared records)",
    }),
    buildReportRate({
      metricId: "verdict_E_rate",
      numerator: funnel.adjudicate.verdictCounts.E.count,
      denominator: adjudicated,
      unit: "E_verdicts / adjudicated_records",
      populationLabel:
        "Share of adjudicated records labeled E; denominator is adjudicated records only",
      numeratorDefinition: "Adjudicated records with verdict E",
      denominatorDefinition:
        "Adjudicated records only (never all discovered papers, mentions, families, or prepared records)",
    }),
    buildReportRate({
      metricId: "verdict_F_rate",
      numerator: funnel.adjudicate.verdictCounts.F.count,
      denominator: adjudicated,
      unit: "F_verdicts / adjudicated_records",
      populationLabel:
        "Share of adjudicated records labeled F; denominator is adjudicated records only",
      numeratorDefinition: "Adjudicated records with verdict F",
      denominatorDefinition:
        "Adjudicated records only (never all discovered papers, mentions, families, or prepared records)",
    }),
    buildReportRate({
      metricId: "verdict_U_rate",
      numerator: funnel.adjudicate.verdictCounts.U.count,
      denominator: adjudicated,
      unit: "U_verdicts / adjudicated_records",
      populationLabel:
        "Share of adjudicated records labeled U (scientific ambiguity with evidence); denominator is adjudicated records only",
      numeratorDefinition: "Adjudicated records with verdict U",
      denominatorDefinition:
        "Adjudicated records only (never operational non-verdicts)",
    }),
  ];

  return rates.sort((left, right) =>
    compareCodeUnits(left.metricId, right.metricId),
  );
}

/**
 * Every Discover candidate with the scores the adaptive portfolio gave it and
 * the decision it took. Deferred candidates are included: the interesting
 * question is whether the selected ones scored differently.
 */
function buildSelectionAudit(
  discoverArtifact: DiscoverArtifact,
): ReportSelectionAuditRow[] {
  const candidatesById = new Map(
    discoverArtifact.payload.claimCandidates.map((candidate) => [
      candidate.candidateId,
      candidate,
    ]),
  );
  return discoverArtifact.payload.candidateDispositions
    .map((disposition) => {
      const candidate = candidatesById.get(disposition.candidateId);
      if (!candidate) {
        throw new CanonicalReportBoundaryError(
          `Candidate disposition references an unknown candidate: ${disposition.candidateId}`,
        );
      }
      return {
        candidateId: disposition.candidateId,
        seedId: candidate.seedId,
        rank: disposition.rank,
        selectedForScope: disposition.selectedForScope,
        reason: disposition.reason,
        claimShape: disposition.annotation.claimShape,
        uniqueCitingPaperCount: disposition.annotation.uniqueCitingPaperCount,
        specificityScore: disposition.annotation.specificityScore,
        confidenceAggregate: disposition.annotation.confidenceAggregate,
        ...(disposition.componentScores
          ? { componentScores: disposition.componentScores }
          : {}),
      };
    })
    .sort((left, right) => left.rank - right.rank);
}

function buildRecordTraces(input: {
  prepareArtifact: PrepareArtifact;
  evidenceArtifact: EvidenceArtifact;
  adjudicateArtifact: AdjudicateArtifact;
  lineage: ReportLineage;
}): ReportRecordTrace[] {
  const evidenceById = new Map(
    input.evidenceArtifact.payload.records.map((record) => [
      record.recordId,
      record,
    ]),
  );
  const adjudicateById = new Map(
    input.adjudicateArtifact.payload.records.map((record) => [
      record.recordId,
      record,
    ]),
  );
  const selectionById = new Map(
    input.evidenceArtifact.payload.selections.map((selection) => [
      selection.selectionId,
      selection,
    ]),
  );

  const traces: ReportRecordTrace[] = [];
  for (const prepareRecord of input.prepareArtifact.payload.records) {
    const evidenceRecord = evidenceById.get(prepareRecord.recordId);
    const adjudicateRecord = adjudicateById.get(prepareRecord.recordId);
    if (evidenceRecord == null || adjudicateRecord == null) {
      throw new CanonicalReportBoundaryError(
        `Missing Evidence/Adjudicate outcome for Prepare record: ${prepareRecord.recordId}`,
      );
    }

    const rankingSource =
      evidenceRecord.finalSelectionId == null
        ? undefined
        : selectionById.get(evidenceRecord.finalSelectionId)?.rankingSource;
    if (evidenceRecord.finalSelectionId != null && rankingSource == null) {
      throw new CanonicalReportBoundaryError(
        `Dangling final selection on Evidence record: ${evidenceRecord.recordId}`,
      );
    }

    const adjudication =
      adjudicateRecord.status === "adjudicated"
        ? {
            status: "adjudicated" as const,
            adjudicationResultId: adjudicateRecord.adjudicationResultId,
            verdict: adjudicateRecord.verdict,
            mutationKinds: adjudicateRecord.mutationKinds,
            direction: adjudicateRecord.direction,
            evidenceSufficiency: adjudicateRecord.evidenceSufficiency,
            ...(adjudicateRecord.evidenceLimitation
              ? { evidenceLimitation: adjudicateRecord.evidenceLimitation }
              : {}),
          }
        : adjudicateRecord.status === "not_adjudicated"
          ? {
              status: "not_adjudicated" as const,
              adjudicationResultId: adjudicateRecord.adjudicationResultId,
              gateCode: adjudicateRecord.gateCode,
            }
          : adjudicateRecord.status === "adjudication_failed"
            ? {
                status: "adjudication_failed" as const,
                adjudicationResultId: adjudicateRecord.adjudicationResultId,
                failureCode: adjudicateRecord.failureCode,
              }
            : {
                status: "invalid_output" as const,
                adjudicationResultId: adjudicateRecord.adjudicationResultId,
              };

    traces.push({
      recordId: prepareRecord.recordId,
      familyId: prepareRecord.familyId,
      citationOccurrenceId: prepareRecord.citationOccurrenceId,
      prepareArtifact: input.lineage.prepareArtifact,
      evidenceArtifact: input.lineage.evidenceArtifact,
      adjudicateArtifact: input.lineage.adjudicateArtifact,
      classification:
        prepareRecord.classification.status === "failed"
          ? { status: "failed" as const, signals: [] }
          : {
              status: prepareRecord.classification.status,
              citationRole: prepareRecord.classification.citationRole,
              evaluationMode: prepareRecord.classification.evaluationMode,
              signals: prepareRecord.classification.signals,
            },
      evidence: {
        retrievalStatus: evidenceRecord.retrievalStatus,
        rerankStatus: evidenceRecord.rerankStatus,
        ...(rankingSource ? { rankingSource } : {}),
        queryId: evidenceRecord.queryId,
        ...(evidenceRecord.bm25RunId
          ? { bm25RunId: evidenceRecord.bm25RunId }
          : {}),
        ...(evidenceRecord.rerankRunId
          ? { rerankRunId: evidenceRecord.rerankRunId }
          : {}),
        ...(evidenceRecord.finalSelectionId
          ? { finalSelectionId: evidenceRecord.finalSelectionId }
          : {}),
      },
      adjudication,
    });
  }

  return traces.sort((left, right) =>
    compareCodeUnits(left.recordId, right.recordId),
  );
}

function buildDecisionSummaries(
  artifacts: Array<{
    canonicalStage: ReportDecisionSummary["stage"];
    decisions: AppendOnlyDecision[];
  }>,
): ReportDecisionSummary[] {
  const counts = new Map<string, ReportDecisionSummary>();
  for (const artifact of artifacts) {
    for (const decision of artifact.decisions) {
      const key = canonicalSerialize({
        stage: artifact.canonicalStage,
        decisionType: decision.decisionType,
        outcome: decision.outcome,
      });
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, {
          stage: artifact.canonicalStage,
          decisionType: decision.decisionType,
          outcome: decision.outcome,
          count: 1,
          unit: "decisions",
        });
      }
    }
  }
  return [...counts.values()].sort((left, right) =>
    compareCodeUnits(
      `${left.stage}\0${left.decisionType}\0${left.outcome}`,
      `${right.stage}\0${right.decisionType}\0${right.outcome}`,
    ),
  );
}

function count(
  metricId: string,
  value: number,
  unit: ReportCount["unit"],
  population: string,
): ReportCount {
  return buildReportCount({
    metricId,
    count: value,
    unit,
    population,
  });
}

function countBy<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
): number {
  return items.reduce((sum, item) => (predicate(item) ? sum + 1 : sum), 0);
}

function buildFamilyMutations(input: {
  discoverArtifact: DiscoverArtifact;
  prepareArtifact: PrepareArtifact;
  evidenceArtifact: EvidenceArtifact;
  adjudicateArtifact: AdjudicateArtifact;
}): ReportFamilyMutation[] {
  const adjudicateById = new Map(
    input.adjudicateArtifact.payload.records.map((record) => [
      record.recordId,
      record,
    ]),
  );
  const selectionSourceById = new Map(
    input.evidenceArtifact.payload.selections.map((selection) => [
      selection.selectionId,
      selection.rankingSource,
    ]),
  );
  const rankingSourceByRecordId = new Map(
    input.evidenceArtifact.payload.records.flatMap((record) =>
      record.finalSelectionId != null
        ? [
            [
              record.recordId,
              selectionSourceById.get(record.finalSelectionId),
            ] as const,
          ]
        : [],
    ),
  );
  const equivalenceByCandidateId = new Map(
    input.discoverArtifact.payload.claimCandidates.map((candidate) => [
      candidate.candidateId,
      candidate.equivalence?.method,
    ]),
  );

  type FamilyAccumulator = {
    exemplar: PrepareArtifact["payload"]["records"][number];
    rows: ReportFamilyMutationRecord[];
    unitKeys: Set<string>;
  };
  const byFamily = new Map<string, FamilyAccumulator>();
  for (const prepareRecord of input.prepareArtifact.payload.records) {
    const adjudicateRecord = adjudicateById.get(prepareRecord.recordId);
    if (!adjudicateRecord) {
      throw new CanonicalReportBoundaryError(
        `Prepare record has no Adjudicate outcome: ${prepareRecord.recordId}`,
      );
    }
    const paper = prepareRecord.citingPaper.paper;
    const occurrence = prepareRecord.citationOccurrence;
    const claims = prepareRecord.occurrenceSourceClaimRecords;
    const citingRestatement =
      claims.map((claim) => claim.extractedClaimText).join("\n") ||
      prepareRecord.family.trackedClaim;
    const rankingSource = rankingSourceByRecordId.get(prepareRecord.recordId);
    const row: ReportFamilyMutationRecord = {
      recordId: prepareRecord.recordId,
      citationOccurrenceId: prepareRecord.citationOccurrenceId,
      citingPaperId: paper.paperId,
      citingPaperTitle: paper.title,
      ...(paper.doi ? { citingPaperDoi: paper.doi } : {}),
      ...(paper.publicationYear != null
        ? { citingPaperYear: paper.publicationYear }
        : {}),
      ...(occurrence.sectionTitle
        ? { sectionTitle: occurrence.sectionTitle }
        : {}),
      citingRestatement,
      supportSpanTexts: claims.flatMap((claim) =>
        claim.supportSpan ? [claim.supportSpan.text] : [],
      ),
      status: adjudicateRecord.status,
      ...(rankingSource ? { rankingSource } : {}),
    };
    if (adjudicateRecord.status === "adjudicated") {
      row.verdict = adjudicateRecord.verdict;
      row.mutationKinds = [...adjudicateRecord.mutationKinds];
      row.direction = adjudicateRecord.direction;
      row.citingAssertion = adjudicateRecord.citingAssertion;
      row.sourceStatement = adjudicateRecord.sourceStatement;
      row.evidenceSufficiency = adjudicateRecord.evidenceSufficiency;
    } else if (adjudicateRecord.status === "not_adjudicated") {
      row.gateCode = adjudicateRecord.gateCode;
    }
    const entry = byFamily.get(prepareRecord.familyId) ?? {
      exemplar: prepareRecord,
      rows: [],
      unitKeys: new Set<string>(),
    };
    entry.rows.push(row);
    entry.unitKeys.add(
      buildClaimUnitKey({
        familyId: prepareRecord.familyId,
        citingPaperId: paper.paperId,
        claimTexts: claims.map((claim) => claim.extractedClaimText),
      }),
    );
    byFamily.set(prepareRecord.familyId, entry);
  }

  const families = [...byFamily.entries()].map(([familyId, entry]) => {
    const family = entry.exemplar.family;
    const seed = entry.exemplar.seed;
    const rows = [...entry.rows].sort(
      (left, right) =>
        (left.citingPaperYear ?? Number.POSITIVE_INFINITY) -
          (right.citingPaperYear ?? Number.POSITIVE_INFINITY) ||
        compareCodeUnits(left.citingPaperTitle, right.citingPaperTitle) ||
        compareCodeUnits(left.recordId, right.recordId),
    );
    const verdictCounts = {
      F: 0,
      D: 0,
      E: 0,
      U: 0,
      not_adjudicated: 0,
      failed: 0,
    };
    for (const row of rows) {
      if (row.status === "adjudicated" && row.verdict) {
        verdictCounts[row.verdict] += 1;
      } else if (row.status === "not_adjudicated") {
        verdictCounts.not_adjudicated += 1;
      } else {
        verdictCounts.failed += 1;
      }
    }
    const equivalenceMethod = family.candidateIds
      .map((candidateId) => equivalenceByCandidateId.get(candidateId))
      .find((method) => method != null);
    const grounding = family.grounding;
    const spans =
      grounding.status === "grounded" || grounding.status === "ambiguous"
        ? grounding.evidenceSpans.map((span) => ({
            blockId: span.blockId,
            ...(span.sectionTitle ? { sectionTitle: span.sectionTitle } : {}),
            text: span.text,
          }))
        : [];
    const mutation: ReportFamilyMutation = {
      familyId,
      seedId: family.seedId,
      seedDoi: seed.doi,
      ...(seed.resolution.status === "resolved"
        ? { seedTitle: seed.resolution.paper.title }
        : {}),
      trackedClaim: family.trackedClaim,
      ...(equivalenceMethod ? { equivalenceMethod } : {}),
      groundingStatus: grounding.status,
      verifiedSeedGroundingSpans: spans,
      verdictCounts,
      uniqueClaimUnits: entry.unitKeys.size,
      records: rows,
    };
    return mutation;
  });

  return families.sort(
    (left, right) =>
      compareCodeUnits(left.trackedClaim, right.trackedClaim) ||
      compareCodeUnits(left.familyId, right.familyId),
  );
}

function countStatuses<Status extends string>(
  statuses: readonly Status[],
): Array<{ status: Status; count: number }> {
  const counts = new Map<Status, number>();
  for (const status of statuses) {
    if (status.length === 0) continue;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([status, value]) => ({ status, count: value }));
}

function toStageReference<
  Role extends
    | "canonical-discover-input"
    | "canonical-scope-input"
    | "canonical-prepare-input"
    | "canonical-evidence-input"
    | "canonical-adjudicate-input",
  Stage extends "discover" | "scope" | "prepare" | "evidence" | "adjudicate",
>(
  artifact: {
    artifactId: string;
    contentHash: string;
  },
  role: Role,
  canonicalStage: Stage,
  uri: string | undefined,
): {
  artifactId: string;
  contentHash: string;
  role: Role;
  canonicalStage: Stage;
  uri?: string;
} {
  return {
    artifactId: artifact.artifactId,
    contentHash: artifact.contentHash,
    role,
    canonicalStage,
    ...(uri ? { uri } : {}),
  };
}

function assertExactReference(
  reference: ArtifactReference,
  artifact: { artifactId: string; contentHash: string },
  label: string,
): void {
  if (
    reference.artifactId !== artifact.artifactId ||
    reference.contentHash !== artifact.contentHash
  ) {
    throw new CanonicalReportBoundaryError(
      `${label} does not match the supplied artifact ID and content hash`,
    );
  }
}

const parseBoundary = createBoundaryParser(CanonicalReportBoundaryError);
