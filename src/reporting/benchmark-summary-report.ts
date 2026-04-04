import type { BenchmarkSummary } from "../benchmark/types.js";

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

export function toBenchmarkSummaryMarkdown(summary: BenchmarkSummary): string {
  const sections: string[] = [
    "# Benchmark Summary",
    "",
    `Base: ${summary.basePath}`,
    "",
    "| Label | Model | Thinking | Exact | Adjacent | Verdict changes |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const entry of summary.entries) {
    sections.push(
      `| ${entry.label} | ${entry.model ?? "unknown"} | ${entry.useExtendedThinking === true ? "yes" : "no"} | ${String(entry.exactAgreement)}/${String(entry.activeRecords)} (${formatPercent(entry.exactRate)}) | ${String(entry.adjacentAgreement)}/${String(entry.activeRecords)} (${formatPercent(entry.adjacentRate)}) | ${String(entry.verdictChanges)} |`,
    );
  }

  for (const entry of summary.entries) {
    sections.push(
      "",
      `## ${entry.label}`,
      "",
      `- Candidate: ${entry.candidatePath}`,
      `- Model: ${entry.model ?? "unknown"}${entry.useExtendedThinking === true ? " (extended thinking)" : ""}`,
      `- Exact agreement: ${String(entry.exactAgreement)}/${String(entry.activeRecords)} (${formatPercent(entry.exactRate)})`,
      `- Adjacent agreement: ${String(entry.adjacentAgreement)}/${String(entry.activeRecords)} (${formatPercent(entry.adjacentRate)})`,
      `- Verdict changes: ${String(entry.verdictChanges)}`,
      `- Changed task IDs: ${entry.changedTaskIds.length > 0 ? entry.changedTaskIds.join(", ") : "none"}`,
      `- Missing task IDs: ${entry.missingTaskIds.length > 0 ? entry.missingTaskIds.join(", ") : "none"}`,
    );
  }

  return sections.join("\n");
}
