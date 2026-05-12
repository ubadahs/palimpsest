import type {
  AdjudicationRecord,
  AdjudicationVerdict,
  AuditSample,
  EvaluationMode,
} from "../domain/types.js";

function formatPercent(n: number, d: number): string {
  if (d === 0) return "—";
  return `${((n / d) * 100).toFixed(0)}%`;
}

function formatScore(n: number): string {
  return n.toFixed(2);
}

function formatAgreement(value: boolean | undefined): string {
  if (value == null) return "—";
  return value ? "yes" : "no";
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function pushCountRows(
  sections: string[],
  counts: Record<string, number>,
): void {
  const entries = Object.entries(counts).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );
  for (const [key, count] of entries) {
    sections.push(`| ${key} | ${String(count)} |`);
  }
}

export function toAuditSampleSummaryMarkdown(set: AuditSample): string {
  const active = set.records.filter((r) => !r.excluded);
  const adjudicated = active.filter((r) => r.verdict != null);
  const excluded = set.records.filter((r) => r.excluded);

  const verdictCounts: Record<string, number> = {};
  for (const r of adjudicated) {
    const v = r.verdict!;
    verdictCounts[v] = (verdictCounts[v] ?? 0) + 1;
  }

  const byMode = new Map<EvaluationMode, AdjudicationRecord[]>();
  for (const r of adjudicated) {
    const existing = byMode.get(r.evaluationMode);
    if (existing) {
      existing.push(r);
    } else {
      byMode.set(r.evaluationMode, [r]);
    }
  }

  const total = adjudicated.length;

  const sections: string[] = [
    "# Audit Sample Summary",
    "",
    `## Seed: ${set.resolvedSeedPaperTitle}`,
    `**Tracked claim:** ${set.seed.trackedClaim}`,
    `**Adjudicated:** ${String(adjudicated.length)} of ${String(set.records.length)} records (${String(excluded.length)} excluded)`,
    "",
    "## Overall Verdict Distribution",
    "",
    "| Verdict | Count | Rate |",
    "| --- | --- | --- |",
  ];

  const verdictOrder: AdjudicationVerdict[] = [
    "supported",
    "partially_supported",
    "overstated_or_generalized",
    "not_supported",
    "cannot_determine",
  ];

  for (const v of verdictOrder) {
    const count = verdictCounts[v] ?? 0;
    if (count > 0) {
      sections.push(
        `| ${v} | ${String(count)} | ${formatPercent(count, total)} |`,
      );
    }
  }
  sections.push(`| **Total** | **${String(total)}** | |`);

  // By mode breakdown
  sections.push(
    "",
    "## Verdict by Evaluation Mode",
    "",
    "| Mode | Total | Supported | Partial | Not Supported | Cannot Det. |",
    "| --- | --- | --- | --- | --- | --- |",
  );

  for (const [mode, records] of byMode) {
    const s = records.filter((r) => r.verdict === "supported").length;
    const p = records.filter((r) => r.verdict === "partially_supported").length;
    const n = records.filter((r) => r.verdict === "not_supported").length;
    const c = records.filter((r) => r.verdict === "cannot_determine").length;
    sections.push(
      `| ${mode} | ${String(records.length)} | ${String(s)} | ${String(p)} | ${String(n)} | ${String(c)} |`,
    );
  }

  // Retrieval quality
  const rqCounts: Record<string, number> = {};
  for (const r of adjudicated) {
    if (r.retrievalQuality) {
      rqCounts[r.retrievalQuality] = (rqCounts[r.retrievalQuality] ?? 0) + 1;
    }
  }

  sections.push(
    "",
    "## Retrieval Quality",
    "",
    "| Quality | Count | Rate |",
    "| --- | --- | --- |",
  );
  for (const q of ["high", "medium", "low"]) {
    const count = rqCounts[q] ?? 0;
    sections.push(
      `| ${q} | ${String(count)} | ${formatPercent(count, total)} |`,
    );
  }

  const vectorFirstRecords = adjudicated.filter(
    (r) => r.vectorRoutingDecision?.adjudicationMode === "vector_first",
  );
  if (vectorFirstRecords.length > 0) {
    const sourceCounts: Record<string, number> = {};
    const adaptiveReasonCounts: Record<string, number> = {};
    const escalationReasonCounts: Record<string, number> = {};
    let acceptedByVector = 0;
    let escalatedToCategorical = 0;
    let adaptiveSamplingCount = 0;
    let vectorCalls = 0;
    let vectorCost = 0;

    for (const r of vectorFirstRecords) {
      const decision = r.vectorRoutingDecision!;
      incrementCount(sourceCounts, decision.finalVerdictSource);
      if (decision.finalVerdictSource === "axis_derived") {
        acceptedByVector++;
      } else {
        escalatedToCategorical++;
      }
      if (decision.triggeredAdaptiveSampling) {
        adaptiveSamplingCount++;
      }
      for (const reason of decision.adaptiveSamplingReasons) {
        incrementCount(adaptiveReasonCounts, reason);
      }
      for (const reason of decision.categoricalEscalationReasons) {
        incrementCount(escalationReasonCounts, reason);
      }
      vectorCalls +=
        r.fidelityVectorTrace?.telemetry?.totalCalls ??
        r.fidelityVectorTrace?.samples.length ??
        0;
      vectorCost += r.fidelityVectorTrace?.telemetry?.estimatedCostUsd ?? 0;
    }

    const avgSamples =
      vectorFirstRecords.length > 0
        ? vectorCalls / vectorFirstRecords.length
        : 0;
    const categoricalCost = set.runTelemetry?.estimatedCostUsd ?? 0;

    sections.push(
      "",
      "## Vector-First Routing Summary",
      "",
      `Adjudication mode: vector_first`,
      "",
      "| Metric | Value |",
      "| --- | ---: |",
      `| Vector-derived accepted records | ${String(acceptedByVector)} |`,
      `| Categorical escalations | ${String(escalatedToCategorical)} |`,
      `| Adaptive sampling records | ${String(adaptiveSamplingCount)} |`,
      `| Vector sample calls | ${String(vectorCalls)} |`,
      `| Average vector samples / record | ${avgSamples.toFixed(2)} |`,
      `| Estimated vector cost | $${vectorCost.toFixed(4)} |`,
      `| Estimated categorical escalation cost | $${categoricalCost.toFixed(4)} |`,
      `| Estimated adjudication cost | $${(vectorCost + categoricalCost).toFixed(4)} |`,
      "",
      "### Verdict Source Distribution",
      "",
      "| Source | Count |",
      "| --- | ---: |",
    );
    pushCountRows(sections, sourceCounts);

    sections.push(
      "",
      "### Adaptive Sampling Reasons",
      "",
      "| Reason | Count |",
      "| --- | ---: |",
    );
    if (Object.keys(adaptiveReasonCounts).length === 0) {
      sections.push("| none | 0 |");
    } else {
      pushCountRows(sections, adaptiveReasonCounts);
    }

    sections.push(
      "",
      "### Categorical Escalation Reasons",
      "",
      "| Reason | Count |",
      "| --- | ---: |",
    );
    if (Object.keys(escalationReasonCounts).length === 0) {
      sections.push("| none | 0 |");
    } else {
      pushCountRows(sections, escalationReasonCounts);
    }

    const examples = vectorFirstRecords.slice(0, 5);
    sections.push("", "### Vector-First Examples", "");
    for (const r of examples) {
      sections.push(
        `- **${r.taskId}**: ${r.verdict ?? "—"} (${r.vectorRoutingDecision!.finalVerdictSource})`,
      );
    }
  }

  const vectorRecords = adjudicated.filter((r) => r.fidelityVectorTrace);
  if (vectorRecords.length > 0) {
    let vectorCalls = 0;
    let vectorCost = 0;
    sections.push(
      "",
      "## Fidelity Vector Trace Summary",
      "",
      "| Task | Canonical verdict | Modal sampled verdict | Axis-derived verdict | Canonical/axis agreement | Support | Grounding | Claim identity | Scope | Certainty | Uncertainty |",
      "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    );

    for (const r of vectorRecords) {
      const trace = r.fidelityVectorTrace!;
      const means = trace.aggregate.meanAxes;
      vectorCalls += trace.telemetry?.totalCalls ?? trace.samples.length;
      vectorCost += trace.telemetry?.estimatedCostUsd ?? 0;
      sections.push(
        `| ${r.taskId} | ${r.verdict ?? "—"} | ${trace.aggregate.sampledVerdictDistribution.modalSampledVerdict} | ${trace.aggregate.axisDerivedVerdict} | ${formatAgreement(trace.canonicalAxisDerivedVerdictAgreement)} | ${formatScore(means.support)} | ${formatScore(means.evidenceGrounding)} | ${formatScore(means.claimIdentity)} | ${formatScore(means.scopeMatch)} | ${formatScore(means.certaintyMatch)} | ${formatScore(means.uncertainty)} |`,
      );
    }

    sections.push(
      "",
      `Vector trace calls: ${String(vectorCalls)}; estimated vector cost: $${vectorCost.toFixed(4)}.`,
    );
  }

  // Notable findings
  const notSupported = adjudicated.filter((r) => r.verdict === "not_supported");
  const overstated = adjudicated.filter(
    (r) =>
      r.verdict === "overstated_or_generalized" ||
      r.verdict === "partially_supported",
  );

  sections.push("", "## Notable Findings", "");

  if (notSupported.length > 0) {
    sections.push(
      `### Unsupported Citations (${String(notSupported.length)})`,
      "",
    );
    for (const r of notSupported) {
      sections.push(
        `- **${r.citingPaperTitle}** (${r.evaluationMode})`,
        `  ${r.rationale ?? ""}`,
        "",
      );
    }
  }

  if (overstated.length > 0) {
    sections.push(
      `### Partially Supported / Overstated (${String(overstated.length)})`,
      "",
    );
    for (const r of overstated) {
      sections.push(
        `- **${r.citingPaperTitle}** (${r.evaluationMode}): ${r.verdict}`,
        `  ${r.rationale ?? ""}`,
        "",
      );
    }
  }

  if (excluded.length > 0) {
    sections.push(`### Excluded (${String(excluded.length)})`, "");
    for (const r of excluded) {
      sections.push(
        `- **${r.citingPaperTitle}**: ${r.excludeReason ?? "excluded"}`,
        "",
      );
    }
  }

  // Key takeaways
  const supportedCount = verdictCounts["supported"] ?? 0;
  const partialCount = verdictCounts["partially_supported"] ?? 0;
  const notSupportedCount = verdictCounts["not_supported"] ?? 0;

  sections.push(
    "",
    "## Key Metrics",
    "",
    `- **Fidelity rate (supported):** ${formatPercent(supportedCount, total)}`,
    `- **Partial fidelity rate:** ${formatPercent(supportedCount + partialCount, total)}`,
    `- **Unsupported rate:** ${formatPercent(notSupportedCount, total)}`,
    `- **Retrieval high-quality rate:** ${formatPercent(rqCounts["high"] ?? 0, total)}`,
  );

  if (set.runTelemetry) {
    const t = set.runTelemetry;
    sections.push(
      "",
      "## Telemetry",
      "",
      "| Metric | Value |",
      "| --- | --- |",
      `| Model | ${t.model}${t.useExtendedThinking ? " (extended thinking)" : ""} |`,
      `| Calls | ${String(t.successfulCalls)} successful, ${String(t.failedCalls)} failed |`,
      `| Input tokens | ${String(t.totalInputTokens)} |`,
      `| Output tokens | ${String(t.totalOutputTokens)} |`,
      `| Reasoning tokens | ${String(t.totalReasoningTokens)} |`,
      `| Total tokens | ${String(t.totalTokens)} |`,
      `| Total latency | ${(t.totalLatencyMs / 1000).toFixed(1)}s |`,
      `| Avg latency/call | ${(t.averageLatencyMs / 1000).toFixed(1)}s |`,
      `| Estimated cost | $${t.estimatedCostUsd.toFixed(4)} |`,
    );
  }

  return sections.join("\n");
}
