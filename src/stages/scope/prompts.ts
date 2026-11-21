/** Scope prompts for finding inventory, family grounding, and statement relationships. */

import { PROMPT_VERSIONS } from "../../config/prompt-versions.js";
import type {
  ScopeCitationStatement,
  ScopeInventoryFinding,
} from "../../contract/artifacts/scope-statements.js";

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
    suffix: `Build a two-level inventory of the cited paper's own findings. Use only the paper above and work independently of how anybody else cites it.

Takeaways: state the 2–4 central claims a reader would carry away from the paper, at the scope the authors claim them. Each must rest on the paper's own results rather than assertion in the abstract or discussion. Keep the authors' hedges as part of the claim.

Results: list every distinct result that supports a takeaway or that another paper could plausibly cite on its own. Aim for completeness. Give each a single, specific statement with the relevant population, model, intervention or method, measurement, outcome, direction, and uncertainty where applicable. Keep distinct experiments, conditions, and outcomes separate when combining them would obscure their scope. Link each result to the takeaways it supports. A result may stand alone.

For every takeaway and result, list its qualifiers: the restrictions a citing paper could drop or change, such as population or model, setting, measurement method, sample size, and how strongly the authors state the claim. Copy each qualifier as an exact contiguous quote within one of that item's support spans.

Keep each qualifier at the level supported by its context. A sample size stated for images or panels in a figure caption belongs to that displayed result. Use the experiment's own reported sample size for the study or experiment.

- Include empirical or theoretical results, methods established or evaluated by the authors, and estimates or comparisons the authors derive from stated premises. A worked estimate may be an original contribution even in an introduction, editorial, or review, even if its inputs cite other sources, and even without new measurements. Trace which part the authors calculated or inferred and which inputs they credited elsewhere. An unexplained number, a description of prior work, general background, opinion, and a proposal for future work do not qualify.
- For each takeaway and result, explain why the text shows the cited paper established it. Evidence may come from more than one block. For a derived quantity, quote its value or comparison together with the passage giving its derivation or inputs. Preserve the stated scope and precision. Distinguish distinct citation markers within a paragraph and attach each to the proposition it supports.
- When the paper has no independently established findings or the available text does not give exact support, return empty takeaways and results arrays and explain why. Never complete missing evidence from general knowledge.
- PDF conversion can flatten raised digits into a single number. Use a stated computation or an unambiguous local context to interpret such notation. Leave ambiguous quantities unresolved. Copy evidence exactly as supplied, including any flattened notation.

Return JSON with a short inventoryReason, takeaways, and results. Every takeaway and result has a unique id, statement, qualifiers (exact quotes), ownershipReason, and supportSpans. Each result also has supports (takeaway IDs, or an empty array). Each support span has the blockId and its exact verbatimQuote.`,
  };
}

const inventoryMatchingRules = `Compare with the central takeaways first. Open the detailed results when the author credits a quantitative result or a specific experiment, including an assay-specific attribution. Follow the recorded links where relevant and consider standalone results too. Check every applicable quoted qualifier, including the measurement method. A paraphrase preserves the scientific reading even when it omits detail. Treat a changed or omitted qualifier as material only when the wording credits the paper with a result whose meaning, scope, or evidential strength changes. Identify the exact wording and the difference in what a reader would understand.`;

export function buildScopeStatementMatchingPrompt(input: {
  findings: ScopeInventoryFinding[];
  statements: ScopeCitationStatement[];
}) {
  const entries = input.findings.map(
    ({ findingId, statement, evidenceSpans, hierarchy }) => ({
      findingId,
      statement,
      qualifiers: hierarchy.qualifiers,
      evidence: evidenceSpans.map(({ text }) => text),
      ...(hierarchy.kind === "result" ? { supports: hierarchy.supports } : {}),
    }),
  );
  const findingJson = JSON.stringify(
    {
      takeaways: entries.filter((entry) => !("supports" in entry)),
      results: entries.filter((entry) => "supports" in entry),
    },
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

${inventoryMatchingRules} Use the exact evidence for each finding. Shared topic, method, model, or output is insufficient by itself, especially where two papers performed separate studies.

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
