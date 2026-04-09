import type { ClaimDiscoveryResult } from "../domain/types.js";
import type { AttributionDiscoveryResult } from "../pipeline/discovery-family-probe.js";
import { formatAcquisitionSummary } from "../retrieval/fulltext-fetch.js";

export function toDiscoveryMarkdown(results: ClaimDiscoveryResult[]): string {
  const lines: string[] = ["# Claim Discovery Report", ""];

  for (const result of results) {
    const title = result.resolvedPaper?.title ?? result.doi;
    lines.push(`## ${title}`);
    lines.push("");
    lines.push(`- **DOI:** ${result.doi}`);
    lines.push(`- **Status:** ${result.status}`);
    lines.push(`- **Detail:** ${result.statusDetail}`);
    if (result.llmModel) {
      lines.push(`- **Model:** ${result.llmModel}`);
    }
    if (result.llmEstimatedCostUsd != null) {
      lines.push(
        `- **Est. cost (extraction):** $${result.llmEstimatedCostUsd.toFixed(4)}`,
      );
    }
    lines.push(
      `- **Claims:** ${String(result.totalClaimCount)} total, ${String(result.findingCount)} findings`,
    );
    if (result.fullTextAcquisition) {
      lines.push(
        `- **Full text acquisition:** ${formatAcquisitionSummary(result.fullTextAcquisition)}`,
      );
    }

    if (result.ranking) {
      const r = result.ranking;
      lines.push(
        `- **Ranking:** ${String(r.citingPapersAnalyzed)} citing papers analyzed (${r.rankingModel}, $${r.rankingEstimatedCostUsd.toFixed(4)})`,
      );
    }
    lines.push("");

    if (result.claims.length === 0) {
      lines.push("*No claims extracted.*");
      lines.push("");
      continue;
    }

    if (result.ranking) {
      lines.push("### Ranked by citing-paper engagement");
      lines.push("");
      lines.push("| Rank | # | Type | Direct | Indirect | Claim |");
      lines.push("|------|---|------|--------|----------|-------|");

      const sorted = result.ranking.engagements;
      for (let i = 0; i < sorted.length; i++) {
        const e = sorted[i]!;
        const truncated =
          e.claimText.length > 80
            ? `${e.claimText.slice(0, 77)}...`
            : e.claimText;
        lines.push(
          `| ${String(i + 1)} | ${String(e.claimIndex + 1)} | ${e.claimType} | ${String(e.directCount)} | ${String(e.indirectCount)} | ${truncated} |`,
        );
      }

      lines.push("");

      const withDirect = sorted.filter((e) => e.directCount > 0);
      if (withDirect.length > 0) {
        lines.push("### Claims with direct citing-paper engagement");
        lines.push("");
        for (const e of withDirect) {
          lines.push(
            `**#${String(e.claimIndex + 1)}** [${e.claimType}] — ${String(e.directCount)} direct, ${String(e.indirectCount)} indirect`,
          );
          lines.push(`> ${e.claimText}`);
          lines.push("");
          lines.push("Direct engagements:");
          for (const p of e.directPapers) {
            lines.push(`- ${p}`);
          }
          lines.push("");
        }
      }

      lines.push("---");
      lines.push("");
    }

    lines.push("### All extracted claims");
    lines.push("");

    for (let i = 0; i < result.claims.length; i++) {
      const claim = result.claims[i]!;
      lines.push(
        `#### ${String(i + 1)}. [${claim.claimType}] ${claim.confidence === "medium" ? "(medium confidence) " : ""}`,
      );
      lines.push("");
      lines.push(`> ${claim.claimText}`);
      lines.push("");
      lines.push(`**Section:** ${claim.section}`);
      if (claim.citedReferences.length > 0) {
        lines.push(`**Cited references:** ${claim.citedReferences.join(", ")}`);
      }
      lines.push("");
      lines.push("**Source:**");
      for (const span of claim.sourceSpans) {
        lines.push(`> ${span}`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Attribution-first report
// ---------------------------------------------------------------------------

export function toAttributionDiscoveryMarkdown(
  results: AttributionDiscoveryResult[],
): string {
  const lines: string[] = ["# Attribution-First Discovery Report", ""];

  for (const result of results) {
    const title = result.resolvedPaper?.title ?? result.doi;
    lines.push(`## ${title}`);
    lines.push("");
    lines.push(`- **DOI:** ${result.doi}`);
    lines.push(
      `- **Neighborhood:** ${String(result.neighborhood.totalCitingPapers)} citing papers (${String(result.neighborhood.fullTextAvailableCount)} full-text available)`,
    );
    lines.push(
      `- **Probe set:** ${String(result.probeSelection.selectedCount)} selected, ${String(result.probeSelection.excludedCount)} excluded (strategy: ${result.probeSelection.strategy})`,
    );
    lines.push(
      `- **Mentions harvested:** ${String(result.mentions.length)} from ${String(result.harvestSummaries.filter((s) => s.harvestOutcome === "success").length)} papers`,
    );

    const inScope = result.extractionRecords.filter(
      (r) => r.inScopeEmpiricalAttribution,
    );
    lines.push(
      `- **Attributed claims:** ${String(inScope.length)} in-scope of ${String(result.extractionRecords.length)} total`,
    );
    lines.push(
      `- **Family candidates:** ${String(result.familyCandidates.length)}`,
    );
    lines.push(`- **Shortlisted:** ${String(result.shortlistEntries.length)}`);

    if (result.warnings.length > 0) {
      lines.push("");
      lines.push("### Warnings");
      for (const w of result.warnings) {
        lines.push(`- ${w}`);
      }
    }
    lines.push("");

    // Harvest summary
    const failedHarvests = result.harvestSummaries.filter(
      (s) => s.harvestOutcome !== "success",
    );
    if (failedHarvests.length > 0) {
      lines.push("### Harvest failures");
      lines.push("");
      for (const s of failedHarvests) {
        lines.push(
          `- **${s.citingPaperTitle.slice(0, 60)}**: ${s.harvestOutcome} — ${s.failureReason ?? "no detail"}`,
        );
      }
      lines.push("");
    }

    // Shortlisted families
    if (result.shortlistEntries.length > 0) {
      lines.push("### Shortlisted families");
      lines.push("");
      for (let i = 0; i < result.shortlistEntries.length; i++) {
        const entry = result.shortlistEntries[i]!;
        lines.push(`#### ${String(i + 1)}. ${entry.trackedClaim}`);
        lines.push("");
        if (entry.seedGroundingStatus) {
          lines.push(`- **Grounding:** ${entry.seedGroundingStatus}`);
        }
        if (entry.supportingMentionCount != null) {
          lines.push(
            `- **Supporting mentions:** ${String(entry.supportingMentionCount)}`,
          );
        }
        if (entry.supportingPaperCount != null) {
          lines.push(
            `- **Supporting papers:** ${String(entry.supportingPaperCount)}`,
          );
        }
        if (entry.notes) {
          lines.push(`- **Notes:** ${entry.notes}`);
        }
        lines.push("");
      }
    }

    // Non-shortlisted families (for transparency)
    const excluded = result.familyCandidates.filter(
      (f) => !f.shortlistEligible,
    );
    if (excluded.length > 0) {
      lines.push("### Excluded families");
      lines.push("");
      for (const f of excluded) {
        const truncated =
          f.canonicalTrackedClaim.length > 80
            ? `${f.canonicalTrackedClaim.slice(0, 77)}…`
            : f.canonicalTrackedClaim;
        lines.push(`- ${truncated} — ${f.shortlistReason}`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}
