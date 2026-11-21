import { z } from "zod";

import {
  artifactReferenceSchema,
  type ArtifactReference,
} from "../contract/artifacts/primitives.js";
import type {
  ScopeCitationStatement,
  ScopeSeedFinding,
} from "../contract/artifacts/scope-statements.js";
import { fidelityVerdictSchema } from "../domain/taxonomy.js";
import type { scopeModelResultSchema } from "../stages/scope/model-result.js";
import type { FirstHopParagraphCitation } from "./parent-citation.js";
import type { HistoryCitationUse, HistoryPaper } from "./store.js";

export const MAX_HISTORY_ASSESSMENT_CASES = 8;
const MAX_PARENT_TEXT_CHARACTERS = 400_000;

export type HistoryAssessmentInput = {
  caseId: string;
  finding: ScopeSeedFinding;
  original?: HistoryPaper | undefined;
  middle?: HistoryPaper | undefined;
  citing?: HistoryPaper | undefined;
  parentTextVersionId?: string | undefined;
  parentSourceArtifact?: ArtifactReference | undefined;
  parentBlocks: readonly {
    blockId: string;
    text: string;
    sectionTitle?: string | undefined;
    blockKind?: string | undefined;
  }[];
  parentStatementText: string;
  parentRetained: readonly string[];
  parentChanges: readonly string[];
  parentCitationCredit?: string | undefined;
  parentCitation?:
    | {
        context: string;
        marker: string;
        originalReferenceId?: string | undefined;
        targetRefIds?: readonly string[] | undefined;
        bundleRefIds?: readonly string[] | undefined;
        markerSpan?:
          | { charOffsetStart: number; charOffsetEnd: number }
          | undefined;
        sourceLocator?: ScopeCitationStatement["sourceLocator"];
        paragraphCitations?: FirstHopParagraphCitation[];
        citationGroupOrdinal?: number | undefined;
        blockId?: string | undefined;
      }
    | undefined;
  downstreamText: string;
  /** Exact downstream quote to keep when reconsidering a rejected route. */
  reconsiderRouteForQuote?: string;
  downstreamExtractedClaim: string;
  downstreamContext: string;
  downstreamMarker: string;
  downstreamCitationCredit?: string | undefined;
  downstreamBibliographyMatch?: HistoryCitationUse["bibliographyMatch"];
  downstreamTargetRefIds?: readonly string[] | undefined;
  downstreamBundleRefIds?: readonly string[] | undefined;
  downstreamMarkerSpan?:
    | {
        charOffsetStart: number;
        charOffsetEnd: number;
      }
    | undefined;
  directCitation: string;
};

export type HistoryAssessmentBatchResult = z.infer<
  typeof scopeModelResultSchema
>;
export type AssessHistoryCases = (
  cases: readonly HistoryAssessmentInput[],
) => Promise<HistoryAssessmentBatchResult>;

export function parentEvidenceStatus(input: HistoryAssessmentInput) {
  if (
    !input.parentTextVersionId ||
    input.parentSourceArtifact?.artifactId !== input.parentTextVersionId ||
    input.parentBlocks.length === 0
  )
    return "unavailable";
  const length = input.parentBlocks.reduce(
    (total, block) => total + block.text.length,
    0,
  );
  return length > MAX_PARENT_TEXT_CHARACTERS ? "oversized" : "available";
}

const nonempty = z.string().trim().min(1);
const comparisonSchema = z
  .object({
    status: z.enum([
      "full",
      "partial",
      "scope_changed",
      "distinct",
      "uncertain",
    ]),
    retained: z.array(z.string()),
    changes: z.array(z.string()),
    reason: z.string(),
  })
  .strict();

const quoteSchema = z
  .object({
    blockId: z.string(),
    text: z.string(),
  })
  .strict();
const verifiedQuoteSchema = quoteSchema
  .extend({
    blockId: nonempty,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .refine(
    ({ start, end, text }) =>
      end - start === text.length && text.trim().length > 0,
  );

function routeSchema<T extends z.ZodType>(evidence: T) {
  return z.discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("direct_restatement"), connection: evidence })
      .strict(),
    z
      .object({
        kind: z.literal("uptake"),
        connection: evidence,
        contribution: evidence,
      })
      .strict(),
    z
      .object({
        kind: z.literal("independent_contribution"),
        contribution: evidence,
      })
      .strict(),
    z.object({ kind: z.literal("unresolved") }).strict(),
    z.object({ kind: z.literal("unrelated") }).strict(),
  ]);
}

const modelRouteSchema = routeSchema(z.array(quoteSchema));
const verifiedRouteSchema = routeSchema(
  z.array(verifiedQuoteSchema).min(1).max(4),
);
const modelImmediateFidelitySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("assessed"),
    verdict: fidelityVerdictSchema,
    reason: z.string(),
    evidence: z.array(quoteSchema),
  }),
  z.strictObject({ status: z.literal("unassessed"), reason: z.string() }),
]);
const immediateFidelitySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("assessed"),
    verdict: fidelityVerdictSchema,
    reason: nonempty,
    evidence: z.array(verifiedQuoteSchema).min(1).max(4),
  }),
  z.strictObject({ status: z.literal("unassessed"), reason: nonempty }),
]);
const modelAssessmentSchema = z
  .object({
    downstreamQuote: z.string(),
    comparison: comparisonSchema,
    immediateFidelity: modelImmediateFidelitySchema,
    reason: z.string(),
    route: modelRouteSchema,
  })
  .strict();
const modelRowSchema = modelAssessmentSchema.extend({
  caseNumber: z.number().int(),
});

// Leave bounds and evidence requirements to per-case verification so one
// unusable row does not discard the remaining structured model output.
export const historyModelOutputSchema = z
  .object({
    assessments: z.array(modelRowSchema),
  })
  .strict();

const verifiedComparisonSchema = comparisonSchema.extend({
  retained: z.array(z.string().min(1)).max(4),
  changes: z.array(nonempty).max(6),
  reason: nonempty,
});

const assessedHistorySchema = modelAssessmentSchema.extend({
  caseId: nonempty,
  findingId: nonempty,
  status: z.literal("assessed"),
  parentTextVersionId: nonempty.optional(),
  parentEvidenceStatus: z.enum(["available", "unavailable", "oversized"]),
  route: verifiedRouteSchema,
  routeRejection: z.literal("outside_credited_passage").optional(),
  comparison: verifiedComparisonSchema,
  immediateFidelity: immediateFidelitySchema,
  reason: nonempty,
  provenanceArtifacts: z.array(artifactReferenceSchema).optional(),
});

export const historyAssessmentSchema = z.discriminatedUnion("status", [
  assessedHistorySchema,
  z
    .object({
      status: z.enum([
        "invalid_output",
        "provider_failure",
        "budget_exhausted",
      ]),
      caseId: nonempty,
      findingId: nonempty,
      reason: nonempty,
      provenanceArtifacts: z.array(artifactReferenceSchema).optional(),
    })
    .strict(),
]);

export type HistoryAssessment = z.infer<typeof historyAssessmentSchema>;
type VerifiedQuote = z.infer<typeof verifiedQuoteSchema>;

function verifyQuotes(
  input: HistoryAssessmentInput,
  quotes: z.infer<typeof quoteSchema>[],
): VerifiedQuote[] | undefined {
  if (quotes.length < 1 || quotes.length > 4) return undefined;
  const verified: VerifiedQuote[] = [];
  for (const { blockId, text } of quotes) {
    const blocks = input.parentBlocks.filter(
      (block) => block.blockId === blockId,
    );
    const block = blocks[0];
    if (blocks.length !== 1 || !block || !text.trim()) return undefined;
    const start = block.text.indexOf(text);
    if (start < 0 || block.text.indexOf(text, start + 1) >= 0) return undefined;
    if (
      verified.some(
        (quote) => quote.blockId === blockId && quote.start === start,
      )
    )
      return undefined;
    verified.push({ blockId, text, start, end: start + text.length });
  }
  return verified;
}

function quotesCreditedPassage(text: string, creditedPassage: string): boolean {
  if (!creditedPassage.trim()) return false;
  if (creditedPassage.includes(text)) return true;
  return (
    text.startsWith(creditedPassage) &&
    /^[\s.,;:!?]*$/u.test(text.slice(creditedPassage.length))
  );
}

function isCreditedConnection(
  input: HistoryAssessmentInput,
  quote: VerifiedQuote,
): boolean {
  return (
    quote.blockId === input.parentCitation?.blockId &&
    quotesCreditedPassage(quote.text, input.parentStatementText)
  );
}

function verifyRoute(
  input: HistoryAssessmentInput,
  route: z.infer<typeof modelRouteSchema>,
):
  | z.infer<typeof verifiedRouteSchema>
  | "outside_credited_passage"
  | undefined {
  switch (route.kind) {
    case "direct_restatement": {
      const connection = verifyQuotes(input, route.connection);
      if (!connection || !input.parentCitation?.blockId) return undefined;
      if (connection.some((quote) => !isCreditedConnection(input, quote))) {
        return "outside_credited_passage";
      }
      if (
        !connection.some(({ text }) =>
          input.parentRetained.some(
            (phrase) => phrase.trim() && text.includes(phrase),
          ),
        )
      )
        return undefined;
      return { ...route, connection };
    }
    case "uptake": {
      const connection = verifyQuotes(input, route.connection);
      const contribution = verifyQuotes(input, route.contribution);
      return connection && contribution
        ? { ...route, connection, contribution }
        : undefined;
    }
    case "independent_contribution": {
      const contribution = verifyQuotes(input, route.contribution);
      return contribution ? { ...route, contribution } : undefined;
    }
    default:
      return route;
  }
}

function verifyComparison(
  comparison: z.infer<typeof comparisonSchema>,
  downstreamQuote: string,
): z.infer<typeof verifiedComparisonSchema> {
  const parsed = verifiedComparisonSchema.safeParse(comparison);
  const carriesFinding = ["full", "partial", "scope_changed"].includes(
    comparison.status,
  );
  if (
    parsed.success &&
    (!carriesFinding || comparison.retained.length > 0) &&
    ((comparison.status !== "partial" &&
      comparison.status !== "scope_changed") ||
      comparison.changes.length > 0) &&
    (comparison.status !== "distinct" ||
      (comparison.retained.length === 0 && comparison.changes.length === 0)) &&
    comparison.retained.every(
      (phrase) => phrase.trim() && downstreamQuote.includes(phrase),
    )
  )
    return parsed.data;

  return {
    status: "uncertain",
    retained: [],
    changes: [],
    reason:
      "Comparison evidence rejected by verification. The answer lacks required exact wording, documented differences, or an explanation.",
  };
}

function verifyImmediateFidelity(
  input: HistoryAssessmentInput,
  fidelity: z.infer<typeof modelImmediateFidelitySchema>,
  evidenceStatus: ReturnType<typeof parentEvidenceStatus>,
): z.infer<typeof immediateFidelitySchema> {
  if (evidenceStatus !== "available") {
    return {
      status: "unassessed",
      reason:
        "The exact intermediate text was unavailable for fidelity assessment.",
    };
  }
  if (fidelity.status === "assessed") {
    const evidence = verifyQuotes(input, fidelity.evidence);
    if (evidence && fidelity.reason.trim()) return { ...fidelity, evidence };
  }
  return {
    status: "unassessed",
    reason:
      fidelity.status === "unassessed" && fidelity.reason.trim()
        ? fidelity.reason
        : "Fidelity assessment lacks an explanation or exact intermediate evidence.",
  };
}

export function verifyHistoryAssessments(
  cases: readonly HistoryAssessmentInput[],
  rawOutput: unknown,
): HistoryAssessment[] {
  const parsed = z
    .object({ assessments: z.array(z.unknown()) })
    .safeParse(rawOutput);
  const rows = parsed.success ? parsed.data.assessments : [];
  return cases.map((input, index) => {
    const invalid = (reason: string): HistoryAssessment => ({
      caseId: input.caseId,
      findingId: input.finding.findingId,
      status: "invalid_output",
      reason,
    });
    const matching = rows.filter(
      (row) =>
        row != null &&
        typeof row === "object" &&
        "caseNumber" in row &&
        row.caseNumber === index + 1,
    );
    if (matching.length !== 1)
      return invalid(
        matching.length === 0
          ? "Assessment row is missing."
          : "Assessment row is duplicated.",
      );
    const parsedRow = modelRowSchema.safeParse(matching[0]);
    if (!parsedRow.success)
      return invalid("Assessment row has an invalid shape.");
    const row = parsedRow.data;
    if (
      !row.downstreamQuote.trim() ||
      !input.downstreamText.includes(row.downstreamQuote)
    )
      return invalid(
        "Downstream quote is absent from the verified citation wording.",
      );
    if (
      input.reconsiderRouteForQuote !== undefined &&
      row.downstreamQuote !== input.reconsiderRouteForQuote
    ) {
      return invalid(
        "Route reconsideration changed the verified downstream quote.",
      );
    }
    const evidenceStatus = parentEvidenceStatus(input);
    const routeCheck =
      evidenceStatus === "available" || row.route.kind === "unresolved"
        ? verifyRoute(input, row.route)
        : undefined;
    const outsideCredit = routeCheck === "outside_credited_passage";
    const reason = row.reason.trim();
    const verifiedRoute = !outsideCredit && reason ? routeCheck : undefined;
    return {
      caseId: input.caseId,
      findingId: input.finding.findingId,
      downstreamQuote: row.downstreamQuote,
      status: "assessed",
      route: verifiedRoute ?? { kind: "unresolved" },
      ...(outsideCredit
        ? { routeRejection: "outside_credited_passage" as const }
        : {}),
      reason: verifiedRoute
        ? reason
        : outsideCredit
          ? "The direct restatement cited wording outside the verified first-hop passage."
          : evidenceStatus === "available"
            ? "Route evidence rejected by verification. The answer lacks an explanation or exact evidence from the intermediate paper."
            : "Route evidence rejected by verification. The exact intermediate text was unavailable for route verification.",
      comparison: verifyComparison(row.comparison, row.downstreamQuote),
      immediateFidelity: verifyImmediateFidelity(
        input,
        row.immediateFidelity,
        evidenceStatus,
      ),
      parentEvidenceStatus: evidenceStatus,
      ...(evidenceStatus !== "unavailable" && input.parentTextVersionId
        ? { parentTextVersionId: input.parentTextVersionId }
        : {}),
    };
  });
}
