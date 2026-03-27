import type {
  EvaluationMode,
  FamilyEvidenceResult,
  TaskWithEvidence,
} from "../domain/types.js";
import { truncate } from "./report-utils.js";

export function toEvidenceJson(result: FamilyEvidenceResult): string {
  return JSON.stringify(result, null, 2);
}

function renderTaskWithEvidence(
  task: TaskWithEvidence,
  edgeTitle: string,
): string {
  const bundled = task.modifiers.isBundled ? " · bundled" : "";
  const review = task.modifiers.isReviewMediated ? " · review-mediated" : "";
  const lines: string[] = [
    `### ${truncate(edgeTitle, 70)} — ${task.citationRole}${bundled}${review}`,
    "",
    `**Eval mode:** ${task.evaluationMode}`,
    `**Rubric:** ${task.rubricQuestion}`,
    `**Evidence status:** ${task.evidenceRetrievalStatus}`,
    `**Mentions:** ${String(task.mentionCount)}`,
  ];

  if (task.mentions.length > 0) {
    const best = task.mentions[0]!;
    lines.push(
      "",
      "**Citing context:**",
      "",
      `> ${truncate(best.rawContext, 400)}`,
    );
  }

  if (task.citedPaperEvidenceSpans.length > 0) {
    lines.push(
      "",
      `**Retrieved evidence spans (${String(task.citedPaperEvidenceSpans.length)}):**`,
      "",
    );
    for (let i = 0; i < task.citedPaperEvidenceSpans.length; i++) {
      const span = task.citedPaperEvidenceSpans[i]!;
      const section = span.sectionTitle ? ` (${span.sectionTitle})` : "";
      lines.push(
        `${String(i + 1)}. [${span.matchMethod}, score ${String(span.relevanceScore)}]${section}`,
        "",
        `> ${truncate(span.text, 350)}`,
        "",
      );
    }
  }

  return lines.join("\n");
}

export function toEvidenceMarkdown(result: FamilyEvidenceResult): string {
  const { summary } = result;

  const sections: string[] = [
    "# Evidence Retrieval Report",
    "",
    `## Seed: ${result.resolvedSeedPaperTitle}`,
    `**Tracked claim:** ${result.seed.trackedClaim}`,
    `**Study mode:** ${result.studyMode}`,
    `**Cited paper full text:** ${result.citedPaperFullTextAvailable ? "available" : "not available"}`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Total tasks | ${String(summary.totalTasks)} |`,
    `| Tasks with evidence | ${String(summary.tasksWithEvidence)} |`,
    `| Tasks no matches | ${String(summary.tasksNoMatches)} |`,
    `| Tasks no full text | ${String(summary.tasksNoFulltext)} |`,
    `| Total evidence spans | ${String(summary.totalEvidenceSpans)} |`,
  ];

  if (Object.keys(summary.tasksByMode).length > 0) {
    sections.push(
      "",
      "### Tasks by evaluation mode",
      "",
      "| Mode | Count |",
      "| --- | --- |",
    );
    for (const [mode, count] of Object.entries(summary.tasksByMode) as [
      EvaluationMode,
      number,
    ][]) {
      sections.push(`| ${mode} | ${String(count)} |`);
    }
  }

  sections.push("", "## Tasks with Evidence", "");

  const withEvidence = result.edges
    .flatMap((e) => e.tasks.map((t) => ({ edge: e, task: t })))
    .filter((x) => x.task.citedPaperEvidenceSpans.length > 0);

  if (withEvidence.length === 0) {
    sections.push("No tasks retrieved evidence spans.");
  } else {
    for (const { edge, task } of withEvidence) {
      sections.push(
        renderTaskWithEvidence(task, edge.citingPaperTitle),
        "---",
        "",
      );
    }
  }

  const noMatches = result.edges
    .flatMap((e) => e.tasks.map((t) => ({ edge: e, task: t })))
    .filter((x) => x.task.evidenceRetrievalStatus === "no_matches");

  if (noMatches.length > 0) {
    sections.push(
      "",
      `## Tasks Without Matching Evidence (${String(noMatches.length)})`,
      "",
      "| Paper | Role | Mode | Mentions |",
      "| --- | --- | --- | --- |",
    );
    for (const { edge, task } of noMatches) {
      sections.push(
        `| ${truncate(edge.citingPaperTitle, 45)} | ${task.citationRole} | ${task.evaluationMode} | ${String(task.mentionCount)} |`,
      );
    }
  }

  return sections.join("\n");
}
