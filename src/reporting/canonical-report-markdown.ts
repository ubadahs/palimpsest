import {
  reportArtifactPayloadSchema,
  reportArtifactSchema,
  type ReportArtifact,
  type ReportArtifactPayload,
  type ReportCodebookCounts,
  type ReportCount,
  type ReportRate,
  type ReportRecordTrace,
  type ReportWeightedRate,
} from "../contract/lean-artifacts.js";

/**
 * Runs with at most this many records list every restatement and trace every
 * record in Markdown. Larger runs summarize per family, so the file grows with
 * families rather than records; the JSON always holds every record.
 */
export const MARKDOWN_RECORD_DETAIL_LIMIT = 200;
/** Restatements shown per verdict per family in a summarized report. */
export const MARKDOWN_EXAMPLES_PER_VERDICT = 2;

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

  const detailed = payload.recordTraces.length <= MARKDOWN_RECORD_DETAIL_LIMIT;
  lines.push("## Claim families and their restatements");
  lines.push("");
  lines.push(
    "Each family is one seed finding. Restatements are listed in citing-paper order (year, then title). Verdicts are uncalibrated.",
  );
  lines.push("");
  if (!detailed) {
    lines.push(
      `This run has ${String(payload.recordTraces.length)} records, more than the ${String(MARKDOWN_RECORD_DETAIL_LIMIT)} this file lists one by one, so each family shows its counts and up to ${String(MARKDOWN_EXAMPLES_PER_VERDICT)} illustrative restatements per verdict (D and E first, with the adjudicator's statements, then U and F; the earliest citing papers). Every restatement, with its verdict and the adjudicator's statements, is in \`familyMutations\` of the report JSON beside this file.`,
    );
    lines.push("");
  }
  if (payload.familyMutations.length === 0) {
    lines.push("- No families were scoped.");
    lines.push("");
  }
  payload.familyMutations.forEach((family, familyIndex) => {
    const counts = family.verdictCounts;
    const adjudicated = counts.F + counts.D + counts.E + counts.U;
    lines.push(`### ${family.claim}`);
    lines.push("");
    lines.push(
      `Seed: ${family.seedTitle ?? family.seedDoi} (\`${family.seedDoi}\`) · grounding \`${family.groundingStatus}\`${family.equivalenceMethod ? ` · equivalence \`${family.equivalenceMethod}\`` : ""} · ${String(family.records.length)} records, ${String(family.uniqueClaimUnits)} unique claim units · F ${String(counts.F)}, D ${String(counts.D)}, E ${String(counts.E)}, U ${String(counts.U)}, gated ${String(counts.not_adjudicated)}, failed ${String(counts.failed)}`,
    );
    lines.push("");
    if (adjudicated > 0) {
      lines.push(
        `Share of the ${String(adjudicated)} adjudicated: ${(["D", "E", "U", "F"] as const).map((verdict) => `${verdict} ${formatPercent(counts[verdict] / adjudicated)}`).join(", ")}.`,
      );
      lines.push("");
    }
    for (const span of family.verifiedSeedGroundingSpans.slice(
      0,
      detailed ? 3 : 1,
    )) {
      lines.push(
        `> Seed${span.sectionTitle ? ` (${span.sectionTitle})` : ""}: ${span.text}`,
      );
    }
    if (family.verifiedSeedGroundingSpans.length > 0) lines.push("");
    if (detailed) {
      for (const record of family.records) appendRestatement(lines, record);
    } else {
      const shown = (["D", "E", "U", "F"] as const).flatMap((verdict) =>
        family.records
          .filter(
            (record) =>
              record.status === "adjudicated" && record.verdict === verdict,
          )
          .slice(0, MARKDOWN_EXAMPLES_PER_VERDICT),
      );
      // The adjudicator's two statements say what moved, so they stay on D
      // and E examples; U and F examples keep only the restatement.
      for (const record of shown) {
        appendRestatement(lines, record, {
          statements: record.verdict === "D" || record.verdict === "E",
        });
      }
      const rest = family.records.length - shown.length;
      if (rest > 0) {
        lines.push(
          `- ${String(rest)} more restatement${rest === 1 ? "" : "s"} in \`familyMutations[${String(familyIndex)}].records\` of the report JSON.`,
        );
      }
    }
    lines.push("");
  });

  appendSeedCodebooks(lines, payload.seedCodebooks);

  lines.push("## Run and funnel coverage");
  lines.push("");
  lines.push(`Run ID: \`${payload.lineage.runId}\``);
  lines.push("");
  lines.push("### Discover");
  lines.push("");
  appendCountLines(lines, [
    payload.funnel.discover.seeds,
    payload.funnel.discover.providerReportedNeighborhoodTotal,
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
    payload.funnel.discover.uniqueCitingPapersWithOccurrences,
    payload.funnel.discover.uniqueCitationGroups,
    payload.funnel.discover.attributedClaimsWithVerifiedSupportSpan,
    payload.funnel.discover.attributedClaimsMissingSupportSpan,
    payload.funnel.discover.deferredByFamilyCap,
    payload.funnel.discover.deferredByRecordBudget,
    payload.funnel.discover.deferredByNovelty,
  ]);
  lines.push("");
  lines.push(
    "Probe sampling design (year band :: type group → probed / sampling-frame papers, inclusion probability π; then all enumerated and all probed):",
  );
  lines.push("");
  const seedIds = new Set(
    payload.funnel.discover.probeStratumCounts.map((entry) => entry.seedId),
  );
  for (const stratum of payload.funnel.discover.probeStratumCounts) {
    lines.push(
      `- ${seedIds.size > 1 ? `seed \`${stratum.seedId}\` · ` : ""}\`${stratum.stratum}\`: ${String(stratum.probedFrame)} / ${String(stratum.frame)} (π = ${formatProbability(stratum.inclusionProbability)}); ${String(stratum.enumerated)} enumerated, ${String(stratum.probed)} probed`,
    );
  }
  if (payload.funnel.discover.probeStratumCounts.length === 0) {
    lines.push("- No citing papers enumerated.");
  }
  lines.push("");
  appendStatusTable(
    lines,
    "Neighborhood coverage",
    payload.funnel.discover.neighborhoodCoverage,
    "No neighborhood queries recorded.",
  );
  appendStatusTable(
    lines,
    "Full-text access channel",
    payload.funnel.discover.materializationChannelCounts,
    "No citing paper text was materialized.",
  );
  appendStatusTable(
    lines,
    "Materialization loss reasons",
    payload.funnel.discover.materializationLossReasonCounts,
    "Every probed citing paper materialized.",
  );
  appendStatusTable(
    lines,
    "Harvest loss reasons",
    payload.funnel.discover.harvestLossReasonCounts,
    "Every materialized citing paper yielded occurrences.",
  );
  appendStatusTable(
    lines,
    "Bibliography match method",
    payload.funnel.discover.bibliographyMatchMethodCounts,
    "No seed bibliography entry was matched.",
  );
  const enumerated =
    payload.funnel.discover.returnedCitingPaperObservations.count;
  const frame = payload.funnel.discover.probeStratumCounts.reduce(
    (total, stratum) => total + stratum.frame,
    0,
  );
  lines.push(
    `Discover enumerated ${String(enumerated)} of ${String(payload.funnel.discover.providerReportedNeighborhoodTotal.count)} provider-reported citing works. ${String(frame)} of them${enumerated > 0 ? ` (${formatPercent(frame / enumerated)})` : ""} form the sampling frame: the provider does not mark them closed or abstract-only. Discover probed ${String(payload.funnel.discover.probed.count)}, giving each frame stratum one probe before any got a second and then each next probe to the stratum where a probed paper stood for the most frame papers. Unweighted rates below count the observed sample as it is; the weighted F/D/E/U rates count each adjudicated record from a frame paper 1/π of its stratum, estimating rates over the frame${payload.funnel.discover.neighborhoodCoverage.some((entry) => entry.status === "truncated" && entry.count > 0) ? " (drawn from a neighborhood truncated by the neighborhood limit, so not the whole provider-reported total)" : ""}.`,
  );
  lines.push("");
  lines.push(
    "Candidate selection is deterministic. Deferred-by-novelty counts are lexical-redundancy diagnostics; cross-citer paraphrases are merged by the Discover equivalence pass.",
  );
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
    ...(payload.funnel.evidence.rerankSkippedPinnedSelection
      ? [payload.funnel.evidence.rerankSkippedPinnedSelection]
      : []),
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
    payload.funnel.adjudicate.uniqueClaimUnits,
    payload.funnel.adjudicate.uniqueAdjudicatedClaimUnits,
    payload.funnel.adjudicate.repeatedRecordsBeyondUniqueUnits,
    payload.funnel.adjudicate.packetsWithVerifiedSupportSpans,
    payload.funnel.adjudicate.packetsMissingSupportSpans,
    payload.funnel.adjudicate.evidenceSufficient,
    payload.funnel.adjudicate.evidenceLimited,
    payload.funnel.adjudicate.figureOnlyLimitation,
    ...Object.values(payload.funnel.adjudicate.seedText ?? {}),
  ]);
  const adjudicationCoverage = requireRate(
    payload.rates,
    "adjudication_coverage",
  );
  appendRateLine(lines, adjudicationCoverage);
  const scopeSelection = requireRate(payload.rates, "scope_selection_rate");
  appendRateLine(lines, scopeSelection);
  lines.push("");
  lines.push(
    "Unique claim units collapse repeated family × citing-paper × claim packets. Evidence sufficiency is a packet diagnostic, not a fidelity verdict.",
  );
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
  lines.push("### Weighted by sampling design");
  lines.push("");
  lines.push(
    "Each adjudicated record from a sampling-frame paper counts 1/π, where π is the share of its stratum's frame papers that were probed; records from papers outside the frame are left out. Sample counts are the unweighted numerator and denominator the estimate rests on.",
  );
  lines.push("");
  for (const rate of payload.weightedRates) {
    appendWeightedRateLine(lines, rate);
  }
  lines.push("");
  lines.push("### By unique claim unit");
  lines.push("");
  lines.push(
    "The same citing paper restating the same claim several times counts once here; a unit is counted under every verdict its records received.",
  );
  lines.push("");
  appendCountLines(lines, [
    payload.funnel.adjudicate.uniqueClaimUnitVerdictCounts.F,
    payload.funnel.adjudicate.uniqueClaimUnitVerdictCounts.D,
    payload.funnel.adjudicate.uniqueClaimUnitVerdictCounts.E,
    payload.funnel.adjudicate.uniqueClaimUnitVerdictCounts.U,
  ]);
  for (const metricId of [
    "verdict_F_unique_rate",
    "verdict_D_unique_rate",
    "verdict_E_unique_rate",
    "verdict_U_unique_rate",
  ] as const) {
    appendRateLine(lines, requireRate(payload.rates, metricId));
  }
  lines.push("");

  lines.push("### By evidence regime");
  lines.push("");
  lines.push(
    "Adjudicated verdicts split by how the evidence was selected. Scope-pinned records saw grounding-chosen passages first; compare them with unpinned records before pooling.",
  );
  lines.push("");
  if (payload.funnel.adjudicate.verdictCountsByRankingSource.length === 0) {
    lines.push("- No adjudicated records.");
  } else {
    for (const row of payload.funnel.adjudicate.verdictCountsByRankingSource) {
      lines.push(
        `- \`${row.rankingSource}\`: F ${String(row.F)}, D ${String(row.D)}, E ${String(row.E)}, U ${String(row.U)}`,
      );
    }
  }
  lines.push("");

  lines.push("## Mutation kinds (D verdicts only)");
  lines.push("");
  lines.push(
    "Which dimension of the source claim moved, and in which direction. A D record may name up to three kinds.",
  );
  lines.push("");
  if (payload.funnel.adjudicate.mutationKindCounts.length === 0) {
    lines.push("- No mutation kinds recorded.");
  } else {
    for (const entry of payload.funnel.adjudicate.mutationKindCounts) {
      lines.push(
        `- kind \`${entry.status}\`: ${String(entry.count)} (unit: D records naming this kind)`,
      );
    }
  }
  for (const entry of payload.funnel.adjudicate.mutationDirectionCounts) {
    lines.push(
      `- direction \`${entry.status}\`: ${String(entry.count)} (unit: D records)`,
    );
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
  } else if (!detailed) {
    lines.push(
      `- ${String(payload.recordTraces.length)} records, more than the ${String(MARKDOWN_RECORD_DETAIL_LIMIT)} traced here one by one; each record's trace is in \`recordTraces\` of the report JSON.`,
    );
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
  lines.push("### Candidate selection");
  lines.push("");
  if (payload.selectionAudit.length === 0) {
    lines.push("- No claim candidates were scored.");
  } else {
    lines.push(
      "| rank | scoped | shape | citers | specificity | confidence | utility |",
    );
    lines.push("|---|---|---|---|---|---|---|");
    for (const row of payload.selectionAudit) {
      const scores = row.componentScores;
      lines.push(
        `| ${String(row.rank)} | ${row.selectedForScope ? "yes" : "no"} | \`${row.claimShape}\` | ${String(row.uniqueCitingPaperCount)} | ${row.specificityScore.toFixed(2)} | ${row.confidenceAggregate.toFixed(2)} | ${scores ? scores.utility.toFixed(3) : "—"} |`,
      );
    }
    lines.push("");
    lines.push(
      "Selection is discriminating only if the scoped rows score differently from the deferred ones; compare the columns, do not assume it.",
    );
  }
  lines.push("");
  lines.push("### Citation-role signals");
  lines.push("");
  const signalCounts = new Map<string, number>();
  for (const trace of payload.recordTraces) {
    for (const signal of trace.classification.signals) {
      signalCounts.set(signal, (signalCounts.get(signal) ?? 0) + 1);
    }
  }
  if (signalCounts.size === 0) {
    lines.push("- No classification signal fired on any record.");
  } else {
    for (const [signal, count] of [...signalCounts.entries()].sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    )) {
      lines.push(`- \`${signal}\`: ${String(count)}`);
    }
  }
  lines.push("");

  return `${lines.join("\n")}`;
}

function appendSeedCodebooks(
  lines: string[],
  codebooks: ReportArtifactPayload["seedCodebooks"],
): void {
  lines.push("## Seed codebook view");
  lines.push("");
  lines.push(
    "A second view beside the families. Codebook entries come from the seed paper itself, not from the citers, and stay the same across runs of the same seed text, so these rows can be compared between runs. Each citing claim is tagged with the entries it is about; a tag says what a claim is about, never whether it is right, and it is not a verdict. A claim tagged none is about nothing the codebook lists; that does not mean the seed never said it. A record counts under every entry it is tagged with; under a theme it counts once if it carries the theme itself or any entry under it. Verdicts are uncalibrated.",
  );
  lines.push("");
  if (codebooks.length === 0) {
    lines.push("- No seed text was materialized, so no codebook was built.");
    lines.push("");
    return;
  }
  const countCells = (counts: ReportCodebookCounts): string =>
    [
      counts.taggedClaimUnits,
      counts.adjudicatedRecords,
      counts.F,
      counts.D,
      counts.E,
      counts.U,
    ]
      .map(String)
      .join(" | ");
  for (const codebook of codebooks) {
    lines.push(`### ${codebook.seedTitle ?? codebook.seedDoi}`);
    lines.push("");
    if (
      codebook.codebookStatus === "failed" ||
      codebook.codebookStatus === "seed_text_unavailable"
    ) {
      lines.push(
        `No codebook (\`${codebook.codebookStatus}\`${codebook.unavailableReason ? `: ${codebook.unavailableReason}` : ""}); its ${String(codebook.claims.total)} claims are untagged.`,
      );
      lines.push("");
      continue;
    }
    lines.push(
      `Codebook \`${codebook.codebookId ?? "unknown"}\` (${codebook.codebookStatus}${codebook.codebookStatus === "reused" ? `, generated ${codebook.generatedAt ?? "earlier"}` : ""}; procedure \`${codebook.procedureVersion ?? "unknown"}\`): ${String(codebook.themes.length)} themes, ${String(codebook.entries.length)} entries.`,
    );
    lines.push("");
    const claims = codebook.claims;
    lines.push(
      `Claims: ${String(claims.total)} — specific entries ${String(claims.specific)}, theme only ${String(claims.themeOnly)}, none ${String(claims.none)}, tagging failed ${String(claims.taggingFailed)}, not tagged ${String(claims.notTagged)}. Claim units: ${String(codebook.claimUnits.total)}, ${String(codebook.claimUnits.untagged)} untagged. Adjudicated records: ${String(codebook.adjudicatedRecords.total)}, ${String(codebook.adjudicatedRecords.untagged)} untagged.`,
    );
    lines.push("");
    lines.push("#### By theme");
    lines.push("");
    lines.push(
      "| Theme | Statement | Entries | Claim units | Theme only | Via entries | Adjudicated | F | D | E | U |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
    for (const theme of codebook.themes) {
      const counts = theme.counts;
      lines.push(
        `| ${theme.themeId}${theme.isHeadline ? " (headline)" : ""} | ${escapeCell(theme.statement)} | ${String(theme.entryIds.length)} | ${String(counts.taggedClaimUnits)} | ${String(theme.themeOnlyClaimUnits)} | ${String(theme.entryClaimUnits)} | ${String(counts.adjudicatedRecords)} | ${String(counts.F)} | ${String(counts.D)} | ${String(counts.E)} | ${String(counts.U)} |`,
      );
    }
    lines.push("");
    lines.push("#### By entry");
    lines.push("");
    lines.push(
      "| Entry | Theme | Type | Statement | Claim units | Adjudicated | F | D | E | U |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const entry of codebook.entries) {
      lines.push(
        `| ${entry.entryId} | ${entry.themeId} | ${entry.type}${entry.attributedToOtherWork ? " (relayed)" : ""} | ${escapeCell(entry.statement)} | ${countCells(entry.counts)} |`,
      );
    }
    lines.push("");
    lines.push(
      codebook.uncitedEntryIds.length > 0
        ? `Entries no claim cites: ${codebook.uncitedEntryIds.join(", ")}.`
        : "Every entry is cited by at least one claim.",
    );
    lines.push("");
  }
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ");
}

function appendRestatement(
  lines: string[],
  record: ReportArtifactPayload["familyMutations"][number]["records"][number],
  options: { statements: boolean } = { statements: true },
): void {
  const year =
    record.citingPaperYear != null ? String(record.citingPaperYear) : "n.d.";
  const outcome =
    record.status === "adjudicated"
      ? `**${record.verdict ?? "?"}**${record.mutationKinds && record.mutationKinds.length > 0 ? ` (${record.direction ?? "shifted"}: ${record.mutationKinds.join(", ")})` : ""}`
      : record.status === "not_adjudicated"
        ? `gated: ${record.gateCode ?? "unknown"}`
        : record.status;
  lines.push(
    `- ${year} · ${record.citingPaperTitle}${record.citingPaperDoi ? ` (\`${record.citingPaperDoi}\`)` : ""} · ${outcome}`,
  );
  lines.push(
    `  - Restatement: ${record.citingRestatement.replace(/\n/g, " / ")}`,
  );
  if (options.statements && record.citingAssertion && record.sourceStatement) {
    lines.push(`  - Citing asserts: ${record.citingAssertion}`);
    lines.push(`  - Seed evidence says: ${record.sourceStatement}`);
  }
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

/** A small "how many of each" table, or a line saying there were none. */
function appendStatusTable(
  lines: string[],
  title: string,
  counts: ReadonlyArray<{ status: string; count: number }>,
  emptyMessage: string,
): void {
  lines.push(`${title}:`);
  lines.push("");
  if (counts.length === 0) {
    lines.push(`- ${emptyMessage}`);
  } else {
    for (const entry of counts) {
      lines.push(`- \`${entry.status}\`: ${String(entry.count)}`);
    }
  }
  lines.push("");
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

function appendWeightedRateLine(
  lines: string[],
  rate: ReportWeightedRate,
): void {
  const valueText =
    rate.value == null
      ? "not estimable (zero denominator)"
      : String(rate.value);
  lines.push(
    `- \`${rate.metricId}\`: ${valueText}; weighted numerator=${String(rate.weightedNumerator)}; weighted denominator=${String(rate.weightedDenominator)}; sample numerator=${String(rate.sampleNumerator)}; sample denominator=${String(rate.sampleDenominator)}; weighting=${rate.weighting}; unit=${rate.unit}; population=${rate.populationLabel}; numerator definition=${rate.numeratorDefinition}; denominator definition=${rate.denominatorDefinition}`,
  );
}

function formatPercent(share: number): string {
  return `${String(Math.round(share * 100))}%`;
}

function formatProbability(value: number | null): string {
  return value == null ? "n/a" : String(Math.round(value * 1000) / 1000);
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
    default:
      return unit;
  }
}
