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

export const CANONICAL_ADJUDICATE_PROMPT_ID =
  "canonical-categorical-adjudicate" as const;
export const CANONICAL_ADJUDICATE_PROMPT_VERSION = "v2" as const;

type CanonicalAdjudicatePacketChunk = {
  chunkId: string;
  text: string;
  sourceBlockKind: EvidenceChunk["sourceBlockKind"];
  sourceSectionTitle?: string | undefined;
  charOffsetStart: number;
  charOffsetEnd: number;
};

type CanonicalAdjudicatePacketClaim = {
  claimRecordId: string;
  claimText: string;
  supportSpanText?: string | undefined;
  supportSpanCharOffsetStart?: number | undefined;
  supportSpanCharOffsetEnd?: number | undefined;
};

export type CanonicalAdjudicatePacket = {
  recordId: string;
  familyId: string;
  citationOccurrenceId: string;
  citationRole: string;
  evaluationMode: string;
  isBundled: boolean;
  bundleSize: number;
  seedRefLabel?: string | undefined;
  citingPaperTitle: string;
  citedPaperTitle: string;
  familyTrackedClaim: string;
  markedCitingContext: string;
  occurrenceClaims: CanonicalAdjudicatePacketClaim[];
  selectedChunks: CanonicalAdjudicatePacketChunk[];
};

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

  const marker =
    prepareRecord.citationOccurrence.seedRefLabel ??
    prepareRecord.citationOccurrence.citationMarker;
  const window = extractCitingWindow(
    prepareRecord.context.verbatim.text,
    marker,
    800,
  );
  const markedCitingContext = annotateCitingContext(
    window,
    prepareRecord.citationOccurrence.citationMarker,
    prepareRecord.citationOccurrence.seedRefLabel,
  );

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

function renderCanonicalAdjudicatePacket(
  packet: CanonicalAdjudicatePacket,
): string {
  const bundleWarning = packet.isBundled
    ? `\nBundled-reference warning: this citation marker is shared with ${String(packet.bundleSize)} references. Evaluate only the claim attributed to the seed paper under review; ignore attributions to other bundled works.`
    : "";
  const seedLabel = packet.seedRefLabel
    ? `\nSeed reference label: ${packet.seedRefLabel}`
    : "";

  const claimsBlock = packet.occurrenceClaims
    .map((claim, index) => {
      const span =
        claim.supportSpanText != null
          ? `\n   supportSpan: "${claim.supportSpanText}" (offsets ${String(claim.supportSpanCharOffsetStart)}-${String(claim.supportSpanCharOffsetEnd)})`
          : "";
      return `${String(index + 1)}. claimRecordId=${claim.claimRecordId}\n   "${claim.claimText}"${span}`;
    })
    .join("\n");

  const chunksBlock = packet.selectedChunks
    .map((chunk, index) => {
      const section = chunk.sourceSectionTitle
        ? `, section="${chunk.sourceSectionTitle}"`
        : "";
      return `${String(index + 1)}. chunkId=${chunk.chunkId} (${chunk.sourceBlockKind}${section}, offsets ${String(chunk.charOffsetStart)}-${String(chunk.charOffsetEnd)})\n"${chunk.text}"`;
    })
    .join("\n\n");

  return `## Citation unit

Record ID: ${packet.recordId}
Citation role: ${packet.citationRole}
Evaluation mode: ${packet.evaluationMode}
Citing paper: "${packet.citingPaperTitle}"
Cited/seed paper: "${packet.citedPaperTitle}"
Family tracked claim (analyst anchor only): "${packet.familyTrackedClaim}"${seedLabel}${bundleWarning}

## Citing context

Sentences attributed to the seed are marked with ▶ ... ◀ when disambiguation is needed. Evaluate only the claim attributed to the seed, not other claims in the paragraph or bundle.

${packet.markedCitingContext}

## Occurrence-local attributed claims

Use only these claimRecordId values in evaluatedClaimRecordIds. Verified supportSpan text is the exact citing-side attribution span:

${claimsBlock}

## Selected cited-paper chunks

Chunk order is presentation order only. It is not a judgment of support or truth. Use only these chunkId values in citedChunkIds. Judge only from this text evidence; figure-only support not present in the chunks is an evidence limitation, not grounds to invent content:

${chunksBlock}`;
}

export function buildCanonicalAdjudicatePrompt(
  packet: CanonicalAdjudicatePacket,
): string {
  return `${renderCanonicalAdjudicatePacket(packet)}

## Task

Compare the citing paper's attribution to the selected cited-paper chunks.

Return JSON with:
- comparison: two concise sentences — (1) what the citing paper attributes to the seed, (2) what the selected cited chunks actually say
- verdict: one of F, D, E, U using these definitions only:
  - F (faithful): the attribution preserves the cited source's substantive meaning; reasonable compression is allowed, including bundled citations when the seed supports a meaningful claim kernel
  - D (distortion): a real source kernel exists, but scope, strength, certainty, causality, population, conditions, measurement endpoint, or generality is materially altered
  - E (error): the central attribution is unsupported, contradicted, about the wrong entity/result, or otherwise lacks the claimed source kernel
  - U (uncertain): exact cited evidence is present, but genuine scientific or attribution ambiguity prevents a defensible F/D/E judgment. Do not use U for missing evidence or tool failure.
- rationale: 2-3 sentences explaining the comparison without advocacy
- confidence: low | medium | high (does not change the verdict path)
- evaluatedClaimRecordIds: every occurrence-local claimRecordId supplied above, exactly once; no omissions, unknowns, or duplicates
- citedChunkIds: one or more selected chunkId values supplied above; no unknowns or duplicates

Judge only from the packet. Do not invent evidence outside the selected chunks. Quantifier compression that preserves the kernel (for example "four types" vs "only four types") remains F when the source supports that kernel. Proxy endpoints that change what was measured (for example prevalence/density vs staining intensity) are D when the source kernel differs.`;
}
