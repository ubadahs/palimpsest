import type {
  CitationMention,
  EdgeExtractionResult,
  ExtractionOutcome,
  FamilyExtractionResult,
} from "../domain/types.js";
import { CONFIDENCE_SORT_ORDER, truncate } from "./report-utils.js";

export function toM2Json(result: FamilyExtractionResult): string {
  return JSON.stringify(result, null, 2);
}

function renderMention(m: CitationMention): string {
  const section = m.sectionTitle ? ` (section: ${m.sectionTitle})` : "";
  const lines: string[] = [
    `#### Mention ${String(m.mentionIndex + 1)}${section}`,
    "",
    `**Marker:** \`${truncate(m.citationMarker, 80)}\``,
    `**Style:** ${m.markerStyle} · **Context:** ${m.contextType} · **Confidence:** ${m.confidence}`,
    `**Context length:** ${String(m.contextLength)} chars`,
  ];
  if (m.provenance.refId) {
    lines.push(`**Ref ID:** ${m.provenance.refId}`);
  }
  if (m.provenance.charOffsetStart != null) {
    lines.push(
      `**Offset:** ${String(m.provenance.charOffsetStart)}–${String(m.provenance.charOffsetEnd)}`,
    );
  }
  lines.push("", `> ${truncate(m.rawContext, 400)}`, "");
  return lines.join("\n");
}

function renderEdge(edge: EdgeExtractionResult): string {
  const lines: string[] = [
    `### ${edge.citingPaperTitle}`,
    "",
    `- **Outcome:** ${edge.extractionOutcome}`,
    `- **Source type:** ${edge.sourceType}`,
    `- **Extraction success:** ${String(edge.extractionSuccess)}`,
    `- **Usable for grounding:** ${String(edge.usableForGrounding)}`,
    `- **Mentions:** ${String(edge.deduplicatedMentionCount)} deduplicated (${String(edge.rawMentionCount)} raw)`,
  ];

  if (edge.failureReason) {
    lines.push(`- **Failure detail:** ${edge.failureReason}`);
  }

  if (edge.mentions.length > 0) {
    lines.push("");
    for (const m of edge.mentions) {
      lines.push(renderMention(m));
    }
  }

  return lines.join("\n");
}

function renderFailureSummary(
  counts: Partial<Record<ExtractionOutcome, number>>,
): string {
  const entries = Object.entries(counts) as [ExtractionOutcome, number][];
  if (entries.length === 0) return "None";
  return entries.map(([k, v]) => `${k}: ${String(v)}`).join(", ");
}

export function toM2Markdown(result: FamilyExtractionResult): string {
  const { seed, summary } = result;
  const title = result.resolvedSeedPaper?.title ?? seed.doi;

  const sections: string[] = [
    "# M2 Citation-Context Extraction Report",
    "",
    `## Seed: ${title}`,
    "",
    `**DOI:** ${seed.doi}`,
    `**Tracked claim:** ${seed.trackedClaim}`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Total edges | ${String(summary.totalEdges)} |`,
    `| Attempted | ${String(summary.attemptedEdges)} |`,
    `| Successful (raw) | ${String(summary.successfulEdgesRaw)} |`,
    `| Successful (usable) | ${String(summary.successfulEdgesUsable)} |`,
    `| Raw mentions | ${String(summary.rawMentionCount)} |`,
    `| Deduplicated mentions | ${String(summary.deduplicatedMentionCount)} |`,
    `| Usable mentions | ${String(summary.usableMentionCount)} |`,
    `| Failure breakdown | ${renderFailureSummary(summary.failureCountsByOutcome)} |`,
  ];

  const xmlEdges = result.edgeResults.filter(
    (e) => e.sourceType === "jats_xml",
  );
  const pdfEdges = result.edgeResults.filter(
    (e) => e.sourceType === "pdf_text",
  );
  const skipped = result.edgeResults.filter(
    (e) => e.extractionOutcome === "skipped_not_auditable",
  );

  sections.push(
    "",
    "### By source type",
    "",
    "| Source | Attempted | Successful | Usable |",
    "| --- | --- | --- | --- |",
    `| JATS XML | ${String(xmlEdges.length)} | ${String(xmlEdges.filter((e) => e.extractionSuccess).length)} | ${String(xmlEdges.filter((e) => e.usableForGrounding === true).length)} |`,
    `| PDF text | ${String(pdfEdges.length)} | ${String(pdfEdges.filter((e) => e.extractionSuccess).length)} | ${String(pdfEdges.filter((e) => e.usableForGrounding === true).length)} |`,
    `| Skipped | ${String(skipped.length)} | — | — |`,
  );

  sections.push("", "## Edges", "");

  for (const edge of result.edgeResults) {
    sections.push(renderEdge(edge), "---", "");
  }

  return sections.join("\n");
}

// --- Compact manual inspection artifact ---

export function toM2InspectionArtifact(
  result: FamilyExtractionResult,
  mentionLimit: number = 10,
  failedEdgeLimit: number = 3,
): string {
  const title = result.resolvedSeedPaper?.title ?? result.seed.doi;

  const lines: string[] = [
    "# M2 Compact Inspection Artifact",
    "",
    `## Seed: ${title}`,
    `**Tracked claim:** ${result.seed.trackedClaim}`,
    "",
    `**Summary:** ${String(result.summary.successfulEdgesUsable)} usable / ${String(result.summary.successfulEdgesRaw)} extracted / ${String(result.summary.attemptedEdges)} attempted · ${String(result.summary.deduplicatedMentionCount)} deduplicated mentions (${String(result.summary.usableMentionCount)} usable)`,
    "",
  ];

  // Collect usable deduplicated mentions across all edges
  const usableMentions: {
    edge: EdgeExtractionResult;
    mention: CitationMention;
  }[] = [];

  for (const edge of result.edgeResults) {
    if (!edge.extractionSuccess) continue;
    for (const m of edge.mentions) {
      usableMentions.push({ edge, mention: m });
    }
  }

  usableMentions.sort(
    (a, b) =>
      CONFIDENCE_SORT_ORDER[a.mention.confidence] -
      CONFIDENCE_SORT_ORDER[b.mention.confidence],
  );

  lines.push(
    `## Top ${String(Math.min(mentionLimit, usableMentions.length))} Mentions`,
    "",
  );

  for (const { edge, mention } of usableMentions.slice(0, mentionLimit)) {
    const usable =
      edge.usableForGrounding === true
        ? "usable"
        : edge.usableForGrounding === "unknown"
          ? "unknown"
          : "not usable";

    lines.push(
      `### ${truncate(edge.citingPaperTitle, 80)}`,
      "",
      `**Confidence:** ${mention.confidence} · **Context type:** ${mention.contextType} · **Grounding:** ${usable}`,
    );
    if (mention.sectionTitle) {
      lines.push(`**Section:** ${mention.sectionTitle}`);
    }
    lines.push(
      `**Marker:** \`${truncate(mention.citationMarker, 60)}\``,
      "",
      `> ${truncate(mention.rawContext, 300)}`,
      "",
    );
  }

  // Failed edges
  const failedEdges = result.edgeResults.filter(
    (e) =>
      !e.extractionSuccess && e.extractionOutcome !== "skipped_not_auditable",
  );

  if (failedEdges.length > 0) {
    lines.push(
      `## Failed Edges (${String(Math.min(failedEdgeLimit, failedEdges.length))} of ${String(failedEdges.length)})`,
      "",
      "| Paper | Outcome | Detail |",
      "| --- | --- | --- |",
    );

    for (const edge of failedEdges.slice(0, failedEdgeLimit)) {
      lines.push(
        `| ${truncate(edge.citingPaperTitle, 50)} | ${edge.extractionOutcome} | ${edge.failureReason ?? "—"} |`,
      );
    }

    lines.push("");
  }

  return lines.join("\n");
}
