/**
 * Constructed cases: adjudication cases whose right answer is known because
 * they were made by editing a restatement a human labelled faithful.
 *
 * Human labels on real records hold almost no distortions, so they cannot
 * show whether an adjudicator misses one. A distortion takes a faithful
 * restatement and moves it along one named dimension; an adjudicator that
 * still answers `F` has missed a distortion we put there on purpose. A
 * control rewords the same restatement without changing what it says; an
 * adjudicator that objects to it is reacting to the edit, not to the seed.
 */
import { z } from "zod";
import {
  buildCanonicalAdjudicatePrompt,
  canonicalAdjudicatePacketSchema,
  type CanonicalAdjudicatePacket,
} from "../adjudication/canonical-adjudicate-packet.js";
import { buildStableId } from "../shared/stable-identity.js";
import {
  controlExpectation,
  distortionExpectation,
  type ConstructedLabel,
  type EvaluationCase,
} from "./types.js";

const editSchema = z
  .object({ find: z.string().min(1), replace: z.string() })
  .strict();
type Edit = z.infer<typeof editSchema>;

const mutationEdit = {
  /** Prepare record of the faithful restatement being edited. */
  recordId: z.string().min(1),
  /** Why the edit does, or does not, change what is attributed to the seed. */
  rationale: z.string().min(1),
  /** Edits to the citing text; each `find` occurs once in the shown context. */
  contextEdits: z.array(editSchema).min(1),
  /** The same change made to the extracted claim wording. */
  claimEdits: z.array(editSchema).min(1),
};
const mutationSchema = z.discriminatedUnion("expectedVerdict", [
  z.object({ ...mutationEdit, ...distortionExpectation }).strict(),
  z.object({ ...mutationEdit, ...controlExpectation }).strict(),
]);
export type Mutation = z.infer<typeof mutationSchema>;
export const mutationFileSchema = z.array(mutationSchema);

type AdjudicationCase = Extract<EvaluationCase, { task: "adjudication" }>;

function occurrences(text: string, find: string): number {
  return text.split(find).length - 1;
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  return edits.reduce(
    (current, edit) => current.split(edit.find).join(edit.replace),
    text,
  );
}

/** The citing context as the citing paper wrote it, without scope markers. */
function withoutMarkers(markedContext: string): string {
  return markedContext.replace(/▶ ?| ?◀/g, "");
}

function mutatePacket(
  packet: CanonicalAdjudicatePacket,
  mutation: Mutation,
): CanonicalAdjudicatePacket {
  for (const edit of mutation.contextEdits) {
    const count = occurrences(packet.markedCitingContext, edit.find);
    if (count !== 1)
      throw new Error(
        `Context edit "${edit.find}" occurs ${String(count)} times in the citing context of ${mutation.recordId}; it must occur once`,
      );
  }
  for (const edit of mutation.claimEdits) {
    if (
      !packet.occurrenceClaims.some((claim) =>
        claim.claimText.includes(edit.find),
      )
    )
      throw new Error(
        `Claim edit "${edit.find}" matches no attributed claim of ${mutation.recordId}`,
      );
  }
  const markedCitingContext = applyEdits(
    packet.markedCitingContext,
    mutation.contextEdits,
  );
  const original = withoutMarkers(packet.markedCitingContext);
  const edited = withoutMarkers(markedCitingContext);
  const occurrenceClaims = packet.occurrenceClaims.map((claim) => {
    const supportSpanText =
      claim.supportSpanText == null
        ? undefined
        : applyEdits(claim.supportSpanText, mutation.contextEdits);
    // A span that was readable in the context must stay readable in it, or
    // the packet would show the model two versions of the citing sentence.
    if (
      claim.supportSpanText != null &&
      supportSpanText != null &&
      original.includes(claim.supportSpanText) &&
      !edited.includes(supportSpanText)
    )
      throw new Error(
        `A context edit of ${mutation.recordId} crosses the edge of a support span; keep each edit inside or outside the span`,
      );
    // Offsets index the unedited paragraph and are not shown to a model.
    return {
      claimRecordId: claim.claimRecordId,
      claimText: applyEdits(claim.claimText, mutation.claimEdits),
      ...(supportSpanText != null ? { supportSpanText } : {}),
    };
  });
  if (
    occurrenceClaims.every(
      (claim, index) =>
        claim.supportSpanText ===
        packet.occurrenceClaims[index]!.supportSpanText,
    )
  )
    throw new Error(
      `The context edits of ${mutation.recordId} change no support span, so they do not touch what is attributed to the seed`,
    );
  return { ...packet, markedCitingContext, occurrenceClaims };
}

function expectationOf(mutation: Mutation) {
  return mutation.expectedVerdict === "F"
    ? { expectedVerdict: mutation.expectedVerdict }
    : {
        expectedVerdict: mutation.expectedVerdict,
        mutationKind: mutation.mutationKind,
        direction: mutation.direction,
      };
}

/**
 * Builds the constructed case for one mutation. The case gets its own record
 * and unit identity, shaped like a real one, so it inherits no label or saved
 * observation from its source and a blind reviewer cannot tell it apart.
 */
function buildConstructedCase(
  source: AdjudicationCase,
  mutation: Mutation,
  evidencePinned: boolean,
): Omit<AdjudicationCase, "caseId"> {
  if (source.constructed)
    throw new Error(`Mutation source ${source.recordId} is itself constructed`);
  const recordId = buildStableId("record", {
    sourceRecordId: source.recordId,
    mutation,
  });
  const packet = {
    ...mutatePacket(
      canonicalAdjudicatePacketSchema.parse(source.packet),
      mutation,
    ),
    recordId,
  };
  const constructed: ConstructedLabel = {
    sourceCaseId: source.caseId,
    rationale: mutation.rationale,
    evidencePinned,
    ...expectationOf(mutation),
  };
  return {
    task: "adjudication",
    runId: source.runId,
    seedDoi: source.seedDoi,
    recordId,
    sourceArtifactHashes: source.sourceArtifactHashes,
    unitKey: buildStableId("constructed-unit", {
      sourceUnitKey: source.unitKey,
      mutation,
    }),
    packet,
    anthropicPrompt: buildCanonicalAdjudicatePrompt(packet),
    constructed,
  };
}

/**
 * Builds every constructed case of a dataset. An edit is only a known answer
 * if its starting point was faithful, so each one must edit a unit a human
 * labelled `F`.
 */
export function buildConstructedCases(
  observed: readonly EvaluationCase[],
  humanVerdicts: ReadonlyMap<string, { verdict: string }>,
  mutations: readonly Mutation[],
): Omit<AdjudicationCase, "caseId">[] {
  const sourceByRecord = new Map(
    observed.flatMap((item) =>
      item.task === "adjudication" ? [[item.recordId, item] as const] : [],
    ),
  );
  // Pins come from the family's grounding and lead every selection, so a
  // packet they fill is the same whatever this citer wrote.
  const pinnedRecords = new Set(
    observed.flatMap((item) =>
      item.task === "rerank" &&
      item.pinnedChunkIds.length >= item.selectionLimit
        ? [item.recordId]
        : [],
    ),
  );
  return mutations.map((mutation) => {
    const source = sourceByRecord.get(mutation.recordId);
    if (!source)
      throw new Error(
        `Mutation names ${mutation.recordId}, which is not an adjudication case of the selected reports`,
      );
    if (humanVerdicts.get(source.unitKey)?.verdict !== "F")
      throw new Error(
        `Mutation source ${mutation.recordId} has no undisputed human F label`,
      );
    return buildConstructedCase(
      source,
      mutation,
      pinnedRecords.has(source.recordId),
    );
  });
}
