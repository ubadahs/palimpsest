/**
 * Seed codebook: a fixed list of the statements a citer could cite the seed
 * for, drawn from the seed paper itself, and the tags that say which of them
 * each citing claim is about.
 *
 * Both are Scope annotations. They never exclude a candidate, change a
 * family, or touch a record or a verdict: Report reads them as a second view
 * beside the families. A codebook is generated once per seed text and
 * procedure version and then reused from SQLite, so its entries stay put
 * while the citer list and the family partition move between runs.
 */
import { z } from "zod";

import { PROMPT_VERSIONS } from "../../config/prompt-versions.js";
import {
  buildStableId,
  canonicalSha256,
} from "../../shared/stable-identity.js";
import { sha256DigestSchema, stableIdentifierSchema } from "./primitives.js";
import { modelExecutionSchema } from "../model-execution.js";
import { addIssue } from "./checks.js";

export const codebookEntryTypeSchema = z.enum([
  "result",
  "background_prior_work",
  "method_or_resource",
]);
export type CodebookEntryType = z.infer<typeof codebookEntryTypeSchema>;

export const codebookThemeIdSchema = z.string().regex(/^T[0-9]+$/);
export const codebookEntryIdSchema = z.string().regex(/^E[0-9]{2,}$/);

/** A quote exact-verified against one seed-text block. */
export const codebookQuoteSchema = z
  .object({
    blockId: z.string().min(1),
    text: z.string().min(1),
    charOffsetStart: z.number().int().nonnegative(),
    charOffsetEnd: z.number().int().positive(),
  })
  .strict();
export type CodebookQuote = z.infer<typeof codebookQuoteSchema>;

export const codebookThemeSchema = z
  .object({
    themeId: codebookThemeIdSchema,
    statement: z.string().min(1),
    /** The seed's main claim; its entries are the steps that make it up. */
    isHeadline: z.boolean(),
    quotes: z.array(codebookQuoteSchema),
  })
  .strict();
export type CodebookTheme = z.infer<typeof codebookThemeSchema>;

export const codebookEntrySchema = z
  .object({
    entryId: codebookEntryIdSchema,
    themeId: codebookThemeIdSchema,
    statement: z.string().min(1),
    type: codebookEntryTypeSchema,
    /** The seed presents the statement as established by other work. */
    attributedToOtherWork: z.boolean(),
    quotes: z.array(codebookQuoteSchema).min(1),
  })
  .strict();
export type CodebookEntry = z.infer<typeof codebookEntrySchema>;

/** What the organise step proposed and what quote verification kept. */
export const codebookVerificationSchema = z
  .object({
    proposedThemes: z.number().int().nonnegative(),
    proposedEntries: z.number().int().nonnegative(),
    quotesProposed: z.number().int().nonnegative(),
    quotesVerified: z.number().int().nonnegative(),
    /** Entries whose every quote failed exact verification. */
    entriesDropped: z.number().int().nonnegative(),
    /** Entries whose parent theme was unknown or dropped. */
    entriesOrphaned: z.number().int().nonnegative(),
    /** Themes with no verified quote and no surviving entry. */
    themesDropped: z.number().int().nonnegative(),
  })
  .strict();
export type CodebookVerification = z.infer<typeof codebookVerificationSchema>;

export type SeedCodebookContent = {
  themes: CodebookTheme[];
  entries: CodebookEntry[];
};

/**
 * Part of the stored-codebook key, so a changed prompt, schema, or
 * verification rule regenerates instead of reusing a codebook built another
 * way. It is the codebook prompts' version; bump that for any of these.
 */
export const SEED_CODEBOOK_PROCEDURE_VERSION = PROMPT_VERSIONS.seedCodebook;

/** Content hash of the seed text a codebook was built from. */
export function buildSeedTextHash(
  blocks: ReadonlyArray<{ blockId: string; text: string }>,
): string {
  return canonicalSha256(
    blocks.map((block) => ({ blockId: block.blockId, text: block.text })),
  );
}

export function buildSeedCodebookId(input: {
  seedId: string;
  seedTextHash: string;
  procedureVersion: string;
  content: SeedCodebookContent;
}): string {
  return buildStableId("codebook", {
    identityKind: "seed-codebook-v1",
    seedId: input.seedId,
    seedTextHash: input.seedTextHash,
    procedureVersion: input.procedureVersion,
    themes: input.content.themes,
    entries: input.content.entries,
  });
}

const storedCodebookFields = {
  seedId: stableIdentifierSchema,
  codebookId: stableIdentifierSchema,
  procedureVersion: z.string().min(1),
  seedTextHash: sha256DigestSchema,
  /** Model that ran the procedure when the codebook was generated. */
  model: z.string().min(1),
  generatedAt: z.string().datetime({ offset: true }),
  /** Run whose Scope generated the codebook. */
  generatedInRunId: z.string().min(1).optional(),
  verification: codebookVerificationSchema,
  themes: z.array(codebookThemeSchema).min(1),
  entries: z.array(codebookEntrySchema),
} as const;

/** The verified codebook as SQLite keeps it between runs. */
export const storedSeedCodebookSchema = z
  .object(storedCodebookFields)
  .strict()
  .superRefine((codebook, context) => {
    validateCodebookIdentity(codebook, context);
  });
export type StoredSeedCodebook = z.infer<typeof storedSeedCodebookSchema>;

const codebookFailureCodeSchema = z.enum([
  "timeout",
  "rate_limited",
  "transport",
  "invalid_response",
  "provider_failure",
  "no_verified_entries",
]);

/**
 * One per Scope seed materialization. `generated` carries the procedure's
 * model calls; `reused` names the run that generated it. Either way the
 * codebook is recorded in full.
 */
export const scopeSeedCodebookSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("generated"),
      ...storedCodebookFields,
      executions: z.array(modelExecutionSchema).min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("reused"),
      ...storedCodebookFields,
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      seedId: stableIdentifierSchema,
      procedureVersion: z.string().min(1),
      seedTextHash: sha256DigestSchema,
      failure: z
        .object({ code: codebookFailureCodeSchema, reason: z.string().min(1) })
        .strict(),
      executions: z.array(modelExecutionSchema),
    })
    .strict(),
  z
    .object({
      status: z.literal("seed_text_unavailable"),
      seedId: stableIdentifierSchema,
      reason: z.string().min(1),
    })
    .strict(),
]);
export type ScopeSeedCodebook = z.infer<typeof scopeSeedCodebookSchema>;
export type UsableScopeSeedCodebook = Extract<
  ScopeSeedCodebook,
  { status: "generated" | "reused" }
>;

export function isUsableCodebook(
  codebook: ScopeSeedCodebook,
): codebook is UsableScopeSeedCodebook {
  return codebook.status === "generated" || codebook.status === "reused";
}

function validateCodebookIdentity(
  codebook: {
    seedId: string;
    codebookId: string;
    procedureVersion: string;
    seedTextHash: string;
    themes: CodebookTheme[];
    entries: CodebookEntry[];
  },
  context: z.RefinementCtx,
): void {
  if (
    codebook.codebookId !==
    buildSeedCodebookId({
      seedId: codebook.seedId,
      seedTextHash: codebook.seedTextHash,
      procedureVersion: codebook.procedureVersion,
      content: { themes: codebook.themes, entries: codebook.entries },
    })
  ) {
    addIssue(
      context,
      ["codebookId"],
      "codebookId does not match the seed, seed text, procedure, and content",
    );
  }
}

/**
 * What a citing claim is about, per the seed codebook. Topic decides, not
 * accuracy: a claim that misstates an entry is still tagged with it. A tag is
 * never a verdict.
 */
export const claimTagKindSchema = z.enum(["specific", "theme_only", "none"]);
export type ClaimTagKind = z.infer<typeof claimTagKindSchema>;

export const scopeClaimTagSchema = z.discriminatedUnion("status", [
  z
    .object({
      claimRecordId: stableIdentifierSchema,
      seedId: stableIdentifierSchema,
      status: z.literal("tagged"),
      kind: claimTagKindSchema,
      /**
       * Sorted ids: 1 to 3 entries for `specific`, one theme for
       * `theme_only`, none for `none`.
       */
      tags: z.array(z.string().min(1)).max(3),
      reason: z.string().min(1),
      execution: modelExecutionSchema,
    })
    .strict()
    .superRefine((tag, context) => {
      const valid =
        tag.kind === "specific"
          ? tag.tags.length >= 1 &&
            tag.tags.every((id) => codebookEntryIdSchema.safeParse(id).success)
          : tag.kind === "theme_only"
            ? tag.tags.length === 1 &&
              codebookThemeIdSchema.safeParse(tag.tags[0]).success
            : tag.tags.length === 0;
      if (!valid) {
        addIssue(context, ["tags"], `Tags do not fit kind ${tag.kind}`);
      }
    }),
  z
    .object({
      claimRecordId: stableIdentifierSchema,
      seedId: stableIdentifierSchema,
      status: z.literal("tagging_failed"),
      failure: z
        .object({
          code: z.enum([
            "timeout",
            "rate_limited",
            "transport",
            "invalid_response",
            "provider_failure",
          ]),
          reason: z.string().min(1),
        })
        .strict(),
      execution: modelExecutionSchema,
    })
    .strict(),
  z
    .object({
      claimRecordId: stableIdentifierSchema,
      seedId: stableIdentifierSchema,
      status: z.literal("not_tagged"),
      reason: z.literal("codebook_unavailable"),
    })
    .strict(),
]);
export type ScopeClaimTag = z.infer<typeof scopeClaimTagSchema>;
