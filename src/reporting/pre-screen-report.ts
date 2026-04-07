import { claimGroundingBlocksAnalysis } from "../domain/pre-screen.js";
import type { ClaimFamilyPreScreen, PreScreenEdge } from "../domain/types.js";
import { formatAcquisitionSummary } from "../retrieval/fulltext-fetch.js";

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
  if (edge.inClaimFamily === false) {
    tags.push("out-of-claim-family");
  }
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

function renderAuditabilityTable(
  label: string,
  m: ClaimFamilyPreScreen["metrics"],
): string[] {
  return [
    "",
    `#### ${label}`,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Total citing papers (before dedup) | ${String(m.totalEdges)} |`,
    `| Unique edges (after dedup) | ${String(m.uniqueEdges)} |`,
    `| Collapsed duplicates | ${String(m.collapsedDuplicates)} |`,
    `| Auditable (structured XML) | ${String(m.auditableStructuredEdges)} |`,
    `| Auditable (PDF) | ${String(m.auditablePdfEdges)} |`,
    `| Partially auditable | ${String(m.partiallyAuditableEdges)} |`,
    `| Not auditable | ${String(m.notAuditableEdges)} |`,
    `| Auditable coverage | ${formatPercent(m.auditableCoverage)} |`,
  ];
}

function renderPopulationMix(
  metrics: ClaimFamilyPreScreen["metrics"],
): string[] {
  return [
    "",
    "#### Citation population mix (claim-scoped edges)",
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
  ];
}

function renderSeedSection(result: ClaimFamilyPreScreen): string {
  const { seed, metrics, decision, decisionReason, resolvedSeedPaper } = result;
  const title = resolvedSeedPaper?.title ?? seed.doi;
  const decisionLabel =
    decision === "greenlight" ? "GREENLIGHT" : "DEPRIORITIZE";

  const lines: string[] = [
    `### ${title}`,
    "",
    `**DOI:** ${seed.doi}`,
    `**Tracked claim (analyst hypothesis):** ${seed.trackedClaim}`,
  ];

  if (result.seedFullTextAcquisition) {
    lines.push(
      `**Seed full text acquisition:** ${formatAcquisitionSummary(result.seedFullTextAcquisition)}`,
    );
  }

  if (seed.notes) {
    lines.push(`**Notes:** ${seed.notes}`);
  }

  const cg = result.claimGrounding;
  if (cg) {
    lines.push(
      "",
      `**Claim grounding (LLM):** \`${cg.status}\`${claimGroundingBlocksAnalysis(cg) ? " — **blocks M2+** until revised" : ""}`,
      `**Normalized claim:** ${cg.normalizedClaim}`,
      `**Grounding detail:** ${cg.detailReason}`,
    );
    if (cg.supportSpans.length > 0) {
      lines.push("", "**LLM-quoted seed passages:**", "");
      for (const sp of cg.supportSpans.slice(0, 5)) {
        const excerpt =
          sp.text.length > 280 ? `${sp.text.slice(0, 277)}…` : sp.text;
        const scoreLabel =
          sp.bm25Score != null
            ? `lexical ${sp.bm25Score.toFixed(3)}`
            : "verbatim";
        lines.push(`- (${scoreLabel}) ${excerpt.replace(/\n/g, " ")}`);
      }
    }
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

  if (result.neighborhoodMetrics) {
    lines.push(
      ...renderAuditabilityTable(
        "Neighborhood auditability (all deduped citers)",
        result.neighborhoodMetrics,
      ),
    );
    lines.push(...renderPopulationMix(result.neighborhoodMetrics));
  }

  lines.push(
    ...renderAuditabilityTable(
      "Claim-scoped auditability (M2+ uses these edges)",
      metrics,
    ),
  );
  lines.push(...renderPopulationMix(metrics));

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
    "| Seed | Claim edges | Grounding | Coverage | Primary-like | Reviews | Profile | M2 | Decision |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const r of results) {
    const title = r.resolvedSeedPaper?.title ?? r.seed.doi;
    const dec = r.decision === "greenlight" ? "GREENLIGHT" : "DEPRIORITIZE";
    const profile =
      r.familyUseProfile.length > 0
        ? r.familyUseProfile.slice(0, 2).join(", ")
        : "—";
    const ground = r.claimGrounding?.status ?? "—";
    lines.push(
      `| ${title} | ${String(r.metrics.uniqueEdges)} | ${ground} | ${formatPercent(r.metrics.auditableCoverage)} | ${formatPercent(r.metrics.primaryLikeEdgeRate)} | ${formatPercent(r.metrics.reviewEdgeRate)} | ${profile} | ${r.m2Priority} | ${dec} |`,
    );
  }

  return lines.join("\n");
}

export type PreScreenMarkdownOptions = {
  /** Basename of the grounding trace JSON written alongside this report. */
  groundingTraceFileName?: string;
};

export function toPreScreenMarkdown(
  results: ClaimFamilyPreScreen[],
  options: PreScreenMarkdownOptions = {},
): string {
  const traceNote =
    options.groundingTraceFileName != null
      ? [
          "",
          "> **LLM grounding trace.** Full prompts, raw model responses, parsing, and quote verification for each seed are in the sidecar file:",
          `> \`${options.groundingTraceFileName}\``,
          "",
        ].join("\n")
      : "";

  const sections: string[] = [
    "# Pre-Screen Report",
    "",
    REPORT_NOTE,
    traceNote,
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
