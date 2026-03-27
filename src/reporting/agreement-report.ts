import type {
  AdjudicationRecord,
  AdjudicationVerdict,
  CalibrationSet,
  EvaluationMode,
} from "../domain/types.js";
import { truncate } from "./report-utils.js";

type Pair = {
  record: AdjudicationRecord;
  humanVerdict: AdjudicationVerdict;
  llmVerdict: AdjudicationVerdict;
  agree: boolean;
};

function formatPercent(n: number, d: number): string {
  if (d === 0) return "—";
  return `${((n / d) * 100).toFixed(0)}%`;
}

export function toAgreementMarkdown(
  human: CalibrationSet,
  llm: CalibrationSet,
): string {
  const pairs: Pair[] = [];

  for (const hRecord of human.records) {
    if (hRecord.excluded || !hRecord.verdict) continue;
    const lRecord = llm.records.find((r) => r.taskId === hRecord.taskId);
    if (!lRecord?.verdict) continue;

    pairs.push({
      record: hRecord,
      humanVerdict: hRecord.verdict,
      llmVerdict: lRecord.verdict,
      agree: hRecord.verdict === lRecord.verdict,
    });
  }

  const total = pairs.length;
  const exact = pairs.filter((p) => p.agree).length;

  const adjacentMatch = pairs.filter((p) => {
    if (p.agree) return true;
    const close = new Set(["supported", "partially_supported"]);
    return close.has(p.humanVerdict) && close.has(p.llmVerdict);
  }).length;

  const sections: string[] = [
    "# Human vs LLM Agreement Report",
    "",
    `## Seed: ${human.resolvedSeedPaperTitle}`,
    `**Human adjudicator:** ${human.records.find((r) => r.adjudicator)?.adjudicator ?? "unknown"}`,
    `**LLM adjudicator:** ${llm.records.find((r) => r.adjudicator)?.adjudicator ?? "unknown"}`,
    `**Records compared:** ${String(total)}`,
    "",
    "## Overall Agreement",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Exact agreement | ${String(exact)} / ${String(total)} (${formatPercent(exact, total)}) |`,
    `| Adjacent agreement (supported/partial collapsed) | ${String(adjacentMatch)} / ${String(total)} (${formatPercent(adjacentMatch, total)}) |`,
  ];

  // By mode
  const byMode = new Map<EvaluationMode, Pair[]>();
  for (const p of pairs) {
    const mode = p.record.evaluationMode;
    const existing = byMode.get(mode);
    if (existing) {
      existing.push(p);
    } else {
      byMode.set(mode, [p]);
    }
  }

  sections.push(
    "",
    "## Agreement by Evaluation Mode",
    "",
    "| Mode | Total | Exact | Rate |",
    "| --- | --- | --- | --- |",
  );
  for (const [mode, modePairs] of byMode) {
    const modeExact = modePairs.filter((p) => p.agree).length;
    sections.push(
      `| ${mode} | ${String(modePairs.length)} | ${String(modeExact)} | ${formatPercent(modeExact, modePairs.length)} |`,
    );
  }

  // Per-record comparison table
  sections.push(
    "",
    "## Per-Record Comparison",
    "",
    "| # | Paper | Mode | Human | LLM | Match? |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]!;
    const match = p.agree ? "YES" : "**NO**";
    sections.push(
      `| ${String(i + 1)} | ${truncate(p.record.citingPaperTitle, 40)} | ${p.record.evaluationMode} | ${p.humanVerdict} | ${p.llmVerdict} | ${match} |`,
    );
  }

  // Disagreements detail
  const disagreements = pairs.filter((p) => !p.agree);

  if (disagreements.length > 0) {
    sections.push("", `## Disagreements (${String(disagreements.length)})`, "");
    for (const p of disagreements) {
      const humanRec = human.records.find((r) => r.taskId === p.record.taskId);
      const llmRec = llm.records.find((r) => r.taskId === p.record.taskId);

      sections.push(
        `### ${truncate(p.record.citingPaperTitle, 70)}`,
        "",
        `**Mode:** ${p.record.evaluationMode}`,
        `**Human:** ${p.humanVerdict} — ${humanRec?.rationale ?? ""}`,
        `**LLM:** ${p.llmVerdict} — ${llmRec?.rationale ?? ""}`,
        "",
      );
    }
  }

  return sections.join("\n");
}
