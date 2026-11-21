import { z } from "zod";
import { hasQuotedWording } from "./grade-evidence.js";
import { VERDICT_DEFINITIONS } from "./rubric.js";
import { fidelityVerdictSchema } from "./taxonomy.js";

/** History distinguishes faithful wording used as a premise for a wider claim. */
export const citationUseVerdictSchema = z.enum([
  ...fidelityVerdictSchema.options,
  "B",
]);

export const citationUseRubric = `Choose one citation-use verdict: F, B, D, E, or U.
${Object.entries(VERDICT_DEFINITIONS)
  .map(([code, { name, definition }]) => `${code} (${name}): ${definition}`)
  .join("\n")}
B (faithful at the marker, used to support a broader claim): the proposition credited to the reference faithfully represents its source, and the citing authors use that proposition as a premise for their own materially wider conclusion. B is a distinct citation-use verdict.

First identify the smallest complete proposition actually credited to the designated marker. Quote its exact contiguous wording, preserving qualifications, the predicate, and citation punctuation inside the span. Include shared wording essential to interpreting coordinated clauses. A citation can follow or interrupt its clause. Its position alone cannot decide where the attribution ends. A reference in a bundle may support a bounded component when the writing assigns that component to it. Do not invent a narrower attributed statement by picking only the words the source supports.

Judge the attributed proposition against the cited source. If the attributed words themselves broaden the population, exposure, outcome or strength, give D when the core is supported, even if the authors also draw a wider conclusion. Give E for a fundamentally unsupported attribution. If the proposition is faithful, use B only when a distinct exact passage in the marker-bearing paragraph states a materially wider conclusion and the writing connects the evidence to it. The conclusion can be in the same sentence, earlier or later. Quote it separately and explain the connection and what broadened. Another topic in the paragraph, a mere restatement, or a separate claim supported solely by another reference is insufficient. Use F for a faithful attribution without such an evidenced broader use. Use U when the available text leaves materially different readings of the attribution or use unresolved. For every verdict, give the exact attributed span and supporting source wording. Do not assess the clinical or scientific truth of the authors' own conclusion.`;

/** Paragraph-local UTF-16 offsets, in the same coordinate system as the marker. */
export function locateBroaderClaim(
  verdict: string | null,
  attributed: string,
  broader: string | null | undefined,
  paragraph: string,
) {
  if (verdict !== "B") return broader == null ? null : undefined;
  if (
    !broader?.trim() ||
    !hasQuotedWording(broader) ||
    attributed.includes(broader) ||
    broader.includes(attributed)
  )
    return undefined;
  const start = paragraph.indexOf(broader);
  if (start < 0 || start !== paragraph.lastIndexOf(broader)) return undefined;
  return { text: broader, start, end: start + broader.length };
}
