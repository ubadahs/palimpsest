import {
  reportArtifactPayloadSchema,
  reportArtifactSchema,
  type ReportArtifact,
  type ReportArtifactPayload,
  type ReportCount,
  type ReportRate,
  type ReportRecordTrace,
} from "../contract/lean-artifacts.js";

/**
 * Pure deterministic Markdown rendering of a validated canonical Report.
 * Formats already-validated JSON fields only; never derives a second set of
 * counts or rates.
 */
export function renderCanonicalReportMarkdown(
  validatedReportArtifactOrPayload: ReportArtifact | ReportArtifactPayload,
): string {
  const payload = extractValidatedPayload(validatedReportArtifactOrPayload);
  const lines: string[] = [];

  lines.push("# Canonical citation fidelity report");
  lines.push("");
  lines.push("## Uncalibrated warning");
  lines.push("");
  lines.push(`Interpretation status: \`${payload.interpretationStatus}\``);
  lines.push("");
  lines.push(payload.interpretationWarning);
  lines.push("");
  lines.push(
    `Report method: \`${payload.method.methodId}\` (${payload.method.strategy}; calibration: ${payload.method.calibrationStatus}).`,
  );
  lines.push("");
  lines.push(
    `Deterministic: ${String(payload.deterministic)}; replayable from inputs: ${String(payload.replayableFromInputs)}.`,
  );
  lines.push("");

  lines.push("## Run and funnel coverage");
  lines.push("");
  lines.push(`Run ID: \`${payload.lineage.runId}\``);
  lines.push("");
  lines.push("### Discover");
  lines.push("");
  appendCountLines(lines, [
    payload.funnel.discover.seeds,
    payload.funnel.discover.returnedCitingPaperObservations,
    payload.funnel.discover.probed,
    payload.funnel.discover.notProbed,
    payload.funnel.discover.materializationSucceeded,
    payload.funnel.discover.materializationFailed,
    payload.funnel.discover.materializationUnavailable,
    payload.funnel.discover.materializationNotAttempted,
    payload.funnel.discover.harvestSucceeded,
    payload.funnel.discover.harvestNoMentions,
    payload.funnel.discover.harvestFailed,
    payload.funnel.discover.harvestNotAttempted,
    payload.funnel.discover.citationOccurrences,
    payload.funnel.discover.extractionClaimsExtracted,
    payload.funnel.discover.extractionNoClaims,
    payload.funnel.discover.extractionFailed,
    payload.funnel.discover.attributedClaimRecords,
    payload.funnel.discover.candidateClaims,
    payload.funnel.discover.selectedCandidates,
    payload.funnel.discover.deferredCandidates,
  ]);
  lines.push("");
  lines.push("### Scope");
  lines.push("");
  appendCountLines(lines, [
    payload.funnel.scope.scopedCandidates,
    payload.funnel.scope.deferredCandidates,
    payload.funnel.scope.families,
  ]);
  for (const entry of payload.funnel.scope.groundingStatusCounts) {
    lines.push(
      `- grounding status \`${entry.status}\`: ${String(entry.count)} (unit: families)`,
    );
  }
  lines.push("");
  lines.push("### Prepare");
  lines.push("");
  appendCountLines(lines, [
    payload.funnel.prepare.expectedFamilyOccurrencePairs,
    payload.funnel.prepare.preparedRecords,
    payload.funnel.prepare.classified,
    payload.funnel.prepare.ambiguous,
    payload.funnel.prepare.failed,
    payload.funnel.prepare.lowInformation,
    payload.funnel.prepare.manualReview,
    payload.funnel.prepare.manualReviewRoleAmbiguous,
    payload.funnel.prepare.manualReviewExtractionLimited,
  ]);
  lines.push("");
  lines.push(
    "Low-information and manual-review counts are overlapping role/mode populations; they may overlap classification-status counts and are not a partition.",
  );
  lines.push("");
  lines.push(
    "Manual-review queue entries stay gated as operational non-verdicts. Ambiguous citation roles are not auto-routed to the model.",
  );
  lines.push("");

  lines.push("## Retrieval and reranking");
  lines.push("");
  appendCountLines(lines, [
    payload.funnel.evidence.recordOutcomes,
    payload.funnel.evidence.bm25MatchedRuns,
    payload.funnel.evidence.bm25NoMatchRuns,
    payload.funnel.evidence.rerankDisabled,
    payload.funnel.evidence.rerankCompleted,
    payload.funnel.evidence.rerankFailed,
    payload.funnel.evidence.rerankNotAttempted,
    payload.funnel.evidence.uniqueFinalSelectionsBm25,
    payload.funnel.evidence.uniqueFinalSelectionsReranked,
    payload.funnel.evidence.recordSelectionBm25,
    payload.funnel.evidence.recordSelectionReranked,
  ]);
  lines.push("");
  lines.push(
    "Unique final selections count selection objects; record-selection counts report family×occurrence uses. One shared selection object may serve multiple records.",
  );
  for (const entry of payload.funnel.evidence.retrievalStatusCounts) {
    lines.push(
      `- retrieval status \`${entry.status}\`: ${String(entry.count)} (unit: family×occurrence records)`,
    );
  }
  const retrievalCoverage = requireRate(payload.rates, "retrieval_coverage");
  appendRateLine(lines, retrievalCoverage);
  lines.push("");

  lines.push("## Adjudication coverage");
  lines.push("");
  appendCountLines(lines, [
    payload.funnel.adjudicate.totalRecordOutcomes,
    payload.funnel.adjudicate.adjudicated,
    payload.funnel.adjudicate.notAdjudicated,
    payload.funnel.adjudicate.adjudicationFailed,
    payload.funnel.adjudicate.invalidOutput,
  ]);
  const adjudicationCoverage = requireRate(
    payload.rates,
    "adjudication_coverage",
  );
  appendRateLine(lines, adjudicationCoverage);
  const scopeSelection = requireRate(payload.rates, "scope_selection_rate");
  appendRateLine(lines, scopeSelection);
  lines.push("");

  lines.push("## Verdict distribution");
  lines.push("");
  lines.push(
    "F/D/E/U rates use the adjudicated-record denominator only. Operational non-verdicts are excluded.",
  );
  lines.push("");
  appendCountLines(lines, [
    payload.funnel.adjudicate.verdictCounts.F,
    payload.funnel.adjudicate.verdictCounts.D,
    payload.funnel.adjudicate.verdictCounts.E,
    payload.funnel.adjudicate.verdictCounts.U,
  ]);
  for (const metricId of [
    "verdict_F_rate",
    "verdict_D_rate",
    "verdict_E_rate",
    "verdict_U_rate",
  ] as const) {
    appendRateLine(lines, requireRate(payload.rates, metricId));
  }
  lines.push("");

  lines.push("## Operational non-verdicts");
  lines.push("");
  if (payload.funnel.adjudicate.gateCodeCounts.length === 0) {
    lines.push("- No gate codes recorded.");
  } else {
    for (const entry of payload.funnel.adjudicate.gateCodeCounts) {
      lines.push(
        `- gate \`${entry.status}\`: ${String(entry.count)} (unit: family×occurrence records)`,
      );
    }
  }
  if (payload.funnel.adjudicate.failureCodeCounts.length === 0) {
    lines.push("- No nonfatal adjudication failure codes recorded.");
  } else {
    for (const entry of payload.funnel.adjudicate.failureCodeCounts) {
      lines.push(
        `- failure \`${entry.status}\`: ${String(entry.count)} (unit: family×occurrence records)`,
      );
    }
  }
  lines.push("");

  lines.push("## Per-record trace");
  lines.push("");
  if (payload.recordTraces.length === 0) {
    lines.push("- No family×occurrence records.");
  } else {
    for (const trace of payload.recordTraces) {
      lines.push(formatTraceLine(trace));
    }
  }
  lines.push("");

  lines.push("## Lineage and provenance");
  lines.push("");
  lines.push(
    `- Discover: \`${payload.lineage.discoverArtifact.artifactId}\` / \`${payload.lineage.discoverArtifact.contentHash}\``,
  );
  lines.push(
    `- Scope: \`${payload.lineage.scopeArtifact.artifactId}\` / \`${payload.lineage.scopeArtifact.contentHash}\``,
  );
  lines.push(
    `- Prepare: \`${payload.lineage.prepareArtifact.artifactId}\` / \`${payload.lineage.prepareArtifact.contentHash}\``,
  );
  lines.push(
    `- Evidence: \`${payload.lineage.evidenceArtifact.artifactId}\` / \`${payload.lineage.evidenceArtifact.contentHash}\``,
  );
  lines.push(
    `- Adjudicate: \`${payload.lineage.adjudicateArtifact.artifactId}\` / \`${payload.lineage.adjudicateArtifact.contentHash}\``,
  );
  lines.push("");
  lines.push("### Decision summaries");
  lines.push("");
  if (payload.decisionSummaries.length === 0) {
    lines.push("- No upstream decisions summarized.");
  } else {
    for (const summary of payload.decisionSummaries) {
      lines.push(
        `- ${summary.stage} / \`${summary.decisionType}\` / \`${summary.outcome}\`: ${String(summary.count)} (unit: decisions)`,
      );
    }
  }
  lines.push("");
  lines.push("### Exclusion summaries");
  lines.push("");
  if (payload.exclusionSummaries.length === 0) {
    lines.push("- No upstream exclusions summarized.");
  } else {
    for (const summary of payload.exclusionSummaries) {
      lines.push(
        `- ${summary.stage} / \`${summary.reasonCode}\`: ${String(summary.count)} (unit: exclusions)`,
      );
    }
  }
  lines.push("");

  return `${lines.join("\n")}`;
}

function extractValidatedPayload(
  input: ReportArtifact | ReportArtifactPayload,
): ReportArtifactPayload {
  if (
    typeof input === "object" &&
    input != null &&
    "canonicalStage" in input &&
    input.canonicalStage === "report"
  ) {
    return reportArtifactSchema.parse(input).payload;
  }
  return reportArtifactPayloadSchema.parse(input);
}

function appendCountLines(lines: string[], counts: ReportCount[]): void {
  for (const entry of counts) {
    lines.push(
      `- \`${entry.metricId}\`: ${String(entry.count)} (unit: ${formatUnit(entry.unit)}; population: ${entry.population})`,
    );
  }
}

function appendRateLine(lines: string[], rate: ReportRate): void {
  const valueText =
    rate.value == null
      ? "not estimable (zero denominator)"
      : String(rate.value);
  lines.push(
    `- \`${rate.metricId}\`: ${valueText}; numerator=${String(rate.numerator)}; denominator=${String(rate.denominator)}; unit=${rate.unit}; population=${rate.populationLabel}; numerator definition=${rate.numeratorDefinition}; denominator definition=${rate.denominatorDefinition}`,
  );
}

function requireRate(rates: ReportRate[], metricId: string): ReportRate {
  const rate = rates.find((entry) => entry.metricId === metricId);
  if (rate == null) {
    throw new Error(
      `Validated report payload missing required rate metric: ${metricId}`,
    );
  }
  return rate;
}

function formatTraceLine(trace: ReportRecordTrace): string {
  const ranking =
    trace.evidence.rankingSource == null
      ? "none"
      : trace.evidence.rankingSource;
  const verdict =
    trace.adjudication.status === "adjudicated"
      ? ` verdict=${trace.adjudication.verdict}`
      : "";
  const gate =
    trace.adjudication.status === "not_adjudicated"
      ? ` gate=${trace.adjudication.gateCode}`
      : "";
  const failure =
    trace.adjudication.status === "adjudication_failed"
      ? ` failure=${trace.adjudication.failureCode}`
      : "";
  return `- record=\`${trace.recordId}\` family=\`${trace.familyId}\` occurrence=\`${trace.citationOccurrenceId}\` retrieval=${trace.evidence.retrievalStatus} rerank=${trace.evidence.rerankStatus} rankingSource=${ranking} adjudication=${trace.adjudication.status}${gate}${failure}${verdict} adjudicationResult=\`${trace.adjudication.adjudicationResultId}\``;
}

function formatUnit(unit: ReportCount["unit"]): string {
  switch (unit) {
    case "family_occurrence_records":
      return "family×occurrence records";
    case "citing_paper_observations":
      return "citing-paper observations";
    case "citation_occurrences":
      return "occurrences";
    case "candidates":
      return "candidates";
    case "families":
      return "families";
    case "seeds":
      return "seeds";
    case "attributed_claim_records":
      return "attributed claim records";
    case "bm25_runs":
      return "bm25 runs";
    case "rerank_runs":
      return "rerank runs";
    case "selections":
      return "selections";
    case "decisions":
      return "decisions";
    case "exclusions":
      return "exclusions";
    default:
      return unit;
  }
}
