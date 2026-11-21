import { z } from "zod";

import {
  assessedStatementRelationshipSchema,
  retainedWordingIsExact,
  scopeStatementAssessmentSchema,
  type ScopeCitationStatement,
  type ScopeSeedFinding,
  type ScopeSeedInventory,
  type ScopeStatementAssessment,
  type ScopeStatementAssessmentBatch,
  type ScopeVerifiedEvidenceSpan,
} from "../../contract/artifacts/scope-statements.js";
import type {
  DiscoverArtifactPayload,
  DiscoverAttributedClaimRecord,
  DiscoverCitationOccurrence,
  DiscoverCitingPaperRecord,
  DiscoverSeed,
} from "../../contract/artifacts/discover.js";
import type { ScopeSeedMaterialization } from "../../contract/artifacts/scope.js";
import {
  annotateCitingContext,
  assessCitationScopeAnnotation,
} from "../../shared/citation-context-window.js";
import { pMap } from "../../shared/concurrency.js";
import { compareCodeUnits, sortedUnique } from "../../shared/order.js";
import { buildStableId } from "../../shared/stable-identity.js";
import {
  parseScopeBoundary,
  scopeModelResultSchema,
  throwIfFatal,
} from "./model-result.js";

export const MAX_SEED_FINDINGS = 12;
const STATEMENT_BATCH_SIZE = 12;

export const groundingSupportSpanOutputSchema = z
  .object({
    verbatimQuote: z.string().min(1),
    blockId: z.string().min(1),
  })
  .strict();

export const scopeInventoryOutputSchema = z
  .object({
    reason: z.string().min(1),
    findings: z
      .array(
        z
          .object({
            statement: z.string().min(1),
            ownershipReason: z.string().min(1),
            supportSpans: z
              .array(groundingSupportSpanOutputSchema)
              .min(1)
              .max(4),
          })
          .strict(),
      )
      .max(MAX_SEED_FINDINGS),
  })
  .strict();

export const scopeStatementMatchingOutputSchema = z
  .object({
    assessments: z.array(
      z
        .object({
          statementId: z.string().min(1),
          relationship: assessedStatementRelationshipSchema,
          findingIds: z.array(z.string().min(1)),
          retained: z.array(z.string().min(1)),
          changes: z.array(z.string().min(1)),
          reason: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

type MaterializedSeed = Extract<
  ScopeSeedMaterialization,
  { status: "materialized" }
>;

export type ScopeStatementAdapters = {
  inventorySeed?: (input: {
    seed: DiscoverSeed;
    seedText: MaterializedSeed;
  }) => Promise<unknown>;
  matchStatements?: (input: {
    findings: ScopeSeedFinding[];
    statements: ScopeCitationStatement[];
  }) => Promise<unknown>;
};

export async function inspectSeedInventory(
  seed: DiscoverSeed,
  materialization: ScopeSeedMaterialization,
  inventorySeed?: ScopeStatementAdapters["inventorySeed"],
): Promise<ScopeSeedInventory> {
  const paper =
    seed.resolution.status === "resolved" ? seed.resolution.paper : undefined;
  const base = {
    seedId: seed.seedId,
    seedDoi: seed.doi,
    seedTitle: paper?.title ?? seed.doi,
    ...(paper?.publicationYear != null
      ? { seedPublicationYear: paper.publicationYear }
      : {}),
    findings: [],
    rejectedFindingCount: 0,
  };
  if (materialization.status !== "materialized") {
    return {
      ...base,
      status: materialization.status,
      reason: materialization.reason,
    };
  }
  const source = {
    ...base,
    seedTextArtifact: materialization.seedTextArtifact,
  };
  if (!inventorySeed) {
    return {
      ...source,
      status: "not_assessed",
      reason: "No seed inventory adapter was configured.",
    };
  }
  const result = parseScopeBoundary(
    scopeModelResultSchema,
    await inventorySeed({ seed, seedText: materialization }),
    `findings inventory for ${seed.seedId}`,
  );
  const execution = { ...source, modelExecution: result.execution };
  if (result.status === "failed") {
    throwIfFatal(result);
    return {
      ...execution,
      status:
        result.reasonCode === "invalid_response"
          ? "invalid_output"
          : "provider_failure",
      reason: result.reason,
    };
  }
  const parsed = scopeInventoryOutputSchema.safeParse(result.rawOutput);
  if (!parsed.success) {
    return {
      ...execution,
      status: "invalid_output",
      reason: "The seed inventory response was malformed.",
    };
  }
  const verify = createSeedQuoteVerifier(materialization);
  const findings = new Map<string, ScopeSeedFinding>();
  let rejectedFindingCount = 0;
  for (const { statement, ownershipReason, supportSpans } of parsed.data
    .findings) {
    const evidenceByPosition = new Map<string, ScopeVerifiedEvidenceSpan>();
    let allVerified = true;
    for (const proposal of supportSpans) {
      const span = verify(proposal);
      if (span)
        evidenceByPosition.set(
          `${span.blockId}:${span.charOffsetStart}:${span.charOffsetEnd}`,
          span,
        );
      else allVerified = false;
    }
    // Every proposed span must verify. A finding may rely on the missing span.
    if (!allVerified) {
      rejectedFindingCount++;
      continue;
    }
    const evidenceSpans = [...evidenceByPosition.values()].sort(
      (left, right) =>
        left.charOffsetStart - right.charOffsetStart ||
        left.charOffsetEnd - right.charOffsetEnd,
    );
    const findingId = buildStableId("finding", {
      seedId: seed.seedId,
      sourceTextHash: materialization.seedTextArtifact.contentHash,
      statement: statement.trim(),
      spans: evidenceSpans.map(
        ({ blockId, charOffsetStart, charOffsetEnd }) => ({
          blockId,
          charOffsetStart,
          charOffsetEnd,
        }),
      ),
    });
    findings.set(findingId, {
      findingId,
      statement,
      ownershipReason,
      evidenceSpans,
    });
  }
  return {
    ...execution,
    findings: [...findings.values()].sort((left, right) =>
      compareCodeUnits(left.findingId, right.findingId),
    ),
    rejectedFindingCount,
    status:
      findings.size > 0
        ? "completed"
        : rejectedFindingCount > 0
          ? "invalid_output"
          : "no_grounded_findings",
    reason:
      rejectedFindingCount > 0
        ? `Rejected ${rejectedFindingCount} proposed finding(s) whose evidence did not verify. ${parsed.data.reason}`
        : parsed.data.reason,
  };
}

function createSeedQuoteVerifier(materialization: MaterializedSeed) {
  const blocksById = new Map(
    materialization.blocks.map((block) => [block.blockId, block]),
  );
  return ({
    blockId,
    verbatimQuote,
  }: z.infer<typeof groundingSupportSpanOutputSchema>):
    | ScopeVerifiedEvidenceSpan
    | undefined => {
    const block = blocksById.get(blockId);
    if (!block || !verbatimQuote.trim()) return;
    const relativeStart = block.text.indexOf(verbatimQuote);
    if (
      relativeStart < 0 ||
      relativeStart !== block.text.lastIndexOf(verbatimQuote)
    )
      return;
    const charOffsetStart = block.charOffsetStart + relativeStart;
    return {
      text: verbatimQuote,
      blockId,
      blockKind: block.blockKind,
      ...(block.sectionTitle ? { sectionTitle: block.sectionTitle } : {}),
      charOffsetStart,
      charOffsetEnd: charOffsetStart + verbatimQuote.length,
      verificationStatus: "verified_exact",
      sourceArtifact: materialization.seedTextArtifact,
    };
  };
}

export function buildScopeCitationStatements(
  payload: Pick<
    DiscoverArtifactPayload,
    "attributedClaimRecords" | "citationMentions"
  > & {
    citingPapers: Pick<
      DiscoverCitingPaperRecord,
      "citingPaperRecordId" | "paper" | "bibliographyMatch"
    >[];
  },
): ScopeCitationStatement[] {
  const mentions = new Map(
    payload.citationMentions.map((mention) => [mention.mentionId, mention]),
  );
  const papers = new Map(
    payload.citingPapers.map((paper) => [paper.citingPaperRecordId, paper]),
  );
  return payload.attributedClaimRecords
    .map((claim): ScopeCitationStatement => {
      const mention = mentions.get(claim.mentionId);
      const paper = mention && papers.get(mention.citingPaperRecordId);
      if (!mention || !paper)
        throw new Error(
          `Attributed claim has no source occurrence: ${claim.claimRecordId}`,
        );
      const {
        rawContext,
        citationMarker,
        markerSpan,
        sourceLocator,
        citationGroupOrdinal,
        sectionTitle,
        locationQuality,
        observationProvenance,
      } = mention;
      const textSpan = claim.supportSpan;
      const credit = statementCredit(
        mention,
        paper.bibliographyMatch,
        textSpan,
      );
      const statementId = buildStableId("citation-statement", {
        claimRecordId: claim.claimRecordId,
        occurrenceId: mention.mentionId,
        sourceTextHash: observationProvenance.sourceTextHash,
        parser: observationProvenance.parser,
        parserVersion: observationProvenance.parserVersion,
        markerSpan,
        textSpan,
        rawContext,
      });
      return {
        statementId,
        seedId: claim.seedId,
        citingPaperId: mention.citingPaperId,
        citingPaperRecordId: paper.citingPaperRecordId,
        ...(paper.paper.doi ? { citingDoi: paper.paper.doi } : {}),
        citingTitle: paper.paper.title,
        ...(paper.paper.publicationYear != null
          ? { citingPublicationYear: paper.paper.publicationYear }
          : {}),
        occurrenceId: mention.mentionId,
        claimRecordId: claim.claimRecordId,
        extractedClaimText: claim.extractedClaimText,
        ...(textSpan ? { textSpan } : {}),
        citationContext: rawContext,
        citationMarker,
        ...(markerSpan ? { markerSpan } : {}),
        ...(sourceLocator ? { sourceLocator } : {}),
        ...(citationGroupOrdinal !== undefined ? { citationGroupOrdinal } : {}),
        ...(sectionTitle !== undefined ? { sectionTitle } : {}),
        locationQuality,
        targetRefIds: mention.targetRefIds,
        bundleRefIds: mention.bundleRefIds,
        ...(paper.bibliographyMatch
          ? { bibliographyMatchMethod: paper.bibliographyMatch.method }
          : {}),
        credit,
        sourceVersion: observationProvenance,
        assessment:
          credit !== "unverified"
            ? unassessed(
                "not_assessed",
                "The exact attributed statement is ready for assessment.",
              )
            : unassessed(
                "exact_attribution_unverified",
                "The claim wording could not be tied to an exact citation marker.",
              ),
      };
    })
    .sort((left, right) =>
      compareCodeUnits(left.statementId, right.statementId),
    );
}

function statementCredit(
  mention: DiscoverCitationOccurrence,
  bibliographyMatch: DiscoverCitingPaperRecord["bibliographyMatch"],
  textSpan: DiscoverAttributedClaimRecord["supportSpan"],
): ScopeCitationStatement["credit"] {
  const { rawContext, citationMarker, markerSpan } = mention;
  if (
    !textSpan ||
    !markerSpan ||
    !bibliographyMatch ||
    bibliographyMatch.method === "author_year_title_overlap" ||
    !mention.targetRefIds.includes(bibliographyMatch.refId) ||
    mention.locationQuality !== "exact_dom" ||
    !citationMarker ||
    markerSpan.charOffsetEnd > rawContext.length ||
    rawContext.slice(markerSpan.charOffsetStart, markerSpan.charOffsetEnd) !==
      citationMarker
  )
    return "unverified";

  const marked = annotateCitingContext(mention, [textSpan]);
  if (rawContext === marked || !assessCitationScopeAnnotation(marked).ok)
    return "unverified";

  const markers = [
    { citationMarker, markerSpan },
    ...(mention.nearbyCitations ?? []),
  ]
    .filter(
      (marker) =>
        rawContext.slice(
          marker.markerSpan.charOffsetStart,
          marker.markerSpan.charOffsetEnd,
        ) === marker.citationMarker,
    )
    .sort(
      (left, right) =>
        left.markerSpan.charOffsetStart - right.markerSpan.charOffsetStart,
    );
  const targetIndex = markers.findIndex(
    (marker) => marker.markerSpan === markerSpan,
  );
  let first = targetIndex;
  let last = targetIndex;
  const joined = (left: number, right: number) =>
    /^[\s,;–—-]*$/u.test(
      rawContext.slice(
        markers[left]!.markerSpan.charOffsetEnd,
        markers[right]!.markerSpan.charOffsetStart,
      ),
    );
  while (first > 0 && joined(first - 1, first)) first--;
  while (last + 1 < markers.length && joined(last, last + 1)) last++;

  // A competing marker closer to the exact wording in the same sentence
  // prevents credit from being transferred across its separately cited clause.
  const targetDistance = Math.max(
    markers[first]!.markerSpan.charOffsetStart - textSpan.charOffsetEnd,
    textSpan.charOffsetStart - markers[last]!.markerSpan.charOffsetEnd,
    0,
  );
  let nonMarkerText = textSpan.text;
  for (let index = markers.length - 1; index >= 0; index--) {
    const marker = markers[index]!;
    const { charOffsetStart, charOffsetEnd } = marker.markerSpan;
    const overlapStart = Math.max(textSpan.charOffsetStart, charOffsetStart);
    const overlapEnd = Math.min(textSpan.charOffsetEnd, charOffsetEnd);
    if (overlapStart < overlapEnd) {
      nonMarkerText =
        nonMarkerText.slice(0, overlapStart - textSpan.charOffsetStart) +
        nonMarkerText.slice(overlapEnd - textSpan.charOffsetStart);
    }
    if (
      (index < first || index > last) &&
      (Math.max(
        charOffsetStart - textSpan.charOffsetEnd,
        textSpan.charOffsetStart - charOffsetEnd,
        0,
      ) <= targetDistance ||
        (index > last &&
          textSpan.charOffsetEnd > markers[last]!.markerSpan.charOffsetEnd &&
          textSpan.charOffsetEnd < charOffsetStart &&
          /^[\s,;]*$/u.test(
            rawContext.slice(textSpan.charOffsetEnd, charOffsetStart),
          ))) &&
      annotateCitingContext({ rawContext, ...marker }, [textSpan]) !==
        rawContext
    )
      return "unverified";
  }
  if (!/\p{L}{2}/u.test(nonMarkerText)) return "unverified";
  return mention.isBundledCitation ||
    mention.bundleSize > 1 ||
    mention.targetRefIds.length > 1 ||
    first < last
    ? "shared_reference_group"
    : "single_reference";
}

type MatchResult = {
  statements: ScopeCitationStatement[];
  batches: ScopeStatementAssessmentBatch[];
};

export async function assessCitationStatements(input: {
  inventory: ScopeSeedInventory;
  statements: ScopeCitationStatement[];
  matchStatements?: ScopeStatementAdapters["matchStatements"];
  concurrency?: number;
}): Promise<MatchResult> {
  const { inventory, statements, matchStatements } = input;
  if (!matchStatements || inventory.status !== "completed") {
    const assessment = !matchStatements
      ? unassessed(
          "not_assessed",
          "No statement matching adapter was configured.",
        )
      : inventory.status === "no_grounded_findings"
        ? unassessed("no_grounded_findings", inventory.reason)
        : unassessed("inventory_unavailable", inventory.reason);
    return {
      statements: statements.map((statement) =>
        statement.credit === "unverified"
          ? statement
          : { ...statement, assessment },
      ),
      batches: [],
    };
  }
  const available = new Set(
    inventory.findings.map((finding) => finding.findingId),
  );
  const verified = statements.filter(
    (statement) => statement.credit !== "unverified",
  );
  const groups: ScopeCitationStatement[][] = [];
  for (let start = 0; start < verified.length; start += STATEMENT_BATCH_SIZE) {
    groups.push(verified.slice(start, start + STATEMENT_BATCH_SIZE));
  }

  if (groups.length === 0) return { statements, batches: [] };
  const matchGroup = async (group: ScopeCitationStatement[]) => {
    const statementIds = group.map((statement) => statement.statementId);
    const batchId = buildStableId("statement-assessment", {
      seedId: inventory.seedId,
      findingIds: inventory.findings.map((finding) => finding.findingId),
      statementIds,
    });
    const result = parseScopeBoundary(
      scopeModelResultSchema,
      await matchStatements({
        findings: inventory.findings,
        statements: group,
      }),
      `citation statement assessment ${batchId}`,
    );
    const batch = {
      batchId,
      seedId: inventory.seedId,
      statementIds,
      modelExecution: result.execution,
    };
    if (result.status === "failed") {
      throwIfFatal(result);
      return {
        batch,
        assessments: statementIds.map(
          (id) =>
            [
              id,
              unassessed(
                result.reasonCode === "invalid_response"
                  ? "invalid_output"
                  : "provider_failure",
                result.reason,
                batchId,
              ),
            ] as const,
        ),
      };
    }

    const parsed = scopeStatementMatchingOutputSchema.safeParse(
      result.rawOutput,
    );
    const rowsById = new Map<
      string,
      z.infer<typeof scopeStatementMatchingOutputSchema>["assessments"]
    >();
    if (parsed.success) {
      for (const row of parsed.data.assessments) {
        const rows = rowsById.get(row.statementId);
        if (rows) rows.push(row);
        else rowsById.set(row.statementId, [row]);
      }
    }
    return {
      batch,
      assessments: group.map((statement) => {
        const id = statement.statementId;
        const rows = rowsById.get(id);
        const row = rows?.length === 1 ? rows[0] : undefined;
        const parsedAssessment =
          row &&
          scopeStatementAssessmentSchema.safeParse({
            status: "assessed",
            relationship: row.relationship,
            findingIds: sortedUnique(row.findingIds),
            retained: row.retained,
            changes: row.changes,
            reason: row.reason,
            batchId,
          });
        const assessment =
          parsedAssessment?.success &&
          parsedAssessment.data.findingIds.every((findingId) =>
            available.has(findingId),
          ) &&
          parsedAssessment.data.retained.every((phrase) =>
            retainedWordingIsExact(phrase, statement.textSpan?.text),
          )
            ? parsedAssessment.data
            : unassessed(
                "invalid_output",
                "The model did not return one valid assessment tied to this statement and its inventory.",
                batchId,
              );
        return [id, assessment] as const;
      }),
    };
  };
  // Prime the shared inventory prefix before allowing the remaining batches
  // to run concurrently, as Scope does with the full cited paper.
  const matched = [
    await matchGroup(groups[0]!),
    ...(await pMap(groups.slice(1), matchGroup, {
      concurrency: input.concurrency ?? 1,
    })),
  ];
  const assessmentById = new Map(
    matched.flatMap(({ assessments }) => assessments),
  );
  return {
    statements: statements.map((statement) => ({
      ...statement,
      assessment:
        assessmentById.get(statement.statementId) ?? statement.assessment,
    })),
    batches: matched.map(({ batch }) => batch),
  };
}

function unassessed(
  status: Exclude<ScopeStatementAssessment["status"], "assessed">,
  reason: string,
  batchId?: string,
): ScopeStatementAssessment {
  return {
    status,
    relationship: "unassessed",
    findingIds: [],
    retained: [],
    changes: [],
    reason,
    ...(batchId ? { batchId } : {}),
  };
}
