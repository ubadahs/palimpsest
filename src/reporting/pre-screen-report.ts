import type { ClaimFamilyPreScreen, PreScreenEdge } from "../domain/types.js";

// --- JSON output ---

export function toPreScreenJson(results: ClaimFamilyPreScreen[]): string {
  return JSON.stringify(results, null, 2);
}

// --- Markdown output ---

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function edgeTagSummary(edge: PreScreenEdge): string {
  const tags: string[] = [];
  const c = edge.classification;
  if (c.isReview) tags.push("review");
  if (c.isCommentary) tags.push("commentary");
  if (c.isLetter) tags.push("letter");
  if (c.isBookChapter) tags.push("book-chapter");
  if (c.isPreprint) tags.push("preprint");
  if (c.highReferenceCount) tags.push("high-refs");
  if (c.isPrimaryLike && !c.isPreprint) tags.push("primary");
  return tags.length > 0 ? tags.join(", ") : "—";
}

const REPORT_NOTE = [
  "> **Note on citation population mix.** A review-heavy neighborhood is not",
  "> a worse neighborhood. Review literature is part of the claim-transmission",
  "> system and may be important for studying latent bias and consolidation.",
  "> The composition metrics below describe the family, not judge it.",
].join("\n");

function renderSeedSection(result: ClaimFamilyPreScreen): string {
  const { seed, metrics, decision, decisionReason, resolvedSeedPaper } = result;
  const title = resolvedSeedPaper?.title ?? seed.doi;
  const decisionLabel =
    decision === "greenlight" ? "GREENLIGHT" : "DEPRIORITIZE";

  const lines: string[] = [
    `### ${title}`,
    "",
    `**DOI:** ${seed.doi}`,
    `**Tracked claim:** ${seed.trackedClaim}`,
  ];

  if (seed.notes) {
    lines.push(`**Notes:** ${seed.notes}`);
  }

  lines.push(
    "",
    `**Decision:** ${decisionLabel}`,
    `**Reason:** ${decisionReason}`,
  );

  if (result.familyUseProfile.length > 0) {
    const display = result.familyUseProfile.slice(0, 2).join(", ");
    lines.push(`**Family profile:** ${display}`);
  }

  lines.push(`**M2 priority:** ${result.m2Priority}`);

  lines.push(
    "",
    "#### Auditability",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Total citing papers (before dedup) | ${String(metrics.totalEdges)} |`,
    `| Unique edges (after dedup) | ${String(metrics.uniqueEdges)} |`,
    `| Collapsed duplicates | ${String(metrics.collapsedDuplicates)} |`,
    `| Auditable (structured XML) | ${String(metrics.auditableStructuredEdges)} |`,
    `| Auditable (PDF) | ${String(metrics.auditablePdfEdges)} |`,
    `| Partially auditable | ${String(metrics.partiallyAuditableEdges)} |`,
    `| Not auditable | ${String(metrics.notAuditableEdges)} |`,
    `| Auditable coverage | ${formatPercent(metrics.auditableCoverage)} |`,
  );

  lines.push(
    "",
    "#### Citation population mix",
    "",
    "| Category | Count | Share |",
    "| --- | --- | --- |",
    `| Primary-like (candidates for empirical-attribution pipeline) | ${String(metrics.primaryLikeEdgeCount)} | ${formatPercent(metrics.primaryLikeEdgeRate)} |`,
    `| Journal articles | ${String(metrics.articleEdgeCount)} | ${formatPercent(metrics.articleEdgeRate)} |`,
    `| Preprints | ${String(metrics.preprintEdgeCount)} | ${formatPercent(metrics.preprintEdgeRate)} |`,
    `| Reviews | ${String(metrics.reviewEdgeCount)} | ${formatPercent(metrics.reviewEdgeRate)} |`,
    `| Commentary / editorial / perspective | ${String(metrics.commentaryEdgeCount)} | ${formatPercent(metrics.commentaryEdgeRate)} |`,
    `| Letters / errata | ${String(metrics.letterEdgeCount)} | ${formatPercent(metrics.letterEdgeRate)} |`,
    `| Book chapters | ${String(metrics.bookChapterEdgeCount)} | ${formatPercent(metrics.bookChapterEdgeRate)} |`,
  );

  if (result.duplicateGroups.length > 0) {
    lines.push("", "#### Duplicate groups", "");
    for (const group of result.duplicateGroups) {
      const repTitle =
        result.resolvedPapers[group.keptRepresentativePaperId]?.title ??
        group.keptRepresentativePaperId;
      const collapsedTitles = group.collapsedFromPaperIds.map(
        (id) => result.resolvedPapers[id]?.title ?? id,
      );
      lines.push(
        `- **Kept:** ${repTitle}`,
        `  - **Collapsed:** ${collapsedTitles.join("; ")}`,
        `  - **Reason:** ${group.collapseReason}`,
      );
    }
  }

  if (result.edges.length > 0) {
    lines.push(
      "",
      "#### Edges",
      "",
      "| Citing paper | Type | Refs | Auditability | Tags |",
      "| --- | --- | --- | --- | --- |",
    );

    for (const edge of result.edges) {
      const citingTitle =
        result.resolvedPapers[edge.citingPaperId]?.title ?? edge.citingPaperId;
      const ptype = edge.paperType ?? "—";
      const refs =
        edge.referencedWorksCount != null
          ? String(edge.referencedWorksCount)
          : "—";
      lines.push(
        `| ${citingTitle} | ${ptype} | ${refs} | ${edge.auditabilityStatus} | ${edgeTagSummary(edge)} |`,
      );
    }
  }

  return lines.join("\n");
}

function renderSummaryTable(results: ClaimFamilyPreScreen[]): string {
  const lines: string[] = [
    "## Summary",
    "",
    "| Seed | Unique | Coverage | Primary-like | Reviews | Profile | M2 | Decision |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const r of results) {
    const title = r.resolvedSeedPaper?.title ?? r.seed.doi;
    const dec = r.decision === "greenlight" ? "GREENLIGHT" : "DEPRIORITIZE";
    const profile =
      r.familyUseProfile.length > 0
        ? r.familyUseProfile.slice(0, 2).join(", ")
        : "—";
    lines.push(
      `| ${title} | ${String(r.metrics.uniqueEdges)} | ${formatPercent(r.metrics.auditableCoverage)} | ${formatPercent(r.metrics.primaryLikeEdgeRate)} | ${formatPercent(r.metrics.reviewEdgeRate)} | ${profile} | ${r.m2Priority} | ${dec} |`,
    );
  }

  return lines.join("\n");
}

export function toPreScreenMarkdown(results: ClaimFamilyPreScreen[]): string {
  const sections: string[] = [
    "# Pre-Screen Report",
    "",
    REPORT_NOTE,
    "",
    renderSummaryTable(results),
    "",
    "## Claim Families",
    "",
  ];

  for (const result of results) {
    sections.push(renderSeedSection(result));
    sections.push("");
  }

  return sections.join("\n");
}
