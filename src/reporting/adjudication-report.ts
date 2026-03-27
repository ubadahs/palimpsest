import type {
  AdjudicationRecord,
  CalibrationSet,
  EvaluationMode,
} from "../domain/types.js";
import { truncate } from "./report-utils.js";

export function toCalibrationJson(set: CalibrationSet): string {
  return JSON.stringify(set, null, 2);
}

function roleTag(role: string): string {
  const tags: Record<string, string> = {
    substantive_attribution: "[ATTR]",
    background_context: "[BG]",
    methods_materials: "[METH]",
    acknowledgment_or_low_information: "[LOW]",
    unclear: "[?]",
  };
  return tags[role] ?? "[?]";
}

function renderRecord(r: AdjudicationRecord, index: number): string {
  const bundled = r.modifiers.isBundled ? " · bundled" : "";
  const review = r.modifiers.isReviewMediated ? " · review-mediated" : "";
  const verdictLine = r.verdict
    ? `**Verdict:** ${r.verdict}`
    : "**Verdict:** _________________";
  const rationaleLine = r.rationale
    ? `**Rationale:** ${r.rationale}`
    : "**Rationale:** _________________";
  const retrievalLine = r.retrievalQuality
    ? `**Retrieval quality:** ${r.retrievalQuality}`
    : "**Retrieval quality:** high / medium / low";
  const confidenceLine = r.judgeConfidence
    ? `**Judge confidence:** ${r.judgeConfidence}`
    : "**Judge confidence:** high / medium / low";

  const lines: string[] = [
    `### ${String(index + 1)}. ${truncate(r.citingPaperTitle, 70)}`,
    "",
    `**Role:** ${roleTag(r.citationRole)} ${r.citationRole}${bundled}${review}`,
    `**Eval mode:** ${r.evaluationMode}`,
    `**Task ID:** \`${r.taskId}\``,
    "",
    `**Rubric:** ${r.rubricQuestion}`,
    "",
    "**Citing context:**",
    "",
    `> ${truncate(r.citingSpan, 500)}`,
    "",
  ];

  if (r.citingSpanSection) {
    lines.push(`**Section:** ${r.citingSpanSection}`);
  }
  lines.push(`**Marker:** \`${truncate(r.citingMarker, 60)}\``);

  if (r.evidenceSpans.length > 0) {
    lines.push(
      "",
      `**Evidence from cited paper (${String(r.evidenceSpans.length)} spans):**`,
      "",
    );
    for (let i = 0; i < Math.min(r.evidenceSpans.length, 3); i++) {
      const span = r.evidenceSpans[i]!;
      lines.push(
        `${String(i + 1)}. [${span.matchMethod}, score ${String(span.relevanceScore)}]`,
        "",
        `> ${truncate(span.text, 400)}`,
        "",
      );
    }
  } else {
    lines.push("", `**Evidence:** ${r.evidenceRetrievalStatus}`, "");
  }

  lines.push(
    "---",
    "",
    "**Verdicts:** supported / partially_supported / overstated_or_generalized / not_supported / cannot_determine",
    "",
    verdictLine,
    rationaleLine,
    retrievalLine,
    confidenceLine,
    "",
  );

  return lines.join("\n");
}

function renderSummaryTable(records: AdjudicationRecord[]): string {
  const byMode: Partial<Record<EvaluationMode, number>> = {};
  for (const r of records) {
    const count = byMode[r.evaluationMode] ?? 0;
    byMode[r.evaluationMode] = count + 1;
  }

  const lines = ["| Mode | Count |", "| --- | --- |"];
  for (const [mode, count] of Object.entries(byMode)) {
    lines.push(`| ${mode} | ${String(count)} |`);
  }
  lines.push(`| **Total** | **${String(records.length)}** |`);

  return lines.join("\n");
}

export function toCalibrationMarkdown(set: CalibrationSet): string {
  const sections: string[] = [
    "# Adjudication Calibration Worksheet",
    "",
    `## Seed: ${set.resolvedSeedPaperTitle}`,
    `**Tracked claim:** ${set.seed.trackedClaim}`,
    `**Study mode:** ${set.studyMode}`,
    `**Created:** ${set.createdAt}`,
    `**Target size:** ${String(set.targetSize)} · **Actual:** ${String(set.records.length)}`,
    "",
    "> Fill in the verdict, rationale, retrieval quality, and judge confidence for each task.",
    "> Use the JSON companion file (`calibration-set.json`) for machine-readable results.",
    "",
    "## Sampling Summary",
    "",
    renderSummaryTable(set.records),
    "",
  ];

  if (set.samplingStrategy.oversampled.length > 0) {
    sections.push(
      `**Oversampled categories:** ${set.samplingStrategy.oversampled.join(", ")}`,
      "",
    );
  }

  sections.push("## Tasks", "");

  for (let i = 0; i < set.records.length; i++) {
    sections.push(renderRecord(set.records[i]!, i));
  }

  return sections.join("\n");
}
