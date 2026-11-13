/**
 * The seed codebook procedure and codebook tagging, without any provider.
 *
 * A codebook is built by three model calls that share the seed text as a
 * cached prompt prefix: list the seed's results and headline, list what it
 * relays from prior work and the methods and resources it can be cited for,
 * then organise both lists into themes and entries and deduplicate. Every
 * quote is exact-verified against the seed-text blocks; an entry with no
 * verified quote is dropped and counted.
 *
 * Tagging asks, one claim per request with the codebook as the shared prefix,
 * which entries a citing claim is about. Callers inject the model call, so
 * this module is the whole procedure and is tested with mocked replies.
 */
import { z } from "zod";

import {
  SEED_CODEBOOK_PROCEDURE_VERSION,
  buildSeedCodebookId,
  codebookEntryTypeSchema,
  type ClaimTagKind,
  type CodebookEntry,
  type CodebookQuote,
  type CodebookTheme,
  type CodebookVerification,
  type ScopeSeedCodebook,
  type SeedCodebookContent,
  type StoredSeedCodebook,
} from "../../contract/artifacts/codebook.js";
import type { Result } from "../../domain/common.js";
import type {
  SeedCodebookKey,
  SeedCodebookStore,
} from "../../storage/seed-codebooks.js";

export type CodebookSeedBlock = {
  blockId: string;
  text: string;
  sectionTitle?: string | undefined;
  charOffsetStart: number;
};

// ---------------------------------------------------------------------------
// Model reply schemas
// ---------------------------------------------------------------------------

const draftItemSchema = z
  .object({
    statement: z.string().min(1),
    attributedToOtherWork: z.boolean(),
    quotes: z.array(z.string()),
  })
  .strict();

const organiseThemeSchema = z
  .object({
    id: z.string().min(1),
    statement: z.string().min(1),
    isHeadline: z.boolean(),
    quotes: z.array(z.string()),
  })
  .strict();

const organiseEntrySchema = z
  .object({
    id: z.string().min(1),
    parent: z.string().min(1),
    statement: z.string().min(1),
    type: codebookEntryTypeSchema,
    attributedToOtherWork: z.boolean(),
    quotes: z.array(z.string()),
  })
  .strict();

/**
 * One reply shape for all three steps. The response schema travels with the
 * request ahead of the prompt, so three different schemas would break the
 * shared seed-text prefix into three cache writes; with one schema the second
 * and third calls read the cache the first wrote. Each step fills only its
 * own arrays and leaves the others empty.
 */
const codebookStepReplySchema = z
  .object({
    headline: z.array(draftItemSchema),
    results: z.array(draftItemSchema),
    background: z.array(draftItemSchema),
    methods: z.array(draftItemSchema),
    themes: z.array(organiseThemeSchema),
    entries: z.array(organiseEntrySchema),
  })
  .strict();
type CodebookStepReply = z.infer<typeof codebookStepReplySchema>;

export type CodebookOrganiseReply = Pick<
  CodebookStepReply,
  "themes" | "entries"
>;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export type CodebookStep = "draft_results" | "draft_background" | "organise";

/** The seed text, shared and cached across all three codebook calls. */
function buildCodebookPromptPrefix(input: {
  seedTitle: string;
  blocks: readonly CodebookSeedBlock[];
}): string {
  const paper = input.blocks
    .map(
      (block) =>
        `[${block.blockId}${block.sectionTitle ? ` | ${block.sectionTitle}` : ""}]\n${block.text}`,
    )
    .join("\n\n");
  return `Below is the full text of a scientific paper (the "seed paper"), in blocks labelled [block id | section]. Later papers cite it. You will help build a codebook of everything a later paper could cite it for.

Quote rule for every task: a quote MUST be copied character-for-character from the paper text (an exact substring, including punctuation, symbols and capitalization), a sentence or part of one, inside a single block. Never include the [block id] labels.

Title: ${input.seedTitle}

${paper}

---
`;
}

const DRAFT_RESULTS_TASK = `TASK (fill only "headline" and "results"; leave every other array empty): List (a) the paper's headline claim(s): its overall take-home message, one or two items; and (b) every specific result the paper reports from its own data, each with its interpretation folded in (a result and the conclusion the paper draws from it are ONE item). Include interpretations, models and speculations from the discussion as items only when they are not a restatement of the headline or of a result. Each item: one short plain sentence, attributedToOtherWork=false unless the paper presents it as others' finding, and 1-3 quotes.`;

const DRAFT_BACKGROUND_TASK = `TASK (fill only "background" and "methods"; leave every other array empty): List (a) background statements the paper relays from prior work, mainly in the introduction and discussion: each distinct factual statement the paper makes while citing other work, which a later paper might cite this paper for (attributedToOtherWork=true). Be exhaustive: go through the introduction and discussion paragraph by paragraph; one item per distinct statement. (b) methods, techniques, reagents, cell or animal lines, datasets and resources the paper used, generated or made available, that a later paper could cite it for (attributedToOtherWork=true for ones made by others, false for ones the paper generated). Do NOT list the paper's own results here. Each item: one short plain sentence and 1-3 quotes.`;

function buildCodebookOrganiseTask(drafts: {
  headline: unknown[];
  results: unknown[];
  background: unknown[];
  methods: unknown[];
}): string {
  return `TASK (fill only "themes" and "entries"; leave every other array empty): Organise the candidate items below (drafted from the paper above) into a two-level codebook and deduplicate.

Top level: a few themes (about 4 to 8), ids T1, T2, .... Exactly one theme is the headline (isHeadline=true), and its statement is the paper's main claim. The other themes group what is NOT part of the main claim by subject: secondary results, background relayed from prior work, methods and resources.
Second level: specific entries, ids E01, E02, ..., each with exactly one parent theme id.

Rules:
- The headline theme is never empty. The specific entries that make up the main claim (the steps of its central mechanism or result chain) go under the headline theme. A general restatement of the main claim and its specific parts must belong to the same theme.
- A result and its own interpretation are ONE entry.
- A restatement of the headline (in the abstract, the discussion or a summary figure) is NOT a new entry: it is the headline theme itself.
- Merge near-duplicates. Before answering, compare every pair of entries, across themes as well as within one. If a citing claim could fit both equally well, or one restates the other in other words or at a slightly different level of detail, merge them into one entry and keep the quotes of both.
- Keep genuinely distinct statements distinct; do not merge unrelated background facts into one entry.
- Every entry has exactly one parent theme. Every entry keeps at least one quote, copied exactly from the candidate items' quotes or from the paper. Give every theme a quote too.
- type for entries: result (the paper's own findings, with the conclusions it draws from them), background_prior_work (statements the paper relays from earlier work), method_or_resource (methods, reagents, lines, datasets and resources).
- attributedToOtherWork: true when the paper presents the statement as established by other work.

Candidate items (JSON):
${JSON.stringify(drafts, null, 1)}`;
}

// ---------------------------------------------------------------------------
// Procedure
// ---------------------------------------------------------------------------

/**
 * One codebook model call. The prefix is identical for all three steps of a
 * seed, so the first call writes the provider cache and the others read it.
 */
export type CodebookModelCall = (input: {
  step: CodebookStep;
  promptPrefix: string;
  promptSuffix: string;
  schema: typeof codebookStepReplySchema;
}) => Promise<CodebookStepReply>;

export type CodebookProcedureOutput = {
  content: SeedCodebookContent;
  verification: CodebookVerification;
};

/**
 * Runs the three calls in order (each waits for the one before, so the
 * second and third read the cache the first wrote) and verifies the result.
 * A provider failure propagates; a codebook with no verified entry is a
 * typed failure.
 */
export async function runSeedCodebookProcedure(input: {
  seedTitle: string;
  blocks: readonly CodebookSeedBlock[];
  call: CodebookModelCall;
}): Promise<Result<CodebookProcedureOutput>> {
  const promptPrefix = buildCodebookPromptPrefix(input);
  const drafted = await input.call({
    step: "draft_results",
    promptPrefix,
    promptSuffix: DRAFT_RESULTS_TASK,
    schema: codebookStepReplySchema,
  });
  const relayed = await input.call({
    step: "draft_background",
    promptPrefix,
    promptSuffix: DRAFT_BACKGROUND_TASK,
    schema: codebookStepReplySchema,
  });
  const organised = await input.call({
    step: "organise",
    promptPrefix,
    promptSuffix: buildCodebookOrganiseTask({
      headline: drafted.headline,
      results: drafted.results,
      background: relayed.background,
      methods: relayed.methods,
    }),
    schema: codebookStepReplySchema,
  });
  return verifyCodebookReply(organised, input.blocks);
}

/**
 * Exact-verifies every quote against a single seed-text block, drops entries
 * with no verified quote, drops themes left with neither a quote nor an
 * entry, and renumbers what is left (themes in reply order, entries grouped
 * by theme) so ids are dense and stable for a given reply.
 */
export function verifyCodebookReply(
  reply: CodebookOrganiseReply,
  blocks: readonly CodebookSeedBlock[],
): Result<CodebookProcedureOutput> {
  let quotesProposed = 0;
  let quotesVerified = 0;
  const verify = (quotes: readonly string[]): CodebookQuote[] => {
    const verified: CodebookQuote[] = [];
    const seen = new Set<string>();
    for (const quote of quotes) {
      quotesProposed += 1;
      const located = locateQuote(quote, blocks);
      if (!located) continue;
      quotesVerified += 1;
      const key = `${located.blockId}\u0000${String(located.charOffsetStart)}\u0000${located.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      verified.push(located);
    }
    return verified;
  };

  const themes = reply.themes.map((theme) => ({
    replyId: theme.id.trim(),
    statement: theme.statement.trim(),
    isHeadline: theme.isHeadline,
    quotes: verify(theme.quotes),
  }));
  const themeReplyIds = new Set(themes.map((theme) => theme.replyId));
  let entriesDropped = 0;
  let entriesOrphaned = 0;
  const entries: Array<
    Omit<CodebookEntry, "entryId" | "themeId"> & {
      parent: string;
    }
  > = [];
  for (const entry of reply.entries) {
    const quotes = verify(entry.quotes);
    if (quotes.length === 0) {
      entriesDropped += 1;
      continue;
    }
    const parent = entry.parent.trim();
    if (!themeReplyIds.has(parent)) {
      entriesOrphaned += 1;
      continue;
    }
    entries.push({
      parent,
      statement: entry.statement.trim(),
      type: entry.type,
      attributedToOtherWork: entry.attributedToOtherWork,
      quotes,
    });
  }

  const parentsWithEntries = new Set(entries.map((entry) => entry.parent));
  const seenThemeIds = new Set<string>();
  const keptThemes = themes.filter((theme) => {
    // A duplicate theme id cannot be told apart from the first; drop it.
    if (seenThemeIds.has(theme.replyId)) return false;
    seenThemeIds.add(theme.replyId);
    return theme.quotes.length > 0 || parentsWithEntries.has(theme.replyId);
  });
  const themesDropped = themes.length - keptThemes.length;

  const finalThemes: CodebookTheme[] = keptThemes.map((theme, index) => ({
    themeId: `T${String(index + 1)}`,
    statement: theme.statement,
    isHeadline: theme.isHeadline,
    quotes: theme.quotes,
  }));
  const themeIdByReplyId = new Map(
    keptThemes.map((theme, index) => [theme.replyId, finalThemes[index]!]),
  );
  const finalEntries: CodebookEntry[] = [];
  for (const theme of keptThemes) {
    const finalTheme = themeIdByReplyId.get(theme.replyId)!;
    for (const entry of entries) {
      if (entry.parent !== theme.replyId) continue;
      finalEntries.push({
        entryId: `E${String(finalEntries.length + 1).padStart(2, "0")}`,
        themeId: finalTheme.themeId,
        statement: entry.statement,
        type: entry.type,
        attributedToOtherWork: entry.attributedToOtherWork,
        quotes: entry.quotes,
      });
    }
  }

  if (finalEntries.length === 0 || finalThemes.length === 0) {
    return {
      ok: false,
      error: `No codebook entry kept a verified quote (${String(quotesVerified)} of ${String(quotesProposed)} quotes verified).`,
    };
  }

  return {
    ok: true,
    data: {
      content: { themes: finalThemes, entries: finalEntries },
      verification: {
        proposedThemes: reply.themes.length,
        proposedEntries: reply.entries.length,
        quotesProposed,
        quotesVerified,
        entriesDropped,
        entriesOrphaned,
        themesDropped,
      },
    },
  };
}

/** First block, in document order, that holds the quote exactly. */
function locateQuote(
  quote: string,
  blocks: readonly CodebookSeedBlock[],
): CodebookQuote | undefined {
  const candidates = quote === quote.trim() ? [quote] : [quote, quote.trim()];
  for (const text of candidates) {
    if (text.length === 0) continue;
    for (const block of blocks) {
      const start = block.text.indexOf(text);
      if (start < 0) continue;
      return {
        blockId: block.blockId,
        text,
        charOffsetStart: block.charOffsetStart + start,
        charOffsetEnd: block.charOffsetStart + start + text.length,
      };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Store and reuse
// ---------------------------------------------------------------------------

export type GeneratedCodebookOutcome =
  | {
      status: "generated";
      output: CodebookProcedureOutput;
      model: string;
      executions: Extract<
        ScopeSeedCodebook,
        { status: "generated" }
      >["executions"];
    }
  | Extract<ScopeSeedCodebook, { status: "failed" }>;

/**
 * Reuses the stored codebook for this exact key unless `regenerate` is set;
 * otherwise generates one and stores it. `--force-refresh` deliberately has
 * no say here: refreshing papers is a different intent from regrouping every
 * claim, which only `--regenerate-codebook` asks for.
 */
export async function resolveSeedCodebook(input: {
  store: SeedCodebookStore | undefined;
  key: SeedCodebookKey;
  regenerate: boolean;
  generatedAt: string;
  runId?: string | undefined;
  generate: () => Promise<GeneratedCodebookOutcome>;
}): Promise<ScopeSeedCodebook> {
  if (!input.regenerate) {
    const stored = input.store?.get(input.key);
    if (stored) return { status: "reused", ...stored };
  }
  const outcome = await input.generate();
  if (outcome.status === "failed") return outcome;
  const stored: StoredSeedCodebook = {
    seedId: input.key.seedId,
    codebookId: buildSeedCodebookId({
      seedId: input.key.seedId,
      seedTextHash: input.key.seedTextHash,
      procedureVersion: input.key.procedureVersion,
      content: outcome.output.content,
    }),
    procedureVersion: input.key.procedureVersion,
    seedTextHash: input.key.seedTextHash,
    model: outcome.model,
    generatedAt: input.generatedAt,
    ...(input.runId != null ? { generatedInRunId: input.runId } : {}),
    verification: outcome.output.verification,
    themes: outcome.output.content.themes,
    entries: outcome.output.content.entries,
  };
  input.store?.put(stored);
  return { status: "generated", ...stored, executions: outcome.executions };
}

export { SEED_CODEBOOK_PROCEDURE_VERSION };

// ---------------------------------------------------------------------------
// Tagging
// ---------------------------------------------------------------------------

/** The codebook as the tagger sees it: themes, each followed by its entries. */
function renderCodebookForTagging(codebook: {
  themes: readonly CodebookTheme[];
  entries: readonly CodebookEntry[];
}): string {
  return codebook.themes
    .map((theme) => {
      const children = codebook.entries
        .filter((entry) => entry.themeId === theme.themeId)
        .map(
          (entry) =>
            `  ${entry.entryId} [${entry.type}${entry.attributedToOtherWork ? "; relayed from prior work" : ""}] ${entry.statement}\n      quote: "${entry.quotes[0]!.text}"`,
        )
        .join("\n");
      const quote = theme.quotes[0]
        ? `\n  quote: "${theme.quotes[0].text}"`
        : "";
      return `${theme.themeId} THEME${theme.isHeadline ? " (HEADLINE)" : ""}: ${theme.statement}${quote}${children ? `\n${children}` : ""}`;
    })
    .join("\n\n");
}

/** Shared, cached prefix for every tagging request of a seed. */
export function buildCodebookTaggingPrefix(codebook: {
  themes: readonly CodebookTheme[];
  entries: readonly CodebookEntry[];
}): string {
  return `A later paper cites a seed paper and attributes a claim to it. Tag the claim with the codebook entries it is ABOUT.

Match on topic, not accuracy. The claim may state the seed correctly, overstate it, distort it, or get it wrong: tag the entries it is talking about either way. A claim that misstates an entry is still about that entry.

Answer with one of:
- kind "specific": 1 to 3 specific entry ids (E..) the claim is about, unordered. Use more than one only when the claim really concerns several entries (e.g. it joins two findings). Do not add entries that are merely related.
- kind "theme_only": a single theme id (T..) when the claim is broader than any specific entry under that theme (e.g. it states the theme or the headline in general terms). Then entries is [].
- kind "none": no entry or theme covers the claim's topic (the codebook does not list it, or the seed never discusses it). Then entries is [] and theme is null.
Set theme to null unless kind is "theme_only". Give a one-line reason.

Codebook (themes, each followed by its specific entries):
${renderCodebookForTagging(codebook)}

`;
}

export function buildCodebookTaggingSuffix(claimText: string): string {
  return `Citing claim: "${claimText}"`;
}

const taggingReplyShape = z
  .object({
    kind: z.enum(["specific", "theme_only", "none"]),
    entries: z.array(z.string()),
    theme: z.string().nullable(),
    reason: z.string().min(1),
  })
  .strict();
export type CodebookTaggingReply = z.infer<typeof taggingReplyShape>;

/**
 * The reply schema for one codebook. Ids the codebook does not hold, more
 * than three entries, or a theme-only answer without a theme fail local
 * validation, so the reply is a typed invalid output and never enters the
 * exact-result cache.
 */
export function codebookTaggingReplySchema(codebook: {
  themes: readonly CodebookTheme[];
  entries: readonly CodebookEntry[];
}) {
  const entryIds = new Set(codebook.entries.map((entry) => entry.entryId));
  const themeIds = new Set(codebook.themes.map((theme) => theme.themeId));
  return taggingReplyShape.superRefine((reply, context) => {
    if (reply.kind === "specific") {
      const ids = new Set(reply.entries.map((id) => id.trim()));
      if (ids.size < 1 || ids.size > 3) {
        context.addIssue({
          code: "custom",
          path: ["entries"],
          message: `A specific answer names 1 to 3 entries, not ${String(ids.size)}`,
        });
      }
      for (const id of ids) {
        if (!entryIds.has(id)) {
          context.addIssue({
            code: "custom",
            path: ["entries"],
            message: `Unknown codebook entry: ${id}`,
          });
        }
      }
    } else if (reply.kind === "theme_only") {
      if (reply.theme == null || !themeIds.has(reply.theme.trim())) {
        context.addIssue({
          code: "custom",
          path: ["theme"],
          message: `Unknown codebook theme: ${String(reply.theme)}`,
        });
      }
    }
  });
}

/** The sorted tag set a valid reply stands for. */
export function normalizeTaggingReply(reply: CodebookTaggingReply): {
  kind: ClaimTagKind;
  tags: string[];
} {
  if (reply.kind === "specific") {
    return {
      kind: "specific",
      tags: [...new Set(reply.entries.map((id) => id.trim()))].sort(),
    };
  }
  if (reply.kind === "theme_only") {
    return { kind: "theme_only", tags: [reply.theme!.trim()] };
  }
  return { kind: "none", tags: [] };
}
