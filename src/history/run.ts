import {
  uniqueSortedArtifactReferences,
  type ArtifactReference,
} from "../contract/artifacts/primitives.js";
import { scopeFatalFailureCodeSchema } from "../contract/artifacts/scope.js";
import type { ScopeCitationStatement } from "../contract/artifacts/scope-statements.js";
import type { DiscoverCitationOccurrence } from "../contract/artifacts/discover.js";
import { citationObservationParserMatches } from "../domain/parsing.js";
import type { ReportChain } from "../pipeline/report-chain.js";
import { compareCodeUnits } from "../shared/order.js";
import {
  MAX_HISTORY_ASSESSMENT_CASES,
  verifyHistoryAssessments,
  type AssessHistoryCases,
  type HistoryAssessmentBatchResult,
  type HistoryAssessmentInput,
  type HistoryAssessment,
} from "./assessment.js";
import {
  locateHistoryCitationBlock,
  type FirstHopParagraphCitation,
  type ReadFirstHopParagraphCitations,
} from "./parent-citation.js";
import {
  isHistorySpendLimit,
  isReliableReference,
  toHistoryPaper,
  unavailableHistorySource,
  type HistoryCiterExamination,
  type HistoryMiddleText,
  type HistorySource,
} from "./sources.js";
import {
  citationHistoryLimitsSchema,
  createCitationHistoryArtifact,
  historyAssessmentCaseId,
  historyCitationUseId,
  type CitationHistoryArtifact,
  type CitationHistoryNeighborhood,
  type CitationHistoryPath,
  type CitationHistoryPayload,
  type HistoryCitationUse,
  type HistoryLaterHop,
  type HistoryPaper,
} from "./store.js";

const contributingRelationships = new Set(["full", "partial", "scope_changed"]);

type Target = {
  path: CitationHistoryPath;
  statement: ScopeCitationStatement;
  originalReferenceId?: string;
  paragraphCitations?: FirstHopParagraphCitation[];
};

/** Prefer DOI-resolved works, then cover another original finding and another
 * intermediate paper where possible. Stable statement IDs break ties. */
function chooseDiverseStatements(
  eligible: ScopeCitationStatement[],
  limit: number,
): ScopeCitationStatement[] {
  const remaining = [...eligible].sort((a, b) =>
    compareCodeUnits(a.statementId, b.statementId),
  );
  const selected: ScopeCitationStatement[] = [];
  const coveredPapers = new Set<string>();
  const coveredFindings = new Set<string>();
  const priority = (statement: ScopeCitationStatement) =>
    Number(Boolean(statement.citingDoi)) * 3 +
    Number(!coveredPapers.has(statement.citingPaperId)) +
    Number(
      statement.assessment.findingIds.some((id) => !coveredFindings.has(id)),
    );
  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    for (let i = 1; i < remaining.length; i++) {
      if (priority(remaining[i]!) > priority(remaining[bestIndex]!))
        bestIndex = i;
    }
    const candidate = remaining.splice(bestIndex, 1)[0]!;
    selected.push(candidate);
    coveredPapers.add(candidate.citingPaperId);
    candidate.assessment.findingIds.forEach((id) => coveredFindings.add(id));
  }
  return selected;
}

function selectTargets(input: {
  report: ReportChain;
  explicitStatementIds: string[];
  maxParents: number;
  readFirstHopParagraphCitations?: ReadFirstHopParagraphCitations | undefined;
}): { selection: CitationHistoryPayload["selection"]; targets: Target[] } {
  const { report, explicitStatementIds, maxParents } = input;
  const { citationStatements, seedInventories, statementAssessments } =
    report.scope.payload;
  const requested = new Set(explicitStatementIds);
  const eligible = citationStatements.filter(
    (statement) =>
      statement.credit !== "unverified" &&
      statement.textSpan != null &&
      contributingRelationships.has(statement.assessment.relationship),
  );
  const eligibleById = new Map(
    eligible.map((item) => [item.statementId, item]),
  );
  for (const id of requested) {
    if (!citationStatements.some((item) => item.statementId === id))
      throw new Error("Unknown citation statement " + id);
    if (!eligibleById.has(id))
      throw new Error(
        "Citation statement lacks verified evidence of an inherited finding: " +
          id,
      );
  }
  if (requested.size > maxParents)
    throw new Error(
      "Requested citation statements exceed the history parent limit",
    );
  const seedsById = new Map(
    report.discover.payload.seeds.map((seed) => [seed.seedId, seed]),
  );
  const papersById = new Map(
    report.discover.payload.citingPapers.map((paper) => [
      paper.citingPaperRecordId,
      paper,
    ]),
  );
  const claimsById = new Map(
    report.discover.payload.attributedClaimRecords.map((claim) => [
      claim.claimRecordId,
      claim,
    ]),
  );
  const inventoriesById = new Map(
    seedInventories.map((inventory) => [inventory.seedId, inventory]),
  );
  const analysesById = new Map(
    statementAssessments.map((item) => [item.batchId, item]),
  );
  const selected =
    requested.size > 0
      ? [...requested].sort(compareCodeUnits).map((id) => eligibleById.get(id)!)
      : chooseDiverseStatements(eligible, maxParents);
  const targets = selected.map((statement): Target => {
    const seed = seedsById.get(statement.seedId);
    const citing = papersById.get(statement.citingPaperRecordId);
    if (seed?.resolution.status !== "resolved" || !citing)
      throw new Error(
        "The frozen citation statement has no source paper in the report chain",
      );
    const assessment = statement.assessment;
    const batch = assessment.batchId
      ? analysesById.get(assessment.batchId)
      : undefined;
    const findings =
      inventoriesById
        .get(seed.seedId)
        ?.findings.filter((finding) =>
          assessment.findingIds.includes(finding.findingId),
        ) ?? [];
    const sourceMatch = isReliableReference(citing.bibliographyMatch?.method);
    return {
      statement,
      ...(sourceMatch && input.readFirstHopParagraphCitations
        ? {
            paragraphCitations: input.readFirstHopParagraphCitations(statement),
          }
        : {}),
      ...(sourceMatch && citing.bibliographyMatch
        ? { originalReferenceId: citing.bibliographyMatch.refId }
        : {}),
      path: {
        statementId: statement.statementId,
        original: toHistoryPaper({ ...seed.resolution.paper, doi: seed.doi }),
        middle: toHistoryPaper({
          paperId: statement.citingPaperId,
          title: statement.citingTitle,
          doi: statement.citingDoi,
          publicationYear:
            statement.citingPublicationYear ?? citing.paper.publicationYear,
        }),
        firstHop: {
          occurrenceId: statement.occurrenceId,
          sourceVersion: statement.sourceVersion,
          claimRecordId: statement.claimRecordId,
          relationship: sourceMatch ? assessment.relationship : "unassessed",
          ...(statement.textSpan
            ? { text: statement.textSpan.text, supportSpan: statement.textSpan }
            : {}),
          context: statement.citationContext,
          citationMarker: statement.citationMarker,
          ...(statement.sourceLocator
            ? { sourceLocator: statement.sourceLocator }
            : {}),
          ...(statement.citationGroupOrdinal === undefined
            ? {}
            : { citationGroupOrdinal: statement.citationGroupOrdinal }),
          ...(statement.markerSpan ? { markerSpan: statement.markerSpan } : {}),
          credit: sourceMatch ? statement.credit : "unverified",
          findings: sourceMatch ? findings : [],
          findingIds: sourceMatch ? assessment.findingIds : [],
          retained: sourceMatch ? assessment.retained : [],
          changes: sourceMatch ? assessment.changes : [],
          reason: sourceMatch
            ? assessment.reason
            : "The originating bibliography match does not uniquely identify the original paper.",
          provenanceArtifacts: uniqueSortedArtifactReferences([
            ...statement.sourceVersion.artifacts,
            ...(claimsById.get(statement.claimRecordId)?.provenanceArtifacts ??
              []),
            ...findings.flatMap((finding) =>
              finding.evidenceSpans.map((span) => span.sourceArtifact),
            ),
            ...(batch
              ? [
                  batch.modelExecution.requestArtifact,
                  batch.modelExecution.responseArtifact,
                ]
              : []),
          ]),
        },
        laterHops: [],
      },
    };
  });
  return {
    selection: {
      candidateCount: citationStatements.length,
      eligibleCount: eligible.length,
      selectedCount: targets.length,
      explicitStatementIds: [...requested].sort(compareCodeUnits),
    },
    targets,
  };
}

function matchesParentVersion(
  source: HistoryMiddleText,
  { statement }: Target,
): boolean {
  const version = statement.sourceVersion;
  return (
    version.sourceTextHash === source.sourceTextHash &&
    citationObservationParserMatches(version.parser, source.parser.kind) &&
    version.parserVersion === source.parser.version
  );
}

function recordMiddleSource(
  source: HistoryMiddleText | undefined,
  targets: Target[],
  neighborhood: CitationHistoryNeighborhood,
): void {
  if (!source) {
    neighborhood.middleSource = {
      status: "unavailable",
      reason: "The full intermediate text could not be retrieved.",
      provenanceArtifacts: [],
    };
  } else if (!targets.some((target) => matchesParentVersion(source, target))) {
    neighborhood.middleSource = {
      status: "source_version_unverified",
      reason:
        "The full intermediate text could not be tied to the version used in the first hop.",
      sourceArtifact: source.sourceArtifact,
      provenanceArtifacts: [source.sourceArtifact],
    };
  } else {
    neighborhood.middleSource = {
      status: "available",
      textVersionId: source.sourceArtifact.artifactId,
      reason: "Full intermediate text matched a first-hop source version.",
      sourceArtifact: source.sourceArtifact,
      provenanceArtifacts: [source.sourceArtifact],
    };
  }
}

function buildCitationUse(
  middlePaperId: string,
  citing: HistoryPaper,
  examination: HistoryCiterExamination,
  occurrence: DiscoverCitationOccurrence,
  statement: ScopeCitationStatement | undefined,
): HistoryCitationUse {
  return {
    useId: historyCitationUseId(
      middlePaperId,
      occurrence.mentionId,
      occurrence.observationProvenance.sourceTextHash,
      statement?.statementId,
    ),
    middlePaperId,
    citing,
    occurrenceId: occurrence.mentionId,
    ...(statement
      ? {
          claimRecordId: statement.claimRecordId,
          statementId: statement.statementId,
          statementText: statement.extractedClaimText,
          credit: statement.credit,
        }
      : {}),
    observationProvenance: occurrence.observationProvenance,
    ...(occurrence.sourceLocator
      ? { sourceLocator: occurrence.sourceLocator }
      : {}),
    ...(occurrence.citationGroupOrdinal === undefined
      ? {}
      : { citationGroupOrdinal: occurrence.citationGroupOrdinal }),
    targetRefIds: occurrence.targetRefIds,
    ...(examination.bibliographyMatch
      ? { bibliographyMatch: examination.bibliographyMatch }
      : {}),
    mentionIndex: occurrence.mentionIndex,
    ...(occurrence.charOffsetStart === undefined
      ? {}
      : { charOffsetStart: occurrence.charOffsetStart }),
    ...(occurrence.charOffsetEnd === undefined
      ? {}
      : { charOffsetEnd: occurrence.charOffsetEnd }),
    context: occurrence.rawContext,
    citationMarker: occurrence.citationMarker,
    ...(occurrence.markerSpan ? { markerSpan: occurrence.markerSpan } : {}),
    ...(statement?.textSpan ? { supportSpan: statement.textSpan } : {}),
    provenanceArtifacts: uniqueSortedArtifactReferences([
      ...occurrence.observationProvenance.artifacts,
      ...(statement
        ? (examination.claimProvenance?.get(statement.claimRecordId) ?? [])
        : []),
    ]),
  };
}

type PendingCase = {
  hop: HistoryLaterHop;
  input: HistoryAssessmentInput;
};

function recordCitationUses(input: {
  targets: Target[];
  citing: HistoryPaper;
  examination: HistoryCiterExamination;
  middleText: HistoryMiddleText | undefined;
  citationUses: HistoryCitationUse[];
}): PendingCase[] {
  const { targets, citing, examination, middleText, citationUses } = input;
  const byOccurrence = new Map<string, ScopeCitationStatement[]>();
  for (const statement of examination.statements) {
    const list = byOccurrence.get(statement.occurrenceId);
    if (list) list.push(statement);
    else byOccurrence.set(statement.occurrenceId, [statement]);
  }
  const pending: PendingCase[] = [];
  for (const occurrence of examination.occurrences) {
    for (const statement of byOccurrence.get(occurrence.mentionId) ?? [
      undefined,
    ]) {
      const use = buildCitationUse(
        targets[0]!.path.middle.paperId,
        citing,
        examination,
        occurrence,
        statement,
      );
      citationUses.push(use);
      for (const target of targets) {
        const { path } = target;
        const source =
          middleText && matchesParentVersion(middleText, target)
            ? middleText
            : undefined;
        const directCitation = examination.directCitation(
          path.original,
          occurrence,
        );
        const hop: HistoryLaterHop = {
          useId: use.useId,
          assessments: [],
          status: "unassessed",
          reason: examination.reason,
          directCitation,
          provenanceArtifacts: uniqueSortedArtifactReferences([
            ...directCitation.provenanceArtifacts,
            ...(source ? [source.sourceArtifact] : []),
          ]),
        };
        path.laterHops.push(hop);
        const parentStatementText = path.firstHop.text;
        const downstreamText = statement?.textSpan?.text;
        if (
          !parentStatementText ||
          path.firstHop.credit === "unverified" ||
          path.firstHop.findings.length === 0
        ) {
          hop.reason =
            "The first hop has no finding tied to a verified citation statement.";
          continue;
        }
        if (!downstreamText || statement.credit === "unverified") {
          if (statement)
            hop.reason =
              "The downstream statement lacks exact citation attribution.";
          continue;
        }
        const parentCitation = {
          context: target.statement.citationContext,
          marker: target.statement.citationMarker,
          ...(target.originalReferenceId
            ? { originalReferenceId: target.originalReferenceId }
            : {}),
          targetRefIds: target.statement.targetRefIds,
          bundleRefIds: target.statement.bundleRefIds,
          ...(target.paragraphCitations?.length
            ? { paragraphCitations: target.paragraphCitations }
            : {}),
          ...(target.statement.markerSpan
            ? { markerSpan: target.statement.markerSpan }
            : {}),
          ...(target.statement.sourceLocator
            ? { sourceLocator: target.statement.sourceLocator }
            : {}),
          ...(target.statement.citationGroupOrdinal === undefined
            ? {}
            : { citationGroupOrdinal: target.statement.citationGroupOrdinal }),
        };
        const blockId =
          source && locateHistoryCitationBlock(source.blocks, parentCitation);
        for (const finding of path.firstHop.findings) {
          pending.push({
            hop,
            input: {
              caseId: historyAssessmentCaseId(
                path.statementId,
                use.useId,
                finding.findingId,
              ),
              finding,
              original: path.original,
              middle: path.middle,
              citing,
              parentCitation: {
                ...parentCitation,
                ...(blockId ? { blockId } : {}),
              },
              parentStatementText,
              parentRetained: path.firstHop.retained,
              parentCitationCredit: path.firstHop.credit,
              parentChanges: path.firstHop.changes,
              ...(source
                ? {
                    parentTextVersionId: source.sourceArtifact.artifactId,
                    parentSourceArtifact: source.sourceArtifact,
                  }
                : {}),
              parentBlocks: source?.blocks ?? [],
              downstreamText,
              downstreamExtractedClaim: statement.extractedClaimText,
              downstreamCitationCredit: statement.credit,
              downstreamBibliographyMatch: use.bibliographyMatch,
              downstreamTargetRefIds: use.targetRefIds,
              downstreamBundleRefIds: occurrence.bundleRefIds,
              downstreamContext: occurrence.rawContext,
              downstreamMarker: occurrence.citationMarker,
              ...(occurrence.markerSpan
                ? { downstreamMarkerSpan: occurrence.markerSpan }
                : {}),
              directCitation: directCitation.status,
            },
          });
        }
      }
    }
  }
  return pending;
}

const assessmentPriority = {
  assessed: 4,
  invalid_output: 3,
  provider_failure: 2,
  budget_exhausted: 1,
  unassessed: 0,
} as const;

function recordAssessment(
  hop: HistoryLaterHop,
  assessment: HistoryAssessment,
  provenanceArtifacts: ArtifactReference[] = [],
): void {
  hop.assessments.push({ ...assessment, provenanceArtifacts });
  hop.provenanceArtifacts = uniqueSortedArtifactReferences([
    ...hop.provenanceArtifacts,
    ...provenanceArtifacts,
  ]);
  if (assessmentPriority[assessment.status] > assessmentPriority[hop.status]) {
    hop.status = assessment.status;
    hop.reason =
      assessment.status === "assessed"
        ? "Compared the downstream statement to the original finding and assessed its route."
        : assessment.reason;
  }
}

function recordSkippedAssessments(
  pending: PendingCase[],
  status: "budget_exhausted" | "provider_failure",
  reason: string,
): void {
  for (const { hop, input } of pending) {
    recordAssessment(hop, {
      caseId: input.caseId,
      findingId: input.finding.findingId,
      status,
      reason,
    });
  }
}

/** Reconsider only routes with exact evidence outside the credited passage.
 * Keep the initial judgments and attach both calls to each reconsidered case. */
async function reconsiderRejectedRoutes(
  cases: readonly HistoryAssessmentInput[],
  assessments: readonly HistoryAssessment[],
  assessHistoryCases: AssessHistoryCases,
): Promise<
  | {
      byIndex: Map<number, HistoryAssessment>;
      result: HistoryAssessmentBatchResult;
      provenanceArtifacts: ArtifactReference[];
    }
  | undefined
> {
  const targets = assessments.flatMap((assessment, index) =>
    assessment.status === "assessed" && assessment.routeRejection
      ? [
          {
            index,
            assessment,
            input: {
              ...cases[index]!,
              reconsiderRouteForQuote: assessment.downstreamQuote,
            },
          },
        ]
      : [],
  );
  if (!targets.length) return undefined;

  const inputs = targets.map(({ input }) => input);
  let result: HistoryAssessmentBatchResult;
  try {
    result = await assessHistoryCases(inputs);
  } catch (error) {
    if (!isHistorySpendLimit(error)) throw error;
    return undefined;
  }
  const reviewed =
    result.status === "completed"
      ? verifyHistoryAssessments(inputs, result.rawOutput)
      : [];
  const byIndex = new Map<number, HistoryAssessment>(
    targets.map(({ index, assessment }, position) => {
      const update = reviewed[position];
      if (update?.status === "assessed" && update.route.kind !== "unresolved") {
        const corrected = {
          ...assessment,
          route: update.route,
          reason: update.reason,
        };
        delete corrected.routeRejection;
        return [index, corrected];
      }
      return [index, assessment];
    }),
  );
  return {
    byIndex,
    result,
    provenanceArtifacts: [
      result.execution.requestArtifact,
      result.execution.responseArtifact,
    ],
  };
}

async function assessPendingCases(
  pending: PendingCase[],
  assessHistoryCases: AssessHistoryCases,
  terminalProviderFailure: string | undefined,
): Promise<{
  budgetExhausted: boolean;
  failed: boolean;
  terminalProviderFailure?: string;
  provenanceArtifacts: ArtifactReference[];
}> {
  const provenanceArtifacts: ArtifactReference[] = [];
  if (terminalProviderFailure) {
    recordSkippedAssessments(
      pending,
      "provider_failure",
      terminalProviderFailure,
    );
    return {
      budgetExhausted: false,
      failed: pending.length > 0,
      terminalProviderFailure,
      provenanceArtifacts,
    };
  }
  let failed = false;
  const byVersion = new Map<string | undefined, PendingCase[]>();
  for (const entry of pending) {
    const version = entry.input.parentTextVersionId;
    const group = byVersion.get(version);
    if (group) group.push(entry);
    else byVersion.set(version, [entry]);
  }
  const ordered = [...byVersion.values()].flat();
  for (let offset = 0; offset < ordered.length; ) {
    const version = ordered[offset]!.input.parentTextVersionId;
    const batch = ordered
      .slice(offset, offset + MAX_HISTORY_ASSESSMENT_CASES)
      .filter(({ input }) => input.parentTextVersionId === version);
    const cases = batch.map((entry) => entry.input);
    let result: Awaited<ReturnType<AssessHistoryCases>>;
    try {
      result = await assessHistoryCases(cases);
    } catch (error) {
      if (!isHistorySpendLimit(error)) throw error;
      recordSkippedAssessments(
        ordered.slice(offset),
        "budget_exhausted",
        "The comparison would exceed the citation history spend limit.",
      );
      return { budgetExhausted: true, failed, provenanceArtifacts };
    }
    const batchArtifacts = [
      result.execution.requestArtifact,
      result.execution.responseArtifact,
    ];
    provenanceArtifacts.push(...batchArtifacts);
    const assessments: HistoryAssessment[] =
      result.status === "completed"
        ? verifyHistoryAssessments(cases, result.rawOutput)
        : cases.map((entry) => ({
            caseId: entry.caseId,
            findingId: entry.finding.findingId,
            status:
              result.reasonCode === "invalid_response"
                ? ("invalid_output" as const)
                : ("provider_failure" as const),
            reason: result.reason,
          }));
    const review = await reconsiderRejectedRoutes(
      cases,
      assessments,
      assessHistoryCases,
    );
    if (review) provenanceArtifacts.push(...review.provenanceArtifacts);
    for (const [index, { hop }] of batch.entries()) {
      const reviewed = review?.byIndex.get(index);
      const assessment = reviewed ?? assessments[index]!;
      recordAssessment(
        hop,
        assessment,
        reviewed && review
          ? [...batchArtifacts, ...review.provenanceArtifacts]
          : batchArtifacts,
      );
      failed ||= assessment.status !== "assessed";
    }
    const finalCall = review?.result ?? result;
    offset += batch.length;
    if (
      finalCall.status === "failed" &&
      scopeFatalFailureCodeSchema.safeParse(finalCall.reasonCode).success
    ) {
      terminalProviderFailure =
        "Comparison was deferred after a terminal model provider failure: " +
        finalCall.reason;
      recordSkippedAssessments(
        ordered.slice(offset),
        "provider_failure",
        terminalProviderFailure,
      );
      return {
        budgetExhausted: false,
        failed,
        terminalProviderFailure,
        provenanceArtifacts,
      };
    }
  }
  return { budgetExhausted: false, failed, provenanceArtifacts };
}

export async function runCitationHistory(input: {
  report: ReportChain;
  limits: CitationHistoryPayload["limits"];
  explicitStatementIds?: string[];
  getSource: (
    middle: HistoryPaper,
    maxCiters: number,
  ) => Promise<HistorySource>;
  assessHistoryCases: AssessHistoryCases;
  readFirstHopParagraphCitations?: ReadFirstHopParagraphCitations;
}): Promise<CitationHistoryArtifact> {
  const { report, getSource, assessHistoryCases } = input;
  const limits = citationHistoryLimitsSchema.parse(input.limits);
  const { targets, selection } = selectTargets({
    report,
    explicitStatementIds: input.explicitStatementIds ?? [],
    maxParents: limits.maxParents,
    readFirstHopParagraphCitations: input.readFirstHopParagraphCitations,
  });
  const targetsByPaper = new Map<string, Target[]>();
  for (const target of targets) {
    const paperId = target.path.middle.paperId;
    const current = targetsByPaper.get(paperId);
    if (current) current.push(target);
    else targetsByPaper.set(paperId, [target]);
  }

  const groups = [...targetsByPaper.values()].map((middleTargets) => {
    const { middle } = middleTargets[0]!.path;
    const viable = middleTargets.some(
      ({ path }) =>
        path.firstHop.credit !== "unverified" &&
        path.firstHop.findings.length > 0,
    );
    return { middle, middleTargets, viable };
  });
  let viableGroups = groups.filter(
    ({ middle, viable }) => middle.doi && viable,
  ).length;
  let remainingCiters = limits.maxCiters;
  const neighborhoods: CitationHistoryNeighborhood[] = [];
  const citationUses: HistoryCitationUse[] = [];
  let terminalProviderFailure: string | undefined;
  for (const { middle, middleTargets, viable } of groups) {
    // Recalculate the share as each group finishes. An undersubscribed
    // neighborhood leaves all of its unused work allowance to later groups.
    let allocation = 0;
    if (middle.doi && viable) {
      allocation = Math.ceil(remainingCiters / viableGroups);
      viableGroups -= 1;
    }
    const source = !viable
      ? unavailableHistorySource(
          middle,
          "neighborhood_unavailable",
          "No verified inherited statement has a reliable bibliography match.",
        )
      : !middle.doi
        ? unavailableHistorySource(
            middle,
            "missing_doi",
            "The intermediate paper has no resolved DOI.",
          )
        : allocation > 0
          ? await getSource(middle, allocation)
          : unavailableHistorySource(
              middle,
              "citer_budget_exhausted",
              "The global citing-paper limit was reached before this paper.",
            );
    const selected = source.citers;
    if (selected.length > allocation)
      throw new Error(
        "The citation history source exceeded the remaining citer limit",
      );
    remainingCiters -= selected.length;
    const neighborhood: CitationHistoryNeighborhood = {
      ...source.neighborhood,
      allocatedCiterLimit: allocation,
      citers: [],
    };
    neighborhoods.push(neighborhood);
    let middleText: Promise<HistoryMiddleText | undefined> | undefined;
    for (const { paper, examine } of selected) {
      if (terminalProviderFailure && !source.neighborhood.sourceReport) {
        neighborhood.citers.push({
          paper,
          status: "examination_failed",
          reason: terminalProviderFailure,
          provenanceArtifacts: [],
        });
        continue;
      }
      const examined = await examine();
      let { status, reason } = examined;
      const hasExactStatement = examined.statements.some(
        (statement) => statement.credit !== "unverified",
      );
      if (hasExactStatement && !middleText && !terminalProviderFailure) {
        middleText = source.middleText();
        recordMiddleSource(await middleText, middleTargets, neighborhood);
      }
      const pending = recordCitationUses({
        targets: middleTargets,
        citing: paper,
        examination: examined,
        middleText: await middleText,
        citationUses,
      });
      const assessment = await assessPendingCases(
        pending,
        assessHistoryCases,
        terminalProviderFailure,
      );
      terminalProviderFailure = assessment.terminalProviderFailure;
      if (assessment.budgetExhausted) {
        status = "budget_exhausted";
        reason = "A comparison would exceed the citation history spend limit.";
      } else if (status === "assessed" && assessment.failed) {
        status = "examination_failed";
        reason =
          terminalProviderFailure ??
          "At least one later citation comparison could not be completed.";
      } else if (
        status === "assessed" &&
        (!hasExactStatement ||
          examined.statements.some(
            (statement) => statement.credit === "unverified",
          ))
      ) {
        status = "examination_failed";
        reason =
          "At least one statement could not be assessed from its exact citation attribution.";
      }
      neighborhood.citers.push({
        paper,
        status,
        reason,
        provenanceArtifacts: uniqueSortedArtifactReferences([
          ...examined.provenanceArtifacts,
          ...assessment.provenanceArtifacts,
        ]),
      });
    }
  }

  return createCitationHistoryArtifact({
    report: {
      runId: report.report.runId,
      artifactId: report.report.artifactId,
      contentHash: report.report.contentHash,
    },
    limits,
    selection,
    paths: targets.map((target) => target.path),
    citationUses,
    neighborhoods,
  });
}
