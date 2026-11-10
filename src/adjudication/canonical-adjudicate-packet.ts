import { z } from "zod";

import { mutationKindSchema } from "../domain/taxonomy.js";
import { parsedBlockKindSchema } from "../domain/parsing.js";
import { seedSectionRoleSchema } from "../contract/artifacts/seed-section-role.js";
import type {
  EvidenceChunk,
  EvidenceSelection,
  PreparedCitationInstance,
} from "../contract/lean-artifacts.js";
import {
  annotateCitingContext,
  assessCitationScopeAnnotation,
  extractCitingWindow,
} from "../shared/citation-context-window.js";
import { assessEvidenceLimitation } from "../shared/evidence-limitation.js";
import { LLM_PROMPT_VERSIONS } from "../config/llm-versions.js";
import { mutationDirectionSchema } from "../contract/canonical-adjudicate.js";
import {
  adjudicationVerdictDefinitions,
  FIDELITY_BOUNDARY_GUIDANCE,
} from "../shared/scientific-rubrics.js";

export const CANONICAL_ADJUDICATE_PROMPT_ID =
  "canonical-categorical-adjudicate" as const;
export const CANONICAL_ADJUDICATE_PROMPT_VERSION =
  LLM_PROMPT_VERSIONS.adjudication;

const packetChunkSchema = z
  .object({
    chunkId: z.string(),
    text: z.string(),
    sourceBlockKind: parsedBlockKindSchema,
    sourceSectionTitle: z.string().optional(),
    sourceSectionRole: seedSectionRoleSchema.optional(),
    sourceCitesOtherWork: z.boolean().optional(),
    charOffsetStart: z.number().int(),
    charOffsetEnd: z.number().int(),
  })
  .strict();

const packetClaimSchema = z
  .object({
    claimRecordId: z.string(),
    claimText: z.string(),
    supportSpanText: z.string().optional(),
    supportSpanCharOffsetStart: z.number().int().optional(),
    supportSpanCharOffsetEnd: z.number().int().optional(),
  })
  .strict();

/**
 * Everything the adjudicator is shown about one record. A packet saved to disk
 * (a frozen evaluation case) is read back through this schema.
 */
export const canonicalAdjudicatePacketSchema = z
  .object({
    recordId: z.string(),
    familyId: z.string(),
    citationOccurrenceId: z.string(),
    citationRole: z.string(),
    evaluationMode: z.string(),
    isBundled: z.boolean(),
    bundleSize: z.number().int(),
    seedRefLabel: z.string().optional(),
    citingPaperTitle: z.string(),
    citedPaperTitle: z.string(),
    familyTrackedClaim: z.string(),
    markedCitingContext: z.string(),
    occurrenceClaims: z.array(packetClaimSchema),
    selectedChunks: z.array(packetChunkSchema),
  })
  .strict();
export type CanonicalAdjudicatePacket = z.infer<
  typeof canonicalAdjudicatePacketSchema
>;

export type CanonicalAdjudicatePacketBuildInput = {
  prepareRecord: PreparedCitationInstance;
  selection: EvidenceSelection;
  selectedChunks: EvidenceChunk[];
};

/**
 * Compact neutral packet for categorical adjudication. Excludes Scope grounding
 * verdicts, ranking scores, prior adjudicator labels, and leading advocacy text.
 */
export function buildCanonicalAdjudicatePacket(
  input: CanonicalAdjudicatePacketBuildInput,
): CanonicalAdjudicatePacket {
  const { prepareRecord, selection, selectedChunks } = input;
  const classification = prepareRecord.classification;
  if (classification.status !== "classified") {
    throw new Error(
      "Canonical Adjudicate packet requires a classified Prepare record",
    );
  }

  // Prefer the resolved author-year label; fall back to the raw marker so
  // numeric-marker journals still center the window on the citing sentence.
  const seedRefLabel = prepareRecord.citationOccurrence.seedRefLabel;
  const rawMarker = prepareRecord.citationOccurrence.citationMarker;
  // Support-span offsets refer to the full citing context. Mark before
  // trimming the window so a repeated year elsewhere cannot redirect it.
  const markedFullContext = annotateCitingContext(
    prepareRecord.citationOccurrence.rawContext,
    rawMarker,
    seedRefLabel,
    prepareRecord.occurrenceSourceClaimRecords.flatMap((claim) =>
      claim.supportSpan ? [claim.supportSpan] : [],
    ),
  );
  const window = extractCitingWindow(
    markedFullContext,
    markedFullContext.includes("▶") ? "▶" : (seedRefLabel ?? rawMarker),
    800,
    seedRefLabel ? [rawMarker] : [],
  );
  // Keep the full marked text when a window would cut a multi-sentence mark.
  const markedCitingContext =
    markedFullContext.includes("▶") && !assessCitationScopeAnnotation(window).ok
      ? markedFullContext
      : window;

  const chunksById = new Map(
    selectedChunks.map((chunk) => [chunk.chunkId, chunk]),
  );
  const orderedChunks = selection.selectedChunkIds.map((chunkId) => {
    const chunk = chunksById.get(chunkId);
    if (!chunk) {
      throw new Error(
        `Selected evidence chunk missing from corpus: ${chunkId}`,
      );
    }
    return {
      chunkId: chunk.chunkId,
      text: chunk.text,
      sourceBlockKind: chunk.sourceBlockKind,
      ...(chunk.sourceSectionTitle
        ? { sourceSectionTitle: chunk.sourceSectionTitle }
        : {}),
      ...(chunk.sourceSectionRole
        ? { sourceSectionRole: chunk.sourceSectionRole }
        : {}),
      ...(chunk.sourceCitesOtherWork != null
        ? { sourceCitesOtherWork: chunk.sourceCitesOtherWork }
        : {}),
      charOffsetStart: chunk.charOffsetStart,
      charOffsetEnd: chunk.charOffsetEnd,
    };
  });

  return {
    recordId: prepareRecord.recordId,
    familyId: prepareRecord.familyId,
    citationOccurrenceId: prepareRecord.citationOccurrenceId,
    citationRole: classification.citationRole,
    evaluationMode: classification.evaluationMode,
    isBundled: classification.modifiers.isBundled,
    bundleSize: classification.modifiers.bundleSize,
    ...(prepareRecord.citationOccurrence.seedRefLabel
      ? { seedRefLabel: prepareRecord.citationOccurrence.seedRefLabel }
      : {}),
    citingPaperTitle: prepareRecord.citingPaper.paper.title,
    citedPaperTitle:
      prepareRecord.seed.resolution.status === "resolved"
        ? prepareRecord.seed.resolution.paper.title
        : prepareRecord.seed.doi,
    familyTrackedClaim: prepareRecord.family.trackedClaim,
    markedCitingContext,
    occurrenceClaims: prepareRecord.occurrenceSourceClaimRecords.map(
      (claim) => ({
        claimRecordId: claim.claimRecordId,
        claimText: claim.extractedClaimText,
        ...(claim.supportSpan
          ? {
              supportSpanText: claim.supportSpan.text,
              supportSpanCharOffsetStart: claim.supportSpan.charOffsetStart,
              supportSpanCharOffsetEnd: claim.supportSpan.charOffsetEnd,
            }
          : {}),
      }),
    ),
    selectedChunks: orderedChunks,
  };
}

export function assessAdjudicatePacketQuality(
  packet: CanonicalAdjudicatePacket,
): {
  ok: boolean;
  gateReason?: string;
} {
  const missingSupportSpan = packet.occurrenceClaims.some(
    (claim) => claim.supportSpanText == null,
  );
  if (missingSupportSpan) {
    return {
      ok: false,
      gateReason:
        "Occurrence-local claims lack exact-verified support spans and are reserved for manual review",
    };
  }
  if (
    packet.occurrenceClaims.length > 0 &&
    !packet.markedCitingContext.includes("▶")
  ) {
    return {
      ok: false,
      gateReason:
        "Citation target could not be verified against the support span and resolved reference",
    };
  }
  const markerQuality = assessCitationScopeAnnotation(
    packet.markedCitingContext,
  );
  if (!markerQuality.ok) {
    return { ok: false, gateReason: markerQuality.reason };
  }
  return { ok: true };
}

export function packetEvidenceLimitation(packet: CanonicalAdjudicatePacket) {
  return assessEvidenceLimitation({
    claimTexts: packet.occurrenceClaims.map((claim) => claim.claimText),
    citingContext: packet.markedCitingContext,
    selectedChunkTexts: packet.selectedChunks.map((chunk) => chunk.text),
  });
}

/**
 * The citing paper's side of a record: what it is, the marked context, and the
 * claims it attributes to the seed. Shared by every adjudication prompt so the
 * prompts differ only in how the seed's evidence is presented.
 */
export function renderCitingSide(packet: CanonicalAdjudicatePacket): string {
  const bundleWarning = packet.isBundled
    ? `\nBundled-reference warning: this citation marker is shared with ${String(packet.bundleSize)} references. Evaluate only the claim attributed to the seed paper under review; ignore attributions to other bundled works.`
    : "";
  const seedLabel = packet.seedRefLabel
    ? `\nSeed reference label: ${packet.seedRefLabel}`
    : "";

  // Offsets are omitted: they index the full paragraph, not the window shown.
  const claimsBlock = packet.occurrenceClaims
    .map((claim, index) => {
      const span =
        claim.supportSpanText != null
          ? `\n   supportSpan: "${claim.supportSpanText}"`
          : "";
      return `${String(index + 1)}. "${claim.claimText}"${span}`;
    })
    .join("\n");

  return `## Citation unit

Record ID: ${packet.recordId}
Citation role: ${packet.citationRole} (${describeCitationRole(packet.citationRole)})
Evaluation mode: ${packet.evaluationMode} (${describeEvaluationMode(packet.evaluationMode)})
Citing paper: "${packet.citingPaperTitle}"
Cited/seed paper: "${packet.citedPaperTitle}"${seedLabel}${bundleWarning}

## Citing context

Sentences attributed to the seed are marked with ▶ ... ◀ when disambiguation is needed. Evaluate only the claim attributed to the seed, not other claims in the paragraph or bundle.

${packet.markedCitingContext}

## Attributed claims in this citation

Each verified supportSpan is the exact citing-side text the claim was extracted from. Judge all of them together as one attribution:

${claimsBlock}`;
}

/** Reply fields every adjudication prompt asks for, after the two statements. */
export function judgmentFieldInstructions(): string {
  return `${adjudicationVerdictDefinitions()}
- mutationKinds: for D only, one to three of ${mutationKindSchema.options.join(" | ")}; an empty array for F, E, and U
- direction: one of ${mutationDirectionSchema.options.join(" | ")} — how the citing version moved relative to the source (strengthened = stronger, broader, or more certain; weakened = hedged or narrowed; shifted = changed entity, endpoint, or population). Use none for F.
- rationale: 2-3 sentences explaining the comparison without advocacy
- confidence: low | medium | high (does not change the verdict path)`;
}

function renderSelectedChunks(packet: CanonicalAdjudicatePacket): string {
  return packet.selectedChunks
    .map((chunk, index) => {
      const section = chunk.sourceSectionTitle
        ? `, section="${chunk.sourceSectionTitle}"`
        : "";
      const role = chunk.sourceSectionRole
        ? `, role=${chunk.sourceSectionRole}`
        : "";
      const cites = chunk.sourceCitesOtherWork
        ? ", cites other work: may summarize prior findings rather than report the seed's own"
        : "";
      return `#${String(index + 1)} (${chunk.sourceBlockKind}${role}${section}${cites}, offsets ${String(chunk.charOffsetStart)}-${String(chunk.charOffsetEnd)})\n"${chunk.text}"`;
    })
    .join("\n\n");
}

export function buildCanonicalAdjudicatePrompt(
  packet: CanonicalAdjudicatePacket,
): string {
  return `${renderCitingSide(packet)}

## Selected cited-paper chunks

Chunk order is presentation order only. It is not a judgment of support or truth. Each chunk names its section role; only role=results, figure, table, or abstract can establish what the seed itself found, and a chunk that cites other work may be the seed summarizing prior literature. Refer to chunks by their numbers in citedChunks. Judge only from this text evidence; figure-only support not present in the chunks is an evidence limitation, not grounds to invent content:

${renderSelectedChunks(packet)}

## Task

Compare the citing paper's attribution to the selected cited-paper chunks.

Return JSON with:
- citingAssertion: one concise sentence stating what the citing paper attributes to the seed
- sourceStatement: one concise sentence stating what the selected cited chunks actually say
${judgmentFieldInstructions()}
- citedChunks: one or more chunk numbers from the list above that you relied on; no unknowns or duplicates

Judge only from the packet. Do not invent evidence outside the selected chunks. ${FIDELITY_BOUNDARY_GUIDANCE} If a chunk is the seed paper summarizing prior work rather than reporting its own result, say so in sourceStatement and do not treat it as the seed's finding.`;
}

function describeCitationRole(role: string): string {
  switch (role) {
    case "substantive_attribution":
      return "the citing text attributes a specific finding to the seed";
    case "background_context":
      return "the seed is cited as general background for a framing statement";
    case "methods_materials":
      return "the seed is cited for a method, reagent, or protocol";
    case "acknowledgment_or_low_information":
      return "the seed is acknowledged without a substantive claim";
    default:
      return "role as classified by the deterministic citation-role rules";
  }
}

function describeEvaluationMode(mode: string): string {
  switch (mode) {
    case "fidelity_specific_claim":
      return "judge the specific attributed claim strictly";
    case "fidelity_background_framing":
      return "judge whether the framing is a fair generalization of the seed";
    case "fidelity_methods_use":
      return "judge whether the method or material is attributed correctly";
    case "fidelity_bundled_use":
      return "judge only the kernel the seed contributes to a shared citation";
    case "review_transmission":
      return "the citing paper is a review; note that its restatement may itself be transmitted onward";
    default:
      return "evaluation mode as classified by the deterministic rules";
  }
}
