/**
 * Adjudication over the whole seed paper instead of a few retrieved chunks.
 *
 * The seed text is a stable prompt prefix, identical for every record of a
 * seed, so the provider can cache it. The model points at its evidence by
 * quoting the text, and each quote is verified as an exact substring of the
 * block it names. Because the model has read the whole paper, an `E` verdict
 * means the paper does not support the attribution, not that retrieval missed
 * the passage.
 */
import { z } from "zod";

import {
  addMutationConsistencyIssues,
  adjudicateJudgmentFields,
} from "../contract/canonical-adjudicate.js";
import type { Result } from "../domain/common.js";
import { FIDELITY_BOUNDARY_GUIDANCE } from "../shared/scientific-rubrics.js";
import {
  judgmentFieldInstructions,
  renderCitingSide,
  type CanonicalAdjudicatePacket,
} from "./canonical-adjudicate-packet.js";

/** One block of the seed paper as the adjudicator reads it. */
export type SeedTextBlock = {
  blockId: string;
  text: string;
  blockKind: string;
  sectionTitle?: string | undefined;
  sectionRole?: string | undefined;
  citesOtherWork: boolean;
};

export type SeedText = { title: string; blocks: readonly SeedTextBlock[] };

function renderSeedText(blocks: readonly SeedTextBlock[]): string {
  return blocks
    .map((block, index) => {
      const role = block.sectionRole ? `, role=${block.sectionRole}` : "";
      const section = block.sectionTitle
        ? `, section="${block.sectionTitle}"`
        : "";
      const cites = block.citesOtherWork ? ", cites other work" : "";
      return `#${String(index + 1)} (${block.blockKind}${role}${section}${cites})\n"${block.text}"`;
    })
    .join("\n\n");
}

/**
 * The prefix depends only on the seed, so every record of one seed shares it.
 * Everything about the citing paper is in the suffix.
 *
 * Saved evaluation trials are reused under one `promptRevision`; bump it in
 * `evaluation/config.ts` when this text changes.
 */
export function buildSeedTextAdjudicatePrompt(input: {
  packet: CanonicalAdjudicatePacket;
  seed: SeedText;
}): { prefix: string; suffix: string } {
  const prefix = `## Cited/seed paper, full text

Title: "${input.seed.title}"

The whole text of the seed paper follows as numbered blocks in reading order. Each block names its section role; only role=results, figure, table, or abstract can establish what the seed itself found, and a block that cites other work may be the seed summarizing prior literature. Figures appear only as their captions.

${renderSeedText(input.seed.blocks)}

`;
  const suffix = `${renderCitingSide(input.packet)}

## Task

Compare the citing paper's attribution to the seed text above. You have the whole paper, so an attribution it supports nowhere is E.

Return JSON with:
- citingAssertion: one concise sentence stating what the citing paper attributes to the seed
- sourceStatement: one concise sentence stating what the seed paper actually says on this point
${judgmentFieldInstructions()}
- seedQuotes: the seed passages you relied on, each as { "block": <block number>, "quote": <text copied exactly and contiguously from that block> }. Give at least one for F, D, and U. For E, quote the nearest related passage, or return an empty list when the paper says nothing on the point.

Judge only from the seed text. Do not invent evidence it does not contain; figure-only support that the captions do not state is an evidence limitation, not grounds to invent content. ${FIDELITY_BOUNDARY_GUIDANCE} If a passage is the seed paper summarizing prior work rather than reporting its own result, say so in sourceStatement and do not treat it as the seed's finding.`;
  return { prefix, suffix };
}

/** Model reply. Vocabulary and quotes are checked by `resolveSeedTextJudgment`. */
export const seedTextAdjudicateReplySchema = z
  .object({
    citingAssertion: z.string().min(1),
    sourceStatement: z.string().min(1),
    verdict: z.string().min(1),
    mutationKinds: z.array(z.string()).default([]),
    direction: z.string().min(1),
    rationale: z.string().min(1),
    confidence: z.string().min(1),
    seedQuotes: z
      .array(
        z
          .object({
            block: z.number().int().positive(),
            quote: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type SeedTextAdjudicateReply = z.infer<
  typeof seedTextAdjudicateReplySchema
>;

const seedTextJudgmentSchema = z
  .object({
    ...adjudicateJudgmentFields,
    /** Quotes that are exact substrings of the block they name. */
    seedQuotes: z.array(
      z
        .object({ blockId: z.string().min(1), quote: z.string().min(1) })
        .strict(),
    ),
    /** Quotes the model gave that do not occur in the block it named. */
    unverifiedQuoteCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine(addMutationConsistencyIssues)
  .superRefine((judgment, context) => {
    if (judgment.verdict !== "E" && judgment.seedQuotes.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["seedQuotes"],
        message: `A ${judgment.verdict} verdict must rest on at least one verified seed quote`,
      });
    }
  });
export type SeedTextJudgment = z.infer<typeof seedTextJudgmentSchema>;

/**
 * Checks the reply's vocabulary and verifies its quotes against the seed
 * text. A quote that does not occur in its block is dropped and counted; the
 * judgment survives as long as a verdict that needs evidence keeps one
 * verified quote.
 */
export function resolveSeedTextJudgment(
  reply: SeedTextAdjudicateReply,
  blocks: readonly SeedTextBlock[],
): Result<SeedTextJudgment> {
  const { seedQuotes: proposed, ...judgment } = reply;
  const verified = proposed.flatMap(({ block, quote }) => {
    const source = blocks[block - 1];
    return source?.text.includes(quote)
      ? [{ blockId: source.blockId, quote }]
      : [];
  });
  const parsed = seedTextJudgmentSchema.safeParse({
    ...judgment,
    seedQuotes: verified,
    unverifiedQuoteCount: proposed.length - verified.length,
  });
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    error: `${issue?.path.join(".") ?? "root"}: ${issue?.message ?? parsed.error.message}`,
  };
}
