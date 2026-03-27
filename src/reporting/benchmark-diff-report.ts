import type { BenchmarkDiffResult } from "../benchmark/types.js";
import { truncate } from "./report-utils.js";

export function toBenchmarkDiffMarkdown(result: BenchmarkDiffResult): string {
  const sections: string[] = [
    "# Benchmark Diff Report",
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Base records | ${String(result.summary.totalBaseRecords)} |`,
    `| Candidate records | ${String(result.summary.totalCandidateRecords)} |`,
    `| Verdict changes | ${String(result.summary.changedVerdicts)} |`,
    `| Rationale changes | ${String(result.summary.changedRationales)} |`,
    `| Exclusion changes | ${String(result.summary.changedExclusions)} |`,
    `| Missing in base | ${String(result.summary.missingInBase)} |`,
    `| Missing in candidate | ${String(result.summary.missingInCandidate)} |`,
    "",
    "## Entries",
    "",
    "| Task ID | Paper | Base | Candidate | Verdict? | Rationale? | Exclusion? | Missing? |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const entry of result.entries) {
    const missing = entry.missingInBase
      ? "missing in base"
      : entry.missingInCandidate
        ? "missing in candidate"
        : "—";

    sections.push(
      `| ${entry.taskId} | ${truncate(entry.citingPaperTitle, 40)} | ${entry.baseVerdict ?? "—"} | ${entry.candidateVerdict ?? "—"} | ${entry.verdictChanged ? "yes" : ""} | ${entry.rationaleChanged ? "yes" : ""} | ${entry.exclusionChanged ? "yes" : ""} | ${missing} |`,
    );
  }

  return sections.join("\n");
}
