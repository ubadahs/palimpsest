/** Scope prompts for finding inventory, family grounding, and statement relationships. */

import { PROMPT_VERSIONS } from "../../config/prompt-versions.js";
import type {
  ScopeCitationStatement,
  ScopeSeedFinding,
} from "../../contract/artifacts/scope-statements.js";
import { MAX_SEED_FINDINGS } from "./statements.js";

export const GROUNDING_PROMPT_ID = "scope-grounding" as const;
export const GROUNDING_PROMPT_VERSION = PROMPT_VERSIONS.grounding;
export const INVENTORY_PROMPT_ID = "scope-seed-inventory" as const;
export const INVENTORY_PROMPT_VERSION = PROMPT_VERSIONS.seedInventory;
export const MATCHING_PROMPT_ID = "scope-statement-matching" as const;
export const MATCHING_PROMPT_VERSION = PROMPT_VERSIONS.seedStatementMatching;

type SeedTextInput = {
  seedTitle: string;
  blocks: Array<{
    blockId: string;
    text: string;
    sectionTitle?: string | undefined;
    blockKind: string;
    sectionRole?: string | undefined;
    citationMentionCount?: number | undefined;
  }>;
};

/** The inventory and family grounding calls use the same cached paper text. */
function buildSeedTextPrefix(input: SeedTextInput): string {
  const blockText = input.blocks
    .map((block) => {
      const tags = [
        block.blockKind,
        block.sectionTitle && `section="${block.sectionTitle}"`,
        block.sectionRole && `role=${block.sectionRole}`,
        block.citationMentionCount !== undefined &&
          `references=${block.citationMentionCount}`,
      ]
        .filter(Boolean)
        .join(" ");
      return `### blockId=${block.blockId} (${tags})\n${block.text}`;
    })
    .join("\n\n");

  return `You are assisting a metascience project that audits citation fidelity.
Use the cited paper's immutable text below as evidence. Quotes must be exact contiguous substrings of the referenced block.

## Cited paper

Title: ${input.seedTitle}

## Seed-text blocks

${blockText}

`;
}

export function buildScopeGroundingPrompt(
  input: SeedTextInput & { claim: string },
) {
  return {
    prefix: buildSeedTextPrefix(input),
    suffix: `Ground the claim below against the text of the cited paper.

## Claim

"${input.claim}"

## Response format

Respond with JSON (no markdown fences):
{
  "status": "grounded" | "ambiguous" | "not_found",
  "detailReason": "string",
  "supportSpans": [ { "verbatimQuote": "exact substring", "blockId": "block id from above" } ]
}
Rules:
- grounded/ambiguous require at least one supportSpan with an exact quote and correct blockId
- not_found must use an empty supportSpans array
- never invent blockIds`,
  };
}

export function buildScopeInventoryPrompt(input: SeedTextInput) {
  return {
    prefix: buildSeedTextPrefix(input),
    suffix: `Build a compact inventory of the cited paper's own central findings. Use only the paper above and work independently of how anybody else cites it.

- Select up to ${MAX_SEED_FINDINGS} key findings. Give each a single, specific statement with the relevant population, model, intervention or method, measurement, outcome, direction, and uncertainty where applicable. Keep distinct experiments, conditions, and outcomes separate when combining them would obscure their scope.
- Include empirical or theoretical results, methods established or evaluated by the authors, and estimates or comparisons the authors derive from stated premises. A worked estimate may be an original contribution even in an introduction, editorial, or review, even if its inputs cite other sources, and even without new measurements. Trace which part the authors calculated or inferred and which inputs they credited elsewhere. An unexplained number, a description of prior work, general background, opinion, and a proposal for future work do not qualify.
- For each proposed finding, explain why the text shows the cited paper established it. Evidence may come from more than one block. For a derived quantity, quote its value or comparison together with the passage giving its derivation or inputs. Preserve the stated scope and precision. Distinguish distinct citation markers within a paragraph and attach each to the proposition it supports.
- When the paper has no independently established findings or the available text does not give exact support, return an empty findings array and explain why. Never complete missing evidence from general knowledge.
- PDF conversion can flatten raised digits into a single number. Use a stated computation or an unambiguous local context to interpret such notation. Leave ambiguous quantities unresolved. Copy evidence exactly as supplied, including any flattened notation.

Return JSON with a short inventory reason and findings. Each finding has statement, ownershipReason, and supportSpans. Each support span has the blockId and its exact verbatimQuote.`,
  };
}

export function buildScopeStatementMatchingPrompt(input: {
  findings: ScopeSeedFinding[];
  statements: ScopeCitationStatement[];
}) {
  const findingJson = JSON.stringify(
    input.findings.map((finding) => ({
      findingId: finding.findingId,
      statement: finding.statement,
      evidence: finding.evidenceSpans.map(({ text }) => text),
    })),
    null,
    2,
  );
  const statementJson = JSON.stringify(
    input.statements.map((statement) => ({
      statementId: statement.statementId,
      exactWording: statement.textSpan?.text,
      extractedClaim: statement.extractedClaimText,
      marker: statement.citationMarker,
      credit: statement.credit,
    })),
    null,
    2,
  );

  return {
    prefix: `Relate each citing paper's local, exact wording to specific grounded findings of the paper it cites. Compare only the supplied inventory, which may omit other findings from the paper. The exact wording is authoritative. The extracted claim only identifies which proposition to consider when the wording contains several. Assess only that proposition. A shared reference group gives the cited paper credit as a group member without assigning the claim uniquely to it.

Compare experimentally and logically important qualifiers such as source, species or population, model, intervention, comparator, site, scale, dose or age, endpoint, direction, and quantifier. Use the exact evidence for each finding. Shared topic, method, model, or output is insufficient by itself, especially where two papers performed separate studies.

Classify each relationship:
- full: The citing wording carries the specific finding with its material scope intact. Paraphrase is allowed.
- partial: The citing wording carries an identifiable subset of the result. It leaves out a component without asserting a materially different or broader conclusion. Record what is carried and what is omitted.
- scope_changed: The citing wording still refers to a specific finding but changes or broadens a material condition, source, direction, or conclusion. Record what remains and what changed.
- distinct: The wording gives citation credit for a substantively different proposition, technique, result, or background. Leave findingIds, retained, and changes empty.
- uncertain: Wording, attribution, or comparison is insufficient to resolve the relationship. Include only plausible, specific finding IDs if available. State what prevents resolution.

Return exactly one assessment per supplied statementId with relationship, findingIds, retained, changes, and reason. Use only IDs from the supplied findings. In retained, give verbatim contiguous phrases from exactWording that carry the relevant aspects of the finding. A full, partial, or scope_changed relationship requires at least one retained phrase. In changes, describe any changes or omissions. Partial and scope_changed require at least one change or omission. Do not fill either array with guesses. This comparison is independent of any citation-fidelity verdict.

## Grounded findings

${findingJson}

`,
    suffix: `## Citation statements\n\n${statementJson}`,
  };
}
